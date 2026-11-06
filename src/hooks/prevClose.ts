import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { getAbiItem, type Address } from 'viem'
import { EXCHANGE, exchangeAbi } from '../lib/contracts'
import { lastSessionOpen } from '../lib/market'

const PRICES_UPDATED = getAbiItem({ abi: exchangeAbi, name: 'PricesUpdated' })
const CHUNK = 9_999n // Arc RPC getLogs range limit is 10k blocks
const MAX_CHUNKS = 50 // ~72h at ~0.52s blocks: reaches Friday's close from a Monday open
const EXTRA_AFTER_HIT = 3 // after the first pre-open report, look ~4h further back for stocks it skipped
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Previous close per token (6-decimal USDC), read from the exchange's own PricesUpdated history:
 * the last CRE price reported before the most recent NYSE open. Tokens with no report in that
 * window are missing from the map; callers fall back to the listing price.
 */
export function usePrevClose(tokenCount: number) {
  const client = usePublicClient({ chainId: arcTestnet.id })
  const openTs = lastSessionOpen()
  return useQuery({
    queryKey: ['prevClose', openTs, tokenCount],
    enabled: !!client && tokenCount > 0,
    retry: 1,
    staleTime: 10 * 60_000,
    refetchInterval: 10 * 60_000,
    queryFn: async () => {
      const prev = new Map<string, bigint>()
      if (!client) return prev
      const head = await client.getBlock()
      const ref = await client.getBlock({ blockNumber: head.number > 10_000n ? head.number - 10_000n : 0n })
      const span = Number(head.number - ref.number) || 1
      const secsPerBlock = Math.max(0.05, Number(head.timestamp - ref.timestamp) / span)
      const behind = BigInt(Math.max(0, Math.floor((Number(head.timestamp) - openTs) / secsPerBlock)))
      // Start a little after the estimated open block; reports are filtered by their own timestamp.
      let to = head.number - behind + 2_000n
      if (to > head.number) to = head.number
      let sinceHit = -1
      for (let i = 0; i < MAX_CHUNKS && to > 0n; i++) {
        if (i > 0) await sleep(150) // stay under the public RPC rate limit
        const from = to > CHUNK ? to - CHUNK : 0n
        const logs = await client.getLogs({ address: EXCHANGE, event: PRICES_UPDATED, fromBlock: from, toBlock: to })
        // Newest first, so the first price seen for a token is its latest pre-open price.
        for (const l of [...logs].reverse()) {
          const { tokens, prices, timestamp } = l.args
          if (!tokens || !prices || timestamp === undefined || Number(timestamp) >= openTs) continue
          tokens.forEach((t: Address, j: number) => {
            const k = t.toLowerCase()
            if (!prev.has(k)) prev.set(k, prices[j])
          })
        }
        if (prev.size >= tokenCount) break // every stock has a pre-open price
        if (prev.size > 0 && ++sinceHit >= EXTRA_AFTER_HIT) break // rest fall back to listing
        to = from - 1n
      }
      return prev
    },
  })
}
