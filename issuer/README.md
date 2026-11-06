# Inphinity issuer (Base Sepolia → Arc Testnet via CCTP)

Mock issuer for the Inphinity demo. It issues mock tokenized US stocks (tAAPL, tMSFT, tNVDA, tTSLA, tAMZN, tGOOGL, tMETA, tSPY) on
**Base Sepolia** as native cross-chain tokens using Circle's **CCTP for non-USDC assets**, then
bridges them to **Arc Testnet**, where Inphinity's exchange and index funds hold them.

These are testnet mock tokens, not real securities.

## Scripts

```bash
npm install
npm run deploy                                  # deploy each stock on Base Sepolia and its twin on Arc
npm run bridge -- tAAPL 1000 0xArcAddress  # mint on Base Sepolia and bridge to an Arc address
```

The scripts read a testnet-only deployer key from `PRIVATE_KEY` (never commit it). The wallet needs
Base Sepolia ETH, which pays gas and Circle's relay fee. Deployed addresses are written to
`deployments.json`.

- CrossChainTokenService (all testnets): `0x63753E722bd2C2A5DF6EE19C5106662208B81077`
- Domains: Base Sepolia `6`, Arc Testnet `26`

## Live deployment (testnet)

| Stock | Address (same on Base Sepolia and Arc Testnet) | Starting price | Exchange inventory |
|---|---|---|---|
| tAAPL | `0x4572E4D21199deA83a5E069361871512c31a3bBd` | $344.17 | 10,000 |
| tMSFT | `0xeFde44E09DDDc17d169760FC3922b55BEda7a53B` | $535.93 | 10,000 |
| tNVDA | `0x5263E1f5A05e6b3F733fA401042c6F9f4a09464f` | $181.60 | 10,000 |
| tTSLA | `0xA6128ee533f73a1CF116a752a2cf65e20134F1D0` | $343.69 | 10,000 |
| tAMZN | `0x4e297D91F5622c129fE926b197795B5d3124316C` | $260.21 | 10,000 |
| tGOOGL | `0xc9e364b45DEb73de694c7d97eF189A99013029dB` | $282.57 | 10,000 |
| tMETA | `0xC382598902b4bfBE61aC085EF3c7334EDb6917BB` | $605.08 | 10,000 |
| tSPY | `0x6a915806B8CE8545C4701CC041B1077Db5274f48` | $733.00 | 10,000 |

Arc Testnet contracts (owner `0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93`):
- StockExchange `0x93662de514b981f8c7bf97085e359e0f18034804`, USDC reserve 40
- IndexFactory `0x9fa4034efb237a7c154adea20b1ccfa0cd538b11` (trusted by the exchange)
- SIPManager `0xd96ea5a6c776eac72e5da4f7abb838b5da053f3a`
