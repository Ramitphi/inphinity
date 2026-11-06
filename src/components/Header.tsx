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
    ...stocks.map((s) => ({ k: s.token, sym: ticker(s.symbol), price: usd(s.price), ch: s.dayChange as number | undefined })),
    ...funds.map((f) => ({ k: f.address, sym: `${f.symbol} NAV`, price: usd(f.navPerShare), ch: undefined as number | undefined })),
  ]
  if (!items.length) return <div className="tape"><div className="tape-inner" style={{ animation: 'none', paddingLeft: 24 }}>LOADING PRICES FROM ARC…</div></div>
  const row = items.map((i) => (
    <span className="tape-item" key={i.k}>
      <b>{i.sym}</b>{i.price}{' '}
      {i.ch !== undefined && (i.ch > -0.005
        ? <span className="up">▲{pct(Math.abs(i.ch)).slice(1)}</span>
        : <span className="down">▼{pct(i.ch).slice(1)}</span>)}
    </span>
  ))
  return (
    <div className="tape" aria-label="Ticker">
      <div className="tape-inner" style={{ animationDuration: `${items.length * 5}s` }}>{row}{row}</div>
    </div>
  )
}

function Wallet() {
  const { chainId, isConnected } = useAccount()
  const onBridge = usePath().startsWith('/bridge')
  const { switchChain, isPending } = useSwitchChain()
  const bal = useUsdcBalance()
  const wrong = isConnected && chainId !== arcTestnet.id && !onBridge // the bridge page runs on Base Sepolia
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
  ['/', 'Indices'], ['/create', 'Create'], ['/portfolio', 'Portfolio'], ['/prices', 'Prices'], ['/bridge', 'Bridge'],
] as const

export function Header() {
  const path = usePath()
  const now = useNow(30_000)
  const nyse = nyseStatus(new Date(now))
  const active = (to: string) => (to === '/' ? path === '/' || path === '/indices' || path.startsWith('/index/') : path.startsWith(to))
  return (
    <header>
      <Tape />
      <div className="mast">
        <div className="side">Index funds from<br />any tokenized stock</div>
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
