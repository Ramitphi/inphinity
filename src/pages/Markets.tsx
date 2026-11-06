import { useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { EXCHANGE, exchangeAbi } from '../lib/contracts'
import { ago, qty, ticker, usd } from '../lib/format'
import { Link } from '../lib/router'
import { useFunds, useStocks } from '../hooks/data'
import { Change, Flash, Num, useNow } from '../components/ui'

const chainId = arcTestnet.id

/** Read-only price board. Single stocks are not traded in the app; funds buy and sell them through the exchange. */
export function Prices() {
  const { stocks, isLoading, error } = useStocks()
  const { funds } = useFunds()
  const now = useNow(30_000)
  const maxAge = useReadContract({ chainId, address: EXCHANGE, abi: exchangeAbi, functionName: 'maxPriceAge' })
  const oldest = stocks.length ? stocks.reduce((m, s) => (s.updatedAt < m ? s.updatedAt : m), stocks[0].updatedAt) : undefined
  const stale = oldest !== undefined && maxAge.data !== undefined && now / 1000 - Number(oldest) > Number(maxAge.data)

  // How many funds hold each stock (by fund.getTokens()). Undefined until every fund's tokens have loaded.
  const fundsLoaded = funds.every((f) => f.tokens !== undefined)
  const inFunds = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of funds) for (const t of f.tokens ?? []) m.set(t.toLowerCase(), (m.get(t.toLowerCase()) ?? 0) + 1)
    return m
  }, [funds])

  return (
    <>
      <h2 className="title">Prices</h2>
      <div className="sub">Live prices from Chainlink CRE. Stocks are issued on Base and bridged to Arc with Circle CCTP. Build a fund from any of them.</div>
      {error && <div className="alert">Could not load prices from Arc: {error.message.split('\n')[0]}</div>}
      <table className="board">
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="hide-sm">Company</th>
            <th className="r">Last (USDC)</th>
            <th className="r">1D</th>
            <th className="r hide-sm">Since listing</th>
            <th className="r hide-sm">Inventory</th>
            <th className="r hide-sm">In funds</th>
            <th className="r"><span className="hide-sm">Build</span></th>
          </tr>
        </thead>
        <tbody>
          {isLoading && Array.from({ length: 8 }, (_, i) => (
            <tr key={i}><td colSpan={8}><span className="skel" style={{ width: '100%' }} /></td></tr>
          ))}
          {stocks.map((s) => {
            const sym = ticker(s.symbol)
            const n = inFunds.get(s.token.toLowerCase()) ?? 0
            return (
              <tr key={s.token}>
                <td className="sym">{sym}</td>
                <td className="name hide-sm">{s.company}</td>
                <Flash as="td" className="r" value={Number(s.price)}><Num value={usd(s.price)} /></Flash>
                <td className="r"><Change v={s.dayChange} /></td>
                <td className="r hide-sm"><Change v={s.change} /></td>
                <td className="r mono hide-sm">{s.inventory === undefined ? '—' : qty(s.inventory, 0)}</td>
                <td className="r mono hide-sm" data-testid={`in-funds-${sym}`}>{fundsLoaded ? `in ${n} fund${n === 1 ? '' : 's'}` : '—'}</td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  {s.inventory === undefined ? null : s.inventory > 0n
                    ? <Link className="btn sm" to={`/create?with=${encodeURIComponent(sym)}`}>Build<span className="hide-sm"> a fund with this</span> →</Link>
                    : <span className="muted">not yet on Arc</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {stale && <div className="alert">Some prices are older than the exchange allows ({Math.round(Number(maxAge.data) / 3600)}h), so funds can't take investments until the oracle pushes a fresh report.</div>}
      <div className="note">
        {oldest !== undefined && <>Prices updated {ago(oldest, now)} · </>}1D is versus the last price reported before today's NYSE open · Inventory is what the exchange holds on Arc for funds to buy · Prices set by oracle (Chainlink CRE) · Not real securities, testnet demo.
      </div>
    </>
  )
}
