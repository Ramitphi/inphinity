import { useEffect, useState } from 'react'
import { useAccount, useBalance, useReadContract, useReadContracts, useSwitchChain } from 'wagmi'
import { arcTestnet, baseSepolia } from 'viem/chains'
import { erc20Abi, formatUnits, type EIP1193Provider } from 'viem'
import { EXPLORER } from '../lib/contracts'
import { short, ticker, units } from '../lib/format'
import { Link } from '../lib/router'
import { BASE_EXPLORER, STEPS, TOKEN_ID, clearJob, estimateFee, markArrived, startBridge, useBridgeJob, type BridgeJob } from '../lib/bridge'
import { useStocks } from '../hooks/data'
import { AmountInput, KV, useDebounced, useNow } from '../components/ui'
import { parse } from './Markets'

export function Bridge() {
  const job = useBridgeJob()
  return (
    <>
      <h2 className="title">Bridge from Base</h2>
      <div className="sub">Move tokenized stocks from Base Sepolia to Arc with Circle Bridge Kit (CCTPx). They land in your own wallet on Arc.</div>
      <div className="split">
        <div>{job ? <Progress job={job} /> : <BridgeForm />}</div>
        <div>
          <div className="box">
            <h3>Route</h3>
            <div className="in">
              <KV k="From">Base Sepolia</KV>
              <KV k="To">Arc Testnet</KV>
              <KV k="Protocol">Circle CCTPx · Bridge Kit</KV>
              <KV k="Finality">Standard · ~15-20 min</KV>
              <KV k="Mint on Arc">Circle relayer (no Arc gas)</KV>
            </div>
          </div>
          <div className="box">
            <h3>How it works</h3>
            <div className="in">
              <ol style={{ paddingLeft: 22, margin: 0, lineHeight: 1.35, listStyle: 'decimal' }}>
                <li>Approve the stock to its CCTPx token manager on Base.</li>
                <li>The token is burned on Base; Circle's fee is paid in Base ETH.</li>
                <li>Circle attests the burn once Base finalizes.</li>
                <li>Circle's relayer mints the same amount to you on Arc.</li>
              </ol>
              <div className="note">Same token address on both chains. Testnet mock, not real securities.</div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function BridgeForm() {
  const { address, chainId, connector, isConnected } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { stocks } = useStocks()
  const [symbol, setSymbol] = useState('tAAPL')
  const [amount, setAmount] = useState('')
  const [fee, setFee] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const debounced = useDebounced(amount, 500)
  const stock = stocks.find((s) => s.symbol === symbol)
  const onBase = chainId === baseSepolia.id

  const baseBals = useReadContracts({
    contracts: address ? stocks.map((s) => ({ chainId: baseSepolia.id, address: s.token, abi: erc20Abi, functionName: 'balanceOf', args: [address] }) as const) : [],
    query: { enabled: !!address && stocks.length > 0, refetchInterval: 15_000 },
  })
  const balOf = (sym: string) => {
    const i = stocks.findIndex((s) => s.symbol === sym)
    return baseBals.data?.[i]?.result as bigint | undefined
  }
  const bal = balOf(symbol)
  const eth = useBalance({ address, chainId: baseSepolia.id, query: { enabled: !!address } })
  const arcBal = useReadContract({
    chainId: arcTestnet.id, address: stock?.token, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined,
    query: { enabled: !!address && !!stock },
  })
  const amt = parse(debounced, 18)

  useEffect(() => {
    setFee(null)
    if (!connector || !address || amt === 0n) return
    let live = true
    connector.getProvider()
      .then((provider) => estimateFee(provider as EIP1193Provider, { symbol, amount: debounced, recipient: address }))
      .then((f) => live && setFee(f))
      .catch(() => live && setFee(null))
    return () => { live = false }
  }, [connector, address, symbol, debounced, amt])

  let problem: string | null = null
  if (amt > 0n && bal !== undefined && amt > bal) problem = bal === 0n ? `You have no ${ticker(symbol)} on Base Sepolia.` : `You only have ${units(bal)} ${ticker(symbol)} on Base Sepolia.`
  else if (onBase && eth.data && eth.data.value === 0n) problem = 'You need Base Sepolia ETH for gas and the Circle fee.'

  async function go() {
    if (!connector || !address || !stock || amt === 0n) return
    setBusy(true)
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider
      await startBridge({ provider, symbol, token: stock.token, amount: debounced, recipient: address, before: (arcBal.data as bigint | undefined) ?? 0n })
    } finally { setBusy(false) }
  }

  return (
    <div className="box">
      <h3>Send to Arc</h3>
      <div className="in">
        <div className="lbl"><span>Stock</span><span>Your balance on Base Sepolia</span></div>
        <div className="picker" style={{ margin: '6px 0 14px' }}>
          {stocks.map((s) => (
            <button key={s.token} className={s.symbol === symbol ? 'on' : ''} onClick={() => setSymbol(s.symbol)} aria-pressed={s.symbol === symbol} disabled={!TOKEN_ID[s.symbol]}>
              <div className="sym">{ticker(s.symbol)}</div>
              <div className="name">{address ? units(balOf(s.symbol)) : s.company}</div>
            </button>
          ))}
        </div>
        <label className="lbl" htmlFor="bridge-amt">
          <span>Amount</span>
          {bal !== undefined && bal > 0n && <button onClick={() => setAmount(formatUnits(bal, 18))}>Max {units(bal)}</button>}
        </label>
        <AmountInput id="bridge-amt" value={amount} onChange={setAmount} unit={ticker(symbol)} decimals={18} bad={!!problem} />
        <KV k="Recipient on Arc">{address ? `${short(address)} (you)` : '—'}</KV>
        <KV k="You receive on Arc">{amt > 0n ? `${units(amt)} ${ticker(symbol)}` : '—'}</KV>
        <KV k="Circle fee (Base ETH)">{amt === 0n ? '—' : fee ?? 'quoting…'}</KV>
        <KV k="Base Sepolia ETH">{eth.data ? Number(formatUnits(eth.data.value, 18)).toFixed(5) : '—'}</KV>
        {problem && <div className="alert">{problem}</div>}
        {!isConnected ? <div className="info">Connect a wallet to bridge.</div>
          : !onBase ? (
            <button className="btn solid block" style={{ marginTop: 12 }} disabled={switching} onClick={() => switchChain({ chainId: baseSepolia.id })}>
              {switching ? 'Switching…' : 'Switch to Base Sepolia'}
            </button>
          ) : (
            <button className="btn solid block" style={{ marginTop: 12 }} disabled={busy || amt === 0n || !!problem} onClick={go}>
              {busy ? 'Confirm in your wallet…' : `Approve & bridge ${ticker(symbol)}`}
            </button>
          )}
        <div className="note">
          Two wallet steps on Base Sepolia: approve, then the transfer (which carries Circle's fee). Need test tokens on Base? The issuer mints them; ETH for gas comes from a Base Sepolia faucet.
        </div>
      </div>
    </div>
  )
}

function Progress({ job }: { job: BridgeJob }) {
  const now = useNow()
  const { chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const arc = useReadContract({
    chainId: arcTestnet.id, address: job.token, abi: erc20Abi, functionName: 'balanceOf', args: [job.recipient],
    query: { enabled: job.status === 'running', refetchInterval: 15_000 },
  })
  const arrived = arc.data !== undefined && arc.data > BigInt(job.before)
  useEffect(() => { if (arrived && job.status === 'running') markArrived() }, [arrived, job.status])

  const secs = Math.floor((now - job.startedAt) / 1000)
  const elapsed = `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`
  const sym = ticker(job.symbol)
  const mark = (s: string) => (s === 'done' ? '■' : s === 'active' ? '▶' : s === 'error' ? '✕' : '□')

  return (
    <div className="box">
      <h3>
        <span>Bridging {job.amount} {sym} → Arc</span>
        <span>{job.status === 'done' ? 'Arrived' : job.status === 'error' ? 'Stopped' : elapsed}</span>
      </h3>
      <div className="in">
        {STEPS.map(([k, label]) => {
          const s = job.steps[k]
          const link = s.tx && (k === 'forward' ? `${EXPLORER}/tx/${s.tx}` : `${BASE_EXPLORER}/tx/${s.tx}`)
          return (
            <div key={k} className="kv" style={{ alignItems: 'center' }}>
              <span className={s.state === 'error' ? 'down' : s.state === 'done' ? '' : s.state === 'active' ? '' : 'muted'}>
                <span className="mono" style={{ display: 'inline-block', width: 22 }}>{mark(s.state)}</span>{label}
              </span>
              <b>{link ? <a href={link} target="_blank" rel="noopener noreferrer">{short(s.tx)} ↗</a> : s.state === 'active' ? '…' : ''}</b>
            </div>
          )
        })}
        {job.status === 'running' && job.steps.transfer.state === 'done' && (
          <div className="info">Burned on Base. Waiting for Base Sepolia to finalize and Circle's relayer to mint on Arc, usually 15-20 minutes. You can leave this page; we keep watching your Arc balance.</div>
        )}
        {job.error && <div className={job.status === 'error' ? 'alert' : 'info'}>{job.error}</div>}
        {job.status === 'done' && (
          <div className="info">
            {job.amount} {sym} arrived in {short(job.recipient)} on Arc{arc.data !== undefined ? ` (balance ${units(arc.data)} ${sym})` : ''}.
          </div>
        )}
        <KV k="Arc balance now">{arc.data === undefined ? '—' : `${units(arc.data)} ${sym}`}</KV>
        <div className="row-actions">
          {job.status === 'done' && isConnected && chainId !== arcTestnet.id && <button className="btn solid" onClick={() => switchChain({ chainId: arcTestnet.id })}>Switch back to Arc</button>}
          {job.status === 'done' && <Link className="btn" to="/">Sell or invest on Arc →</Link>}
          {job.status !== 'running' && <button className="btn" onClick={clearJob}>{job.status === 'error' ? 'Try again' : 'Bridge more'}</button>}
          {job.status === 'running' && job.steps.transfer.state !== 'done' && job.error === undefined && <span className="note" style={{ margin: 0 }}>Confirm each step in your wallet.</span>}
        </div>
      </div>
    </div>
  )
}
