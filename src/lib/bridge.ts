// Base Sepolia -> Arc bridging of the stock tokens with Circle Bridge Kit (CCTPx).
// Progress lives in a module-level store so it survives navigation, and in
// localStorage so a reload can keep watching for the tokens to land on Arc.
import { useSyncExternalStore } from 'react'
import type { EIP1193Provider } from 'viem'
import { BRIDGEABLE } from './stocks'

export const BASE_EXPLORER = 'https://sepolia.basescan.org'

// CCTPx token ids (bytes32) per symbol, from the stock catalog.
export const TOKEN_ID: Record<string, `0x${string}`> = Object.fromEntries(BRIDGEABLE.map((s) => [s.symbol, s.tokenId]))

export const STEPS = [
  ['approve', 'Approve on Base Sepolia'],
  ['transfer', 'Burn on Base Sepolia'],
  ['fetchAttestation', 'Circle attestation'],
  ['forward', 'Mint on Arc (Circle relayer)'],
] as const
export type StepKey = (typeof STEPS)[number][0]
export type StepState = 'waiting' | 'active' | 'done' | 'error'

export type BridgeJob = {
  symbol: string
  token: `0x${string}`
  amount: string
  recipient: `0x${string}`
  before: string // recipient's Arc balance before, in base units
  startedAt: number
  steps: Record<StepKey, { state: StepState; tx?: string }>
  status: 'running' | 'done' | 'error'
  error?: string
}

const KEY = 'inphinity.bridge.job'
const load = (): BridgeJob | null => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') } catch { return null }
}
let job: BridgeJob | null = load()
const listeners = new Set<() => void>()
function set(next: BridgeJob | null) {
  job = next
  try { next ? localStorage.setItem(KEY, JSON.stringify(next)) : localStorage.removeItem(KEY) } catch { /* storage unavailable */ }
  listeners.forEach((l) => l())
}
const update = (fn: (j: BridgeJob) => BridgeJob) => job && set(fn(job))
const step = (k: StepKey, state: StepState, tx?: string) =>
  update((j) => ({ ...j, steps: { ...j.steps, [k]: { state, tx: tx ?? j.steps[k].tx } } }))

export const useBridgeJob = () => useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => job)
export const clearJob = () => set(null)
export const markArrived = () => update((j) => ({
  ...j, status: 'done',
  steps: Object.fromEntries(STEPS.map(([k]) => [k, { ...j.steps[k], state: 'done' }])) as BridgeJob['steps'],
}))

type Params = { provider: EIP1193Provider; symbol: string; token: `0x${string}`; amount: string; recipient: `0x${string}`; before: bigint }

async function kitFor(provider: EIP1193Provider) {
  const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([
    import('@circle-fin/bridge-kit'), import('@circle-fin/adapter-viem-v2'),
  ])
  return { kit: new BridgeKit(), adapter: await createViemAdapterFromProvider({ provider }) }
}

const bridgeParams = (adapter: unknown, p: { symbol: string; amount: string; recipient: string }) => ({
  from: { adapter, chain: 'Base_Sepolia' },
  // CCTPx always pays Circle's relayer to mint on the destination, so only an address is needed on Arc.
  to: { recipientAddress: p.recipient, chain: 'Arc_Testnet', useForwarder: true },
  amount: p.amount,
  token: TOKEN_ID[p.symbol],
}) as never

/** Circle's fee for the transfer (paid in Base Sepolia ETH with the burn). */
export async function estimateFee(provider: EIP1193Provider, p: { symbol: string; amount: string; recipient: string }) {
  const { kit, adapter } = await kitFor(provider)
  const est = await kit.estimate(bridgeParams(adapter, p))
  const f = est.fees?.[0]
  return f ? `${Number(f.amount).toPrecision(3)} ${f.token}` : null
}

export async function startBridge(p: Params) {
  set({
    symbol: p.symbol, token: p.token, amount: p.amount, recipient: p.recipient, before: p.before.toString(),
    startedAt: Date.now(), status: 'running',
    steps: { approve: { state: 'active' }, transfer: { state: 'waiting' }, fetchAttestation: { state: 'waiting' }, forward: { state: 'waiting' } },
  })
  try {
    const { kit, adapter } = await kitFor(p.provider)
    type Ev = { values?: { transactionHash?: string; status?: string } }
    const on = (m: 'approve' | 'transfer' | 'fetchAttestation' | 'forward', fn: (e: Ev) => void) => kit.on(m, fn as never)
    // Bridge Kit also reports a failed step, so only a step with a transaction hash counts as done.
    on('approve', (e) => { if (e.values?.transactionHash) { step('approve', 'done', e.values.transactionHash); step('transfer', 'active') } })
    on('transfer', (e) => { if (e.values?.transactionHash) { step('approve', 'done'); step('transfer', 'done', e.values.transactionHash); step('fetchAttestation', 'active') } })
    on('fetchAttestation', (e) => { if (e.values?.status === 'complete') { step('fetchAttestation', 'done'); step('forward', 'active') } })
    on('forward', (e) => step('forward', 'done', e.values?.transactionHash))
    const res = await kit.bridge(bridgeParams(adapter, p)) as { state: string; steps: { name: string; state: string; errorMessage?: string; error?: { message?: string } }[] }
    if (res.state === 'success') return markArrived()
    const bad = res.steps.find((s) => s.state === 'error')
    throw new Error(bad?.errorMessage ?? bad?.error?.message ?? `Bridge ended in state ${res.state}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const nice = /reject|denied|cancel/i.test(msg) ? 'Cancelled in your wallet.'
      : /insufficient funds|exceeds balance/i.test(msg) ? 'Not enough Base Sepolia ETH for gas and the Circle fee.'
      : msg.split('\n')[0]
    update((j) => {
      // If the burn already happened, the relayer still mints on Arc: keep watching instead of failing.
      if (j.steps.transfer.state === 'done' && !/reject|denied|cancel/i.test(msg)) return { ...j, error: `Lost track of the relayer (${nice}). Still watching your Arc balance.` }
      const k = (STEPS.find(([s]) => j.steps[s].state === 'active')?.[0]) ?? 'approve'
      return { ...j, status: 'error', error: nice, steps: { ...j.steps, [k]: { ...j.steps[k], state: 'error' } } }
    })
  }
}
