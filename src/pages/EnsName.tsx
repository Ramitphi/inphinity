import { useReadContracts } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import type { Address } from 'viem'
import { EXPLORER, FACTORY, factoryAbi, fundAbi, COMPANY } from '../lib/contracts'
import { ccipMessageUrl, ensAppUrl, ensExplorerRecordsUrl, useEnsProfile, PROFILE_KEYS } from '../lib/ens'
import { short, usd, qty } from '../lib/format'
import { Link } from '../lib/router'
import { KV, Lcd } from '../components/ui'
import { POLL } from '../hooks/data'

const chainId = arcTestnet.id
const SHADES = ['#0a0a0a', '#4a4a4a', '#7a7a7a', '#a5a5a5', '#cfcfcf', '#2a2a2a', '#5f5f5f', '#909090', '#bababa', '#e2e2e2']
const ext = { target: '_blank', rel: 'noopener noreferrer' } as const
const LABELS: Record<string, string> = {
  name: 'Name', description: 'Description', url: 'Website', 'inphinity.symbol': 'Symbol',
  'inphinity.weights': 'Weights (bps)', 'inphinity.tokens': 'Token addresses (Arc)', 'inphinity.fee': 'Fee (bps / yr)',
  'inphinity.creator': 'Creator', 'inphinity.chain': 'Chain', 'inphinity.index': 'Factory index',
  'inphinity.ccip': 'CCIP message', 'inphinity.disclaimer': 'Disclaimer',
}

