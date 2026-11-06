// Arc Testnet: announce funds to Sepolia over CCIP (FundNameSender.announce / announceWithLabel).
// Pays the CCIP fee in native USDC: sends getFee() + 10% and the contract refunds the excess.
// Before paying, previews on Sepolia what the receiver would do and skips funds that already have
// a name pointing at them (e.g. named by the off-chain relayer), unless --force.
//
// Usage: PRIVATE_KEY=0x... bun run scripts/announce.ts --fund 0x... [--label bchip] [--force] [--dry-run]
//        PRIVATE_KEY=0x... bun run scripts/announce.ts --index 3
//        PRIVATE_KEY=0x... bun run scripts/announce.ts --all          (every factory fund not yet announced)
// --label only works when the signer is the fund's creator (announceWithLabel).
import { decodeEventLog, formatEther, parseAbi, zeroHash, type Address, type Hex } from "viem";
import { ARC, CCIP, DRY_RUN, arc, arg, artifact, explain, loadState, send, sep, signerFor } from "./config";

const factoryAbi = parseAbi(["function indexCount() view returns (uint256)", "function indexAt(uint256) view returns (address)"]);
const { abi: senderAbi } = artifact("FundNameSender");
const { abi: receiverAbi } = artifact("FundNameReceiver");

const state = loadState();
const sender = state.arc?.sender;
const receiver = state.sepolia?.receiver;
if (!sender) throw new Error("No sender in deployments.json: run deploy-sender.ts first.");
const s = signerFor("arc");
const label = arg("label") ?? "";
const force = process.argv.includes("--force");

let funds: Address[] = [];
if (arg("fund")) funds = [arg("fund") as Address];
else if (arg("index") !== undefined) funds = [await arc.readContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "indexAt", args: [BigInt(arg("index")!)] })];
else if (process.argv.includes("--all")) {
  const n = await arc.readContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "indexCount" });
  for (let i = 0n; i < n; i++) funds.push(await arc.readContract({ address: ARC.indexFactory, abi: factoryAbi, functionName: "indexAt", args: [i] }));
} else throw new Error("Pass --fund 0x..., --index N or --all.");

const bal = await arc.getBalance({ address: s.from });
console.log(`Announcing ${funds.length} fund(s) via ${sender} as ${s.from} (balance ${formatEther(bal)} USDC)${DRY_RUN ? " (dry-run)" : ""}`);

for (const fund of funds) {
  const done = (await arc.readContract({ address: sender, abi: senderAbi, functionName: "announced", args: [fund] })) as Hex;
  if (done !== zeroHash) {
    console.log(`  ${fund}: already announced, message ${done}\n    ${CCIP.explorer}${done}`);
    continue;
  }
  let payload: any;
  try {
    payload = await arc.readContract({ address: sender, abi: senderAbi, functionName: "buildPayload", args: [fund, label] });
  } catch (e) {
    console.log(`  ${fund}: cannot announce: ${explain(e)}`);
    continue;
  }
  if (receiver) {
    const [l, , complete] = (await sep.readContract({ address: receiver, abi: receiverAbi, functionName: "previewLabel", args: [payload.label, fund, payload.creator] })) as [string, boolean, boolean];
    if (!l) console.log(`  ${fund}: warning: receiver finds no free label for "${payload.label}"`);
    else if (complete && !force) {
      console.log(`  ${fund}: ${l}.inphinity.eth already resolves to it (relayer); skipping (use --force to send anyway)`);
      continue;
    } else console.log(`  ${fund} (${payload.label}): will become ${l}.inphinity.eth`);
  }
  const fee = (await arc.readContract({
    address: sender,
    abi: senderAbi,
    functionName: label ? "getFeeWithLabel" : "getFee",
    args: label ? [fund, label] : [fund],
  })) as bigint;
  const value = (fee * 110n) / 100n;
  console.log(`    CCIP fee ${formatEther(fee)} USDC (sending ${formatEther(value)}, excess refunded)`);
  const { receipt } = await send(s, `announce ${payload.label}`, {
    address: sender,
    abi: senderAbi,
    functionName: label ? "announceWithLabel" : "announce",
    args: label ? [fund, label] : [fund],
    value,
  });
  if (!receipt) continue;
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: senderAbi, data: log.data, topics: log.topics }) as any;
      if (ev.eventName === "FundAnnounced") {
        console.log(`    messageId ${ev.args.messageId} (label ${ev.args.label})`);
        console.log(`    track: ${CCIP.explorer}${ev.args.messageId}`);
        console.log(`    then:  bun run status -- --message ${ev.args.messageId} --wait`);
      }
    } catch {}
  }
}
