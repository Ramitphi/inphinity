/**
 * NSE stock price feed for the StockExchange contract (Chainlink CRE, TypeScript SDK).
 *
 * Flow on every cron tick:
 *   1. Read the listed stocks from StockExchange.getStocks() (and maxMoveBps) on arc-testnet.
 *   2. For each stock, fetch the NSE price in INR from Twelve Data (HTTP capability, median consensus).
 *   3. Fetch USD/INR from Twelve Data (median consensus).
 *   4. price = INR price / USD-INR, expressed in USDC base units (6 decimals) per whole token.
 *   5. Encode abi.encode(address[] tokens, uint256[] prices, uint64 timestamp), the exact layout
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
  /** StockExchange address. Empty until the user fills it in after deploying the contract. */
  exchangeAddress: z.string(),
  /** Gas limit for the report delivery transaction (decimal string). */
  gasLimit: z.string().default("1000000"),
  /** Which block the on-chain reads use. */
  readBlock: z.enum(["latest", "finalized"]).default("latest"),
  twelveData: z.object({
    baseUrl: z.string().url().default("https://api.twelvedata.com"),
    /** Optional `exchange` query parameter for stock quotes. Empty = not sent. */
    exchange: z.string().default(""),
    /** Optional `mic_code` query parameter for stock quotes (XNSE = NSE India). Empty = not sent. */
    micCode: z.string().default("XNSE"),
    /** Currency pair used for the INR to USD conversion. */
    fxSymbol: z.string().default("USD/INR"),
    /** Per-request timeout, e.g. "8s" (the platform maximum is 10s). */
    requestTimeout: z.string().default("8s"),
    /** If > 0, nodes may share one cached response up to this many seconds old (max 600). 0 = every node fetches its own. */
    cacheMaxAgeSeconds: z.number().int().min(0).max(600).default(0),
  }),
  /**
   * Optional per-stock ticker overrides. Key = token symbol (e.g. "tRELIANCE") or the token address
   * (lowercase or checksummed); value = the NSE ticker to query on Twelve Data.
   */
  tickerOverrides: z.record(z.string(), z.string()).default({}),
  /** Hard cap on stocks processed per run (the platform allows 15 HTTP requests per execution, 1 is used for FX). */
  maxStocksPerRun: z.number().int().min(1).max(14).default(14),
  /** Reject the whole run if USD/INR falls outside this range (guards against a bad provider answer). */
  fxSanityRange: z.object({ min: z.number().positive(), max: z.number().positive() }).default({ min: 40, max: 200 }),
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

// Scaling used for consensus: integers, so bigint median is exact.
const INR_DECIMALS = 4 // INR price stored as paise*100 (INR * 1e4)
const FX_DECIMALS = 6 // USD/INR stored as rate * 1e6

// WriteReportReply.receiverContractExecutionStatus: 0 = SUCCESS, 1 = REVERTED
const RECEIVER_REVERTED = 1

// ---------------------------------------------------------------------------
// Twelve Data helpers (these run on every node, inside the HTTP capability)
// ---------------------------------------------------------------------------

