// Deployed addresses on Arc Testnet (chain 5042002). See issuer/README.md for how they were made.
import { erc20Abi } from 'viem'
import { STOCK_CATALOG } from './stocks'

export const EXCHANGE = '0x93662de514b981f8c7bf97085e359e0f18034804' as const
export const FACTORY = '0x9fa4034efb237a7c154adea20b1ccfa0cd538b11' as const
export const SIP_MANAGER = '0xd96ea5a6c776eac72e5da4f7abb838b5da053f3a' as const
export const USDC = '0x3600000000000000000000000000000000000000' as const // ERC-20 interface, 6 decimals
export const USDC_DECIMALS = 6
export const TOKEN_DECIMALS = 18

export { erc20Abi }
export * from './abis'

// Baseline for the change column and display names, from the stock catalog.
export const LISTING_PRICE: Record<string, number> = Object.fromEntries(STOCK_CATALOG.map((s) => [s.symbol, s.listing]))
export const COMPANY: Record<string, string> = Object.fromEntries(STOCK_CATALOG.map((s) => [s.symbol, s.company]))

export const EXPLORER = 'https://testnet.arcscan.app'
