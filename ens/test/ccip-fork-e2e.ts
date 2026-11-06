// End-to-end test of the Chainlink CCIP naming path on two local forks (Arc Testnet + Sepolia).
//
// Prerequisites (see README "Testing the CCIP path"): Hardhat forks of Sepolia on :8545 and Arc on
// :8546, the team wallet impersonated on both, and `ccip-setup.ts --enable` already run against them.
//
// 1. Arc: create a real fund through IndexFactory.createIndex -> ArcEnsRegistrar sends a CCIP
//    message through the real Arc router/OnRamp (fee paid from the registrar's balance).
// 2. The payload the OnRamp emitted is checked byte-for-byte against what we expect from Arc data.
// 3. Sepolia: that payload is delivered to InphinityEnsReceiver exactly as the CCIP router would
//    (the only simulated hop is the Chainlink DON carrying the bytes across).
// 4. The name resolves through the ENSv2 Universal Resolver; duplicates, wrong senders, label
//    collisions, failures + retry and the "naming never blocks fund creation" rule are checked.
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, getAddress, http, parseEventLogs, toHex, type Abi, type Address, type Hex } from "viem";
import { arcTestnet, sepolia } from "viem/chains";
import { ARC, ARC_COIN_TYPE, CCIP, ENS, TEAM_WALLET } from "../src/config";
import { indexFundAbi, permissionedResolverAbi } from "../src/abis";
import { loadState } from "../src/lib";
import registrarArtifact from "../ccip-artifacts/ArcEnsRegistrar.json";
import receiverArtifact from "../ccip-artifacts/InphinityEnsReceiver.json";

const SEP = "http://127.0.0.1:8545", ARCRPC = "http://127.0.0.1:8546";
const t = (url: string) => http(url, { timeout: 120_000 });
const sep = createPublicClient({ chain: sepolia, transport: t(SEP) });
const arc = createPublicClient({ chain: arcTestnet, transport: t(ARCRPC) });
const wallet = (chain: typeof sepolia | typeof arcTestnet, url: string, account: Address) => createWalletClient({ account, chain, transport: t(url) });
const rpc = (url: string, method: string, params: unknown[]) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

const regAbi = registrarArtifact.abi as Abi;
const recAbi = receiverArtifact.abi as Abi;
const factoryAbi = [
  { type: "function", name: "createIndex", stateMutability: "nonpayable", inputs: [{ name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "label", type: "string" }, { name: "tokens", type: "address[]" }, { name: "weightsBps", type: "uint16[]" }, { name: "feeBps", type: "uint16" }, { name: "description", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "indexAt", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "indexCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "IndexCreated", inputs: [{ name: "fund", type: "address", indexed: true }, { name: "creator", type: "address", indexed: true }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "label", type: "string" }] },
] as const;
const FUND_MESSAGE = [{ type: "tuple", components: [
  { name: "label", type: "string" }, { name: "fund", type: "address" }, { name: "creator", type: "address" }, { name: "name", type: "string" },
  { name: "symbol", type: "string" }, { name: "feeBps", type: "uint16" }, { name: "weights", type: "string" }, { name: "tokens", type: "string" }, { name: "index", type: "uint256" },
] }] as const;

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

const state = loadState();
const registrar = state.arcEnsRegistrar!, receiver = state.ensReceiver!, resolver = state.resolver!;
const ur = { universalResolverAddress: ENS.universalResolver } as const;
const arcTeam = wallet(arcTestnet, ARCRPC, TEAM_WALLET);
const bchip = await arc.readContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "indexAt", args: [0n] });
const stocks = (await arc.readContract({ address: bchip, abi: indexFundAbi, functionName: "getTokens" })).slice(0, 2);

/** Creates a fund on the Arc fork and returns the fund, the NamingRequested event and the OnRamp payload. */
async function createFund(name: string, symbol: string, label: string) {
  const hash = await arcTeam.writeContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "createIndex", args: [name, symbol, label, stocks, [6000, 4000], 75, "creator text that must NOT be published"], gas: 15_000_000n });
  const rc = await arc.waitForTransactionReceipt({ hash });
  const created = parseEventLogs({ abi: factoryAbi, logs: rc.logs, eventName: "IndexCreated" })[0];
  const ours = parseEventLogs({ abi: regAbi, logs: rc.logs.filter((l) => l.address.toLowerCase() === registrar.toLowerCase()) }) as any[];
  return { rc, fund: created?.args.fund as Address, events: ours, gas: rc.gasUsed };
}

