/**
 * ENSv2 fund names on Sepolia: every Inphinity fund is mirrored as <label>.inphinity.eth by the
 * relayer in ens/ (see ens/DESIGN.md). Names resolve through the ENSv2 Universal Resolver with
 * Arc Testnet's ENSIP-11 coin type. Read-only: the app never writes to ENS.
 */
import { useQuery } from '@tanstack/react-query'
import { createPublicClient, http, type Address } from 'viem'
import { sepolia } from 'viem/chains'

export const ENS_PARENT = 'inphinity.eth'
export const ENS_APP = 'https://sepolia.app.ens.domains'
/** ENSv2 Universal Resolver on Sepolia. viem's built-in default is the older one. */
const UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' as const
/** 0x80000000 | 5042002: Arc Testnet addresses (ENSIP-11). Funds have no coin type 60 address. */
export const ARC_COIN_TYPE = 0x80000000n | 5042002n

const client = createPublicClient({
  chain: sepolia,
  transport: http(import.meta.env.VITE_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'),
})
const ur = { universalResolverAddress: UNIVERSAL_RESOLVER } as const

const RESERVED = ['latest', 'www', 'app', 'admin', 'official', 'support']

/** Same rules as ens/src/lib.ts sanitizeLabel: a-z0-9 and '-', 3 to 32 chars. */
export function ensLabel(input: string): string | null {
  let s = input.normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > 32) s = s.slice(0, 32).replace(/-+$/g, '')
  if (s.length < 3 || s.slice(2, 4) === '--' || RESERVED.includes(s)) return null
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s) ? s : null
}

/** The name a new fund will get, if the label is free (the relayer adds -2, -3 on collisions). */
export function expectedEnsName(symbol: string, name: string): string | null {
  const l = ensLabel(symbol) ?? ensLabel(name)
  return l ? `${l}.${ENS_PARENT}` : null
}

const KEYS = ['inphinity.weights', 'inphinity.fee', 'inphinity.creator', 'inphinity.symbol', 'inphinity.chain', 'inphinity.ccip'] as const
export type FundEns = { name: string; records: Partial<Record<(typeof KEYS)[number], string>> }

async function arcAddressOf(name: string) {
  return client.getEnsAddress({ name, coinType: ARC_COIN_TYPE, ...ur }).catch(() => null)
}

/** Finds the ENS name whose Arc address is this fund, trying the labels the relayer would use. */
async function findFundEns(fund: Address, symbol: string, fundName: string): Promise<FundEns | null> {
  const base = ensLabel(symbol) ?? ensLabel(fundName)
  if (!base) return null
  for (let n = 1; n <= 5; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const name = `${base.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}.${ENS_PARENT}`
    const addr = await arcAddressOf(name)
    if (!addr) return null // labels are handed out in order, so the first gap ends the search
    if (addr.toLowerCase() !== fund.toLowerCase()) continue // taken by another fund
    const values = await Promise.all(KEYS.map((key) => client.getEnsText({ name, key, ...ur }).catch(() => null)))
    const records: FundEns['records'] = {}
    KEYS.forEach((k, i) => { if (values[i]) records[k] = values[i]! })
    return { name, records }
  }
  return null
}

export function useFundEns(fund: Address | undefined, symbol: string | undefined, name: string | undefined) {
  return useQuery({
    queryKey: ['fund-ens', fund?.toLowerCase(), symbol, name],
    queryFn: () => findFundEns(fund!, symbol!, name!),
    enabled: !!fund && !!symbol && !!name,
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data ? false : 30_000), // keep checking until the relayer has named it
  })
}

export const ensAppUrl = (name: string) => `${ENS_APP}/${name}`
/** Chainlink CCIP explorer page for the message that created the name. */
export const ccipMessageUrl = (messageId: string) => `https://ccip.chain.link/msg/${messageId}`

/** Every text record the relayer writes for a fund, in display order. */
export const PROFILE_KEYS = [
  'name', 'description', 'url', 'inphinity.symbol', 'inphinity.weights', 'inphinity.tokens', 'inphinity.fee',
  'inphinity.creator', 'inphinity.chain', 'inphinity.index', 'inphinity.ccip', 'inphinity.disclaimer',
] as const
export type EnsProfile = {
  name: string
  fund: Address | null // ENSIP-11 Arc Testnet address record
  resolver: Address | null
  records: Partial<Record<(typeof PROFILE_KEYS)[number], string>>
}

/** Reads a fund name's Arc address and all its text records through the ENSv2 Universal Resolver. */
export async function readEnsProfile(name: string): Promise<EnsProfile> {
  const [fund, resolver, ...values] = await Promise.all([
    arcAddressOf(name),
    client.getEnsResolver({ name, ...ur }).catch(() => null),
    ...PROFILE_KEYS.map((key) => client.getEnsText({ name, key, ...ur }).catch(() => null)),
  ])
  const records: EnsProfile['records'] = {}
  PROFILE_KEYS.forEach((k, i) => { if (values[i]) records[k] = values[i]! })
  return { name, fund: (fund as Address | null) ?? null, resolver: (resolver as Address | null) ?? null, records }
}

export function useEnsProfile(name: string) {
  return useQuery({ queryKey: ['ens-profile', name], queryFn: () => readEnsProfile(name), staleTime: 60_000 })
}

export const ensExplorerRecordsUrl = (name: string) => `https://sepolia.explorer.ens.domains/${name}/records`
