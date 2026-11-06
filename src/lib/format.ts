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
