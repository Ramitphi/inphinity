// Creates a small index fund with an ENS label, so the factory registrar sends a Chainlink CCIP
// naming message to Sepolia. Usage: tsx --env-file=<deployer.env> scripts/ccip-test-fund.ts [label]
import { createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { arcTestnet } from "viem/chains";
import { account, arc } from "./common.ts";
const FACTORY = "0x9fa4034efb237a7c154adea20b1ccfa0cd538b11";
const abi = parseAbi([
  "function createIndex(string name,string symbol,string label,address[] tokens,uint16[] weightsBps,uint16 feeBps,string description) returns (address)",
  "event IndexCreated(address indexed fund,address indexed creator,string name,string symbol,string label)",
  "event NamingRequested(bytes32 indexed messageId, address indexed fund, string label)",
]);
const w = createWalletClient({ account, chain: arcTestnet, transport: http() });
const hash = await w.writeContract({ address: FACTORY, abi, functionName: "createIndex", args: [
  "AI Builders", "AIBLD", process.argv[2] ?? "aibuilders",
  ["0x5263E1f5A05e6b3F733fA401042c6F9f4a09464f", "0xeFde44E09DDDc17d169760FC3922b55BEda7a53B", "0xc9e364b45DEb73de694c7d97eF189A99013029dB"],
  [4000, 3000, 3000], 50, "NVIDIA, Microsoft and Alphabet: the companies building AI, in one USDC fund."] });
const r = await arc.waitForTransactionReceipt({ hash });
console.log("createIndex", r.status, `https://testnet.arcscan.app/tx/${hash}`);
for (const l of r.logs) { try { const [e] = parseEventLogs({ abi, logs: [l] }); if (e) console.log(e.eventName, JSON.stringify(e.args)); } catch {} }
console.log("raw log topics:", r.logs.map((l) => l.address + ":" + l.topics[0]?.slice(0, 10)).join(" "));
