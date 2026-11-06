import { describe, expect } from "bun:test"
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from "@chainlink/cre-sdk/test"
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, parseAbiParameters, toFunctionSelector } from "viem"
import { configSchema, onCronTrigger } from "./main"

const CHAIN_SELECTOR = 3034092155422581607n // arc-testnet
const EXCHANGE = "0x1111111111111111111111111111111111111111"
const T1 = "0x00000000000000000000000000000000000000a1" // tRELIANCE
const T2 = "0x00000000000000000000000000000000000000a2" // tTCS (quote fails)
const T3 = "0x00000000000000000000000000000000000000a3" // tINFY (move exceeds cap)

const stocksReturn = encodeAbiParameters(
  parseAbiParameters("(address token, string name, string symbol, uint256 price, uint256 updatedAt)[] result"),
  [
    [
      { token: T1, name: "Reliance", symbol: "tRELIANCE", price: 14_700_000n, updatedAt: 1_000n },
      { token: T2, name: "TCS", symbol: "tTCS", price: 45_000_000n, updatedAt: 1_000n },
      { token: T3, name: "Infosys", symbol: "tINFY", price: 10_000_000n, updatedAt: 1_000n },
    ],
  ],
)
const maxMoveReturn = encodeAbiParameters(parseAbiParameters("uint256"), [500n])

const json = (value: unknown) => ({ statusCode: 200, body: new TextEncoder().encode(JSON.stringify(value)) })

describe("price feed workflow", () => {
  test("builds the report the contract decodes", () => {
    const config = configSchema.parse({
      schedules: ["0 * * * *"],
      exchangeAddress: EXCHANGE,
      twelveData: {},
      tickerOverrides: { tINFY: "INFY" },
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
    const seenAuth: string[] = []
    const http = HttpActionsMock.testInstance()
    http.sendRequest = (input) => {
      seenUrls.push(input.url)
      seenAuth.push(input.multiHeaders?.Authorization?.values?.[0] ?? "")
      if (input.url.includes("/exchange_rate")) return json({ symbol: "USD/INR", rate: 85, timestamp: 1 })
      if (input.url.includes("symbol=RELIANCE")) return json({ price: "1250.0000" })
      if (input.url.includes("symbol=TCS")) return json({ code: 404, message: "symbol not found", status: "error" })
      if (input.url.includes("symbol=INFY")) return json({ price: "1700.0000" }) // 20 USDC vs 10 stored: > 5% cap
      return { statusCode: 500, body: new Uint8Array() }
    }

    const runtime = newTestRuntime(new Map([["main", new Map([["TWELVE_DATA_API_KEY", "test-key"]])]]), {
      timeProvider: () => 1_700_000_000_000,
    })
    runtime.config = config

    onCronTrigger(runtime)
    const logs = runtime.getLogs().join("\n")

    expect(seenAuth.every((a) => a === "apikey test-key")).toBe(true)
    expect(seenUrls.some((u) => u.includes("/price?symbol=RELIANCE&mic_code=XNSE&dp=4"))).toBe(true)
    expect(seenUrls.some((u) => u.includes("symbol=USD%2FINR"))).toBe(true)
    expect(logs).toContain("Skipped tTCS")
    expect(written).toBeDefined()

    // Decode like StockExchange._processReport: abi.decode(report, (address[], uint256[], uint64)).
    // Test runtime reports carry a 109-byte metadata header before the payload.
    const payload = `0x${Buffer.from((written as Uint8Array).slice(REPORT_METADATA_HEADER_LENGTH)).toString("hex")}` as const
    const [tokens, prices, timestamp] = decodeAbiParameters(
      parseAbiParameters("address[] tokens, uint256[] prices, uint64 timestamp"),
      payload,
    )
    expect(tokens.map((t) => t.toLowerCase())).toEqual([T1, T3])
    expect(prices).toEqual([14_705_882n, 10_500_000n]) // 1250/85 USDC; INFY clamped to +5%
    expect(timestamp).toBe(1_700_000_000n - 30n)
  })
})