async function expectedPayload(fund: Address, label: string): Promise<Hex> {
  const f = { address: fund, abi: indexFundAbi } as const;
  const [name, symbol, fee, tokens, weights, count] = await Promise.all([
    arc.readContract({ ...f, functionName: "name" }), arc.readContract({ ...f, functionName: "symbol" }),
    arc.readContract({ ...f, functionName: "feeBps" }), arc.readContract({ ...f, functionName: "getTokens" }),
    arc.readContract({ ...f, functionName: "getWeights" }), arc.readContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "indexCount" }),
  ]);
  const syms = await Promise.all(tokens.map((tk) => arc.readContract({ address: tk, abi: [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const, functionName: "symbol" })));
  return encodeAbiParameters(FUND_MESSAGE, [{
    label, fund, creator: TEAM_WALLET, name, symbol, feeBps: fee,
    weights: syms.map((s, i) => `${s}:${weights[i]}`).join(","), tokens: tokens.map((tk) => getAddress(tk)).join(","), index: count - 1n,
  }]);
}

/** Delivers a payload to the receiver as the Sepolia CCIP router does. */
async function deliver(messageId: Hex, data: Hex, opts: { sender?: Address; selector?: bigint; from?: Address } = {}) {
  const from = opts.from ?? CCIP.sepoliaRouter;
  await rpc(SEP, "hardhat_impersonateAccount", [from]);
  await rpc(SEP, "hardhat_setBalance", [from, "0x56BC75E2D63100000"]);
  const w = wallet(sepolia, SEP, from);
  const message = { messageId, sourceChainSelector: opts.selector ?? CCIP.arcSelector, sender: encodeAbiParameters([{ type: "address" }], [opts.sender ?? registrar]), data, destTokenAmounts: [] };
  try {
    await sep.simulateContract({ address: receiver, abi: recAbi, functionName: "ccipReceive", args: [message], account: from });
  } catch (e: any) {
    return { reverted: (e.shortMessage ?? String(e)).slice(0, 120) as string };
  }
  const hash = await w.writeContract({ address: receiver, abi: recAbi, functionName: "ccipReceive", args: [message], gas: 2_500_000n } as any);
  const rc = await sep.waitForTransactionReceipt({ hash });
  return { rc, logs: parseEventLogs({ abi: recAbi, logs: rc.logs }) as any[] };
}

const arcAddr = (name: string) => sep.getEnsAddress({ name, coinType: ARC_COIN_TYPE, ...ur }).catch(() => null);
const text = (name: string, key: string) => sep.getEnsText({ name, key, ...ur }).catch(() => null);

// ---------------------------------------------------------------------------
console.log("1. Arc: createIndex sends a CCIP message");
const sym = `CCIPT${Date.now() % 1000}`;
const label = sym.toLowerCase();
const a = await createFund("CCIP Test Fund", sym, sym); // the registrar lowercases the label
const req = a.events.find((e) => e.eventName === "NamingRequested");
check(!!a.fund, `fund created ${a.fund} (gas ${a.gas})`);
check(!!req, `NamingRequested messageId=${req?.args.messageId} fee=${req?.args.fee}`);
check(req?.args.label === label, `label sent: ${req?.args.label}`);
const onRampLogs = a.rc.logs.filter((l) => l.address.toLowerCase() === "0x0409822ac30a1a74fce849e6163a86cf18fe1863");
check(onRampLogs.length > 0, `Arc OnRamp emitted ${onRampLogs.length} log(s)`);
const payload = await expectedPayload(a.fund, label);
check(onRampLogs.some((l) => l.data.toLowerCase().includes(payload.slice(2).toLowerCase())), "OnRamp log carries exactly the expected payload (built independently from Arc reads)");
check(!payload.includes(toHex("creator text that must NOT be published").slice(2)), "creator description is not in the payload");

