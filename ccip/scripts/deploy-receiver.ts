// Ethereum Sepolia: deploy FundNameReceiver (once), bound to the Arc sender in deployments.json.
// The receiver only accepts CCIP messages from Arc Testnet's chain selector and that sender.
//
// Usage: PRIVATE_KEY=0x... bun run scripts/deploy-receiver.ts [--dry-run]
import { CCIP, DRY_RUN, ENS, artifact, deploy, hasCode, loadState, saveState, sep, signerFor } from "./config";

const s = signerFor("sepolia");
const state = loadState();
const { abi } = artifact("FundNameReceiver");
const sender = state.arc?.sender;
console.log(`FundNameReceiver on Sepolia, from ${s.from}${DRY_RUN ? " (dry-run)" : ""}`);
if (!sender) {
  if (!DRY_RUN) throw new Error("No Arc sender in deployments.json: run deploy-sender.ts first.");
  console.log("  (dry-run) no sender yet, using the zero address as a placeholder");
}

let receiver = state.sepolia?.receiver;
if (await hasCode(sep, receiver)) {
  const bound = (await sep.readContract({ address: receiver!, abi, functionName: "sender" })) as string;
  if (sender && bound.toLowerCase() !== sender.toLowerCase()) {
    throw new Error(`Receiver ${receiver} trusts sender ${bound}, but deployments.json has ${sender}. Remove sepolia.receiver from deployments.json to redeploy.`);
  }
  console.log(`  receiver already deployed at ${receiver} (sender ${bound})`);
} else {
  const r = await deploy(s, "FundNameReceiver", [
    CCIP.sepolia.router,
    CCIP.arc.chainSelector,
    sender ?? "0x0000000000000000000000000000000000000000",
    ENS.userRegistry,
    ENS.resolver,
    ENS.ethRegistry,
    ENS.parentLabel,
  ]);
  receiver = r.address;
  if (receiver) {
    state.sepolia = { receiver, receiverTx: r.hash, receiverSender: sender };
    saveState(state);
  }
}
console.log(`Done. Receiver: ${receiver ?? "(dry-run)"}. Next: grant-roles.ts, then deploy-sender.ts again.`);
