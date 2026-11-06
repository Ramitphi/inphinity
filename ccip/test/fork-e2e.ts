// End-to-end test on two local forks: Arc Testnet (port 8546) and Ethereum Sepolia (port 8545).
// It runs the real deploy/grant scripts (impersonating the team wallet, no key needed), then:
//   Arc:     creates a new fund on the live IndexFactory, announces it through the live CCIP Router
//            (real fee quote, real ccipSend, refund), and checks every sender guard;
//   Sepolia: delivers the exact message bytes the sender built by impersonating the live Sepolia
//            Router, with the same gas limit the sender requests, and checks the result through the
//            ENSv2 Universal Resolver; checks every receiver guard; proves records are identical to
//            the relayer's by re-naming BCHIP under a test label and diffing against bchip.inphinity.eth;
//            runs the worst-case fund (10 tokens, max-length strings).
// Gas numbers here are Hardhat's (prague pricing). Live Sepolia prices state ~3x higher: use
// test/live-gas.ts for the numbers that size the CCIP gas limit.
// The CCIP network itself (DON commit + execution) is the only part not exercised here.
//
// Usage: see README "Testing on forks".
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  namehash,
  parseAbi,
  parseEther,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet, sepolia } from "viem/chains";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARC_URL = process.env.ARC_FORK_URL ?? "http://127.0.0.1:8546";
const SEP_URL = process.env.SEPOLIA_FORK_URL ?? "http://127.0.0.1:8545";
const STATE = join(root, "scratch", "fork-state.json");

const TEAM: Address = "0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93";
const FACTORY: Address = "0x9fa4034efb237a7c154adea20b1ccfa0cd538b11";
const BCHIP: Address = "0x9272a103f49399d1b7FD538f7a5103E11080895A";
const SEP_ROUTER: Address = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const ARC_SELECTOR = 3034092155422581607n;
const UR: Address = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";
const RESOLVER: Address = "0x26E1611FD97133dfaef7b562D88528e8C1649ae2";
const USER_REGISTRY: Address = "0xefC414eb999907620AbdA991decD2BD22aBb9Ac1";
const ARC_COIN_TYPE = 2152525650n;
const ALICE: Address = "0x00000000000000000000000000000000000a11ce"; // random non-creator
const TEXT_KEYS = ["name", "description", "url", "inphinity.symbol", "inphinity.weights", "inphinity.tokens", "inphinity.fee", "inphinity.creator", "inphinity.chain", "inphinity.index", "inphinity.disclaimer"];

const arc = createPublicClient({ chain: arcTestnet, transport: http(ARC_URL, { timeout: 120_000 }) });
const sep = createPublicClient({ chain: sepolia, transport: http(SEP_URL, { timeout: 120_000 }) });
const wallet = (chain: typeof arcTestnet | typeof sepolia, url: string, account: Address) => createWalletClient({ chain, transport: http(url, { timeout: 120_000 }), account });

const art = (n: string) => JSON.parse(readFileSync(join(root, "out", `${n}.json`), "utf8")) as { abi: Abi };
const senderAbi = art("FundNameSender").abi;
const receiverAbi = art("FundNameReceiver").abi;
const factoryAbi = parseAbi([
  "function createIndex(string name, string symbol, string label, address[] tokens, uint16[] weightsBps, uint16 feeBps, string description) returns (address)",
  "function indexCount() view returns (uint256)",
  "event IndexCreated(address indexed fund, address indexed creator, string name, string symbol, string label)",
]);
const fundAbi = parseAbi(["function getTokens() view returns (address[])", "function creator() view returns (address)"]);
const eacAbi = parseAbi(["function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)"]);
const registryAbi = parseAbi([
  "struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }",
  "function getState(uint256 anyId) view returns (State)",
  "function roles(uint256 anyId, address account) view returns (uint256)",
]);
const resolverAbi = parseAbi(["function getRecordId(bytes32 node) view returns (uint256)"]);

/** Copy of ens/src/lib.ts sanitizeLabel (the relayer's label rules). */
function sanitizeLabel(input: string): string | null {
  let s = input.normalize("NFKD").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 32) s = s.slice(0, 32).replace(/-+$/g, "");
  if (s.length < 3) return null;
  if (s.slice(2, 4) === "--") return null;
  if (["latest", "www", "app", "admin", "official", "support"].includes(s)) return null;
  return /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(s) ? s : null;
}

