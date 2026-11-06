import { useState } from 'react'
import { toast } from 'sonner'
import { usePublicClient, useWriteContract, useAccount, useSwitchChain } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { erc20Abi, type Abi, type Address, type TransactionReceipt } from 'viem'
import { EXPLORER } from './contracts'
import { allErrors, friendlyError } from './errors'

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }

const TxLink = ({ hash, text }: { hash: string; text: string }) => (
  <span>
    {text}{' '}
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
      View on Arcscan ↗
    </a>
  </span>
)

/** Simulate (for readable errors), send, wait for the receipt, and toast every step. */
export function useTx() {
  const client = usePublicClient({ chainId: arcTestnet.id })
  const { writeContractAsync } = useWriteContract()
  const { address, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [busy, setBusy] = useState<string | null>(null)

  async function send(label: string, call: Call): Promise<TransactionReceipt | null> {
    if (!client || !address) {
      toast.error('Connect your wallet first.')
      return null
    }
    const id = toast.loading(`${label}: confirm in your wallet…`)
    setBusy(label)
    try {
      // Every app transaction runs on Arc. If the wallet is elsewhere (e.g. Base Sepolia after a bridge),
      // ask it to switch first instead of failing with a chain-mismatch error.
      if (chainId !== arcTestnet.id) {
        toast.loading(`${label}: switch your wallet to Arc Testnet…`, { id })
        await switchChainAsync({ chainId: arcTestnet.id })
        toast.loading(`${label}: confirm in your wallet…`, { id })
      }
      const abi = [...call.abi, ...allErrors] as Abi
      const { request } = await client.simulateContract({ ...call, abi, account: address } as never)
      const hash = await writeContractAsync({ ...(request as object), chainId: arcTestnet.id } as never)
      toast.loading(<TxLink hash={hash} text={`${label}: pending…`} />, { id })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`${label} reverted onchain.`)
      toast.success(<TxLink hash={hash} text={`${label}: done.`} />, { id, duration: 8000 })
      return receipt
    } catch (e) {
      console.error(e)
      const msg = friendlyError(e)
      if (msg.startsWith('Cancelled')) toast.message(`${label}: cancelled in your wallet.`, { id })
      else toast.error(`${label} failed. ${msg}`, { id, duration: 9000 })
      return null
    } finally {
      setBusy(null)
    }
  }

  /** Approve `token` to `spender` for `amount` if the current allowance is lower. */
  async function ensureAllowance(token: Address, spender: Address, amount: bigint, symbol: string) {
    if (!client || !address) return false
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [address, spender] })
    if (allowance >= amount) return true
    const r = await send(`Approve ${symbol}`, { address: token, abi: erc20Abi as Abi, functionName: 'approve', args: [spender, amount] })
    return !!r
  }

  return { send, ensureAllowance, busy }
}
