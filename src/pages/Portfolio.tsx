import { useAccount, useReadContracts } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { erc20Abi } from 'viem'
import { INCEPTION_TIP, qty, sinceInception, ticker, units, usd } from '../lib/format'
import { Link } from '../lib/router'
import { POLL, useFunds, useStocks, useUsdcBalance } from '../hooks/data'
import { Change, Num } from '../components/ui'

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
      <div className="empty">Connect a wallet to see your fund shares and USDC.</div>
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
        <div><div className="stat">Total value (USDC)</div><Num big value={usd(total)} /></div>
        <div className="stat">Cash<b>${usd(usdc.data)}</b></div>
        <div className="stat">Funds<b>${usd(fundVal)}</b></div>
        {stockVal > 0n && <div className="stat">Stocks<b>${usd(stockVal)}</b></div>}
      </div>

      <h3 className="eyebrow" style={{ margin: '20px 0 6px' }}>Index funds</h3>
      {myFunds.length === 0 ? <div className="note">No fund shares yet. <Link to="/">Browse index funds →</Link> or <Link to="/create">build your own →</Link></div> : (
        <table className="board">
          <thead><tr><th>Fund</th><th className="r">Shares</th><th className="r hide-sm">NAV / share</th><th className="r">Value</th><th className="r" title={INCEPTION_TIP}>Since inception</th><th className="r"><span className="hide-sm">Redeem</span></th></tr></thead>
          <tbody>{myFunds.map((f) => (
            <tr key={f.address}><td><Link to={`/index/${f.address}`}><b>{f.name}</b> <span className="sym muted" style={{ fontSize: 19 }}>{f.symbol}</span></Link></td>
              <td className="r mono">{qty(f.balance)}</td>
              <td className="r hide-sm"><Num value={usd(f.navPerShare)} /></td>
              <td className="r mono">{usd(((f.balance ?? 0n) * (f.navPerShare ?? 0n)) / E18)}</td>
              <td className="r" title={INCEPTION_TIP}><Change v={sinceInception(f.navPerShare)} /></td>
              <td className="r"><Link className="btn sm" to={`/index/${f.address}`}>Redeem →</Link></td></tr>
          ))}</tbody>
        </table>
      )}
      {held.length > 0 && (
        <>
          <h3 className="eyebrow" style={{ margin: '24px 0 6px' }}>Stocks in your wallet</h3>
          <table className="board">
            <thead><tr><th>Symbol</th><th className="r">Units</th><th className="r hide-sm">Price</th><th className="r">Value</th><th className="r">Since listing</th></tr></thead>
            <tbody>{held.map(({ s, bal }) => (
              <tr key={s.token}><td className="sym">{ticker(s.symbol)}</td><td className="r mono">{units(bal)}</td>
                <td className="r hide-sm"><Num value={usd(s.price)} /></td>
                <td className="r mono">{usd((bal * s.price) / E18)}</td><td className="r"><Change v={s.change} /></td></tr>
            ))}</tbody>
          </table>
          <div className="note">Single stocks are not traded in the app. These are tokens in your wallet, for example from bridging.</div>
        </>
      )}

      <div className="note">Funds are valued at NAV per share; stocks at the oracle mid price. USDC is the ERC-20 balance (6 decimals).</div>
    </>
  )
}
