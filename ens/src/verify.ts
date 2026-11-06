// Step 4: check the registry end to end, the way any app sees it.
//
// Resolution goes through the ENSv2 Universal Resolver (0xeEeE...EeEe on Sepolia) with viem, using
// Arc Testnet's ENSIP-11 coin type. Results are compared with live data read from the fund contract
// on Arc, and the creator's permissions are checked (owns the token, cannot change the resolver,
// cannot transfer, holds no resolver roles).
//
// Usage: bun run src/verify.ts [name ...]     (read-only, no key needed)
//   default names: inphinity.eth, latest.inphinity.eth and every fund in deployments.sepolia.json
import { getAddress, zeroAddress, type Address } from "viem";
import { ARC_COIN_TYPE, ENS, PARENT_NAME, arcClient as arc, sepoliaClient as c } from "./config";
import { indexFundAbi, permissionedResolverAbi, registryAbi } from "./abis";
import { RegistryRoles, ResolverRoles, coinTypeResource, labelId, loadState, textKeyResource } from "./lib";
import { recordIdOf } from "./records";

const TEXT_KEYS = [
  "name",
  "description",
  "url",
  "inphinity.symbol",
  "inphinity.weights",
  "inphinity.fee",
  "inphinity.creator",
  "inphinity.chain",
  "inphinity.factory",
  "inphinity.registry",
  "inphinity.disclaimer",
];

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`    ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

const ur = { universalResolverAddress: ENS.universalResolver } as const;

export async function resolveName(name: string) {
  const [arcAddr, ethAddr, resolver] = await Promise.all([
    c.getEnsAddress({ name, coinType: ARC_COIN_TYPE, ...ur }).catch(() => null),
    c.getEnsAddress({ name, coinType: 60n, ...ur }).catch(() => null),
    c.getEnsResolver({ name, ...ur }).catch(() => null),
  ]);
  const texts: Record<string, string> = {};
  for (const key of TEXT_KEYS) {
    const v = await c.getEnsText({ name, key, ...ur }).catch(() => null);
    if (v) texts[key] = v;
  }
  return { arcAddr, ethAddr, texts, resolver };
}

async function main() {
  const state = loadState();
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const funds = Object.values(state.funds ?? {});
  const names = args.length ? args : [PARENT_NAME, `latest.${PARENT_NAME}`, ...funds.map((f) => f.label)];
  console.log(`Universal Resolver ${ENS.universalResolver}, Arc Testnet coin type ${ARC_COIN_TYPE}\n`);

  for (const name of names) {
    const r = await resolveName(name);
    console.log(name);
    console.log(`    resolver              ${r.resolver ?? "-"}`);
    console.log(`    addr(${ARC_COIN_TYPE})      ${r.arcAddr ?? "-"}`);
    for (const [k, v] of Object.entries(r.texts)) console.log(`    text ${k.padEnd(18)} ${v}`);
    if (state.resolver) check(r.resolver?.toLowerCase() === state.resolver.toLowerCase(), "served by the Inphinity Permissioned Resolver");
    check(!!r.arcAddr, "resolves to an Arc Testnet address");
    check(!r.ethAddr || r.ethAddr === zeroAddress, "no Ethereum (coin type 60) address, so nobody sends mainnet funds to it");

    const label = name.endsWith(`.${PARENT_NAME}`) ? name.slice(0, -PARENT_NAME.length - 1) : null;
    if (!label || !r.arcAddr || label.includes(".")) {
      console.log("");
      continue;
    }

    // Records must match what the fund contract on Arc says right now.
    const fund = getAddress(r.arcAddr) as Address;
    const f = { address: fund, abi: indexFundAbi } as const;
    const creator = await arc.readContract({ ...f, functionName: "creator" }).catch(() => null);
    if (!creator) {
      check(false, `no IndexFund at ${fund} on Arc Testnet`);
      continue;
    }
    const [sym, fee] = await Promise.all([arc.readContract({ ...f, functionName: "symbol" }), arc.readContract({ ...f, functionName: "feeBps" })]);
    check(r.texts["inphinity.symbol"] === sym, `symbol matches Arc (${sym})`);
    check(r.texts["inphinity.fee"] === String(fee), `fee matches Arc (${fee} bps)`);
    check(r.texts["inphinity.creator"]?.toLowerCase() === creator.toLowerCase(), "creator matches Arc");

    if (!state.userRegistry || !state.resolver) continue;
    const st = await c.readContract({ address: state.userRegistry, abi: registryAbi, functionName: "getState", args: [labelId(label)] });
    if (st.status !== 2) {
      const linked = await recordIdOf(state.resolver, name);
      console.log(`    (no token: ${linked ? `linked to record bundle #${linked}` : "default bundle"})\n`);
      continue;
    }
    // Token-scoped roles only (roles() excludes ROOT_RESOURCE, where the operator's roles live).
    const tokenRoles = await c.readContract({ address: state.userRegistry, abi: registryAbi, functionName: "roles", args: [st.tokenId, creator] });
    const has = (bit: bigint) => (tokenRoles & bit) !== 0n;
    check(st.latestOwner.toLowerCase() === creator.toLowerCase(), `ERC-1155 name token owned by the fund creator ${creator}`);
    check(!has(RegistryRoles.SET_RESOLVER), "token does not let the creator change the resolver (anti-phishing)");
    check(!has(RegistryRoles.CAN_TRANSFER_ADMIN), "token is not transferable");
    check(!has(RegistryRoles.SET_SUBREGISTRY), "token does not let the creator attach sub-subnames");
    const operator = await c.readContract({ address: state.resolver, abi: permissionedResolverAbi, functionName: "hasRootRoles", args: [ResolverRoles.SET_TEXT, creator] });
    if (operator) {
      console.log("    note: this creator is also the registry operator (team wallet), which holds root roles by design");
    } else {
      const res = { address: state.resolver, abi: permissionedResolverAbi, functionName: "hasRoles" } as const;
      const anyText = await c.readContract({ ...res, args: [textKeyResource("description"), ResolverRoles.SET_TEXT, creator] });
      const anyAddr = await c.readContract({ ...res, args: [coinTypeResource(ARC_COIN_TYPE), ResolverRoles.SET_ADDRESS, creator] });
      check(!anyText && !anyAddr, "creator holds no resolver roles (they would apply to every fund)");
    }
    console.log("");
  }
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
  console.log(`Browse: https://sepolia.app.ens.domains/${PARENT_NAME}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
