// Step 5 (optional): name funds through Chainlink CCIP instead of the off-chain relayer.
//
//   Arc Testnet                                         Ethereum Sepolia
//   IndexFactory.createIndex                            InphinityEnsReceiver.ccipReceive
//     -> ArcEnsRegistrar.register  --Chainlink CCIP-->    -> UserRegistry.register(label, creator)
//        (reads the fund, pays the fee in native USDC)     -> PermissionedResolver records + links
//
// This script, as the team wallet (owner of IndexFactory, inphinity.eth, the UserRegistry and the
// resolver), and idempotently:
//   1. deploys ArcEnsRegistrar on Arc and InphinityEnsReceiver on Sepolia,
//   2. grants the receiver ROLE_REGISTRAR on the UserRegistry and SET_ADDRESS/SET_TEXT/LINK on the
//      resolver (root roles; the receiver only ever writes what Arc sent),
//   3. points the registrar at the receiver and tops up its native-USDC fee balance,
//   4. with --enable, calls IndexFactory.setRegistrar(registrar). From then on every createIndex
//      sends a CCIP message, and the factory requires a non-empty label (the app sends one).
//      --disable sets it back to address(0) (instant kill switch, fund creation keeps working).
//
// Usage: PRIVATE_KEY=0x... bun run src/ccip-setup.ts [--enable | --disable] [--dry-run]
// Env:   CCIP_FUND_USDC (fee balance to keep on the registrar, default 3; ~0.53 USDC per fund)
//        CCIP_GAS_LIMIT (Sepolia execution gas per message, default 9000000)
import { formatEther, parseEther, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { ARC, CCIP, DRY_RUN, ENS, arcClient as arc, sepoliaClient as c } from "./config";
import { indexFactoryAbi, permissionedResolverAbi, registryAbi } from "./abis";
import { RegistryRoles, ResolverRoles, deploy, loadState, saveState, send, sendValue, signer } from "./lib";
import registrarArtifact from "../ccip-artifacts/ArcEnsRegistrar.json";
import receiverArtifact from "../ccip-artifacts/InphinityEnsReceiver.json";

const registrarArt = registrarArtifact as unknown as { abi: Abi; bytecode: Hex };
const receiverArt = receiverArtifact as unknown as { abi: Abi; bytecode: Hex };
const ENABLE = process.argv.includes("--enable");
const DISABLE = process.argv.includes("--disable");
const FUND_TARGET = parseEther(process.env.CCIP_FUND_USDC ?? "3");
/** Sepolia execution gas per message. Live ccipReceive uses ~4.5M-7.5M; 2.5M failed live. */
const GAS_LIMIT = BigInt(process.env.CCIP_GAS_LIMIT ?? 9_000_000);

export const RECEIVER_RESOLVER_ROLES = ResolverRoles.SET_ADDRESS | ResolverRoles.SET_TEXT | ResolverRoles.LINK;

const hasCode = async (client: typeof c | typeof arc, a?: Address) =>
  !!a && ((await client.getCode({ address: a })) ?? "0x") !== "0x";

async function main() {
  const s = signer();
  const me = s.from;
  const state = loadState();
  if (!state.userRegistry || !state.resolver) throw new Error("Run setup-registry.ts first.");
  console.log(`CCIP bridge Arc -> Sepolia as ${me}${DRY_RUN ? " (dry-run)" : ""}`);

  const factory = { address: ARC.indexFactory, abi: indexFactoryAbi } as const;
  const factoryOwner = await arc.readContract({ ...factory, functionName: "owner" });
  if (factoryOwner.toLowerCase() !== me.toLowerCase()) console.warn(`  note: IndexFactory owner is ${factoryOwner}, not ${me}; --enable will fail`);

  // 1a. Arc: ArcEnsRegistrar.
  let registrar = state.arcEnsRegistrar;
  if (await hasCode(arc, registrar)) console.log(`  ArcEnsRegistrar: ${registrar} (already deployed)`);
  else {
    registrar = await deploy(s, "deploy ArcEnsRegistrar on Arc", registrarArt, [me, ARC.indexFactory, CCIP.arcRouter, CCIP.sepoliaSelector], "arc");
    if (registrar) {
      state.arcEnsRegistrar = registrar;
      saveState(state);
    }
  }

  // 1b. Sepolia: InphinityEnsReceiver, bound to that registrar.
  let receiver = state.ensReceiver;
  if (receiver && (await hasCode(c, receiver)) && registrar) {
    const bound = (await c.readContract({ address: receiver, abi: receiverArt.abi, functionName: "arcSender" })) as Address;
    if (bound.toLowerCase() !== registrar.toLowerCase()) receiver = undefined; // registrar was redeployed
  }
  if (receiver && (await hasCode(c, receiver))) console.log(`  InphinityEnsReceiver: ${receiver} (already deployed)`);
  else if (registrar) {
    receiver = await deploy(s, "deploy InphinityEnsReceiver on Sepolia", receiverArt,
      [me, CCIP.sepoliaRouter, CCIP.arcSelector, registrar, state.userRegistry, state.resolver, ENS.ethRegistry], "sepolia");
    if (receiver) {
      state.ensReceiver = receiver;
      saveState(state);
    }
  }
  if (!registrar || !receiver) {
    console.log("  [dry-run] stopping: the remaining steps need both contracts deployed.");
    return;
  }

  // 2. ENSv2 roles for the receiver.
  const ur = { address: state.userRegistry, abi: registryAbi } as const;
  if (!(await c.readContract({ ...ur, functionName: "hasRootRoles", args: [RegistryRoles.REGISTRAR, receiver] }))) {
    await send(s, "UserRegistry: grant ROLE_REGISTRAR to receiver", { ...ur, functionName: "grantRootRoles", args: [RegistryRoles.REGISTRAR, receiver] });
  } else console.log("  receiver already has ROLE_REGISTRAR");
  const res = { address: state.resolver, abi: permissionedResolverAbi } as const;
  if (!(await c.readContract({ ...res, functionName: "hasRootRoles", args: [RECEIVER_RESOLVER_ROLES, receiver] }))) {
    await send(s, "Resolver: grant SET_ADDRESS|SET_TEXT|LINK to receiver", { ...res, functionName: "grantRootRoles", args: [RECEIVER_RESOLVER_ROLES, receiver] });
  } else console.log("  receiver already has resolver roles");

  // 3. Connect and fund the registrar.
  const reg = { address: registrar, abi: registrarArt.abi } as const;
  const current = (await arc.readContract({ ...reg, functionName: "receiver" })) as Address;
  if (current.toLowerCase() !== receiver.toLowerCase()) {
    await send(s, "ArcEnsRegistrar.setReceiver", { ...reg, functionName: "setReceiver", args: [receiver] } as any, "arc");
  } else console.log("  registrar already points at the receiver");
  const gas = (await arc.readContract({ ...reg, functionName: "gasLimit" })) as bigint;
  if (gas !== GAS_LIMIT) {
    await send(s, `ArcEnsRegistrar.setGasLimit(${GAS_LIMIT}) (was ${gas})`, { ...reg, functionName: "setGasLimit", args: [GAS_LIMIT] } as any, "arc");
  } else console.log(`  registrar gas limit already ${gas}`);
  const fee = (await arc.readContract({ ...reg, functionName: "quoteFee" }).catch(() => 0n)) as bigint;
  const balance = await arc.getBalance({ address: registrar });
  console.log(`  CCIP fee per fund ~${formatEther(fee)} USDC; registrar balance ${formatEther(balance)} USDC`);
  if (balance < FUND_TARGET / 2n) {
    await sendValue(s, `fund registrar with ${formatEther(FUND_TARGET - balance)} USDC`, registrar, FUND_TARGET - balance, "arc");
  }

  // 4. Switch the factory over (or back).
  const active = await arc.readContract({ ...factory, functionName: "registrar" });
  if (ENABLE && active.toLowerCase() !== registrar.toLowerCase()) {
    await send(s, "IndexFactory.setRegistrar(ArcEnsRegistrar)", { ...factory, functionName: "setRegistrar", args: [registrar] }, "arc");
  } else if (DISABLE && active !== zeroAddress) {
    await send(s, "IndexFactory.setRegistrar(0)", { ...factory, functionName: "setRegistrar", args: [zeroAddress] }, "arc");
  }
  const now = DRY_RUN ? active : await arc.readContract({ ...factory, functionName: "registrar" });
  console.log(`\nDone.
  ArcEnsRegistrar (Arc)          ${registrar}
  InphinityEnsReceiver (Sepolia) ${receiver}
  IndexFactory.registrar         ${now}${now.toLowerCase() === registrar.toLowerCase() ? "  (CCIP naming ON)" : "  (CCIP naming OFF; run with --enable)"}
  Track messages: https://ccip.chain.link (search the NamingRequested messageId)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
