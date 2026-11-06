import { describe, expect } from "bun:test"
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from "@chainlink/cre-sdk/test"
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, parseAbiParameters, toFunctionSelector } from "viem"
import { applyMoveCap, configSchema, onCronTrigger, parseYahooQuote } from "./main"

const CHAIN_SELECTOR = 3034092155422581607n // arc-testnet
const EXCHANGE = "0x1111111111111111111111111111111111111111"
const NOW_MS = 1_700_000_000_000
const NOW = 1_700_000_000
const SKEW = 30n

type MockStock = { token: string; name: string; symbol: string; price: bigint; updatedAt: bigint }
type Quote = { status?: number; body?: unknown; raw?: string }

const stock = (n: number, symbol: string, price: bigint, updatedAt = 1_000n): MockStock => ({
  token: `0x${n.toString(16).padStart(40, "0")}`,
  name: symbol,
  symbol,
  price,
  updatedAt,
})

const chartBody = (price: unknown, opts: { time?: unknown; currency?: unknown } = {}) => ({
  chart: {
    result: [
      {
        meta: {
          regularMarketPrice: price,
          regularMarketTime: "time" in opts ? opts.time : NOW - 3_600,
          currency: "currency" in opts ? opts.currency : "USD",
        },
      },
    ],
    error: null,
  },
})

/** Runs the handler against a mocked exchange and Yahoo. Returns the decoded report (or undefined) and the logs. */
const runWorkflow = (
  stocks: MockStock[],
  quotes: Record<string, Quote>,
  opts: { config?: Record<string, unknown>; maxMoveBps?: bigint; write?: { txStatus: number; receiverContractExecutionStatus?: number } } = {},
) => {
  const config = configSchema.parse({ schedules: ["0 * * * *"], exchangeAddress: EXCHANGE, yahoo: {}, ...opts.config })
  const stocksReturn = encodeAbiParameters(
    parseAbiParameters("(address token, string name, string symbol, uint256 price, uint256 updatedAt)[] result"),
    [stocks as never],
  )
  const maxMoveReturn = encodeAbiParameters(parseAbiParameters("uint256"), [opts.maxMoveBps ?? 500n])

  const evm = EvmMock.testInstance(CHAIN_SELECTOR)
  evm.callContract = (input) => {
    const data = Buffer.from(input.call!.data as Uint8Array).toString("hex")
    const sel = (s: string) => toFunctionSelector(s).slice(2)
    if (data.startsWith(sel("getStocks()"))) return { data: hexToBytes(stocksReturn) }
    if (data.startsWith(sel("maxMoveBps()"))) return { data: hexToBytes(maxMoveReturn) }
    throw new Error("unexpected call")
  }
  let written: Uint8Array | undefined
  evm.writeReport = (input) => {
    written = input.report?.rawReport
    return { txHash: new Uint8Array(32).fill(7), ...(opts.write ?? { txStatus: 2 /* SUCCESS */ }) }
  }

  const seenUrls: string[] = []
  const http = HttpActionsMock.testInstance()
  http.sendRequest = (input) => {
    seenUrls.push(input.url)
    const ticker = input.url.split("/").pop()!
    const q = quotes[ticker]
    if (!q) return { statusCode: 500, body: new Uint8Array() }
    const payload = q.raw ?? (q.body === undefined ? "" : JSON.stringify(q.body))
    return { statusCode: q.status ?? 200, body: new TextEncoder().encode(payload) }
  }

  const runtime = newTestRuntime(new Map(), { timeProvider: () => NOW_MS })
  runtime.config = config

  let result: string | undefined
  let error: unknown
  try {
    result = onCronTrigger(runtime)
  } catch (err) {
    error = err
  }
  const logs = runtime.getLogs().join("\n")

  let report: { tokens: string[]; prices: bigint[]; timestamp: bigint } | undefined
  if (written) {
    // Decode like StockExchange._processReport: abi.decode(report, (address[], uint256[], uint64)).
    // Test runtime reports carry a 109-byte metadata header before the payload.
    const payload = `0x${Buffer.from(written.slice(REPORT_METADATA_HEADER_LENGTH)).toString("hex")}` as const
    const [tokens, prices, timestamp] = decodeAbiParameters(
      parseAbiParameters("address[] tokens, uint256[] prices, uint64 timestamp"),
      payload,
    )
    report = { tokens: tokens.map((t) => t.toLowerCase()), prices: [...prices], timestamp }
  }
  return { report, logs, result, error, seenUrls }
}

