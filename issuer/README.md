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
