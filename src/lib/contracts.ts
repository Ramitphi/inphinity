// Deployed addresses on Arc Testnet (chain 5042002). See issuer/README.md for how they were made.
import { erc20Abi } from 'viem'

export const EXCHANGE = '0x93662de514b981f8c7bf97085e359e0f18034804' as const
export const FACTORY = '0x9fa4034efb237a7c154adea20b1ccfa0cd538b11' as const
export const SIP_MANAGER = '0xd96ea5a6c776eac72e5da4f7abb838b5da053f3a' as const
export const USDC = '0x3600000000000000000000000000000000000000' as const // ERC-20 interface, 6 decimals
export const USDC_DECIMALS = 6
export const TOKEN_DECIMALS = 18

export { erc20Abi }
export * from './abis'

// Reference prices the stocks were listed at, used as the baseline for the change column
// until a Chainlink report moves them.
export const LISTING_PRICE: Record<string, number> = {
  tAAPL: 344.17, tMSFT: 535.93, tNVDA: 181.6, tTSLA: 343.69,
  tAMZN: 260.21, tGOOGL: 282.57, tMETA: 605.08, tSPY: 733.0,
}

export const COMPANY: Record<string, string> = {
  tAAPL: 'Apple Inc.', tMSFT: 'Microsoft Corp.', tNVDA: 'NVIDIA Corp.', tTSLA: 'Tesla Inc.',
  tAMZN: 'Amazon.com Inc.', tGOOGL: 'Alphabet Inc. Cl A', tMETA: 'Meta Platforms Inc.', tSPY: 'SPDR S&P 500 ETF',
}

export const EXPLORER = 'https://testnet.arcscan.app'
