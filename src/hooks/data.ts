import { useMemo } from 'react'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { erc20Abi, type Address } from 'viem'
import { usePrevClose } from './prevClose'
import { EXCHANGE, FACTORY, USDC, exchangeAbi, factoryAbi, fundAbi, LISTING_PRICE, COMPANY } from '../lib/contracts'

const chainId = arcTestnet.id
export const POLL = 10_000

export type Stock = {
  token: Address; name: string; symbol: string; company: string
  price: bigint; updatedAt: bigint; inventory?: bigint
  change: number // % vs listing price
  /** % vs the previous close (last price reported before the latest NYSE open); falls back to listing. */
  dayChange: number
}

export function changeVsListing(symbol: string, price: bigint) {
  const base = LISTING_PRICE[symbol]
  if (!base) return 0
  return ((Number(price) / 1e6 - base) / base) * 100
}

function dayChange(symbol: string, price: bigint, prevClose: bigint | undefined) {
  if (!prevClose) return changeVsListing(symbol, price)
  return ((Number(price) - Number(prevClose)) / Number(prevClose)) * 100
}

export function useStocks() {
  const q = useReadContract({ chainId, address: EXCHANGE, abi: exchangeAbi, functionName: 'getStocks', query: { refetchInterval: POLL } })
  const list = q.data ?? []
  const inv = useReadContracts({
    contracts: list.map((s) => ({ chainId, address: EXCHANGE, abi: exchangeAbi, functionName: 'inventoryOf', args: [s.token] }) as const),
    query: { enabled: list.length > 0, refetchInterval: POLL },
  })
  const prev = usePrevClose(list.length)
  const stocks: Stock[] = useMemo(
    () => list.map((s, i) => ({
      token: s.token, name: s.name, symbol: s.symbol, company: COMPANY[s.symbol] ?? s.name.replace(/^Mock /, ''),
      price: s.price, updatedAt: s.updatedAt,
      inventory: inv.data?.[i]?.result as bigint | undefined,
      change: changeVsListing(s.symbol, s.price),
      dayChange: dayChange(s.symbol, s.price, prev.data?.get(s.token.toLowerCase())),
    })),
    [list, inv.data, prev.data],
  )
  const byToken = useMemo(() => new Map(stocks.map((s) => [s.token.toLowerCase(), s])), [stocks])
  return { stocks, byToken, isLoading: q.isLoading, error: q.error, refetch: () => { q.refetch(); inv.refetch() } }
}

export function useUsdcBalance() {
  const { address } = useAccount()
  return useReadContract({
    chainId, address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: POLL },
  })
}

export type FundSummary = {
  address: Address; name: string; symbol: string; creator: Address; feeBps: number
  nav?: bigint; navPerShare?: bigint; totalSupply?: bigint; balance?: bigint
}

const FUND_FIELDS = ['name', 'symbol', 'creator', 'feeBps', 'nav', 'navPerShare', 'totalSupply'] as const

export function useFunds() {
  const { address: user } = useAccount()
  const count = useReadContract({ chainId, address: FACTORY, abi: factoryAbi, functionName: 'indexCount', query: { refetchInterval: POLL } })
  const n = Number(count.data ?? 0n)
  const page = useReadContract({
    chainId, address: FACTORY, abi: factoryAbi, functionName: 'getIndexes', args: [0n, BigInt(Math.min(n, 100))],
    query: { enabled: n > 0 },
  })
  const addrs = (n > 0 ? page.data ?? [] : []) as readonly Address[]
  const per = FUND_FIELDS.length + 1
  const details = useReadContracts({
    contracts: addrs.flatMap((a) => [
      ...FUND_FIELDS.map((f) => ({ chainId, address: a, abi: fundAbi, functionName: f }) as const),
      user
        ? ({ chainId, address: a, abi: fundAbi, functionName: 'balanceOf', args: [user] } as const)
        : ({ chainId, address: a, abi: fundAbi, functionName: 'totalSupply' } as const),
    ]),
    query: { enabled: addrs.length > 0, refetchInterval: POLL },
  })
  const funds: FundSummary[] = useMemo(() => addrs.map((a, i) => {
    const r = (k: number) => details.data?.[i * per + k]?.result
    return {
      address: a, name: (r(0) as string) ?? '…', symbol: (r(1) as string) ?? '', creator: r(2) as Address,
      feeBps: Number(r(3) ?? 0), nav: r(4) as bigint | undefined, navPerShare: r(5) as bigint | undefined,
      totalSupply: r(6) as bigint | undefined, balance: user ? (r(7) as bigint | undefined) : undefined,
    }
  }), [addrs, details.data, user, per])
  return { funds, count: n, isLoading: count.isLoading || (n > 0 && (page.isLoading || details.isLoading)), refetch: () => { count.refetch(); page.refetch(); details.refetch() } }
}
