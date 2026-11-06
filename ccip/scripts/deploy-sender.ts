// Arc Testnet: deploy FundNameSender (once) and keep it configured.
//   - deploys if deployments.json has no sender with code,
//   - points it at the Sepolia receiver once deploy-receiver.ts has recorded one,
//   - syncs the destination gas limit (CCIP_GAS_LIMIT, default 2,000,000).
// Run it before deploy-receiver.ts (the receiver needs the sender address) and once more after it.
//
// Usage: PRIVATE_KEY=0x... bun run scripts/deploy-sender.ts [--dry-run]
import type { Address } from "viem";
import { ARC, CCIP, DEFAULT_GAS_LIMIT, DRY_RUN, arc, artifact, deploy, hasCode, loadState, saveState, send, signerFor } from "./config";

const s = signerFor("arc");
const state = loadState();
const { abi } = artifact("FundNameSender");
console.log(`FundNameSender on Arc Testnet, owner ${s.from}${DRY_RUN ? " (dry-run)" : ""}`);

let sender = state.arc?.sender;
if (await hasCode(arc, sender)) {
  console.log(`  sender already deployed at ${sender}`);
} else {
  const r = await deploy(s, "FundNameSender", [s.from, CCIP.arc.router, ARC.indexFactory, CCIP.sepolia.chainSelector, DEFAULT_GAS_LIMIT]);
  sender = r.address;
  if (sender) {
    state.arc = { sender, senderTx: r.hash };
    saveState(state);
  }
}

if (sender) {
  const read = (functionName: string) => arc.readContract({ address: sender!, abi, functionName }) as Promise<any>;
  const [receiver, gasLimit, owner] = await Promise.all([read("receiver"), read("gasLimit"), read("owner")]);
  if (owner.toLowerCase() !== s.from.toLowerCase()) console.log(`  note: owner is ${owner}, not ${s.from}; setters below will revert`);

  const want = state.sepolia?.receiver;
  if (!want) console.log("  receiver: not deployed yet (run deploy-receiver.ts, then this script again)");
  else if (state.sepolia?.receiverSender && state.sepolia.receiverSender.toLowerCase() !== sender.toLowerCase())
    console.log(`  receiver ${want} trusts sender ${state.sepolia.receiverSender}, not ${sender}: redeploy the receiver`);
  else if ((receiver as Address).toLowerCase() === want.toLowerCase()) console.log(`  receiver: ${want} (ok)`);
  else await send(s, `setReceiver(${want})`, { address: sender, abi, functionName: "setReceiver", args: [want] });

  if (Number(gasLimit) === DEFAULT_GAS_LIMIT) console.log(`  gasLimit: ${gasLimit} (ok)`);
  else await send(s, `setGasLimit(${DEFAULT_GAS_LIMIT})`, { address: sender, abi, functionName: "setGasLimit", args: [DEFAULT_GAS_LIMIT] });
}
console.log(`Done. Sender: ${sender ?? "(dry-run)"}`);
