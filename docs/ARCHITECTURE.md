# Inphinity architecture

```mermaid
flowchart LR
  subgraph BASE["Base Sepolia (stocks' home chain)"]
    ISS["Issuer scripts<br/>issuer/ (viem)"]
    TOK_B["16 stock tokens<br/>CCTP native cross-chain tokens<br/>tAAPL … tORCL"]
    ISS -->|"deploy + mint<br/>(CrossChainTokenService)"| TOK_B
  end

  subgraph CIRCLE["Circle"]
    BK["Bridge Kit + CCTPx<br/>burn → attest → relayer mint"]
  end

  subgraph ARC["Arc Testnet (USDC = gas + settlement)"]
    TOK_A["Same 16 tokens<br/>(same addresses)"]
    EX["StockExchange<br/>oracle price ± 0.5%<br/>stock inventory + USDC reserve<br/>5% cap per update"]
    FAC["IndexFactory<br/>createIndex(label, stocks, weights, fee)"]
    FUND["IndexFund (one per fund)<br/>ERC-20 shares at NAV<br/>invest / redeem / investInKind"]
    FWD["CRE forwarder<br/>(mock, simulation)"]
    REG["ArcEnsRegistrar<br/>CCIP sender, never reverts"]
    TOK_A -->|"inventory"| EX
    FAC -->|"deploys"| FUND
    FUND -->|"buy / sell basket"| EX
    FWD -->|"onReport(prices)"| EX
    FAC -->|"register(label, fund)"| REG
  end

  subgraph CL["Chainlink"]
    CRE["CRE workflow cre/price-feed<br/>Yahoo Finance · median consensus<br/>simulate --broadcast every 5 min"]
    CCIP["CCIP lane Arc → Sepolia<br/>9M gas limit"]
  end

  subgraph SEP["Ethereum Sepolia (ENSv2)"]
    RCV["InphinityEnsReceiver"]
    UR["UserRegistry for inphinity.eth<br/>creator gets ROLE_RENEW only"]
    PR["PermissionedResolver<br/>Arc address (ENSIP-11) + text records<br/>links: symbol, latest · default bundle"]
    RCV -->|"register label"| UR
    RCV -->|"records + linkToNode"| PR
  end

  FB["Fallback relayer<br/>ens/fallback.ts, every 30 min<br/>only when CCIP can't name a fund"]
  WEB["Web app (React, wagmi)<br/>Vercel · inphinity.trade<br/>Indices (home) · Prices (read-only) · Create · Portfolio · Bridge · /name.inphinity.eth"]
  YF[("Yahoo Finance")]

  TOK_B -->|"Bridge Kit"| BK -->|"mint"| TOK_A
  YF --> CRE -->|"signed report"| FWD
  REG -->|"ccipSend"| CCIP -->|"ccipReceive"| RCV
  FB -.->|"NamingSkipped or stuck > 2 h"| UR
  FB -.-> PR
  WEB -->|"create fund"| FAC
  WEB -->|"invest / redeem"| FUND
  WEB -->|"Bridge Kit in browser"| BK
  WEB -->|"read records, verify vs Arc"| PR
```

## Legend

| Piece | What it does | Code |
|---|---|---|
| Issuer scripts | Deploy each stock on Base Sepolia as a Circle CCTP cross-chain token; Circle creates the Arc twin at the same address; bridge stock into exchange inventory | `issuer/` |
| Bridge Kit | In-app Base → Arc bridging: approve, burn on Base, Circle attests, Circle's relayer mints on Arc (no Arc gas). ~15–20 min | `src/lib/bridge.ts`, `src/pages/Bridge.tsx` |
| StockExchange | Oracle-priced inventory exchange in USDC. Accepts prices only from the CRE forwarder when `priceSource = Feed` | `contracts/StockExchange.sol` (Arc Studio) |
| CRE workflow | Reads listed stocks from the exchange, fetches Yahoo prices with median consensus, clamps to the 5% cap, writes a signed report | `cre/price-feed/main.ts` |
| IndexFactory / IndexFund | Anyone creates a fund (2–10 stocks, weights, fee ≤ 2%/yr); shares minted/burned at NAV; investor pays the spread | `contracts/IndexFactory.sol`, `contracts/IndexFund.sol` (Arc Studio) |
| ArcEnsRegistrar → CCIP → InphinityEnsReceiver | Names each fund `<label>.inphinity.eth` on Sepolia inside the fund-creation tx; never blocks fund creation | `contracts/ccip/` |
| UserRegistry + PermissionedResolver | Our ENSv2 subname registry and resolver; Enhanced Access Control keeps creators from repointing names | `ens/`, `ens/DESIGN.md` |
| Fallback relayer | Names a fund only when CCIP didn't (skipped for fee, or stuck > 2 h); retries stored receiver failures | `ens/src/fallback.ts` |
| Web app | React + wagmi on Vercel, index-only (no single-stock buy/sell in the UI); the ENS profile page joins ENS identity with live NAV from Arc and verifies them | `src/` |

PNG export (for slides and the submission form): [`architecture.png`](architecture.png).

Solid arrows are live paths; dotted arrows are the fallback. Addresses are in [`SUBMISSION.md`](SUBMISSION.md#6-contract-addresses).
