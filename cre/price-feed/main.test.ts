import { describe, expect } from "bun:test"
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from "@chainlink/cre-sdk/test"
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, parseAbiParameters, toFunctionSelector } from "viem"
import { configSchema, onCronTrigger } from "./main"

const CHAIN_SELECTOR = 3034092155422581607n // arc-testnet
const EXCHANGE = "0x1111111111111111111111111111111111111111"
const T1 = "0x00000000000000000000000000000000000000a1" // tAAPL
const T2 = "0x00000000000000000000000000000000000000a2" // tMSFT (quote fails)
const T3 = "0x00000000000000000000000000000000000000a3" // tNVDA (move exceeds cap)

const stocksReturn = encodeAbiParameters(
  parseAbiParameters("(address token, string name, string symbol, uint256 price, uint256 updatedAt)[] result"),
  [
    [
      { token: T1, name: "Apple", symbol: "tAAPL", price: 200_000_000n, updatedAt: 1_000n },
      { token: T2, name: "Microsoft", symbol: "tMSFT", price: 400_000_000n, updatedAt: 1_000n },
      { token: T3, name: "Nvidia", symbol: "tNVDA", price: 100_000_000n, updatedAt: 1_000n },
    ],
  ],
)
const maxMoveReturn = encodeAbiParameters(parseAbiParameters("uint256"), [500n])

const chart = (price: number) => ({
  statusCode: 200,
  body: new TextEncoder().encode(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price } }], error: null } })),
})

describe("price feed workflow", () => {
  test("builds the report the contract decodes", () => {
    const config = configSchema.parse({
      schedules: ["0 * * * *"],
      exchangeAddress: EXCHANGE,
      yahoo: {},
    })

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
      return { txStatus: 2 /* SUCCESS */, txHash: new Uint8Array(32).fill(7) }
    }

    const seenUrls: string[] = []
    const http = HttpActionsMock.testInstance()
    http.sendRequest = (input) => {
      seenUrls.push(input.url)
      if (input.url.endsWith("/AAPL")) return chart(205.5) // +2.75%, within the cap
      if (input.url.endsWith("/MSFT")) return { statusCode: 404, body: new Uint8Array() }
      if (input.url.endsWith("/NVDA")) return chart(150) // vs 100 stored: > 5% cap
      return { statusCode: 500, body: new Uint8Array() }
    }

    const runtime = newTestRuntime(new Map(), { timeProvider: () => 1_700_000_000_000 })
    runtime.config = config

    onCronTrigger(runtime)
    const logs = runtime.getLogs().join("\n")

    expect(seenUrls).toContain("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")
    expect(logs).toContain("Skipped tMSFT")
    expect(written).toBeDefined()

    // Decode like StockExchange._processReport: abi.decode(report, (address[], uint256[], uint64)).
    // Test runtime reports carry a 109-byte metadata header before the payload.
    const payload = `0x${Buffer.from((written as Uint8Array).slice(REPORT_METADATA_HEADER_LENGTH)).toString("hex")}` as const
    const [tokens, prices, timestamp] = decodeAbiParameters(
      parseAbiParameters("address[] tokens, uint256[] prices, uint64 timestamp"),
      payload,
    )
    expect(tokens.map((t) => t.toLowerCase())).toEqual([T1, T3])
    expect(prices).toEqual([205_500_000n, 105_000_000n]) // AAPL 205.50 USDC; NVDA clamped to +5%
    expect(timestamp).toBe(1_700_000_000n - 30n)
  })
})