console.log("2. Sepolia: deliver it as the CCIP router");
const messageId = req!.args.messageId as Hex;
const d = await deliver(messageId, payload);
const named = d.logs?.find((l) => l.eventName === "FundNamed");
check(!!named, `FundNamed ${named?.args.name} (gas ${d.rc?.gasUsed}, limit 9,000,000; fork gas is far below live Sepolia gas)`);
const name = `${label}.inphinity.eth`;
check((await arcAddr(name))?.toLowerCase() === a.fund.toLowerCase(), `${name} -> fund via Universal Resolver`);
check((await text(name, "inphinity.ccip")) === messageId, "inphinity.ccip = CCIP message id");
check(!!(await text(name, "inphinity.weights"))?.endsWith(":4000"), `weights ${await text(name, "inphinity.weights")}`);
check((await text(name, "inphinity.fee")) === "75", "fee 75");
check((await text(name, "description")) !== "creator text that must NOT be published", `description is generated: ${await text(name, "description")}`);
check((await arcAddr("latest.inphinity.eth"))?.toLowerCase() === a.fund.toLowerCase(), "latest.inphinity.eth -> new fund");
check(!(await sep.getEnsAddress({ name, coinType: 60n, ...ur }).catch(() => null)), "no coin type 60 address");
check((await arcAddr("bchip.inphinity.eth"))?.toLowerCase() === bchip.toLowerCase(), "bchip.inphinity.eth untouched");

console.log("3. duplicates, impostors, collisions");
const again = await deliver(messageId, payload);
check(!!again.rc && !again.logs?.some((l) => l.eventName === "FundNamed"), "same messageId delivered twice: ignored");
check(!!(await deliver(toHex(1n, { size: 32 }), payload, { sender: TEAM_WALLET })).reverted, "message from another Arc sender: rejected");
check(!!(await deliver(toHex(2n, { size: 32 }), payload, { selector: CCIP.sepoliaSelector })).reverted, "message from another chain: rejected");
check(!!(await deliver(toHex(3n, { size: 32 }), payload, { from: TEAM_WALLET })).reverted, "call not from the router: rejected");
const b = await createFund("CCIP Test Fund Two", `${sym}B`, sym); // same label requested
const reqB = b.events.find((e) => e.eventName === "NamingRequested");
const dB = await deliver(reqB.args.messageId, await expectedPayload(b.fund, label));
check(dB.logs?.find((l) => l.eventName === "FundNamed")?.args.name === `${label}-2.inphinity.eth`, `collision deduped: ${dB.logs?.find((l) => l.eventName === "FundNamed")?.args.name}`);

console.log("4. failure is stored and retryable");
const team = wallet(sepolia, SEP, TEAM_WALLET);
const resolverAbi = [{ type: "function", name: "revokeRootRoles", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] }, ...permissionedResolverAbi] as const;
const ROLES = (1n << 0n) | (1n << 4n) | (1n << 28n);
await sep.waitForTransactionReceipt({ hash: await team.writeContract({ address: resolver, abi: resolverAbi, functionName: "revokeRootRoles", args: [ROLES, receiver] }) });
const c = await createFund("CCIP Test Fund Three", `${sym}C`, `${sym}c`);
const reqC = c.events.find((e) => e.eventName === "NamingRequested");
const dC = await deliver(reqC.args.messageId, await expectedPayload(c.fund, `${label}c`));
check(!!dC.logs?.find((l) => l.eventName === "NamingFailed"), "naming failed without reverting the CCIP delivery (NamingFailed stored)");
await sep.waitForTransactionReceipt({ hash: await team.writeContract({ address: resolver, abi: resolverAbi, functionName: "grantRootRoles", args: [ROLES, receiver] }) });
const rh = await team.writeContract({ address: receiver, abi: recAbi, functionName: "retry", args: [reqC.args.messageId] } as any);
const rr = await sep.waitForTransactionReceipt({ hash: rh });
check(rr.status === "success" && (await arcAddr(`${label}c.inphinity.eth`))?.toLowerCase() === c.fund.toLowerCase(), "retry() named it after the role was restored");

console.log("5. naming never blocks fund creation");
const regW = { address: registrar, abi: regAbi } as const;
const bal = await arc.getBalance({ address: registrar });
await arc.waitForTransactionReceipt({ hash: await arcTeam.writeContract({ ...regW, functionName: "withdraw", args: [TEAM_WALLET, bal] } as any) });
const e = await createFund("CCIP Test Fund Empty", `${sym}E`, `${sym}e`);
check(e.rc.status === "success" && !!e.fund, "createIndex succeeds with an empty fee balance");
check(e.events.some((x) => x.eventName === "NamingSkipped" && x.args.reason === "fee balance too low"), "NamingSkipped(fee balance too low) emitted");
await arc.waitForTransactionReceipt({ hash: await arcTeam.sendTransaction({ to: registrar, value: bal } as any) });

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
void decodeEventLog;