type QuoteRequest = {
  url: string
  apiKey: string
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

/** Parses a decimal string/number into an integer scaled by 10^decimals. Rejects zero, negatives, exponents. */
const toScaled = (value: unknown, decimals: number, what: string): bigint => {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : ""
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${what}: unexpected value format`)
  const scaled = parseUnits(s, decimals)
  if (scaled <= 0n) throw new Error(`${what}: non-positive value`)
  return scaled
}

/** Performs one authenticated Twelve Data GET and returns the parsed JSON object. Never echoes the API key. */
const fetchTwelveData = (sendRequester: HTTPSendRequester, req: QuoteRequest): Record<string, unknown> => {
  const request: HttpRequest = {
    url: req.url,
    method: "GET",
    timeout: req.timeout,
    // Header auth is the method Twelve Data recommends; it keeps the key out of the URL.
    multiHeaders: { Authorization: { values: [`apikey ${req.apiKey}`] } },
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
  if (typeof body !== "object" || body === null) throw new Error(`${req.what}: unexpected response`)
  const obj = body as Record<string, unknown>
  // Twelve Data reports errors as { code, message, status: "error" }, sometimes with HTTP 200.
  if (obj.status === "error" || typeof obj.code === "number") {
    throw new Error(`${req.what}: provider error ${String(obj.code ?? "")} ${String(obj.message ?? "").slice(0, 120)}`)
  }
  return obj
}

/** GET /price -> { "price": "1234.5" }. Returns INR * 1e4. */
const fetchInrPrice = (sendRequester: HTTPSendRequester, req: QuoteRequest): bigint => {
  const obj = fetchTwelveData(sendRequester, req)
  return toScaled(obj.price, INR_DECIMALS, req.what)
}

/** GET /exchange_rate -> { "symbol": "USD/INR", "rate": 85.1, "timestamp": ... }. Returns rate * 1e6. */
const fetchFxRate = (sendRequester: HTTPSendRequester, req: QuoteRequest): bigint => {
  const obj = fetchTwelveData(sendRequester, req)
  return toScaled(obj.rate, FX_DECIMALS, req.what)
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

type OnchainStock = { token: Address; symbol: string; price: bigint; updatedAt: bigint }

const resolveTicker = (config: Config, stock: OnchainStock): string => {
  const overrides = config.tickerOverrides
  const override = overrides[stock.symbol] ?? overrides[stock.token] ?? overrides[stock.token.toLowerCase()]
  if (override && override.trim() !== "") return override.trim()
  // Default rule: token symbol without the leading "t" (tRELIANCE -> RELIANCE).
  return stock.symbol.startsWith("t") ? stock.symbol.slice(1) : stock.symbol
}

const buildUrl = (base: string, path: string, params: Record<string, string>): string => {
  const query = Object.entries(params)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")
  return `${base.replace(/\/+$/, "")}${path}?${query}`
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

  // --- 3. Secret + HTTP client ----------------------------------------------------------------
  // Secrets can only be read inside a handler, never while triggers are being registered.
  const apiKey = runtime.getSecret({ id: SECRET_ID }).result().value
  if (!apiKey) throw new Error(`Secret ${SECRET_ID} is empty`)

  const td = config.twelveData
  const httpClient = new HTTPClient()

  // --- 4. USD/INR (median across nodes) -------------------------------------------------------
  const fx6 = httpClient
    .sendRequest(
      runtime,
      fetchFxRate,
      consensusMedianAggregation<bigint>(),
    )({
      url: buildUrl(td.baseUrl, "/exchange_rate", { symbol: td.fxSymbol, dp: "6" }),
      apiKey,
      timeout: td.requestTimeout,
      cacheMaxAgeSeconds: td.cacheMaxAgeSeconds,
      what: `FX ${td.fxSymbol}`,
    })
    .result()

  const fxMin = parseUnits(String(config.fxSanityRange.min), FX_DECIMALS)
  const fxMax = parseUnits(String(config.fxSanityRange.max), FX_DECIMALS)
  if (fx6 < fxMin || fx6 > fxMax) {
    throw new Error(`${td.fxSymbol} rate ${formatScaled(fx6, FX_DECIMALS)} is outside the sanity range; aborting run`)
  }
  runtime.log(`${td.fxSymbol} = ${formatScaled(fx6, FX_DECIMALS)}`)

  // --- 5. Per-stock INR price, convert, validate -----------------------------------------------
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

    let inr4: bigint
    try {
      inr4 = httpClient
        .sendRequest(
          runtime,
          fetchInrPrice,
          consensusMedianAggregation<bigint>(),
        )({
          url: buildUrl(td.baseUrl, "/price", {
            symbol: ticker,
            exchange: td.exchange,
            mic_code: td.micCode,
            dp: String(INR_DECIMALS),
          }),
          apiKey,
          timeout: td.requestTimeout,
          cacheMaxAgeSeconds: td.cacheMaxAgeSeconds,
          what: `Quote ${ticker}`,
        })
        .result()
    } catch (err) {
      skipped.push(`${stock.symbol} (quote failed: ${errorText(err)})`)
      continue
    }

    // INR/USDINR -> USDC base units (6 decimals) per whole token, rounded to nearest.
    //   price6 = (inr4 / 1e4) / (fx6 / 1e6) * 1e6 = inr4 * 1e8 / fx6
    let price6 = (inr4 * 10n ** 8n + fx6 / 2n) / fx6

    if (price6 === 0n) {
      skipped.push(`${stock.symbol} (price rounds to zero)`)
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

    runtime.log(`${stock.symbol} (${ticker}): INR ${formatScaled(inr4, INR_DECIMALS)} -> ${price6} USDC base units`)
    tokens.push(stock.token)
    prices.push(price6)
  }

  for (const line of skipped) runtime.log(`Skipped ${line}`)

  if (tokens.length === 0) {
    runtime.log("No valid prices to report this run.")
    return "no prices"
  }

  // --- 6. Encode exactly as StockExchange._processReport decodes ----------------------------------
  const encoded = encodeAbiParameters(reportParams, [tokens, prices, timestamp])

  const report = runtime
    .report({
      encodedPayload: hexToBase64(encoded),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  // --- 7. Deliver to the exchange (via the Chainlink forwarder) ----------------------------------
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

const SECRET_ID = "TWELVE_DATA_API_KEY"

const formatScaled = (value: bigint, decimals: number): string => {
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const frac = (value % base).toString().padStart(decimals, "0")
  return `${whole}.${frac}`
}

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
