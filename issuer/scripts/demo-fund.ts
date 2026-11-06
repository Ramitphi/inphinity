// Creates the "Big Tech Bluechip" demo fund (AAPL 30%, MSFT 25%, NVDA 25%, GOOGL 20%, 1% fee) and invests N USDC.
// Usage: tsx --env-file=<deployer.env> scripts/demo-fund.ts [usdc]
import { createWalletClient, http, parseEventLogs, parseAbi, formatUnits } from "viem";
import { arcTestnet } from "viem/chains";
import { account, arc } from "./common.ts";
const FACTORY = "0x9fa4034efb237a7c154adea20b1ccfa0cd538b11";
const USDC = "0x3600000000000000000000000000000000000000";
const fAbi = parseAbi([
  "function createIndex(string name,string symbol,string label,address[] tokens,uint16[] weightsBps,uint16 feeBps,string description) returns (address)",
  "event IndexCreated(address indexed fund,address indexed creator,string name,string symbol,string label)",
  "function indexCount() view returns (uint256)",
]);
const fundAbi = parseAbi(["function invest(uint256 usdcIn,uint256 minShares) returns (uint256)", "function navPerShare() view returns (uint256)", "function nav() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const w = createWalletClient({ account, chain: arcTestnet, transport: http() });
const ok = async (h: `0x${string}`, what: string) => { const r = await arc.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(what + " reverted " + h); console.log(what + ": https://testnet.arcscan.app/tx/" + h); return r; };
const tokens = ["0x4572E4D21199deA83a5E069361871512c31a3bBd","0xeFde44E09DDDc17d169760FC3922b55BEda7a53B","0x5263E1f5A05e6b3F733fA401042c6F9f4a09464f","0xc9e364b45DEb73de694c7d97eF189A99013029dB"] as const;
const r = await ok(await w.writeContract({ address: FACTORY, abi: fAbi, functionName: "createIndex",
  args: ["Big Tech Bluechip", "BCHIP", "", [...tokens], [3000, 2500, 2500, 2000], 100, "Apple, Microsoft, NVIDIA and Alphabet: four US tech leaders in one USDC fund."] }), "createIndex");
const fund = parseEventLogs({ abi: fAbi, eventName: "IndexCreated", logs: r.logs })[0].args.fund;
console.log("fund:", fund);
const amount = BigInt(process.argv[2] ?? "5") * 1_000_000n;
await ok(await w.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [fund, amount] }), "approve");
await ok(await w.writeContract({ address: fund, abi: fundAbi, functionName: "invest", args: [amount, 0n] }), "invest");
console.log("NAV/share:", formatUnits(await arc.readContract({ address: fund, abi: fundAbi, functionName: "navPerShare" }), 6), "fund value:", formatUnits(await arc.readContract({ address: fund, abi: fundAbi, functionName: "nav" }), 6));