const parseWeights = (s?: string) => (s ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
  const [sym, bps] = p.split(':')
  return { sym, bps: Number(bps) }
}).filter((w) => w.sym && Number.isFinite(w.bps))
const pctOf = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`

/** Public profile of a fund's ENS name, read live from Sepolia ENSv2 and checked against Arc. */
export function EnsName({ name }: { name: string }) {
  const q = useEnsProfile(name)
  const p = q.data
  const r = p?.records ?? {}
  const weights = parseWeights(r['inphinity.weights'])
  const tokens = (r['inphinity.tokens'] ?? '').split(',').filter(Boolean)
  const fund = p?.fund ?? undefined

  // Live fund state on Arc, plus what the chain says about the same fields.
  const base = { chainId, address: fund as Address, abi: fundAbi } as const
  const chain = useReadContracts({
    contracts: fund ? [
      { ...base, functionName: 'navPerShare' }, { ...base, functionName: 'nav' }, { ...base, functionName: 'totalSupply' },
      { ...base, functionName: 'creator' }, { ...base, functionName: 'getWeights' }, { ...base, functionName: 'feeBps' },
      { chainId, address: FACTORY, abi: factoryAbi, functionName: 'isIndex', args: [fund] },
    ] : [],
    query: { enabled: !!fund, refetchInterval: POLL },
  })
  const c = chain.data
  const nps = c?.[0]?.result as bigint | undefined
  const aum = c?.[1]?.result as bigint | undefined
  const supply = c?.[2]?.result as bigint | undefined
  const creatorOnchain = c?.[3]?.result as Address | undefined
  const weightsOnchain = c?.[4]?.result as readonly number[] | undefined
  const feeOnchain = c?.[5]?.result as number | undefined
  const isIndex = c?.[6]?.result as boolean | undefined
  const checks = c ? [
    { label: 'Registered by the Inphinity factory', ok: isIndex === true },
    { label: 'Creator matches the fund contract', ok: !!creatorOnchain && creatorOnchain.toLowerCase() === r['inphinity.creator']?.toLowerCase() },
    { label: 'Weights match the fund contract', ok: !!weightsOnchain && weightsOnchain.length === weights.length && weightsOnchain.every((w, i) => Number(w) === weights[i].bps) },
    { label: 'Fee matches the fund contract', ok: feeOnchain !== undefined && Number(feeOnchain) === Number(r['inphinity.fee']) },
  ] : []

  if (q.isLoading) return <div className="sub">Resolving {name} on Sepolia…</div>
  if (q.error) return <div className="alert">Could not reach ENS on Sepolia: {String(q.error).split('\n')[0]}</div>
  // Unknown labels fall back to the parent's wildcard records, so a fund name must carry an Arc address.
  if (!p || !p.fund) {
    return (
      <>
        <h2 className="title">{name}</h2>
        <div className="alert">No fund records found for this name. Funds are named over Chainlink CCIP a few minutes after creation, and only if the naming fee could be paid.</div>
        <div className="row-actions"><Link className="btn" to="/indices">Browse indices</Link></div>
      </>
    )
  }
  const fee = Number(r['inphinity.fee'] ?? feeOnchain ?? 0)
  return (
    <div className="split">
      <div>
        <div className="eyebrow">ENS profile · Sepolia ENSv2 · <a href={ensExplorerRecordsUrl(name)} {...ext}>ENS explorer ↗</a></div>
        <h2 className="title">{r.name ?? name} {r['inphinity.symbol'] && <span className="sym muted" style={{ fontSize: 18 }}>{r['inphinity.symbol']}</span>}</h2>
        <div className="sub mono">{name}</div>
        {r.description && <div className="note" style={{ marginTop: 4 }}>{r.description}</div>}

        <div className="navbig">
          <div>
            <div className="stat">NAV per share (live, Arc)</div>
            <Lcd big value={nps === undefined ? '—' : usd(nps).replace(/,/g, '')} />
          </div>
          <div className="stat">AUM<b>${usd(aum)}</b></div>
          <div className="stat">Fee<b>{(fee / 100).toFixed(2)}% / yr</b></div>
          <div className="stat">Shares out<b>{qty(supply, 2)}</b></div>
        </div>

        <h3 style={{ marginTop: 18 }}>Allocation</h3>
        <table className="board">
          <thead><tr><th>Stock</th><th className="hide-sm">Company</th><th className="r">Weight</th><th className="r hide-sm">Token (Arc)</th></tr></thead>
          <tbody>
            {weights.map((w, i) => (
              <tr key={w.sym}>
                <td><span className="sym"><i style={{ display: 'inline-block', width: 10, height: 10, background: SHADES[i % SHADES.length], border: '1px solid #0a0a0a', marginRight: 6 }} />{w.sym.replace(/^t/, '')}</span></td>
                <td className="name hide-sm">{COMPANY[w.sym] ?? ''}</td>
                <td className="r mono">{pctOf(w.bps)}</td>
                <td className="r mono hide-sm">{tokens[i] ? <a href={`${EXPLORER}/address/${tokens[i]}`} {...ext}>{short(tokens[i])}</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="wbar" title="Weights from ENS">
          {weights.map((w, i) => <span key={w.sym} style={{ width: `${w.bps / 100}%`, background: SHADES[i % SHADES.length] }} />)}
        </div>

        <h3 style={{ marginTop: 18 }}>All ENS records</h3>
        <table className="board">
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>
            {PROFILE_KEYS.filter((k) => r[k]).map((k) => (
              <tr key={k}>
                <td><div>{LABELS[k]}</div><div className="mono muted" style={{ fontSize: 11 }}>{k}</div></td>
                <td className="mono" style={{ wordBreak: 'break-all', fontSize: 13 }}><RecordValue k={k} v={r[k]!} /></td>
              </tr>
            ))}
            {p.fund && (
              <tr>
                <td><div>Arc address</div><div className="mono muted" style={{ fontSize: 11 }}>addr (coin type 2152525650)</div></td>
                <td className="mono" style={{ wordBreak: 'break-all', fontSize: 13 }}><a href={`${EXPLORER}/address/${p.fund}`} {...ext}>{p.fund}</a></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <div className="box">
          <h3>Identity</h3>
          <div className="in">
            <KV k="ENS name"><span className="mono">{name}</span></KV>
            {r['inphinity.creator'] && <KV k="Creator"><a className="mono" href={`${EXPLORER}/address/${r['inphinity.creator']}`} {...ext}>{short(r['inphinity.creator'])}</a></KV>}
            {p.fund && <KV k="Fund on Arc"><a className="mono" href={`${EXPLORER}/address/${p.fund}`} {...ext}>{short(p.fund)}</a></KV>}
            {p.resolver && <KV k="Resolver"><span className="mono">{short(p.resolver)}</span></KV>}
            {r['inphinity.ccip'] && <KV k="Named via"><a className="mono" href={ccipMessageUrl(r['inphinity.ccip'])} {...ext}>CCIP {short(r['inphinity.ccip'])} ↗</a></KV>}
            {p.fund && <div className="row-actions"><Link className="btn solid block" to={`/index/${p.fund}`}>Invest in this fund →</Link></div>}
          </div>
        </div>
        <div className="box">
          <h3>Verified against Arc</h3>
          <div className="in">
            {!c ? <div className="note" style={{ marginTop: 0 }}>Reading the fund contract…</div> : checks.map((x) => (
              <KV key={x.label} k={x.label}><span className={x.ok ? 'up' : 'down'}>{x.ok ? '✓ match' : '✗ mismatch'}</span></KV>
            ))}
            <div className="note">ENS records are written once, over Chainlink CCIP, from the fund's onchain data. These checks re-read the live contract.</div>
          </div>
        </div>
        <div className="box">
          <h3>Open elsewhere</h3>
          <div className="in">
            <KV k="ENS explorer"><a href={ensExplorerRecordsUrl(name)} {...ext}>All records ↗</a></KV>
            <KV k="ENS app"><a href={ensAppUrl(name)} {...ext}>Profile ↗</a></KV>
            {p.fund && <KV k="Arcscan"><a href={`${EXPLORER}/address/${p.fund}`} {...ext}>Contract ↗</a></KV>}
          </div>
        </div>
      </div>
    </div>
  )
}

function RecordValue({ k, v }: { k: string; v: string }) {
  if (k === 'url') return <a href={v} {...ext}>{v}</a>
  if (k === 'inphinity.creator') return <a href={`${EXPLORER}/address/${v}`} {...ext}>{v}</a>
  if (k === 'inphinity.ccip') return <a href={ccipMessageUrl(v)} {...ext}>{v}</a>
  if (k === 'inphinity.weights') return <>{v}<div className="muted">{parseWeights(v).map((w) => `${w.sym.replace(/^t/, '')} ${pctOf(w.bps)}`).join(' · ')}</div></>
  if (k === 'inphinity.fee') return <>{v} <span className="muted">= {(Number(v) / 100).toFixed(2)}% / yr</span></>
  if (k === 'inphinity.tokens') return <>{v.split(',').map((t) => <div key={t}><a href={`${EXPLORER}/address/${t}`} {...ext}>{t}</a></div>)}</>
  return <>{v}</>
}
