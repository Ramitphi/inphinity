/**
 * US stock price feed for the StockExchange contract (Chainlink CRE, TypeScript SDK).
 *
 * Flow on every cron tick:
 *   1. Read the listed stocks from StockExchange.getStocks() (and maxMoveBps) on arc-testnet.
 *   2. For each stock, fetch the USD price from Yahoo Finance's public chart endpoint (no API key,
 *      HTTP capability, median consensus across nodes). Prices are USD, with no FX conversion.
 *   3. Express the price in USDC base units (6 decimals) per whole 18-decimal token.
 *   4. Encode abi.encode(address[] tokens, uint256[] prices, uint64 timestamp), the exact layout
 *      StockExchange._processReport decodes, and deliver it with a signed report via writeReport.
 *
 * A stock whose quote fails is skipped; the rest of the batch is still written.
 */
import {
  bytesToHex,
  consensusMedianAggregation,
  CronCapability,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  ok,
  Runner,
  text,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk"
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbiParameters,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Config (config.json)
// ---------------------------------------------------------------------------

export const configSchema = z.object({
  /** Cron expressions (UTC). Each one registers a trigger that runs the same handler. */
  schedules: z.array(z.string().min(1)).min(1),
  /** CRE chain name of the chain the StockExchange lives on. */
  chainSelectorName: z.string().default("arc-testnet"),
  /** StockExchange address. Empty until filled in. */
  exchangeAddress: z.string(),
  /** Gas limit for the report delivery transaction (decimal string). */
  gasLimit: z.string().default("1000000"),
  /** Which block the on-chain reads use. */
  readBlock: z.enum(["latest", "finalized"]).default("latest"),
  yahoo: z.object({
    /** Chart endpoint base, the ticker is appended: {baseUrl}/AAPL */
    baseUrl: z.string().url().default("https://query1.finance.yahoo.com/v8/finance/chart"),
    /** Per-request timeout, e.g. "8s" (the platform maximum is 10s). */
    requestTimeout: z.string().default("8s"),
    /** If > 0, nodes may share one cached response up to this many seconds old (max 600). 0 = every node fetches its own. */
    cacheMaxAgeSeconds: z.number().int().min(0).max(600).default(0),
  }),
  /**
   * Optional per-stock ticker overrides. Key = token symbol (e.g. "tAAPL") or the token address
   * (lowercase or checksummed); value = the Yahoo ticker to query.
   */
  tickerOverrides: z.record(z.string(), z.string()).default({}),
  /** Hard cap on stocks processed per run (the platform allows 15 HTTP requests per execution). */
  maxStocksPerRun: z.number().int().min(1).max(15).default(15),
  /** Subtracted from DON time for the report timestamp, so it is never ahead of the block time (contract rejects future timestamps). */
  timestampSkewSeconds: z.number().int().min(0).max(600).default(30),
  /**
   * What to do when a new price moves further than the contract's maxMoveBps from the stored price.
   * "clamp" moves the price as far as the cap allows (converges over several runs); "skip" leaves that stock out.
   * Without this the contract would revert the entire report.
   */
  onMoveExceeded: z.enum(["clamp", "skip"]).default("clamp"),
})

export type Config = z.output<typeof configSchema>
type ConfigInput = z.input<typeof configSchema>

// ---------------------------------------------------------------------------
// Contract ABI (only what the workflow uses)
// ---------------------------------------------------------------------------

const stockExchangeAbi = [
  {
    type: "function",
    name: "getStocks",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "result",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "price", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "maxMoveBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

/**
 * Must match `abi.decode(report, (address[], uint256[], uint64))` in StockExchange._processReport.
 * Three top-level parameters (not a wrapped tuple/struct).
 */
const reportParams = parseAbiParameters("address[] tokens, uint256[] prices, uint64 timestamp")

// StockExchange._processReport rejects reports bigger than this many tokens.
const CONTRACT_MAX_TOKENS = 50

// USDC has 6 decimals; the price is USDC base units per whole token.
const PRICE_DECIMALS = 6

// WriteReportReply.receiverContractExecutionStatus: 0 = SUCCESS, 1 = REVERTED
const RECEIVER_REVERTED = 1

// ---------------------------------------------------------------------------
// Yahoo Finance helper (runs on every node, inside the HTTP capability)
// ---------------------------------------------------------------------------

type QuoteRequest = {
  url: string
  timeout: string
  cacheMaxAgeSeconds: number
  what: string
}

type HttpRequest = {
  url: string
  method: "GET"
  timeout: string
  multiHeaders: { [name: string]: { values: string[] } }
  cacheSettings?: { store: boolean; maxAge: string }
}

/** GET /v8/finance/chart/{ticker} -> chart.result[0].meta.regularMarketPrice. Returns USD * 1e6. */
const fetchUsdPrice = (sendRequester: HTTPSendRequester, req: QuoteRequest): bigint => {
  const request: HttpRequest = {
    url: req.url,
    method: "GET",
    timeout: req.timeout,
    // Yahoo rejects requests without a browser-like user agent.
    multiHeaders: { "User-Agent": { values: ["Mozilla/5.0"] }, Accept: { values: ["application/json"] } },
  }
  // Field names follow @chainlink/cre-sdk 1.23 types (store + maxAge); the web docs show an older shape.
  if (req.cacheMaxAgeSeconds > 0) request.cacheSettings = { store: true, maxAge: `${req.cacheMaxAgeSeconds}s` }
  const response = sendRequester.sendRequest(request).result()

  if (!ok(response)) throw new Error(`${req.what}: HTTP ${response.statusCode}`)

  let body: unknown
  try {
    body = JSON.parse(text(response))
  } catch {
    throw new Error(`${req.what}: response is not JSON`)
  }
  const chart = (body as { chart?: { result?: { meta?: { regularMarketPrice?: unknown } }[] | null } } | null)?.chart
  const price = chart?.result?.[0]?.meta?.regularMarketPrice
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error(`${req.what}: no valid regularMarketPrice`)
  }
  const scaled = parseUnits(price.toFixed(PRICE_DECIMALS), PRICE_DECIMALS)
  if (scaled <= 0n) throw new Error(`${req.what}: price rounds to zero`)
  return scaled
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

type OnchainStock = { token: Address; symbol: string; price: bigint; updatedAt: bigint }

const resolveTicker = (config: Config, stock: OnchainStock): string => {
  const overrides = config.tickerOverrides
  const override = overrides[stock.symbol] ?? overrides[stock.token] ?? overrides[stock.token.toLowerCase()]
  if (override && override.trim() !== "") return override.trim()
  // Default rule: token symbol without the leading "t" (tAAPL -> AAPL).
  return stock.symbol.startsWith("t") ? stock.symbol.slice(1) : stock.symbol
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config

  if (!isAddress(config.exchangeAddress)) {
    throw new Error("config.exchangeAddress is empty or not a valid address. Set it to your deployed StockExchange.")
  }
  const exchange = getAddress(config.exchangeAddress)

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName })
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`)
  const evm = new EVMClient(network.chainSelector.selector)
  const blockNumber = config.readBlock === "finalized" ? LAST_FINALIZED_BLOCK_NUMBER : LATEST_BLOCK_NUMBER

  // --- 1. Read the stock registry ------------------------------------------------------------
  const readView = (functionName: "getStocks" | "maxMoveBps") => {
    const reply = evm
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: exchange,
          data: encodeFunctionData({ abi: stockExchangeAbi, functionName }),
        }),
        blockNumber,
      })
      .result()
    return bytesToHex(reply.data)
  }

  const rawStocks = decodeFunctionResult({
    abi: stockExchangeAbi,
    functionName: "getStocks",
    data: readView("getStocks"),
  })
  const maxMoveBps = decodeFunctionResult({
    abi: stockExchangeAbi,
    functionName: "maxMoveBps",
    data: readView("maxMoveBps"),
  })

  let stocks: OnchainStock[] = rawStocks.map((s) => ({
    token: s.token,
    symbol: s.symbol,
    price: s.price,
    updatedAt: s.updatedAt,
  }))
  if (stocks.length === 0) {
    runtime.log("No stocks listed on the exchange. Nothing to do.")
    return "no stocks"
  }
  const limit = Math.min(config.maxStocksPerRun, CONTRACT_MAX_TOKENS)
  if (stocks.length > limit) {
    runtime.log(`Exchange lists ${stocks.length} stocks; only the first ${limit} are updated per run.`)
    stocks = stocks.slice(0, limit)
  }

  // --- 2. Report timestamp --------------------------------------------------------------------
  // The contract requires: stock.updatedAt < timestamp <= block.timestamp (for every token in the report).
  // DON time is consensus time (runtime.now(), never Date.now()); the skew keeps it from running ahead of the chain.
  const timestamp = BigInt(Math.floor(runtime.now().getTime() / 1000)) - BigInt(config.timestampSkewSeconds)

  // --- 3. Per-stock USD price (median across nodes), validate ---------------------------------
  const httpClient = new HTTPClient()
  const y = config.yahoo
  const tokens: Address[] = []
  const prices: bigint[] = []
  const skipped: string[] = []

  for (const stock of stocks) {
    const ticker = resolveTicker(config, stock)

    if (stock.updatedAt >= timestamp) {
      // The contract would revert the whole report for this entry (timestamp must be newer than updatedAt).
      skipped.push(`${stock.symbol} (updated too recently)`)
      continue
    }

    let price6: bigint
    try {
      price6 = httpClient
        .sendRequest(
          runtime,
          fetchUsdPrice,
          consensusMedianAggregation<bigint>(),
        )({
          url: `${y.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(ticker)}`,
          timeout: y.requestTimeout,
          cacheMaxAgeSeconds: y.cacheMaxAgeSeconds,
          what: `Quote ${ticker}`,
        })
        .result()
    } catch (err) {
      skipped.push(`${stock.symbol} (quote failed: ${errorText(err)})`)
      continue
    }

    // The contract caps each update at maxMoveBps of the stored price and reverts the whole report otherwise.
    if (stock.price > 0n) {
      const maxMove = (stock.price * maxMoveBps) / 10000n
      const upper = stock.price + maxMove
      const lower = stock.price - maxMove
      if (price6 > upper || price6 < lower) {
        if (config.onMoveExceeded === "skip") {
          skipped.push(`${stock.symbol} (move ${price6} vs ${stock.price} exceeds cap)`)
          continue
        }
        const clamped = price6 > upper ? upper : lower
        runtime.log(`${stock.symbol}: target ${price6} exceeds the ${maxMoveBps} bps move cap; clamping to ${clamped}`)
        price6 = clamped
        if (price6 === 0n) {
          skipped.push(`${stock.symbol} (clamped price is zero)`)
          continue
        }
      }
    }

    runtime.log(`${stock.symbol} (${ticker}): ${price6} USDC base units`)
    tokens.push(stock.token)
    prices.push(price6)
  }

  for (const line of skipped) runtime.log(`Skipped ${line}`)

  if (tokens.length === 0) {
    runtime.log("No valid prices to report this run.")
    return "no prices"
  }

  // --- 4. Encode exactly as StockExchange._processReport decodes ----------------------------------
  const encoded = encodeAbiParameters(reportParams, [tokens, prices, timestamp])

  const report = runtime
    .report({
      encodedPayload: hexToBase64(encoded),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  // --- 5. Deliver to the exchange (via the Chainlink forwarder) ----------------------------------
  const write = evm
    .writeReport(runtime, {
      receiver: exchange,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result()

  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Report transaction failed: status ${write.txStatus} ${write.errorMessage ?? ""}`)
  }
  const txHash = bytesToHex(write.txHash ?? new Uint8Array(32))
  if (write.receiverContractExecutionStatus === RECEIVER_REVERTED) {
    throw new Error(`StockExchange.onReport reverted (tx ${txHash}). Check price source, timestamp and move cap.`)
  }

  runtime.log(`Wrote ${tokens.length} prices (${skipped.length} skipped). tx ${txHash}`)
  return txHash
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const errorText = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, 160)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return config.schedules.map((schedule) => handler(cron.trigger({ schedule }), onCronTrigger))
}

export async function main() {
  const runner = await Runner.newRunner<Config, ConfigInput>({ configSchema })
  await runner.run(initWorkflow)
}