describe("price feed workflow", () => {
  test("builds the report the contract decodes (ok, failed quote, clamped move)", () => {
    const a = stock(0xa1, "tAAPL", 200_000_000n)
    const m = stock(0xa2, "tMSFT", 400_000_000n)
    const n = stock(0xa3, "tNVDA", 100_000_000n)
    const { report, logs, seenUrls } = runWorkflow([a, m, n], {
      AAPL: { body: chartBody(205.5) }, // +2.75%, within the cap
      MSFT: { status: 404 },
      NVDA: { body: chartBody(150) }, // vs 100 stored: > 5% cap
    })

    expect(seenUrls).toContain("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")
    expect(logs).toContain("Skipped tMSFT")
    expect(logs).toContain("clamping")
    expect(report!.tokens).toEqual([a.token, n.token])
    expect(report!.prices).toEqual([205_500_000n, 105_000_000n]) // AAPL 205.50 USDC; NVDA clamped to +5%
    expect(report!.timestamp).toBe(BigInt(NOW) - SKEW)
  })

  test("clamps a large drop to exactly -maxMoveBps", () => {
    const n = stock(0xa3, "tNVDA", 100_000_000n)
    const { report } = runWorkflow([n], { NVDA: { body: chartBody(10) } })
    expect(report!.prices).toEqual([95_000_000n])
  })

  test("onMoveExceeded=skip leaves the stock out instead of clamping", () => {
    const a = stock(0xa1, "tAAPL", 200_000_000n)
    const n = stock(0xa3, "tNVDA", 100_000_000n)
    const { report, logs } = runWorkflow(
      [a, n],
      { AAPL: { body: chartBody(201) }, NVDA: { body: chartBody(150) } },
      { config: { onMoveExceeded: "skip" } },
    )
    expect(report!.tokens).toEqual([a.token])
    expect(logs).toContain("Skipped tNVDA")
  })

  test("uses the contract's maxMoveBps, not a hard-coded 5%", () => {
    const n = stock(0xa3, "tNVDA", 100_000_000n)
    const { report } = runWorkflow([n], { NVDA: { body: chartBody(150) } }, { maxMoveBps: 1_000n })
    expect(report!.prices).toEqual([110_000_000n])
  })

  test("a move of exactly the cap is sent unchanged (contract uses <=)", () => {
    const n = stock(0xa3, "tNVDA", 100_000_000n)
    const { report, logs } = runWorkflow([n], { NVDA: { body: chartBody(105) } })
    expect(report!.prices).toEqual([105_000_000n])
    expect(logs).not.toContain("clamping")
  })

  test("skips stale, missing-time, non-USD, zero, non-JSON and empty-result quotes", () => {
    const ok = stock(0x01, "tAAPL", 200_000_000n)
    const stale = stock(0x02, "tMSFT", 400_000_000n)
    const noTime = stock(0x03, "tNVDA", 100_000_000n)
    const eur = stock(0x04, "tTSLA", 300_000_000n)
    const zero = stock(0x05, "tAMZN", 200_000_000n)
    const html = stock(0x06, "tGOOGL", 200_000_000n)
    const empty = stock(0x07, "tMETA", 600_000_000n)
    const { report, logs } = runWorkflow([ok, stale, noTime, eur, zero, html, empty], {
      AAPL: { body: chartBody(200) },
      MSFT: { body: chartBody(400, { time: NOW - 5 * 24 * 3600 }) },
      NVDA: { body: chartBody(100, { time: undefined }) },
      TSLA: { body: chartBody(300, { currency: "EUR" }) },
      AMZN: { body: chartBody(0) },
      GOOGL: { raw: "<html>rate limited</html>" },
      META: { body: { chart: { result: null, error: { code: "Not Found" } } } },
    })
    expect(report!.tokens).toEqual([ok.token])
    for (const s of ["tMSFT", "tNVDA", "tTSLA", "tAMZN", "tGOOGL", "tMETA"]) expect(logs).toContain(`Skipped ${s}`)
    expect(logs).toContain("stale quote")
  })

  test("skips a stock whose updatedAt is not older than the report timestamp", () => {
    const fresh = stock(0x01, "tAAPL", 200_000_000n, BigInt(NOW) - SKEW) // timestamp would equal updatedAt
    const old = stock(0x02, "tMSFT", 400_000_000n, BigInt(NOW) - SKEW - 1n)
    const { report, logs, seenUrls } = runWorkflow([fresh, old], {
      AAPL: { body: chartBody(200) },
      MSFT: { body: chartBody(400) },
    })
    expect(report!.tokens).toEqual([old.token])
    expect(logs).toContain("tAAPL (updated too recently)")
    expect(seenUrls.some((u) => u.endsWith("/AAPL"))).toBe(false) // no HTTP call wasted on it
  })

  test("writes nothing when every quote fails", () => {
    const { report, result } = runWorkflow([stock(0x01, "tAAPL", 200_000_000n)], { AAPL: { status: 429 } })
    expect(report).toBeUndefined()
    expect(result).toBe("no prices")
  })

  test("writes nothing when no stocks are listed", () => {
    const { report, result } = runWorkflow([], {})
    expect(report).toBeUndefined()
    expect(result).toBe("no stocks")
  })

  test("respects maxStocksPerRun and ticker overrides", () => {
    const a = stock(0x01, "tAAPL", 200_000_000n)
    const b = stock(0x02, "tBRKB", 500_000_000n)
    const c = stock(0x03, "tMSFT", 400_000_000n)
    const { report, seenUrls } = runWorkflow(
      [a, b, c],
      { AAPL: { body: chartBody(200) }, "BRK-B": { body: chartBody(500) }, MSFT: { body: chartBody(400) } },
      { config: { maxStocksPerRun: 2, tickerOverrides: { tBRKB: "BRK-B" } } },
    )
    expect(report!.tokens).toEqual([a.token, b.token])
    expect(seenUrls.some((u) => u.endsWith("/BRK-B"))).toBe(true)
    expect(seenUrls.some((u) => u.endsWith("/MSFT"))).toBe(false)
  })

  test("throws when the receiver reverts, so the run is visibly failed", () => {
    const { error } = runWorkflow(
      [stock(0x01, "tAAPL", 200_000_000n)],
      { AAPL: { body: chartBody(200) } },
      { write: { txStatus: 2, receiverContractExecutionStatus: 1 } },
    )
    expect(String(error)).toContain("onReport reverted")
  })

  test("rejects a missing exchange address", () => {
    const { error } = runWorkflow([], {}, { config: { exchangeAddress: "" } })
    expect(String(error)).toContain("exchangeAddress")
  })
})

