/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, fallback, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet, baseSepolia } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])
registerChain(baseSepolia.id, baseSepolia.rpcUrls.default.http[0])

export const config = createConfig({
  chains: [arcTestnet, baseSepolia, mainnet], // Base Sepolia for the bridge; mainnet for ENS
  connectors: [injected()],
  transports: {
    // Two public Arc RPCs with batching: if one rate-limits (HTTP 429), reads fall through to the other.
    [arcTestnet.id]: fallback(
      [
        http('https://rpc.testnet.arc.network', { batch: true }),
        http(arcTestnet.rpcUrls.default.http[0], { batch: true }),
      ],
      { retryCount: 2 },
    ),
    [baseSepolia.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
