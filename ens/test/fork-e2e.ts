// End-to-end test on a local Hardhat fork of Sepolia: real, live ENSv2 contracts, sample fund data.
//
// Run it after register-parent.ts and setup-registry.ts have run against the same fork, as the
// team wallet (impersonated, no key needed). See README.md "Testing on a fork".
// It relays sample funds through the real relayer code, resolves them through the Universal
// Resolver, then impersonates a creator to prove what they can and cannot do.
import { createWalletClient, http, namehash, type Address } from "viem";
import { sepolia } from "viem/chains";
import { ARC_COIN_TYPE, ENS, PARENT_LABEL, SEPOLIA_RPC_URL, sepoliaClient as c } from "../src/config";
import { permissionedResolverAbi, registryAbi } from "../src/abis";
import { dnsEncode, explain, labelId, loadState, signer } from "../src/lib";
import { recordIdOf } from "../src/records";
import { processFund, type FundInfo } from "../src/relayer";

if (!/127\.0\.0\.1|localhost/.test(SEPOLIA_RPC_URL)) throw new Error("run against a local fork: SEPOLIA_RPC_URL=http://127.0.0.1:8545");

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};
const rpc = (method: string, params: unknown[]) =>
  fetch(SEPOLIA_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

const state = loadState();
const userRegistry = state.userRegistry!;
const resolver = state.resolver!;
const parentExpiry = await c.readContract({ address: ENS.ethRegistry, abi: registryAbi, functionName: "getExpiry", args: [labelId(PARENT_LABEL)] });
const ctx = { s: signer(), userRegistry, resolver, parentExpiry };
const ur = { universalResolverAddress: ENS.universalResolver } as const;
const arcAddr = (name: string) => c.getEnsAddress({ name, coinType: ARC_COIN_TYPE, ...ur }).catch(() => null);
const text = (name: string, key: string) => c.getEnsText({ name, key, ...ur }).catch(() => null);

const creator: Address = "0x00000000000000000000000000000000c0ffee01";
const fundA: FundInfo = {
  fund: "0x1111111111111111111111111111111111111111",
  index: 0,
  eventLabel: "Tech Giants!!",
  name: "Tech Giants Index",
  symbol: "TECH",
  creator,
  feeBps: 50,
  tokens: ["0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"],
  tokenSymbols: ["AAPL", "MSFT"],
  weights: [6000, 4000],
};
const fundB: FundInfo = { ...fundA, fund: "0x4444444444444444444444444444444444444444", index: 1, symbol: "TECH2", name: "Tech Giants Copy" };
// Fund C asks for label "tech", which is currently fund A's symbol link.
const fundC: FundInfo = { ...fundA, fund: "0x5555555555555555555555555555555555555555", index: 2, eventLabel: "tech", symbol: "TCH", name: "Tech Classic" };

console.log("relay");
const nameA = await processFund(ctx, fundA);
check(nameA === "tech-giants.inphinity.eth", `label sanitized from the event: ${nameA}`);
check((await processFund(ctx, fundA)) === nameA, "re-run is a no-op and returns the same name");
const nameB = await processFund(ctx, fundB);
check(nameB === "tech-giants-2.inphinity.eth", `colliding label deduped: ${nameB}`);

console.log("resolve through the ENSv2 Universal Resolver");
check((await arcAddr(nameA))?.toLowerCase() === fundA.fund, `addr(Arc) ${nameA}`);
check(!(await c.getEnsAddress({ name: nameA, coinType: 60n, ...ur }).catch(() => null)), "no coin type 60 address");
check((await text(nameA, "inphinity.weights")) === "AAPL:6000,MSFT:4000", "inphinity.weights");
check((await text(nameA, "inphinity.fee")) === "50", "inphinity.fee");
check((await arcAddr("tech.inphinity.eth"))?.toLowerCase() === fundA.fund, "symbol link tech.inphinity.eth -> fund A");
check((await arcAddr("inphinity.eth"))?.toLowerCase() === "0x9fa4034efb237a7c154adea20b1ccfa0cd538b11", "inphinity.eth -> IndexFactory on Arc");
check((await text("inphinity.eth", "inphinity.chain")) === "arc-testnet:5042002", "parent inphinity.chain");
check(!(await arcAddr("www.inphinity.eth")), "reserved www.inphinity.eth has no address");
check(((await text("www.inphinity.eth", "description")) ?? "").startsWith("Not an Inphinity fund"), "reserved name shows the default bundle");
check(((await text("random-unindexed.inphinity.eth", "description")) ?? "").startsWith("Not an Inphinity fund"), "unknown subname shows the default bundle");

console.log("record linking: latest + a real fund taking over a symbol link");
const { linkName } = await import("../src/records");
await linkName(ctx.s, resolver, "latest.inphinity.eth", nameB);
check((await arcAddr("latest.inphinity.eth"))?.toLowerCase() === fundB.fund, "latest.inphinity.eth -> fund B");
const nameC = await processFund(ctx, fundC);
check(nameC === "tech.inphinity.eth", `fund C got the label "tech" (${nameC})`);
check((await arcAddr("tech.inphinity.eth"))?.toLowerCase() === fundC.fund, "tech.inphinity.eth now resolves to fund C");
check((await arcAddr(nameA))?.toLowerCase() === fundA.fund, "fund A's records were not touched");
check((await recordIdOf(resolver, nameC)) !== (await recordIdOf(resolver, nameA)), "fund C has its own record bundle");

console.log("creator permissions (impersonated creator)");
await rpc("hardhat_impersonateAccount", [creator]);
await rpc("hardhat_setBalance", [creator, "0x56BC75E2D63100000"]);
void createWalletClient({ account: creator, chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
const st = await c.readContract({ address: userRegistry, abi: registryAbi, functionName: "getState", args: [labelId("tech-giants")] });
check(st.latestOwner.toLowerCase() === creator, "ERC-1155 name token owned by the creator");
const fails = async (msg: string, req: object) => {
  try {
    await c.simulateContract({ ...req, account: creator } as never);
    check(false, `${msg} (call succeeded!)`);
  } catch (e) {
    check(true, `${msg}: ${explain(e).slice(0, 90)}`);
  }
};
const R = { address: resolver, abi: permissionedResolverAbi } as const;
const U = { address: userRegistry, abi: registryAbi } as const;
await fails("creator cannot edit the description", { ...R, functionName: "setText", args: [dnsEncode(nameA), "description", "x"] });
await fails("creator cannot edit the weights", { ...R, functionName: "setText", args: [dnsEncode(nameA), "inphinity.weights", "AAPL:10000"] });
await fails("creator cannot change the fund address", { ...R, functionName: "setAddress", args: [dnsEncode(nameA), ARC_COIN_TYPE, "0x000000000000000000000000000000000000dEaD"] });
await fails("creator cannot link names", { ...R, functionName: "linkToNode", args: [dnsEncode("evil.inphinity.eth"), namehash(nameA)] });
await fails("creator cannot change the resolver", { ...U, functionName: "setResolver", args: [labelId("tech-giants"), creator] });
await fails("creator cannot attach a subregistry", { ...U, functionName: "setSubregistry", args: [labelId("tech-giants"), creator] });
await fails("creator cannot safeTransferFrom the name", { ...U, functionName: "safeTransferFrom", args: [creator, "0x000000000000000000000000000000000000bEEF", st.tokenId, 1n, "0x"] });
await fails("creator cannot unsafeTransfer the name", { ...U, functionName: "unsafeTransfer", args: ["0x000000000000000000000000000000000000bEEF", st.tokenId, "0x"] });
await fails("creator cannot register names", { ...U, functionName: "register", args: ["squat", creator, "0x0000000000000000000000000000000000000000", resolver, 0n, parentExpiry] });

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
