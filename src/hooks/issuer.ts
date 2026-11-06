import { useAccount, useSimulateContract } from 'wagmi'
import { baseSepolia } from 'viem/chains'
import { BRIDGEABLE } from '../lib/stocks'

export const mintAbi = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const

/**
 * Issuer = a wallet allowed to mint the stock on Base Sepolia. Checked by simulating `mint(you, 1)`;
 * nothing is sent. Defaults to the first issued stock (tAAPL).
 */
export function useIsIssuer(token: `0x${string}` | undefined = BRIDGEABLE[0]?.token) {
  const { address } = useAccount()
  const sim = useSimulateContract({
    chainId: baseSepolia.id, address: token, abi: mintAbi, functionName: 'mint', args: address ? [address, 1n] : undefined, account: address,
    query: { enabled: !!address && !!token, retry: false },
  })
  return sim.isSuccess
}
