import { useAccount, useReadContracts } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { erc20Abi } from 'viem'
import { qty, ticker, units, usd } from '../lib/format'
import { Link } from '../lib/router'
import { POLL, useFunds, useStocks, useUsdcBalance } from '../hooks/data'
import { Change, Lcd } from '../components/ui'

const E18 = 10n ** 18n

export function Portfolio() {
  const { address } = useAccount()
  const { stocks } = useStocks()
  const { funds } = useFunds()
  const usdc = useUsdcBalance()
  const bals = useReadContracts({
    contracts: address ? stocks.map((s) => ({ chainId: arcTestnet.id, address: s.token, abi: erc20Abi, functionName: 'balanceOf', args: [address] }) as const) : [],
    query: { enabled: !!address && stocks.length > 0, refetchInterval: POLL },
  })
  if (!address) return (
    <>
      <h2 className="title">Portfolio</h2>
      <div className="empty">Connect a wallet to see your USDC, stocks and fund shares.</div>
    </>
  )
  const held = stocks.map((s, i) => ({ s, bal: (bals.data?.[i]?.result as bigint | undefined) ?? 0n })).filter((x) => x.bal > 0n)
  const myFunds = funds.filter((f) => (f.balance ?? 0n) > 0n)
  const stockVal = held.reduce((a, x) => a + (x.bal * x.s.price) / E18, 0n)
  const fundVal = myFunds.reduce((a, f) => a + ((f.balance ?? 0n) * (f.navPerShare ?? 0n)) / E18, 0n)
  const total = (usdc.data ?? 0n) + stockVal + fundVal

  return (
    <>
      <h2 className="title">Portfolio</h2>
      <div className="navbig">
        <div><div className="stat">Total value (USDC)</div><Lcd big value={usd(total).replace(/,/g, '')} /></div>
        <div className="stat">Cash<b>${usd(usdc.data)}</b></div>
        <div className="stat">Stocks<b>${usd(stockVal)}</b></div>
        <div className="stat">Funds<b>${usd(fundVal)}</b></div>
      </div>

      <h3 className="eyebrow" style={{ margin: '20px 0 6px' }}>Stocks</h3>
      {held.length === 0 ? <div className="note">No stocks yet. <Link to="/">Buy on the board →</Link></div> : (
        <table className="board">
          <thead><tr><th>Symbol</th><th className="r">Units</th><th className="r hide-sm">Price</th><th className="r">Value</th><th className="r">Change</th></tr></thead>
          <tbody>{held.map(({ s, bal }) => (
            <tr key={s.token}><td className="sym">{ticker(s.symbol)}</td><td className="r mono">{units(bal)}</td>
              <td className="r hide-sm"><Lcd value={usd(s.price).replace(/,/g, '')} /></td>
              <td className="r mono">{usd((bal * s.price) / E18)}</td><td className="r"><Change v={s.change} /></td></tr>
          ))}</tbody>
        </table>
      )}

      <h3 className="eyebrow" style={{ margin: '24px 0 6px' }}>Index funds</h3>
      {myFunds.length === 0 ? <div className="note">No fund shares yet. <Link to="/indices">Browse indices →</Link></div> : (
        <table className="board">
          <thead><tr><th>Fund</th><th className="r">Shares</th><th className="r hide-sm">NAV / share</th><th className="r">Value</th></tr></thead>
          <tbody>{myFunds.map((f) => (
            <tr key={f.address}><td><Link to={`/index/${f.address}`}><b>{f.name}</b> <span className="sym muted" style={{ fontSize: 19 }}>{f.symbol}</span></Link></td>
              <td className="r mono">{qty(f.balance)}</td>
              <td className="r hide-sm"><Lcd value={usd(f.navPerShare).replace(/,/g, '')} /></td>
              <td className="r mono">{usd(((f.balance ?? 0n) * (f.navPerShare ?? 0n)) / E18)}</td></tr>
          ))}</tbody>
        </table>
      )}
      <div className="note">Stocks are valued at the oracle mid price; funds at NAV per share. USDC is the ERC-20 balance (6 decimals).</div>
    </>
  )
}
