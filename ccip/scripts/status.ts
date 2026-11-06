// Read-only: where is a CCIP fund announcement, and did the ENS name appear?
//   - asks the CCIP API (api.ccip.chain.link/v2/messages/{id}) for the message status,
//   - reads FundNameReceiver.nameOf(fund) and the name's Arc address record on Sepolia.
//
// Usage: bun run scripts/status.ts                       (every announced factory fund)
//        bun run scripts/status.ts --fund 0x... [--wait]
//        bun run scripts/status.ts --message 0x... [--wait]   (--wait polls every 15 s until final)
import { namehash, parseAbi, zeroHash, type Address, type Hex } from "viem";
import { ARC, CCIP, ENS, arc, arg, artifact, loadState, sep } from "./config";

const { abi: senderAbi } = artifact("FundNameSender");
const { abi: receiverAbi } = artifact("FundNameReceiver");
const factoryAbi = parseAbi(["function indexCount() view returns (uint256)", "function indexAt(uint256) view returns (address)"]);
const resolverAbi = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const ARC_COIN_TYPE = 0x80000000n | 5042002n;

const state = loadState();
const sender = state.arc?.sender;
const receiver = state.sepolia?.receiver;
const wait = process.argv.includes("--wait");

type ApiMsg = { status?: string; readyForManualExecution?: boolean; receiptTransactionHash?: string; sendTransactionHash?: string; sender?: string; receiver?: string };
async function apiStatus(id: Hex): Promise<ApiMsg | null> {
  const r = await fetch(`${CCIP.api}/messages/${id}`).catch(() => null);
  if (!r) return { status: "API unreachable" };
  if (r.status === 404) return null;
  return (await r.json()) as ApiMsg;
}

function dnsEncode(name: string): Hex {
  const bytes: number[] = [];
  for (const l of name.split(".")) {
    const b = new TextEncoder().encode(l);
    bytes.push(b.length, ...b);
  }
  bytes.push(0);
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

async function ensView(fund?: Address) {
  if (!fund || !receiver) return "receiver not deployed";
  const name = (await sep.readContract({ address: receiver, abi: receiverAbi, functionName: "nameOf", args: [fund] })) as string;
  if (!name) return "no name from CCIP yet";
  const { encodeFunctionData, decodeAbiParameters } = await import("viem");
  const data = encodeFunctionData({ abi: parseAbi(["function addr(bytes32,uint256) view returns (bytes)"]), functionName: "addr", args: [namehash(name), ARC_COIN_TYPE] });
  const out = await sep.readContract({ address: ENS.resolver, abi: resolverAbi, functionName: "resolve", args: [dnsEncode(name), data] });
  const [addr] = decodeAbiParameters([{ type: "bytes" }], out);
  const ok = addr.toLowerCase() === fund.toLowerCase();
  return `${name} -> ${addr} ${ok ? "(matches fund)" : "(MISMATCH)"}  https://sepolia.app.ens.domains/${name}`;
}

async function show(id: Hex, fund?: Address) {
  for (;;) {
    const m = await apiStatus(id);
    const st = m?.status ?? "NOT_INDEXED_YET";
    console.log(`  message ${id}`);
    console.log(`    CCIP: ${st}${m?.readyForManualExecution ? " (ready for manual execution: open the explorer link and execute)" : ""}`);
    if (m?.receiptTransactionHash) console.log(`    Sepolia tx: https://sepolia.etherscan.io/tx/${m.receiptTransactionHash}`);
    console.log(`    explorer: ${CCIP.explorer}${id}`);
    if (fund) console.log(`    ENS: ${await ensView(fund)}`);
    if (!wait || st === "SUCCESS" || st === "FAILED") return st;
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

const msg = arg("message") as Hex | undefined;
if (msg) {
  await show(msg);
} else {
  if (!sender) throw new Error("No sender in deployments.json.");
  let funds: Address[] = [];
  if (arg("fund")) funds = [arg("fund") as Address];
  else {
    const n = await arc.readContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "indexCount" });
    for (let i = 0n; i < n; i++) funds.push(await arc.readContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "indexAt", args: [i] }));
  }
  for (const fund of funds) {
    const id = (await arc.readContract({ address: sender, abi: senderAbi, functionName: "announced", args: [fund] })) as Hex;
    console.log(`${fund}:`);
    if (id === zeroHash) console.log(`  not announced (ENS: ${await ensView(fund)})`);
    else await show(id, fund);
  }
}
