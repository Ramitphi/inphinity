import { formatUnits } from 'viem'
import { TOKEN_DECIMALS, USDC_DECIMALS } from './contracts'

export const usd = (v: bigint | undefined, decimals = USDC_DECIMALS) =>
  v === undefined ? '—' : Number(formatUnits(v, decimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const qty = (v: bigint | undefined, max = 4) =>
  v === undefined ? '—' : Number(formatUnits(v, TOKEN_DECIMALS)).toLocaleString('en-US', { maximumFractionDigits: max })

export const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

export const ticker = (symbol: string) => symbol.replace(/^t/, '')

export const toNum = (v: bigint, decimals: number) => Number(formatUnits(v, decimals))

/** Token units with enough decimals that small holdings don't round to zero. */
export const units = (v: bigint | undefined) => {
  if (v === undefined) return '—'
  const n = Number(formatUnits(v, TOKEN_DECIMALS))
  return n.toLocaleString('en-US', { maximumFractionDigits: n === 0 ? 0 : n < 1 ? 6 : n < 100 ? 4 : 2 })
}

/** "just now", "5m ago", "3h ago", "2d ago" for a unix timestamp in seconds. */
export const ago = (unix: bigint | number, now = Date.now()) => {
  const s = Math.max(0, Math.floor(now / 1000 - Number(unix)))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
