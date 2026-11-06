import { Fragment, useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { erc20Abi, parseUnits, type Abi, type Address } from 'viem'
import { EXCHANGE, USDC, exchangeAbi } from '../lib/contracts'
import { qty, ticker, usd } from '../lib/format'
import { useTx } from '../lib/tx'
import { POLL, useStocks, useUsdcBalance, type Stock } from '../hooks/data'
import { AmountInput, Change, Flash, KV, Lcd, useDebounced, useNow } from '../components/ui'

const chainId = arcTestnet.id
const SLIP = 995n // 0.5% slippage: min out = quote * 995 / 1000

export const parse = (v: string, d: number) => {
  try { return v && Number(v) > 0 ? parseUnits(v, d) : 0n } catch { return 0n }
}

export function Markets() {
  const { stocks, isLoading, error, refetch } = useStocks()
  const [sel, setSel] = useState<{ token: Address; side: 'buy' | 'sell' } | null>(null)
  const open = (token: Address, side: 'buy' | 'sell') =>
    setSel((s) => (s?.token === token && s.side === side ? null : { token, side }))

  return (
    <>
      <h2 className="title">The Board</h2>
      <div className="sub">Eight stocks issued on Base, bridged to Arc with Circle CCTP. Buy and sell in USDC, 24/7.</div>
      {error && <div className="alert">Could not load prices from Arc: {error.message.split('\n')[0]}</div>}
      <table className="board">
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="hide-sm">Company</th>
            <th className="r">Last (USDC)</th>
            <th className="r">Change</th>
            <th className="r hide-sm">Available</th>
            <th className="r"><span className="hide-sm">Trade</span></th>
          </tr>
        </thead>
        <tbody>
          {isLoading && Array.from({ length: 8 }, (_, i) => (
            <tr key={i}><td colSpan={6}><span className="skel" style={{ width: '100%' }} /></td></tr>
          ))}
          {stocks.map((s) => (
            <Fragment key={s.token}>
              <tr className={sel?.token === s.token ? 'sel' : ''}>
                <td className="sym">{ticker(s.symbol)}</td>
                <td className="name hide-sm">{s.company}</td>
                <Flash as="td" className="r" value={Number(s.price)}><Lcd value={usd(s.price).replace(/,/g, '')} /></Flash>
                <td className="r"><Change v={s.change} /></td>
                <td className="r mono hide-sm">{qty(s.inventory, 0)}</td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  <button className={`btn buy sm ${sel?.token === s.token && sel.side === 'buy' ? 'on' : ''}`} onClick={() => open(s.token, 'buy')}>Buy</button>{' '}
                  <button className={`btn sell sm ${sel?.token === s.token && sel.side === 'sell' ? 'on' : ''}`} onClick={() => open(s.token, 'sell')}>Sell</button>
                </td>
              </tr>
              {sel?.token === s.token && (
                <tr><td colSpan={6} className="expand">
                  <TradePanel stock={s} side={sel.side} setSide={(side) => setSel({ token: s.token, side })} onDone={refetch} onClose={() => setSel(null)} />
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="note">
        Spread 0.5% each way · Change is versus the listing price · Prices set by oracle (Chainlink CRE) · Not real securities, testnet demo.
      </div>
    </>
  )
}

function TradePanel({ stock, side, setSide, onDone, onClose }: { stock: Stock; side: 'buy' | 'sell'; setSide: (s: 'buy' | 'sell') => void; onDone: () => void; onClose: () => void }) {
  const { address, isConnected } = useAccount()
  const [amount, setAmount] = useState('')
  const debounced = useDebounced(amount)
  const isBuy = side === 'buy'
  const amt = parse(debounced, isBuy ? 6 : 18)
  const now = useNow()
  const { send, ensureAllowance, busy } = useTx()

  const usdcBal = useUsdcBalance()
  const tokBal = useReadContract({ chainId, address: stock.token, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address, refetchInterval: POLL } })
  const reserve = useReadContract({ chainId, address: EXCHANGE, abi: exchangeAbi, functionName: 'reserveBalance', query: { refetchInterval: POLL } })
  const hold = useReadContract({ chainId, address: EXCHANGE, abi: exchangeAbi, functionName: 'holdSeconds' })
  const lastBuy = useReadContract({ chainId, address: EXCHANGE, abi: exchangeAbi, functionName: 'lastBuyTime', args: address ? [address, stock.token] : undefined, query: { enabled: !!address && !isBuy, refetchInterval: POLL } })
  const quote = useReadContract({
    chainId, address: EXCHANGE, abi: exchangeAbi,
    functionName: isBuy ? 'quoteBuy' : 'quoteSell', args: [stock.token, amt],
    query: { enabled: amt > 0n },
  })
  const out = amt > 0n ? (quote.data as bigint | undefined) : undefined
  const minOut = out !== undefined ? (out * SLIP) / 1000n : undefined
  const bal = isBuy ? usdcBal.data : tokBal.data
  const sym = ticker(stock.symbol)

  const unlockAt = lastBuy.data && hold.data ? Number(lastBuy.data + hold.data) * 1000 : 0
  const holdLeft = !isBuy && unlockAt > now ? Math.ceil((unlockAt - now) / 1000) : 0

  let problem: string | null = null
  if (amt > 0n && bal === 0n) problem = isBuy ? 'You have no USDC. Get testnet USDC at faucet.circle.com.' : `You don't hold any ${sym} yet.`
  else if (amt > 0n && bal !== undefined && amt > bal) problem = `You only have ${isBuy ? usd(bal) + ' USDC' : qty(bal) + ' ' + sym}.`
  else if (isBuy && out !== undefined && stock.inventory !== undefined && out > stock.inventory) problem = `Only ${qty(stock.inventory)} ${sym} left in the exchange's inventory.`
  else if (!isBuy && out !== undefined && reserve.data !== undefined && out > reserve.data) problem = `The exchange's USDC reserve (${usd(reserve.data)}) can't cover this sale right now. Try a smaller amount.`
  else if (holdLeft > 0) problem = `You bought ${sym} recently. Selling unlocks in ${holdLeft}s (60s hold after a buy).`
  else if (quote.error && amt > 0n) problem = 'Could not get a quote for this amount.'

  async function execute() {
    if (!address || amt === 0n || minOut === undefined) return
    const ok = isBuy
      ? await ensureAllowance(USDC, EXCHANGE, amt, 'USDC')
      : await ensureAllowance(stock.token, EXCHANGE, amt, sym)
    if (!ok) return
    const r = await send(`${isBuy ? 'Buy' : 'Sell'} ${sym}`, {
      address: EXCHANGE, abi: exchangeAbi as Abi, functionName: side, args: [stock.token, amt, minOut],
    })
    if (r) { setAmount(''); onDone(); usdcBal.refetch(); tokBal.refetch(); reserve.refetch(); lastBuy.refetch() }
  }

  const priceN = Number(stock.price) / 1e6
  return (
    <div className="split" style={{ padding: 14, gap: 16 }}>
      <div className="box">
        <div className="seg">
          <button className={isBuy ? 'on' : ''} onClick={() => { setSide('buy'); setAmount('') }}>Buy {sym}</button>
          <button className={!isBuy ? 'on' : ''} onClick={() => { setSide('sell'); setAmount('') }}>Sell {sym}</button>
        </div>
        <div className="in">
          <label className="lbl" htmlFor={`amt-${stock.token}`}>
            <span>{isBuy ? 'You pay' : 'You sell'}</span>
            {bal !== undefined && (
              <button onClick={() => setAmount(isBuy ? (Number(bal) / 1e6).toFixed(2) : (Number(bal) / 1e18).toString())}>
                Balance {isBuy ? usd(bal) : qty(bal)} · max
              </button>
            )}
          </label>
          <AmountInput id={`amt-${stock.token}`} value={amount} onChange={setAmount} unit={isBuy ? 'USDC' : sym} decimals={isBuy ? 6 : 18} bad={!!problem} />
          <KV k="You receive (est.)">{out === undefined ? '—' : isBuy ? `${qty(out)} ${sym}` : `${usd(out)} USDC`}</KV>
          <KV k={`Minimum after 0.5% slippage`}>{minOut === undefined ? '—' : isBuy ? `${qty(minOut)} ${sym}` : `${usd(minOut)} USDC`}</KV>
          <KV k="Oracle price">{usd(stock.price)} USDC</KV>
          {problem && <div className="alert">{problem}</div>}
          {!isConnected ? (
            <div className="info">Connect a wallet to trade.</div>
          ) : (
            <button className="btn solid block" style={{ marginTop: 12 }} disabled={!!busy || amt === 0n || minOut === undefined || !!problem} onClick={execute}>
              {busy ? `${busy}…` : `Approve & ${isBuy ? 'buy' : 'sell'} ${sym}`}
            </button>
          )}
        </div>
      </div>
      <div className="box">
        <h3><span>{sym} · {stock.company}</span><button className="btn sm" onClick={onClose} aria-label="Close">✕</button></h3>
        <div className="in">
          <KV k="Buy price (incl. spread)">{(priceN * 1.005).toFixed(2)}</KV>
          <KV k="Sell price (incl. spread)">{(priceN * 0.995).toFixed(2)}</KV>
          <KV k="Exchange inventory">{qty(stock.inventory, 2)} {sym}</KV>
          <KV k="You hold">{tokBal.data === undefined ? '—' : `${qty(tokBal.data)} ${sym}`}</KV>
          <KV k="Price updated">{stock.updatedAt ? new Date(Number(stock.updatedAt) * 1000).toLocaleString() : '—'}</KV>
          <div className="note">
            {isBuy
              ? 'Two wallet steps: approve USDC to the exchange, then buy. Tokens arrive in your wallet at the oracle price plus a 0.5% spread.'
              : 'Two wallet steps: approve the stock token to the exchange, then sell. Stocks bought in the last 60 seconds cannot be sold yet.'}
            {' '}Gas on Arc is paid in USDC.
          </div>
        </div>
      </div>
    </div>
  )
}
