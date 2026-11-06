import { ConnectKitButton } from 'connectkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { Link, usePath } from '../lib/router'
import { masthead, nyseStatus } from '../lib/market'
import { pct, short, ticker, usd } from '../lib/format'
import { useFunds, useStocks, useUsdcBalance } from '../hooks/data'
import { useNow } from './ui'

function Tape() {
  const { stocks } = useStocks()
  const { funds } = useFunds()
  const items = [
    ...stocks.map((s) => ({ k: s.token, sym: ticker(s.symbol), price: usd(s.price), ch: s.change as number | undefined })),
    ...funds.map((f) => ({ k: f.address, sym: `${f.symbol} NAV`, price: usd(f.navPerShare), ch: undefined as number | undefined })),
  ]
  if (!items.length) return <div className="tape"><div className="tape-inner" style={{ animation: 'none', paddingLeft: 24 }}>LOADING PRICES FROM ARC…</div></div>
  const row = items.map((i) => (
    <span className="tape-item" key={i.k}>
      <b>{i.sym}</b>{i.price}{' '}
      {i.ch !== undefined && (Math.abs(i.ch) < 0.005
        ? <span className="flat">■0.00%</span>
        : <span className={i.ch > 0 ? 'up' : 'down'}>{i.ch > 0 ? '▲' : '▼'}{pct(i.ch).slice(1)}</span>)}
    </span>
  ))
  return (
    <div className="tape" aria-label="Ticker">
      <div className="tape-inner">{row}{row}</div>
    </div>
  )
}

function Wallet() {
  const { chainId, isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const bal = useUsdcBalance()
  const wrong = isConnected && chainId !== arcTestnet.id
  return (
    <>
      {wrong && (
        <button className="wallet warn" disabled={isPending} onClick={() => switchChain({ chainId: arcTestnet.id })}>
          {isPending ? 'Switching…' : 'Switch to Arc'}
        </button>
      )}
      <ConnectKitButton.Custom>
        {({ show, isConnected, address, ensName }) => (
          <button className={`wallet ${isConnected ? '' : 'solid'}`} onClick={show}>
            {isConnected ? <>{ensName ?? short(address)} · {usd(bal.data)} USDC</> : 'Connect wallet'}
          </button>
        )}
      </ConnectKitButton.Custom>
    </>
  )
}

const NAV = [
  ['/', 'Markets'], ['/indices', 'Indices'], ['/create', 'Create index'], ['/portfolio', 'Portfolio'], ['/bridge', 'Bridge from Base'],
] as const

export function Header() {
  const path = usePath()
  const now = useNow(30_000)
  const nyse = nyseStatus(new Date(now))
  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to) || (to === '/indices' && path.startsWith('/index/')))
  return (
    <header>
      <Tape />
      <div className="mast">
        <div className="side">Tokenized stocks<br />&amp; indices, in USDC</div>
        <h1><Link to="/">INPHINITY</Link></h1>
        <div className="right"><Wallet /></div>
      </div>
      <div className="dateline">
        <span className="hide-sm">{masthead(new Date(now))}</span>
        <span><span className={`dot ${nyse.open ? 'open' : ''}`} />{nyse.label}{nyse.open ? '' : ' · trading stays open'}</span>
        <span>Arc Testnet</span>
      </div>
      <nav className="nav">
        {NAV.map(([to, label]) => (
          <Link key={to} to={to} className={active(to) ? 'on' : ''}>{label}</Link>
        ))}
      </nav>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="foot">
      <span>Testnet demo · Not an offer · Not affiliated with the listed companies</span>
      <span>Settled in USDC on Arc</span>
    </footer>
  )
}
