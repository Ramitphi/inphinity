/**
 * Read-only status of the StockExchange feed (no key needed):
 *   cd cre/price-feed && bun scripts/status.ts [blocksBack=5000]
 * Prints priceSource, forwarder and identity settings, each stock's stored price vs Yahoo,
 * and the PricesUpdated / ReportIgnored events in the last N blocks.
 */
import { createPublicClient, http, parseAbi, formatUnits } from "viem"
import config from "../config.json"

const RPC = process.env.ARC_RPC ?? "https://rpc.testnet.arc.network"
const exchange = config.exchangeAddress as `0x${string}`
const client = createPublicClient({ transport: http(RPC) })
const abi = parseAbi([
  "function getStocks() view returns ((address token,string name,string symbol,uint256 price,uint256 updatedAt)[])",
  "function priceSource() view returns (uint8)",
  "function maxMoveBps() view returns (uint256)",
  "function lastReportAt() view returns (uint256)",
  "function getForwarderAddress() view returns (address)",
  "function getExpectedAuthor() view returns (address)",
  "function getExpectedWorkflowId() view returns (bytes32)",
  "function getExpectedWorkflowName() view returns (bytes10)",
  "event PricesUpdated(address[] tokens, uint256[] prices, uint64 timestamp)",
  "event ReportIgnored()",
])
const read = <T>(functionName: string) => client.readContract({ address: exchange, abi, functionName } as never) as Promise<T>

const [source, maxMove, lastReport, forwarder, author, wfId, wfName, stocks] = await Promise.all([
  read<number>("priceSource"),
  read<bigint>("maxMoveBps"),
  read<bigint>("lastReportAt"),
  read<string>("getForwarderAddress"),
  read<string>("getExpectedAuthor"),
  read<string>("getExpectedWorkflowId"),
  read<string>("getExpectedWorkflowName"),
  read<readonly { token: string; symbol: string; price: bigint; updatedAt: bigint }[]>("getStocks"),
])
const now = Math.floor(Date.now() / 1000)
console.log(`exchange       ${exchange}`)
console.log(`priceSource    ${source} (${source === 1 ? "Feed: reports update prices" : "Admin: reports are ignored"})`)
console.log(`forwarder      ${forwarder}`)
console.log(`expectedAuthor ${author}   workflowId ${wfId}   workflowName ${wfName}`)
console.log(`maxMoveBps     ${maxMove}   lastReportAt ${lastReport} (${lastReport ? `${now - Number(lastReport)}s ago` : "never"})`)
console.log("")
for (const s of stocks) {
  let yahoo = "?"
  try {
    const r = await fetch(`${config.yahoo.baseUrl}/${s.symbol.replace(/^t/, "")}`, { headers: { "User-Agent": "Mozilla/5.0" } })
    yahoo = String((await r.json()).chart.result[0].meta.regularMarketPrice)
  } catch {}
  console.log(`${s.symbol.padEnd(7)} ${formatUnits(s.price, 6).padStart(10)} USDC  yahoo ${yahoo.padStart(8)}  updated ${now - Number(s.updatedAt)}s ago`)
}

const back = BigInt(process.argv[2] ?? 5000)
const latest = await client.getBlockNumber()
const fromBlock = latest > back ? latest - back : 0n
try {
  const logs = await client.getLogs({ address: exchange, fromBlock, toBlock: latest, events: abi.filter((x) => x.type === "event") as never })
  console.log(`\nevents in blocks ${fromBlock}..${latest}: ${logs.length}`)
  for (const l of logs as { eventName: string; transactionHash: string; args: { tokens?: string[]; timestamp?: bigint } }[]) {
    console.log(`  ${l.eventName} tx ${l.transactionHash}${l.args.tokens ? ` tokens=${l.args.tokens.length} ts=${l.args.timestamp}` : ""}`)
  }
} catch (err) {
  console.log(`\n(could not read events: ${String(err).slice(0, 120)}; try a smaller blocksBack)`)
}
