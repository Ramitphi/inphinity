# Inphinity

**Index funds from any tokenized stock: US today, Indian next.**

Anyone can build an index fund from tokenized stocks and invest in it with USDC on Arc. The app is index-only: you invest in funds, and a read-only Prices board shows the stocks they hold. Built at ETHGlobal Mumbai (5–7 Nov 2026), starting from Arc Studio.

- **Live app:** https://www.inphinity.trade (also https://inphinity.vercel.app)
- **Example fund profile:** https://www.inphinity.trade/bchip.inphinity.eth

> Testnet only. Stock tokens are mocks priced from real market data. They are not securities.

## How it works

1. **Stocks:** 16 mock US stocks are issued on **Base Sepolia** as Circle CCTP native cross-chain tokens. They move to **Arc Testnet** with Circle **Bridge Kit** and keep the same address on both chains.
2. **Prices:** a **Chainlink CRE** workflow writes Yahoo Finance prices to the `StockExchange` on Arc every 5 minutes, capped at 5% per update.
3. **Funds:** `IndexFactory` deploys an `IndexFund` per fund. Shares are minted and burned at **NAV**, and the investor pays the spread. Performance is NAV per share since inception.
4. **Names:** each fund gets `<label>.inphinity.eth` on **ENSv2 (Sepolia)**, written from Arc through **Chainlink CCIP**, with a relayer fallback. The profile page verifies the ENS records against Arc.

Diagram: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository map

| Path | What |
|---|---|
| `contracts/` | StockExchange, IndexFund, IndexFactory, SIPManager (written, tested and deployed by Arc Studio) and Foundry tests |
| `contracts/ccip/` | ArcEnsRegistrar (Arc) and InphinityEnsReceiver (Sepolia) |
| `issuer/` | CCTP stock issuance on Base Sepolia, bridging and exchange setup ([README](issuer/README.md)) |
| `cre/` | Chainlink CRE price workflow and runbook ([README](cre/README.md)) |
| `ens/` | ENSv2 registry setup, verification and CCIP fallback ([README](ens/README.md), [DESIGN](ens/DESIGN.md)) |
| `src/` | Web app (React, Vite, wagmi, ConnectKit) |
| `arc-studio-plans/` | Arc Studio's plans (AI planning artifacts) |
| `docs/` | [Decisions](docs/DECISIONS.md), [build log](docs/BUILD_LOG.md), [NAV](docs/NAV.md), [submission](docs/SUBMISSION.md), [video script](docs/VIDEO_SCRIPT.md) |

## Contracts

| Contract | Network | Address |
|---|---|---|
| StockExchange | Arc Testnet | `0x93662de514b981f8c7bf97085e359e0f18034804` |
| IndexFactory | Arc Testnet | `0x9fa4034efb237a7c154adea20b1ccfa0cd538b11` |
| ArcEnsRegistrar | Arc Testnet | `0x39437a4f9c2ed49c5c3310681d440b26a0cb23cd` |
| InphinityEnsReceiver | Sepolia | `0x95b9aaba9fc5209e68afe1686d80a69fa03bb23f` |
| `inphinity.eth` UserRegistry | Sepolia | `0xefC414eb999907620AbdA991decD2BD22aBb9Ac1` |

For the full list, see [`docs/SUBMISSION.md`](docs/SUBMISSION.md#6-contract-addresses).

## Run it

```bash
bun install
bun run dev              # web app
bun run contracts:test   # forge test
```

The CRE, ENS and issuer tooling each have their own runbook in their folder.

## How it was built (AI use)

- **Ramit (solo builder):** product decisions, reviews, merges, onchain approvals and the CRE run. See [`docs/DECISIONS.md`](docs/DECISIONS.md).
- **Arc Studio:** the core contracts, their tests and the deployments.
- **Claude Code** (an orchestrator plus worker sessions): the issuer, the web app, CRE hardening, ENS/CCIP and the docs.

Details per file are in [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md#who-built-what-ai-use-disclosure).
