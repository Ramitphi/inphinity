import { KV } from '../components/ui'

export function Bridge() {
  return (
    <>
      <h2 className="title">Bridge from Base</h2>
      <div className="sub">Move stock tokens issued on Base Sepolia to Arc with Circle CCTP.</div>
      <div className="split">
        <div>
          <ol style={{ paddingLeft: 20, lineHeight: 1.6, fontSize: 16, margin: 0 }}>
            <li><b>Issue on Base.</b> Each mock stock (tAAPL, tMSFT, …) is an ERC-20 minted on Base Sepolia.</li>
            <li><b>Burn on Base.</b> CCTP burns the tokens on the source chain and Circle attests to the burn.</li>
            <li><b>Mint on Arc.</b> The attestation mints the same amount on Arc Testnet, where they trade in USDC.</li>
          </ol>
          <div className="info" style={{ marginTop: 16 }}>
            In-app bridging is coming soon. The eight stocks on the board were already bridged this way and sit in the exchange's inventory.
          </div>
        </div>
        <div className="box">
          <h3>Route</h3>
          <div className="in">
            <KV k="From">Base Sepolia</KV>
            <KV k="To">Arc Testnet</KV>
            <KV k="Protocol">Circle CCTP</KV>
            <KV k="Assets">8 tokenized stocks</KV>
            <div className="note">Next: Indian stocks, issued the same way. Testnet mock, not real securities.</div>
          </div>
        </div>
      </div>
    </>
  )
}
