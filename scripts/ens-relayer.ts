/**
 * ens-relayer — publishes an ENS subname on Ethereum Sepolia for every fund created on Arc Testnet.
 *
 * Watches `IndexFactory.IndexCreated` on Arc, reads the fund's composition, fee and venue from the
 * fund contract, and calls `FundNamePublisher.publish` on Sepolia, which creates
 * `<label>.<parent>` with the fund metadata as ENS records. Safe to re-run: names that are already
 * published are skipped.
 *
 * Usage:
 *   bun run ens:relayer            # backfill from FROM_BLOCK, then keep watching
 *   bun run ens:relayer --once     # backfill and exit (good for a cron job)
 *   bun run ens:relayer --dry-run  # print what would be published, send nothing
 *
 * Env (bun loads .env automatically):
 *   INDEX_FACTORY_ADDRESS        IndexFactory on Arc Testnet (required)
 *   FUND_NAME_PUBLISHER_ADDRESS  FundNamePublisher on Sepolia (required)
 *   RELAYER_PRIVATE_KEY          allowlisted publisher key (required unless --dry-run)
 *   FROM_BLOCK                   Arc block to start scanning from (default: latest - 5000)
 *   ARC_RPC_URL, SEPOLIA_RPC_URL optional RPC overrides
 *   POLL_SECONDS (15), CHUNK_BLOCKS (5000)
 */

import { createPublicClient, createWalletClient, http, isAddress, parseAbi, parseAbiItem } from 'viem'
import type { Address, Hex, Log } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet, sepolia } from 'viem/chains'

const indexCreatedEvent = parseAbiItem(
  'event IndexCreated(address indexed fund, address indexed creator, string name, string symbol, string label, string description)',
)

const fundAbi = parseAbi([
  'function getTokens() view returns (address[])',
  'function getWeights() view returns (uint16[])',
  'function feeBps() view returns (uint16)',
  'function venue() view returns (address)',
])

const erc20Abi = parseAbi(['function symbol() view returns (string)'])

const publisherAbi = parseAbi([
  'struct Holding { address token; string symbol; uint16 weightBps; }',
  'struct FundRecord { string label; address fund; address creator; address venue; string name; string symbol; string description; uint16 feeBps; uint64 createdAt; Holding[] holdings; }',
  'function publish(FundRecord r) returns (bytes32)',
  'function isPublished(string label) view returns (bool)',
  'function fullName(string label) view returns (string)',
])

type IndexCreatedLog = Log<bigint, number, false, typeof indexCreatedEvent, true>

function requireAddress(name: string): Address {
  const value = process.env[name]?.trim()
  if (!value || !isAddress(value)) throw new Error(`${name} must be set to a 0x address`)
  return value
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

const args = new Set(process.argv.slice(2))
const once = args.has('--once')
const dryRun = args.has('--dry-run')

const factory = requireAddress('INDEX_FACTORY_ADDRESS')
const publisher = requireAddress('FUND_NAME_PUBLISHER_ADDRESS')
const pollMs = intEnv('POLL_SECONDS', 15) * 1000
const chunk = BigInt(intEnv('CHUNK_BLOCKS', 5000))

const arc = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || undefined) })
const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || undefined) })

function walletClient() {
  const key = process.env.RELAYER_PRIVATE_KEY?.trim()
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('RELAYER_PRIVATE_KEY must be set to a 0x-prefixed 32-byte key (or use --dry-run)')
  }
  return createWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL || undefined),
  })
}

const wallet = dryRun ? undefined : walletClient()

async function buildRecord(log: IndexCreatedLog) {
  const { fund, creator, name, symbol, label, description } = log.args
  const [tokens, weights, feeBps, venue, block] = await Promise.all([
    arc.readContract({ address: fund, abi: fundAbi, functionName: 'getTokens' }),
    arc.readContract({ address: fund, abi: fundAbi, functionName: 'getWeights' }),
    arc.readContract({ address: fund, abi: fundAbi, functionName: 'feeBps' }),
    arc.readContract({ address: fund, abi: fundAbi, functionName: 'venue' }),
    arc.getBlock({ blockNumber: log.blockNumber }),
  ])
  const symbols = await Promise.all(
    tokens.map((token) => arc.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })),
  )
  return {
    label,
    fund,
    creator,
    venue,
    name,
    symbol,
    description,
    feeBps,
    createdAt: block.timestamp,
    holdings: tokens.map((token, i) => ({ token, symbol: symbols[i], weightBps: weights[i] })),
  }
}

/** Returns true when the fund is published (now or earlier), false when it should be retried. */
async function handle(log: IndexCreatedLog): Promise<boolean> {
  const { label, fund } = log.args
  const fullName = await sepoliaClient.readContract({
    address: publisher, abi: publisherAbi, functionName: 'fullName', args: [label],
  })
  const published = await sepoliaClient.readContract({
    address: publisher, abi: publisherAbi, functionName: 'isPublished', args: [label],
  })
  if (published) {
    console.log(`skip  ${fullName} (already published)`)
    return true
  }
  const record = await buildRecord(log)
  if (!wallet) {
    console.log(`dry   ${fullName} -> ${fund}`)
    console.log(JSON.stringify(record, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2))
    return true
  }
  try {
    const { request } = await sepoliaClient.simulateContract({
      account: wallet.account, address: publisher, abi: publisherAbi, functionName: 'publish', args: [record],
    })
    const hash = await wallet.writeContract(request)
    const receipt = await sepoliaClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
    console.log(`done  ${fullName} -> ${fund} (tx ${hash})`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    console.error(`fail  ${fullName} -> ${fund}: ${message}`)
    return false
  }
}

async function scan(fromBlock: bigint, toBlock: bigint): Promise<IndexCreatedLog[]> {
  const logs: IndexCreatedLog[] = []
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock
    logs.push(...(await arc.getLogs({ address: factory, event: indexCreatedEvent, fromBlock: start, toBlock: end, strict: true })))
  }
  return logs
}

async function main() {
  const latest = await arc.getBlockNumber()
  const fromEnv = process.env.FROM_BLOCK?.trim()
  let cursor = fromEnv ? BigInt(fromEnv) : latest > 5000n ? latest - 5000n : 0n
  let retry: IndexCreatedLog[] = []
  console.log(`watching IndexCreated on ${factory} (Arc) from block ${cursor}; publishing via ${publisher} (Sepolia)${dryRun ? ' [dry run]' : ''}`)

  for (;;) {
    const head = await arc.getBlockNumber()
    const fresh = cursor <= head ? await scan(cursor, head) : []
    cursor = head + 1n
    const pending = [...retry, ...fresh]
    retry = []
    for (const log of pending) {
      if (!(await handle(log))) retry.push(log)
    }
    if (once) {
      if (retry.length > 0) process.exitCode = 1
      return
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
