import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, formatUnits } from 'viem'
import { exchangeAbi, factoryAbi, fundAbi } from './contracts'

// Every custom error any of our contracts can bubble up (funds call the exchange internally).
export const allErrors = [...exchangeAbi, ...factoryAbi, ...fundAbi].filter((x) => x.type === 'error')

const time = (unix: bigint) => new Date(Number(unix) * 1000).toLocaleTimeString()
const usdcN = (v: unknown) => Number(formatUnits(v as bigint, 6)).toFixed(2)
const tok = (v: unknown) => Number(formatUnits(v as bigint, 18)).toLocaleString('en-US', { maximumFractionDigits: 4 })

export function friendlyError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'Cancelled in your wallet.'
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    const name = rev?.data?.errorName
    const a = (rev?.data?.args ?? []) as unknown[]
    switch (name) {
      case 'InsufficientInventory': return `Not enough stock in the exchange: ${tok(a[0])} available, ${tok(a[1])} needed. Try a smaller amount.`
      case 'InsufficientReserve': return `Exchange reserve too low: it can't cover this sale (${usdcN(a[0])} USDC available, ${usdcN(a[1])} needed). Try a smaller amount.`
      case 'HoldActive': return `Recently bought, still in the hold period. Try again after ${time(a[0] as bigint)}.`
      case 'LockedShares': return 'These shares are still locked from your last investment. Try again in about a minute.'
      case 'SlippageExceeded': return 'The price moved more than 0.5% while you were confirming. Please try again.'
      case 'StalePrice': return 'This stock’s price is stale. Waiting for a fresh oracle update.'
      case 'InvalidAmount': return 'Invalid amount (funds need at least 1 USDC; redeem at least some shares).'
      case 'InvalidBasket': return 'Invalid basket: pick 2 to 10 stocks, each with weight above 0, totalling 100%, fee at most 2%.'
      case 'InvalidMetadata': return 'Invalid name or symbol (name 1-128 chars, symbol 1-32 chars, description up to 2048).'
      case 'UnlistedStock': return 'That stock is not listed on the exchange.'
      case 'ERC20InsufficientBalance': return 'Your balance is too low for this amount.'
      case 'ERC20InsufficientAllowance': return 'Approval is too low. Please approve again.'
      case 'ZeroNAV': return 'The fund has no value yet.'
      case 'OnlyTrustedFactory': return 'The exchange does not trust this fund factory yet.'
      case undefined: break
      default: return `Transaction would fail: ${name}.`
    }
    if (/insufficient funds|exceeds balance/i.test(err.message)) return 'Not enough USDC for gas (gas on Arc is paid in USDC). Top up at faucet.circle.com.'
    return err.shortMessage || err.message
  }
  return err instanceof Error ? err.message : String(err)
}