describe("parseYahooQuote", () => {
  const opts = { nowSeconds: NOW, maxQuoteAgeSeconds: 3_600, what: "Quote X" }
  test("scales USD to 6 decimals and rounds sub-micro digits", () => {
    expect(parseYahooQuote(chartBody(344.17, { time: NOW }), opts)).toBe(344_170_000n)
    expect(parseYahooQuote(chartBody(0.1234567, { time: NOW }), opts)).toBe(123_457n)
  })
  test("accepts a quote with no currency field", () => {
    expect(parseYahooQuote(chartBody(10, { time: NOW, currency: undefined }), opts)).toBe(10_000_000n)
  })
  test("age check is inclusive and can be disabled", () => {
    expect(parseYahooQuote(chartBody(10, { time: NOW - 3_600 }), opts)).toBe(10_000_000n)
    expect(() => parseYahooQuote(chartBody(10, { time: NOW - 3_601 }), opts)).toThrow("stale")
    expect(parseYahooQuote(chartBody(10, { time: 1 }), { ...opts, maxQuoteAgeSeconds: 0 })).toBe(10_000_000n)
  })
  test("rejects bad prices", () => {
    for (const p of [0, -1, Number.NaN, "12", null, 1e-7]) {
      expect(() => parseYahooQuote(chartBody(p, { time: NOW }), opts)).toThrow()
    }
  })
})

describe("applyMoveCap", () => {
  test("matches the contract's rounded-down Math.mulDiv bound", () => {
    // 5% of 333 = 16.65 -> 16, so 349 is the highest allowed and 350 must be clamped to 349.
    expect(applyMoveCap(333n, 349n, 500n, "clamp")).toEqual({ price: 349n, clamped: false })
    expect(applyMoveCap(333n, 350n, 500n, "clamp")).toEqual({ price: 349n, clamped: true })
    expect(applyMoveCap(333n, 316n, 500n, "clamp")).toEqual({ price: 317n, clamped: true })
  })
  test("maxMoveBps = 0 pins the price", () => {
    expect(applyMoveCap(100n, 101n, 0n, "clamp")).toEqual({ price: 100n, clamped: true })
    expect(applyMoveCap(100n, 100n, 0n, "clamp")).toEqual({ price: 100n, clamped: false })
  })
  test("never returns a zero price", () => {
    // 100% cap on a 1-unit price: lower bound is 0, which the contract rejects.
    expect(applyMoveCap(1n, 0n, 10_000n, "clamp")).toBeNull()
  })
  test("skip mode returns null outside the band", () => {
    expect(applyMoveCap(100n, 200n, 500n, "skip")).toBeNull()
  })
})
