import { useEffect, useRef, useState } from 'react'
import { ensLabel, expectedEnsName } from '../lib/ens'
import { useAccount } from 'wagmi'
import { parseEventLogs, type Abi, type Address } from 'viem'
import { toast } from 'sonner'
import { FACTORY, factoryAbi } from '../lib/contracts'
import { ticker } from '../lib/format'
import { navigate } from '../lib/router'
import { useTx } from '../lib/tx'
import { useStocks } from '../hooks/data'
import { Change, KV } from '../components/ui'

type Pick = { token: Address; bps: number }

export function Create() {
  const { isConnected } = useAccount()
  const { stocks: allStocks } = useStocks()
  // Only stocks the exchange holds on Arc (bridged from Base Sepolia via CCTP and minted here) can be bought
  // by a fund. A fund holding a stock with zero inventory could be created but never take a cash investment.
  const stocks = allStocks.filter((s) => (s.inventory ?? 0n) > 0n)
  const unavailable = allStocks.filter((s) => s.inventory === 0n)
  const inventoryLoading = allStocks.length > 0 && allStocks.every((s) => s.inventory === undefined)
  const { send, busy } = useTx()
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [desc, setDesc] = useState('')
  const [picks, setPicks] = useState<Pick[]>([])
  const [feeBps, setFeeBps] = useState(100)

  // /create?with=AAPL (from the Prices board or Bridge): pre-select that stock once it is known to be available.
  const preselect = useRef(new URLSearchParams(window.location.search).get('with')?.trim().toUpperCase() || null)
  useEffect(() => {
    const want = preselect.current
    if (!want || inventoryLoading || !allStocks.length) return
    preselect.current = null
    const s = stocks.find((x) => ticker(x.symbol).toUpperCase() === want || x.symbol.toUpperCase() === want)
    if (s) setPicks((ps) => (ps.some((p) => p.token === s.token) ? ps : splitEqually([...ps, { token: s.token, bps: 0 }])))
    else toast.info(`${want} is not available on Arc yet, so a fund can't hold it.`)
  }, [allStocks.length, inventoryLoading, stocks]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = picks.reduce((a, p) => a + p.bps, 0)
  const step1ok = name.trim().length > 0 && name.length <= 128 && symbol.trim().length > 0 && symbol.length <= 32 && desc.length <= 2048
  const step2ok = picks.length >= 2 && picks.length <= 10 && total === 10000 && picks.every((p) => p.bps > 0)
    && picks.every((p) => stocks.some((s) => s.token === p.token))
  const bySym = (t: Address) => stocks.find((s) => s.token === t)
  const blended = picks.reduce((a, p) => a + (bySym(p.token)?.change ?? 0) * p.bps / 10000, 0)

  const splitEqually = (list: Pick[]) => {
    if (!list.length) return list
    const each = Math.floor(10000 / list.length)
    const rest = 10000 - each * list.length
    return list.map((p, i) => ({ ...p, bps: each + (i < rest ? 1 : 0) }))
  }
  const toggle = (token: Address) => setPicks((ps) => {
    if (ps.some((p) => p.token === token)) return splitEqually(ps.filter((p) => p.token !== token))
    if (ps.length >= 10) return ps
    return splitEqually([...ps, { token, bps: 0 }])
  })
  const setW = (token: Address, bps: number) => setPicks((ps) => ps.map((p) => (p.token === token ? { ...p, bps: Math.max(0, Math.min(10000, Math.round(bps))) } : p)))

  async function create() {
    // Keep the picker's order (board order) so the fund lists holdings consistently.
    const ordered = stocks.map((s) => picks.find((p) => p.token === s.token)).filter(Boolean) as Pick[]
    const r = await send(`Create ${symbol.trim()}`, {
      address: FACTORY, abi: factoryAbi as Abi, functionName: 'createIndex',
      // ENS label: required by the factory once the Chainlink CCIP registrar is on (ignored otherwise).
      args: [name.trim(), symbol.trim(), ensLabel(symbol.trim()) ?? ensLabel(name.trim()) ?? 'fund', ordered.map((p) => p.token), ordered.map((p) => p.bps), feeBps, desc.trim()],
    })
    if (!r) return
    const ev = parseEventLogs({ abi: factoryAbi, logs: r.logs, eventName: 'IndexCreated' })[0]
    if (ev) {
      toast.success(`${symbol.trim()} is live. Make the first investment.`)
      navigate(`/index/${ev.args.fund}`)
    } else navigate('/indices')
  }

  const steps = ['1 · Name', '2 · Stocks & weights', '3 · Fee & review']
  return (
    <>
      <h2 className="title">Build your own index</h2>
      <div className="sub">Pick 2–10 stocks, set the weights, choose your fee. Anyone can invest at NAV.</div>
      <div className="steps">
        {steps.map((s, i) => (
          <button key={s} className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''}
            disabled={(i >= 1 && !step1ok) || (i >= 2 && !step2ok)} onClick={() => setStep(i + 1)}>{s}</button>
        ))}
      </div>

      <div className="split">
        <div>
          {step === 1 && (
            <>
              <label className="lbl" htmlFor="c-name"><span>Fund name</span><span>{name.length}/128</span></label>
              <div className="field"><input id="c-name" className="txt" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} placeholder="Big Tech Bluechip" /></div>
              <label className="lbl" htmlFor="c-sym"><span>Symbol</span><span>{symbol.length}/32</span></label>
              <div className="field"><input id="c-sym" className="txt mono" maxLength={32} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="BCHIP" /></div>
              <label className="lbl" htmlFor="c-desc"><span>Description (optional)</span><span>{desc.length}/2048</span></label>
              <textarea id="c-desc" className="txt" maxLength={2048} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="The largest US tech names, weighted by conviction." style={{ margin: '6px 0 12px' }} />
              <div className="row-actions"><button className="btn solid" disabled={!step1ok} onClick={() => setStep(2)}>Next: stocks →</button></div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="picker">
                {stocks.map((s) => {
                  const on = picks.some((p) => p.token === s.token)
                  return (
                    <button key={s.token} className={on ? 'on' : ''} onClick={() => toggle(s.token)} aria-pressed={on}>
                      <div className="sym">{ticker(s.symbol)}</div>
                      <div className="name">{s.company}</div>
                    </button>
                  )
                })}
              </div>
              {inventoryLoading && <div className="note">Checking which stocks are available on Arc…</div>}
              {unavailable.length > 0 && (
                <div className="note">Not yet available on Arc: {unavailable.map((s) => ticker(s.symbol)).join(' · ')}. These stocks have no exchange inventory yet, so a fund could not buy them.</div>
              )}
              {picks.length === 0 && <div className="note">Tap stocks above to add them to your basket.</div>}
              {stocks.filter((s) => picks.some((p) => p.token === s.token)).map((s) => {
                const p = picks.find((x) => x.token === s.token)!
                return (
                  <div className="wrow" key={s.token}>
                    <span className="sym">{ticker(s.symbol)}</span>
                    <input type="range" min={0} max={10000} step={50} value={p.bps} onChange={(e) => setW(s.token, Number(e.target.value))} aria-label={`${ticker(s.symbol)} weight`} />
                    <WeightInput bps={p.bps} label={ticker(s.symbol)} onChange={(v) => setW(s.token, v)} />
                  </div>
                )
              })}
              {picks.length > 0 && (
                <div className="total">
                  <span>TOTAL</span>
                  <span className={`mono ${total === 10000 ? 'up' : 'down'}`}>{(total / 100).toFixed(2)}% {total === 10000 ? '✓' : `(${total > 10000 ? 'over' : 'under'} by ${(Math.abs(10000 - total) / 100).toFixed(2)}%)`}</span>
                </div>
              )}
              {picks.length === 1 && <div className="alert">Pick at least 2 stocks.</div>}
              {picks.some((p) => p.bps === 0) && <div className="alert">Every stock needs a weight above 0%.</div>}
              <div className="row-actions">
                <button className="btn" disabled={picks.length === 0} onClick={() => setPicks(splitEqually)}>Split equally</button>
                <button className="btn" onClick={() => setStep(1)}>Back</button>
                <button className="btn solid" disabled={!step2ok} onClick={() => setStep(3)}>Next: fee & review →</button>
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <label className="lbl" htmlFor="c-fee"><span>Management fee</span><span>max 2.00% / yr</span></label>
              <div className="wrow" style={{ gridTemplateColumns: '1fr 110px' }}>
                <input id="c-fee" type="range" min={0} max={200} step={5} value={feeBps} onChange={(e) => setFeeBps(Number(e.target.value))} />
                <span className="mono" style={{ fontWeight: 600, textAlign: 'right', fontSize: 18 }}>{(feeBps / 100).toFixed(2)}%</span>
              </div>
              <div className="note">You earn the fee as newly minted fund shares, accrued continuously. Weights are fixed once the fund is created.</div>
              {expectedEnsName(symbol.trim(), name.trim()) && (
                <div className="note">ENS: your fund will be listed as <b className="mono">{expectedEnsName(symbol.trim(), name.trim())}</b> on Sepolia (ENSv2), owned by you. Arc sends it to Ethereum through Chainlink CCIP, so it appears a few minutes after creation.</div>
              )}
              <table className="board" style={{ marginTop: 16 }}>
                <thead><tr><th>Stock</th><th className="r">Weight</th><th className="r">Since listing</th></tr></thead>
                <tbody>
                  {stocks.filter((s) => picks.some((p) => p.token === s.token)).map((s) => (
                    <tr key={s.token}><td className="sym">{ticker(s.symbol)} <span className="name">{s.company}</span></td>
                      <td className="r mono">{(picks.find((p) => p.token === s.token)!.bps / 100).toFixed(2)}%</td>
                      <td className="r"><Change v={s.change} /></td></tr>
                  ))}
                </tbody>
              </table>
              {!isConnected && <div className="info">Connect a wallet to create the fund.</div>}
              <div className="row-actions">
                <button className="btn" onClick={() => setStep(2)}>Back</button>
                <button className="btn solid" disabled={!isConnected || !step1ok || !step2ok || !!busy} onClick={create}>
                  {busy ? `${busy}…` : 'Create index onchain'}
                </button>
              </div>
            </>
          )}
        </div>
        <div className="box">
          <h3>Preview</h3>
          <div className="in">
            <KV k="Name">{name || '—'}</KV>
            <KV k="Symbol">{symbol || '—'}</KV>
            <KV k="Stocks">{picks.length ? stocks.filter((s) => picks.some((p) => p.token === s.token)).map((s) => ticker(s.symbol)).join(' · ') : '—'}</KV>
            <KV k="Starting NAV">1.00 USDC</KV>
            <KV k="Fee">{(feeBps / 100).toFixed(2)}% / yr</KV>
            <KV k="Basket, since listing"><span className={blended >= 0 ? 'up' : 'down'}>{picks.length ? `${blended >= 0 ? '▲ +' : '▼ −'}${Math.abs(blended).toFixed(2)}%` : '—'}</span></KV>
            {desc && <div className="note">{desc}</div>}
            <div className="note">Weights are fixed once created. Investors deposit USDC; the fund buys each stock at its weight from the exchange.</div>
          </div>
        </div>
      </div>
    </>
  )
}

/** Percent input that keeps the typed text (e.g. "33.") while editing. */
function WeightInput({ bps, label, onChange }: { bps: number; label: string; onChange: (bps: number) => void }) {
  const [text, setText] = useState((bps / 100).toString())
  useEffect(() => { if (Math.round(Number(text) * 100) !== bps) setText((bps / 100).toString()) }, [bps]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="pctin">
      <input inputMode="decimal" value={text} aria-label={`${label} weight percent`}
        onChange={(e) => {
          const v = e.target.value.replace(',', '.')
          if (!/^\d{0,3}(\.\d{0,2})?$/.test(v)) return
          setText(v)
          onChange(Math.round(Number(v || 0) * 100))
        }}
        onBlur={() => setText((bps / 100).toString())} />
      <span>%</span>
    </div>
  )
}
