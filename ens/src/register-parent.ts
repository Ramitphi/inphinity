// Step 1: register inphinity.eth on Sepolia through the ENSv2 ETH Registrar.
//
// ENSv2 keeps ENSv1's commit-reveal flow but takes payment in an ERC-20 stablecoin chosen by the
// caller. This script:
//   1. stops early if the name is already registered to us (idempotent),
//   2. picks an accepted stablecoin we can pay with (minting ENS's Sepolia MockUSDC if needed),
//   3. approves the registrar, commits, waits MIN_COMMITMENT_AGE, then registers.
// The pending commitment and its secret are saved to deployments.sepolia.json, so an interrupted
// run resumes instead of paying twice.
//
// Usage: PRIVATE_KEY=0x... bun run src/register-parent.ts [--dry-run]
// Env:   ENS_DURATION_DAYS (default 365), PAYMENT_TOKEN (force one accepted token address)
import { maxUint256, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { ENS, MINTABLE_USDC, PARENT_LABEL, PARENT_NAME, PAYMENT_TOKENS, TEAM_WALLET, DRY_RUN, sepoliaClient as c } from "./config";
import { ethRegistrarAbi, rentPriceOracleAbi, erc20Abi, registryAbi } from "./abis";
import { labelId, loadState, saveState, send, signer, sleep, sepoliaTx } from "./lib";

const MOCK_USDC: Address = MINTABLE_USDC;
const registrar = { address: ENS.ethRegistrar, abi: ethRegistrarAbi } as const;

async function main() {
  const s = signer();
  const owner = s.from;
  console.log(`Registering ${PARENT_NAME} for ${owner}${DRY_RUN ? " (dry-run)" : ""}`);
  if (owner.toLowerCase() !== TEAM_WALLET.toLowerCase()) {
    console.warn(`  note: signer is not the team wallet ${TEAM_WALLET}`);
  }

  // 1. Already registered?
  const currentOwner = await c.readContract({
    address: ENS.ethRegistry,
    abi: registryAbi,
    functionName: "getOwner",
    args: [labelId(PARENT_LABEL)],
  });
  if (currentOwner !== zeroAddress) {
    if (currentOwner.toLowerCase() === owner.toLowerCase()) {
      const expiry = await c.readContract({ address: ENS.ethRegistry, abi: registryAbi, functionName: "getExpiry", args: [labelId(PARENT_LABEL)] });
      console.log(`  already registered to ${owner}, expires ${new Date(Number(expiry) * 1000).toISOString()}. Nothing to do.`);
      return;
    }
    throw new Error(`${PARENT_NAME} is owned by ${currentOwner}, not ${owner}. Pick another ENS_PARENT_LABEL.`);
  }
  if (!(await c.readContract({ ...registrar, functionName: "isAvailable", args: [PARENT_LABEL] }))) {
    throw new Error(`${PARENT_NAME} is not available (reserved or in grace period).`);
  }

  // 2. Duration and payment token.
  const minDuration = await c.readContract({ ...registrar, functionName: "MIN_REGISTER_DURATION" });
  let duration = BigInt(Number(process.env.ENS_DURATION_DAYS ?? 365) * 86400);
  if (duration < minDuration) duration = minDuration;

  const oracle = await c.readContract({ ...registrar, functionName: "rentPriceOracle" });
  const candidates = process.env.PAYMENT_TOKEN
    ? [{ name: "PAYMENT_TOKEN", address: process.env.PAYMENT_TOKEN as Address }]
    : PAYMENT_TOKENS;
  let pick: { name: string; address: Address; price: bigint; balance: bigint } | undefined;
  for (const t of candidates) {
    const ok = await c.readContract({ address: oracle, abi: rentPriceOracleAbi, functionName: "isPaymentToken", args: [t.address] }).catch(() => false);
    if (!ok) {
      console.log(`  ${t.name} ${t.address}: not accepted by the registrar's price oracle`);
      continue;
    }
    const [base, premium] = await c.readContract({ ...registrar, functionName: "getRegisterPrice", args: [PARENT_LABEL, duration, t.address] });
    const balance = await c.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    console.log(`  ${t.name} ${t.address}: price ${base + premium} (base ${base}, premium ${premium}), balance ${balance}`);
    const enough = balance >= base + premium;
    if (enough || t.address.toLowerCase() === MOCK_USDC.toLowerCase()) {
      pick ??= { ...t, price: base + premium, balance };
      if (enough) break;
    }
  }
  if (!pick) throw new Error("No accepted payment token with enough balance, and MockUSDC is not accepted.");
  console.log(`  paying with ${pick.name}: ${pick.price} base units for ${Number(duration) / 86400} days`);

  if (pick.balance < pick.price) {
    if (pick.address.toLowerCase() !== MOCK_USDC.toLowerCase()) throw new Error(`Not enough ${pick.name}.`);
    await send(s, "mint MockUSDC", { address: MOCK_USDC, abi: erc20Abi, functionName: "mint", args: [owner, pick.price * 2n] });
  }
  const allowance = await c.readContract({ address: pick.address, abi: erc20Abi, functionName: "allowance", args: [owner, ENS.ethRegistrar] });
  if (allowance < pick.price) {
    await send(s, `approve ${pick.name} to ETH Registrar`, { address: pick.address, abi: erc20Abi, functionName: "approve", args: [ENS.ethRegistrar, maxUint256] });
  }

  // 3. Commit (or reuse a saved, still valid commitment).
  const state = loadState();
  const minAge = await c.readContract({ ...registrar, functionName: "MIN_COMMITMENT_AGE" });
  const maxAge = await c.readContract({ ...registrar, functionName: "MAX_COMMITMENT_AGE" });
  const now = Math.floor(Date.now() / 1000);
  let pending = state.pendingCommit;
  if (pending && (pending.duration !== duration.toString() || now >= pending.committedAt + Number(maxAge))) {
    pending = undefined; // stale or for different parameters
  }
  if (!pending) {
    const secret = toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;
    // subregistry and resolver stay empty here; setup-registry.ts attaches them with setSubregistry/setResolver.
    const commitment = await c.readContract({
      ...registrar,
      functionName: "makeCommitment",
      args: [PARENT_LABEL, owner, secret, zeroAddress, zeroAddress, duration, zeroHash],
    });
    await send(s, "commit", { ...registrar, functionName: "commit", args: [commitment] });
    pending = { commitment, secret, duration: duration.toString(), paymentToken: pick.address, committedAt: Math.floor(Date.now() / 1000) };
    state.pendingCommit = pending;
    saveState(state);
  } else {
    console.log(`  reusing commitment ${pending.commitment} from ${new Date(pending.committedAt * 1000).toISOString()}`);
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] would wait ${minAge}s, then register(${PARENT_LABEL}, ${owner}, secret, 0x0, 0x0, ${duration}, ${pick.address}, 0x0)`);
    return;
  }

  // 4. Wait for the commitment to age (chain time), then reveal.
  for (;;) {
    const committedAt = await c.readContract({ ...registrar, functionName: "commitmentAt", args: [pending.commitment] });
    const block = await c.getBlock();
    const readyAt = committedAt + minAge + 1n;
    if (committedAt > 0n && block.timestamp >= readyAt) break;
    const wait = committedAt === 0n ? 5n : readyAt - block.timestamp;
    console.log(`  waiting ${wait}s for the commitment to age...`);
    await sleep(Number(wait) * 1000 + 2000);
  }
  const { hash } = await send(s, `register ${PARENT_NAME}`, {
    ...registrar,
    functionName: "register",
    args: [PARENT_LABEL, owner, pending.secret, zeroAddress, zeroAddress, BigInt(pending.duration), pick.address, zeroHash], // token is not part of the commitment
  });
  delete state.pendingCommit;
  state.parentName = PARENT_NAME;
  state.parentRegisteredTx = hash;
  saveState(state);
  console.log(`Done: ${PARENT_NAME} registered. ${sepoliaTx(hash)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
