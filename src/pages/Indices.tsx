import { useState } from 'react'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { isAddress, type Abi, type Address } from 'viem'
import { EXPLORER, USDC, fundAbi } from '../lib/contracts'
import { qty, short, ticker, usd } from '../lib/format'
import { Link } from '../lib/router'
import { useTx } from '../lib/tx'
import { POLL, useFunds, useStocks, useUsdcBalance } from '../hooks/data'
import { AmountInput, Change, Flash, KV, Lcd, useDebounced, useNow } from '../components/ui'
import { parse } from './Markets'

const chainId = arcTestnet.id
const SHADES = ['#0a0a0a', '#4a4a4a', '#7a7a7a', '#a5a5a5', '#cfcfcf', '#2a2a2a', '#5f5f5f', '#909090', '#bababa', '#e2e2e2']

export function Indices() {
  const { funds, count, isLoading } = useFunds()
  return (
    <>
      <h2 className="title">Index funds</h2>
      <div className="sub">Baskets of tokenized stocks built by anyone. Invest USDC at NAV; the fund buys every stock at its target weight.</div>
      {!isLoading && count === 0 ? (
        <div className="empty">
          <p style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600 }}>No index funds yet.</p>
          <Link to="/create" className="btn solid">Create the first index →</Link>
        </div>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th>Fund</th>
              <th className="r">NAV / share</th>
              <th className="r hide-sm">Fund value</th>
              <th className="r hide-sm">Fee</th>
              <th className="r hide-sm">Creator</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5}><span className="skel" style={{ width: '100%' }} /></td></tr>}
            {funds.map((f) => (
              <tr key={f.address} className="click">
                <td>
                  <Link to={`/index/${f.address}`} style={{ textDecoration: 'none' }}>
                    <span style={{ fontWeight: 700, fontSize: 17 }}>{f.name}</span>{' '}
                    <span className="sym muted" style={{ fontSize: 13 }}>{f.symbol}</span>
                  </Link>
                </td>
                <Flash as="td" className="r" value={f.navPerShare === undefined ? undefined : Number(f.navPerShare)}>
                  <Link to={`/index/${f.address}`} style={{ textDecoration: 'none' }}><Lcd value={usd(f.navPerShare).replace(/,/g, '')} /></Link>
                </Flash>
                <td className="r mono hide-sm">${usd(f.nav)}</td>
                <td className="r mono hide-sm">{(f.feeBps / 100).toFixed(2)}%</td>
                <td className="r mono hide-sm">{short(f.creator)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="note">NAV is the value of the fund's stocks at the exchange's sell price. Fees accrue to the creator as new shares, at most 2% a year.</div>
    </>
  )
}

export function IndexDetail({ address }: { address: string }) {
  if (!isAddress(address)) return <div className="alert">That is not a valid fund address.</div>
  return <FundView fund={address} />
}

function FundView({ fund }: { fund: Address }) {
  const { address: user } = useAccount()
  const { byToken } = useStocks()
  const base = { chainId, address: fund, abi: fundAbi } as const
  const r = useReadContracts({
    contracts: [
      { ...base, functionName: 'name' }, { ...base, functionName: 'symbol' }, { ...base, functionName: 'creator' },
      { ...base, functionName: 'feeBps' }, { ...base, functionName: 'nav' }, { ...base, functionName: 'navPerShare' },
      { ...base, functionName: 'totalSupply' }, { ...base, functionName: 'holdings' },
    ],
    query: { refetchInterval: POLL },
  })
  const pos = useReadContracts({
    contracts: user ? [
      { ...base, functionName: 'balanceOf', args: [user] }, { ...base, functionName: 'lockedSharesOf', args: [user] },
      { ...base, functionName: 'unlockTime', args: [user] },
    ] : [],
    query: { enabled: !!user, refetchInterval: POLL },
  })
  const d = r.data
  if (r.isLoading) return <div className="sub">Loading fund…</div>
  if (!d || d[0].status === 'failure') return <div className="alert">Could not load this fund. Is the address an Inphinity index?</div>
  const name = d[0].result as string, symbol = d[1].result as string, creator = d[2].result as Address
  const feeBps = Number(d[3].result ?? 0), nav = d[4].result as bigint | undefined, nps = d[5].result as bigint | undefined
  const supply = d[6].result as bigint | undefined
  const [hTokens = [], hBalances = [], hWeights = []] = (d[7].result ?? []) as [readonly Address[], readonly bigint[], readonly number[]]
  const holdings = hTokens.map((t, i) => {
    const s = byToken.get(t.toLowerCase())
    const value = s ? (hBalances[i] * s.price) / 10n ** 18n : undefined
    return { token: t, sym: s ? ticker(s.symbol) : short(t), company: s?.company ?? '', weight: Number(hWeights[i]), units: hBalances[i], value, change: s?.change }
  })
  const blended = holdings.reduce((a, h) => a + (h.change ?? 0) * h.weight / 10000, 0)
  const shares = pos.data?.[0]?.result as bigint | undefined
  const locked = pos.data?.[1]?.result as bigint | undefined
  const unlock = pos.data?.[2]?.result as bigint | undefined
  const refresh = () => { r.refetch(); pos.refetch() }

  return (
    <div className="split">
      <div>
        <div className="eyebrow">
          Index · created by <a href={`${EXPLORER}/address/${creator}`} target="_blank" rel="noopener noreferrer">{short(creator)}</a> ·{' '}
          <a href={`${EXPLORER}/address/${fund}`} target="_blank" rel="noopener noreferrer">contract ↗</a>
        </div>
        <h2 className="title">{name} <span className="sym muted" style={{ fontSize: 18 }}>{symbol}</span></h2>
        <div className="navbig">
          <div>
            <div className="stat">NAV per share</div>
            <Flash value={nps === undefined ? undefined : Number(nps)} as="div"><Lcd big value={usd(nps).replace(/,/g, '')} /></Flash>
          </div>
          <div><Change v={blended} /><div className="stat" style={{ marginTop: 4 }}>vs listing</div></div>
          <div className="stat">Fund value<b>${usd(nav)}</b></div>
          <div className="stat">Fee<b>{(feeBps / 100).toFixed(2)}% / yr</b></div>
          <div className="stat">Shares out<b>{qty(supply, 2)}</b></div>
        </div>
        <table className="board">
          <thead><tr><th>Holding</th><th className="r">Target</th><th className="r hide-sm">Units</th><th className="r">Value</th><th className="r">Change</th></tr></thead>
          <tbody>
            {holdings.map((h, i) => (
              <tr key={h.token}>
                <td><span className="sym"><i style={{ display: 'inline-block', width: 10, height: 10, background: SHADES[i % SHADES.length], border: '1px solid #0a0a0a', marginRight: 6 }} />{h.sym}</span> <span className="name hide-sm">{h.company}</span></td>
                <td className="r mono">{(h.weight / 100).toFixed(h.weight % 100 ? 2 : 0)}%</td>
                <td className="r mono hide-sm">{qty(h.units, 3)}</td>
                <td className="r mono">{usd(h.value)}</td>
                <td className="r"><Change v={h.change} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="wbar" title="Target weights">
          {holdings.map((h, i) => <span key={h.token} style={{ width: `${h.weight / 100}%`, background: SHADES[i % SHADES.length] }} />)}
        </div>
        {supply === 0n && <div className="info">No investors yet. The first investment sets the starting NAV at 1.00 USDC per share.</div>}
      </div>
      <div>
        <InvestBox fund={fund} symbol={symbol} shares={shares} locked={locked} onDone={refresh} />
        <div className="box">
          <h3>Your position</h3>
          <div className="in">
            {!user ? <div className="note" style={{ marginTop: 0 }}>Connect a wallet to see your position.</div> : (
              <>
                <KV k="Shares">{qty(shares, 4)} {symbol}</KV>
                <KV k="Value">${shares !== undefined && nps !== undefined ? usd((shares * nps) / 10n ** 18n) : '—'}</KV>
                {locked !== undefined && locked > 0n && <LockNotice locked={locked} unlock={unlock} symbol={symbol} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function LockNotice({ locked, unlock, symbol }: { locked: bigint; unlock?: bigint; symbol: string }) {
  const now = useNow()
  const left = unlock ? Math.max(0, Math.ceil(Number(unlock) - now / 1000)) : 0
  return <KV k="Locked (new shares)">{qty(locked, 4)} {symbol}{left > 0 ? ` · ${left}s` : ''}</KV>
}

function InvestBox({ fund, symbol, shares, locked, onDone }: { fund: Address; symbol: string; shares?: bigint; locked?: bigint; onDone: () => void }) {
  const { isConnected } = useAccount()
  const [side, setSide] = useState<'invest' | 'redeem'>('invest')
  const [amount, setAmount] = useState('')
  const debounced = useDebounced(amount)
  const isInvest = side === 'invest'
  const amt = parse(debounced, isInvest ? 6 : 18)
  const usdcBal = useUsdcBalance()
  const { send, ensureAllowance, busy } = useTx()
  const preview = useReadContract({
    chainId, address: fund, abi: fundAbi, functionName: isInvest ? 'previewInvest' : 'previewRedeem', args: [amt],
    query: { enabled: amt > 0n && (!isInvest || amt >= 1_000_000n) },
  })
  const out = amt > 0n ? (preview.data as bigint | undefined) : undefined
  const minOut = out !== undefined ? (out * 995n) / 1000n : undefined
  const free = shares !== undefined ? shares - (locked ?? 0n) : undefined

  let problem: string | null = null
  if (isInvest && amt > 0n && amt < 1_000_000n) problem = 'Minimum investment is 1 USDC.'
  else if (isInvest && usdcBal.data !== undefined && amt > usdcBal.data) problem = `You only have ${usd(usdcBal.data)} USDC.`
  else if (!isInvest && free !== undefined && amt > free) problem = locked && locked > 0n
    ? `Only ${qty(free)} ${symbol} can be redeemed now; ${qty(locked)} are still locked (about 60s after investing).`
    : `You only have ${qty(free)} ${symbol}.`
  else if (preview.error && amt > 0n) problem = 'Could not preview this amount (a stock price may be stale or the exchange short of inventory).'

  async function execute() {
    if (minOut === undefined || amt === 0n) return
    if (isInvest && !(await ensureAllowance(USDC, fund, amt, 'USDC'))) return
    const res = await send(isInvest ? `Invest in ${symbol}` : `Redeem ${symbol}`, {
      address: fund, abi: fundAbi as Abi, functionName: side, args: [amt, minOut],
    })
    if (res) { setAmount(''); onDone(); usdcBal.refetch() }
  }

  return (
    <div className="box">
      <div className="seg">
        <button className={isInvest ? 'on' : ''} onClick={() => { setSide('invest'); setAmount('') }}>Invest</button>
        <button className={!isInvest ? 'on' : ''} onClick={() => { setSide('redeem'); setAmount('') }}>Redeem</button>
      </div>
      <div className="in">
        <label className="lbl" htmlFor="fund-amt">
          <span>{isInvest ? 'You pay' : 'You redeem'}</span>
          {isInvest && usdcBal.data !== undefined && <button onClick={() => setAmount((Number(usdcBal.data) / 1e6).toFixed(2))}>Balance {usd(usdcBal.data)}</button>}
          {!isInvest && free !== undefined && free > 0n && <button onClick={() => setAmount((Number(free) / 1e18).toString())}>Max {qty(free)}</button>}
        </label>
        <AmountInput id="fund-amt" value={amount} onChange={setAmount} unit={isInvest ? 'USDC' : symbol} decimals={isInvest ? 6 : 18} bad={!!problem} />
        <KV k="You receive (est.)">{out === undefined ? '—' : isInvest ? `${qty(out)} ${symbol}` : `${usd(out)} USDC`}</KV>
        <KV k="Minimum after 0.5% slippage">{minOut === undefined ? '—' : isInvest ? `${qty(minOut)} ${symbol}` : `${usd(minOut)} USDC`}</KV>
        <KV k="Trading cost (spread)">0.5%</KV>
        {problem && <div className="alert">{problem}</div>}
        {!isConnected ? <div className="info">Connect a wallet to invest.</div> : (
          <button className="btn solid block" style={{ marginTop: 12 }} disabled={!!busy || amt === 0n || minOut === undefined || !!problem} onClick={execute}>
            {busy ? `${busy}…` : isInvest ? 'Approve & invest' : 'Redeem for USDC'}
          </button>
        )}
        <div className="note">
          {isInvest
            ? 'The fund buys each stock at its target weight from the exchange. New shares can be redeemed after about 60 seconds.'
            : 'The fund sells your share of every holding back to the exchange and pays you USDC.'}
        </div>
      </div>
    </div>
  )
}