let failures = 0;
function check(cond: unknown, what: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${what}`);
  if (!cond) failures++;
}
async function expectRevert(p: Promise<unknown>, errorName: string, what: string) {
  try {
    await p;
    check(false, `${what} (did not revert)`);
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? "") + String(e?.message ?? "");
    check(msg.includes(errorName), `${what} -> ${errorName}${msg.includes(errorName) ? "" : ` (got: ${msg.slice(0, 160)})`}`);
  }
}
const rpc = (c: any, method: string, params: unknown[]) => c.request({ method, params });

function run(script: string, env: Record<string, string>) {
  const out = execFileSync("bun", ["run", join(root, "scripts", script)], {
    cwd: root,
    env: { ...process.env, CCIP_STATE_FILE: STATE, FORK_IMPERSONATE: TEAM, ARC_RPC_URL: ARC_URL, SEPOLIA_RPC_URL: SEP_URL, ...env },
    encoding: "utf8",
  });
  process.stdout.write(out.replace(/^/gm, "    | "));
}

const dns = (name: string): Hex => {
  const b: number[] = [];
  for (const l of name.split(".")) {
    const e = new TextEncoder().encode(l);
    b.push(e.length, ...e);
  }
  b.push(0);
  return toHex(Uint8Array.from(b));
};

async function deliver(receiver: Address, sender: Address, data: Hex, opts: { gas: bigint; selector?: bigint; from?: Address; fakeSender?: Address }) {
  const messageId = keccak256(toHex(`msg-${Math.random()}`));
  const w = wallet(sepolia, SEP_URL, opts.from ?? SEP_ROUTER);
  const hash = await w.writeContract({
    address: receiver,
    abi: receiverAbi,
    functionName: "ccipReceive",
    args: [{ messageId, sourceChainSelector: opts.selector ?? ARC_SELECTOR, sender: encodeAbiParameters([{ type: "address" }], [opts.fakeSender ?? sender]), data, destTokenAmounts: [] }],
    gas: opts.gas,
  });
  const rc = await sep.waitForTransactionReceipt({ hash });
  const events = rc.logs.flatMap((l) => {
    try {
      return [decodeEventLog({ abi: receiverAbi, data: l.data, topics: l.topics }) as any];
    } catch {
      return [];
    }
  });
  return { rc, messageId, events };
}

const RUN = Math.random().toString(36).slice(2, 7); // unique labels, so the test also passes on a reused fork

async function main() {
  rmSync(STATE, { force: true });
  for (const [c, who] of [[arc, TEAM], [sep, TEAM], [sep, SEP_ROUTER], [arc, ALICE]] as const) {
    await rpc(c, "hardhat_impersonateAccount", [who]);
    await rpc(c, "hardhat_setBalance", [who, toHex(parseEther("1000"))]);
  }

  console.log("\n# 1. Deploy with the real scripts (impersonating the team wallet)");
  run("deploy-sender.ts", {});
  run("deploy-receiver.ts", {});
  run("grant-roles.ts", {});
  run("deploy-sender.ts", {}); // second run: setReceiver
  run("deploy-sender.ts", {}); // third run: nothing to do
  run("grant-roles.ts", {}); // idempotent
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const sender: Address = st.arc.sender;
  const receiver: Address = st.sepolia.receiver;
  check(String(await arc.readContract({ address: sender, abi: senderAbi, functionName: "receiver" })).toLowerCase() === receiver.toLowerCase(), "sender points at receiver");
  check(String(await sep.readContract({ address: receiver, abi: receiverAbi, functionName: "sender" })).toLowerCase() === sender.toLowerCase(), "receiver trusts sender");
  check(await sep.readContract({ address: USER_REGISTRY, abi: eacAbi, functionName: "hasRootRoles", args: [1n, receiver] }), "receiver has UserRegistry REGISTRAR");
  check(await sep.readContract({ address: RESOLVER, abi: eacAbi, functionName: "hasRootRoles", args: [1n | (1n << 4n) | (1n << 28n), receiver] }), "receiver has resolver SET_ADDRESS|SET_TEXT|LINK");
  check(!(await sep.readContract({ address: USER_REGISTRY, abi: eacAbi, functionName: "hasRootRoles", args: [1n << 128n, receiver] })), "receiver has no REGISTRAR admin role");
  const gasLimit = BigInt((await arc.readContract({ address: sender, abi: senderAbi, functionName: "gasLimit" })) as number);

  console.log("\n# 2. Arc: create a fresh fund on the live IndexFactory, then announce it over the live Router");
  const tokens = (await arc.readContract({ address: BCHIP, abi: fundAbi, functionName: "getTokens" })) as Address[];
  const teamArc = wallet(arcTestnet, ARC_URL, TEAM);
  const sym = `CC${Date.now() % 10000}`;
  const create = await teamArc.writeContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "createIndex",
    args: [`CCIP Test ${sym}`, sym, `ccip-${sym}`, tokens.slice(0, 3), [5000, 3000, 2000], 50, "fork test"],
  });
  const crc = await arc.waitForTransactionReceipt({ hash: create });
  const created = crc.logs.map((l) => { try { return decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics }) as any; } catch { return null; } }).find((e) => e?.eventName === "IndexCreated");
  const fund: Address = created.args.fund;
  console.log(`  created ${sym} at ${fund}`);

  const fee = (await arc.readContract({ address: sender, abi: senderAbi, functionName: "getFeeWithLabel", args: [fund, created.args.label] })) as bigint;
  console.log(`  CCIP fee quote: ${formatEther(fee)} USDC (gasLimit ${gasLimit})`);
  check(fee > 0n && fee < parseEther("5"), "fee quote is sane (0 < fee < 5 USDC)");

  const alice = wallet(arcTestnet, ARC_URL, ALICE);
  await expectRevert(alice.writeContract({ address: sender, abi: senderAbi, functionName: "announceWithLabel", args: [fund, "phish"], value: fee * 2n }), "OnlyCreatorMaySetLabel", "non-creator cannot choose a label");
  await expectRevert(alice.writeContract({ address: sender, abi: senderAbi, functionName: "announce", args: [ALICE], value: fee * 2n }), "NotAnIndexFund", "non-factory address is rejected");
  await expectRevert(teamArc.writeContract({ address: sender, abi: senderAbi, functionName: "announce", args: [fund], value: fee - 1n }), "InsufficientFee", "underpaying is rejected");
  await expectRevert(alice.writeContract({ address: sender, abi: senderAbi, functionName: "setReceiver", args: [ALICE] }), "OwnableUnauthorizedAccount", "only owner can set the receiver");

  const payload = await arc.readContract({ address: sender, abi: senderAbi, functionName: "buildPayload", args: [fund, created.args.label] });
  const data = encodeAbiParameters((senderAbi.find((x: any) => x.name === "buildPayload") as any).outputs, [payload]);
  const before = await arc.getBalance({ address: TEAM });
  const ann = await teamArc.writeContract({ address: sender, abi: senderAbi, functionName: "announceWithLabel", args: [fund, created.args.label], value: fee * 3n });
  const arc_rc = await arc.waitForTransactionReceipt({ hash: ann });
  const after = await arc.getBalance({ address: TEAM });
  const spent = before - after - arc_rc.gasUsed * arc_rc.effectiveGasPrice;
  check(arc_rc.status === "success", `announceWithLabel succeeded (Arc gas ${arc_rc.gasUsed})`);
  check(spent === fee, `paid exactly the fee, excess refunded (spent ${formatEther(spent)})`);
  const annEv = arc_rc.logs.map((l) => { try { return decodeEventLog({ abi: senderAbi, data: l.data, topics: l.topics }) as any; } catch { return null; } }).find((e) => e?.eventName === "FundAnnounced");
  check(annEv && annEv.args.fund === fund && annEv.args.messageId !== `0x${"0".repeat(64)}`, `FundAnnounced(messageId ${annEv?.args.messageId})`);
  // The live OnRamp emits the CCIP message; check our payload bytes are inside it.
  const onrampLog = arc_rc.logs.find((l) => l.address.toLowerCase() === "0x0409822ac30a1a74fce849e6163a86cf18fe1863");
  check(onrampLog && onrampLog.data.includes(data.slice(2, 400)), "live OnRamp emitted a message carrying our payload");
  await expectRevert(teamArc.writeContract({ address: sender, abi: senderAbi, functionName: "announce", args: [fund], value: fee * 2n }), "AlreadyAnnounced", "second announce is rejected");

  const pub = await alice.writeContract({ address: sender, abi: senderAbi, functionName: "announce", args: [BCHIP], value: fee * 2n });
  check((await arc.waitForTransactionReceipt({ hash: pub })).status === "success", "anyone can announce a factory fund (permissionless, symbol label)");

  // Label rules: same output as ens/src/lib.ts sanitizeLabel (copied below) for tricky inputs.
  for (const hint of ["BlueChip", "  My--Fund!! ", "ab", "LATEST", "x".repeat(40), "a-b-c-", "Tech & AI 2026", "--x--y--", "_A_B_C_", "admin", "a.b.c"]) {
    const p: any = await arc.readContract({ address: sender, abi: senderAbi, functionName: "buildPayload", args: [BCHIP, hint] });
    const want = sanitizeLabel(hint) ?? "bchip";
    check(p.label === want, `label(${JSON.stringify(hint)}) = ${p.label}${p.label === want ? "" : ` (relayer: ${want})`}`);
  }

  console.log("\n# 3. Sepolia: deliver the same bytes as the live Router, with the sender's gas limit");
  await expectRevert(deliver(receiver, sender, data, { gas: gasLimit, from: TEAM }), "InvalidRouter", "only the CCIP Router can call ccipReceive");
  await expectRevert(deliver(receiver, sender, data, { gas: gasLimit, selector: 16015286601757825753n }), "WrongSourceChain", "wrong source chain is rejected");
  await expectRevert(deliver(receiver, sender, data, { gas: gasLimit, fakeSender: ALICE }), "WrongSender", "wrong source sender is rejected");

  const d = await deliver(receiver, sender, data, { gas: gasLimit });
  const named = d.events.find((e) => e.eventName === "FundNamed");
  check(d.rc.status === "success" && named, `FundNamed(${named?.args.label}) gas ${d.rc.gasUsed} of limit ${gasLimit}`);
  const name = `${named.args.label}.inphinity.eth`;
  const addr = await sep.getEnsAddress({ name, coinType: ARC_COIN_TYPE, universalResolverAddress: UR });
  check(addr?.toLowerCase() === fund.toLowerCase(), `Universal Resolver: ${name} -> ${addr} (Arc coin type)`);
  const eth = await sep.getEnsAddress({ name, universalResolverAddress: UR }).catch(() => null);
  check(!eth, "no coin type 60 address");
  const weights = await sep.getEnsText({ name, key: "inphinity.weights", universalResolverAddress: UR });
  check(!!weights && weights.split(",").length === 3, `inphinity.weights = ${weights}`);
  const latest = await sep.getEnsAddress({ name: "latest.inphinity.eth", coinType: ARC_COIN_TYPE, universalResolverAddress: UR });
  check(latest?.toLowerCase() === fund.toLowerCase(), "latest.inphinity.eth -> new fund");
  const symName = `${sym.toLowerCase()}.inphinity.eth`;
  const symAddr = await sep.getEnsAddress({ name: symName, coinType: ARC_COIN_TYPE, universalResolverAddress: UR });
  check(symAddr?.toLowerCase() === fund.toLowerCase(), `${symName} (symbol link) -> new fund`);
  const tokenState = await sep.readContract({ address: USER_REGISTRY, abi: registryAbi, functionName: "getState", args: [BigInt(keccak256(toHex(named.args.label)))] });
  check(tokenState.status === 2 && tokenState.latestOwner === TEAM, "name token owned by the fund creator");
  const creatorRoles = await sep.readContract({ address: USER_REGISTRY, abi: registryAbi, functionName: "roles", args: [tokenState.resource, TEAM] });
  check(creatorRoles === 1n << 16n, `creator token roles = ROLE_RENEW only (0x${creatorRoles.toString(16)})`);
  check((await sep.readContract({ address: receiver, abi: receiverAbi, functionName: "nameOf", args: [fund] })) === name, "nameOf(fund) recorded");

  const again = await deliver(receiver, sender, data, { gas: gasLimit });
  check(again.events.some((e) => e.eventName === "FundSkipped" && e.args.reason === "already named"), `redelivery is a no-op (gas ${again.rc.gasUsed})`);

  console.log("\n# 4. Records identical to the relayer's: BCHIP under a test label vs live bchip.inphinity.eth");
  const bchipPayload: any = await arc.readContract({ address: sender, abi: senderAbi, functionName: "buildPayload", args: [BCHIP, ""] });
  check(bchipPayload.label === "bchip", `sender derives label "bchip" from the symbol`);
  const [pl, , complete] = (await sep.readContract({ address: receiver, abi: receiverAbi, functionName: "previewLabel", args: [bchipPayload.label, BCHIP, bchipPayload.creator] })) as [string, boolean, boolean];
  check(pl === "bchip" && complete, "receiver sees bchip.inphinity.eth already resolves to BCHIP (relayer) -> would skip writes");
  const testPayload = { ...bchipPayload, label: `bchip-diff-${RUN}`, symbolLabel: "" };
  const bdata = encodeAbiParameters((senderAbi.find((x: any) => x.name === "buildPayload") as any).outputs, [testPayload]);
  const bd = await deliver(receiver, sender, bdata, { gas: gasLimit });
  check(bd.events.some((e) => e.eventName === "FundNamed"), `named bchip-diff-${RUN}.inphinity.eth (gas ${bd.rc.gasUsed})`);
  for (const key of TEXT_KEYS) {
    const [a, b] = await Promise.all([
      sep.getEnsText({ name: "bchip.inphinity.eth", key, universalResolverAddress: UR }),
      sep.getEnsText({ name: `bchip-diff-${RUN}.inphinity.eth`, key, universalResolverAddress: UR }),
    ]);
    check(a === b && !!a, `text ${key} identical${a === b ? "" : `: relayer=${a} ccip=${b}`}`);
  }
  const [ra, rb] = await Promise.all([
    sep.getEnsAddress({ name: "bchip.inphinity.eth", coinType: ARC_COIN_TYPE, universalResolverAddress: UR }),
    sep.getEnsAddress({ name: `bchip-diff-${RUN}.inphinity.eth`, coinType: ARC_COIN_TYPE, universalResolverAddress: UR }),
  ]);
  check(ra === rb, "Arc address record identical");

  console.log("\n# 5. Label collision: a different fund asking for a taken label gets -2");
  const clash = { ...bchipPayload, symbolLabel: "", fund: `0x${RUN.split("").map((c) => c.charCodeAt(0).toString(16)).join("").padStart(40, "c")}` as Address, label: named.args.label };
  const cd = await deliver(receiver, sender, encodeAbiParameters((senderAbi.find((x: any) => x.name === "buildPayload") as any).outputs, [clash]), { gas: gasLimit });
  const cn = cd.events.find((e) => e.eventName === "FundNamed");
  check(cn?.args.label === `${named.args.label}-2`, `collision -> ${cn?.args.label}`);

  console.log("\n# 6. Worst case: 10 tokens, 128-char name, 32-char symbol, long token symbols");
  const bigTokens = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "a")}` as Address);
  const bigSyms = Array.from({ length: 10 }, (_, i) => `TOKEN${i}`.padEnd(12, "X"));
  const bigName = "N".repeat(128);
  const bigSym = `S${RUN}`.padEnd(32, "S").toUpperCase();
  const big = {
    label: `w${RUN}`.padEnd(32, "w"),
    symbolLabel: bigSym.toLowerCase(),
    fund: `0x${RUN.split("").map((c) => c.charCodeAt(0).toString(16)).join("").padStart(40, "b")}` as Address,
    creator: TEAM,
    index: 999,
    texts: [
      ["name", bigName],
      ["description", `${bigName} (${bigSym}): an Inphinity index fund on Arc Testnet holding ${bigSyms.join(", ")}.`],
      ["url", `https://explorer.testnet.arc.io/address/0x${"b".repeat(40)}`],
      ["inphinity.symbol", bigSym],
      ["inphinity.weights", bigSyms.map((x) => `${x}:1000`).join(",")],
      ["inphinity.tokens", bigTokens.join(",")],
      ["inphinity.fee", "200"],
      ["inphinity.creator", TEAM],
      ["inphinity.chain", "arc-testnet:5042002"],
      ["inphinity.index", "999"],
      ["inphinity.disclaimer", "Testnet mock tokens, not real securities."],
    ].map(([key, value]) => ({ key, value })),
  };
  const wd = await deliver(receiver, sender, encodeAbiParameters((senderAbi.find((x: any) => x.name === "buildPayload") as any).outputs, [big]), { gas: gasLimit });
  check(wd.rc.status === "success" && wd.events.some((e) => e.eventName === "FundNamed"), `worst case named (hardhat gas ${wd.rc.gasUsed}; live Sepolia: see test/live-gas.ts)`);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
