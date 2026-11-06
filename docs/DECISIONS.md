# Inphinity: product and design decisions

How the idea and architecture took shape at ETHGlobal Mumbai (5–7 Nov 2026), from the brainstorming between
Ramit and the Claude orchestrator session. Each entry gives the decision, the options we weighed and why we chose
it. The timeline with commits and transactions is in [`BUILD_LOG.md`](BUILD_LOG.md); the fund math is in
[`NAV.md`](NAV.md) and [`NAV_BRAINSTORM.md`](NAV_BRAINSTORM.md).

> Pitch: **funds from any tokenized stock: US today, Indian next.**

---

## 1. Problem and scope

**Starting idea:** capital markets on Arc. First tokenize Indian stocks (NSE), with compliant trading and a
KYC allowlist across chains.

**What changed:**
- Real Indian equities need a licensed issuer, custody and a KYC/transfer-restriction layer. None of that can be
  done credibly in 36 hours.
- Tokenized US stocks already exist as a category, so the product layer on top (funds) is the new part.

**Decision:**
- Build the **fund layer**: anyone creates an index fund from tokenized stocks, and anyone invests in it with USDC.
- Use **mock US stocks** for the demo.
- Keep Indian stocks as the stated next market, which the "any tokenized stock" design allows.

**Rejected:**
- Indices-only (no tokenization at all): it hides where the assets come from.
- Full issuance and compliance (KYC across chains): out of scope for a hackathon.

## 2. Where the stocks come from: Circle CCTP native cross-chain tokens

**Options:**
1. Deploy plain ERC-20 mocks directly on Arc.
2. A lock-and-mint "wrapped" bridge.
3. **Circle CCTP for non-USDC assets**: native cross-chain tokens that burn on one chain and mint on the other,
   at the same address on every chain.

**Decision:** option 3.
- The issuer mints each stock on **Base Sepolia**, its home chain (most tokenized equities today live on
  Base/Ethereum).
- Stocks reach **Arc Testnet** through CCTP, from scripts and from the in-app **Bridge** page built with Circle
  **Bridge Kit**.
- This mirrors how a real issuer would reach Arc. It's "bridged", not "wrapped": no IOU, and supply stays the
  same across chains.

**Following "the Arc plan":** Arc Studio first planned the issuance in `scripts/cctpx.ts`. It got blocked
because its signer had no Base Sepolia ETH, so the orchestrator finished the issuance with `issuer/`, now also in
Studio.

**Scale:**
- 8 stocks first (AAPL, MSFT, NVDA, TSLA, AMZN, GOOGL, META, SPY).
- Then 8 more (NFLX, AMD, JPM, V, WMT, KO, DIS, ORCL) so funds have real choice.

## 3. How stocks trade on Arc: inventory exchange, not an AMM

**Options:**
1. A Uniswap v4 pool per stock, with hooks for price drift.
2. An **oracle-priced inventory exchange**.

**Decision:** option 2, the `StockExchange` (built and deployed by **Arc Studio**).
- Trades happen at the oracle mid price ± 0.5% spread, against the exchange's stock inventory and a USDC
  reserve.
- **Why:** tokenized stocks should track the real market price, not a pool's price. An AMM with thin testnet
  liquidity would drift and need arbitrage bots. The inventory model is also how issuers actually provide
  liquidity.
- Safety rails: a 5% max move per price update, a 96-hour stale-price freeze, and a 60-second hold after buying.

## 4. Funds: NAV-priced ERC-20 shares, no pool for fund tokens

**Question:** should fund shares trade on a DEX?

**Decision:** "keep it simple".
- Each fund is an ERC-20 share token, minted on `invest` and burned on `redeem` at **NAV**, like an open-ended
  mutual fund or ETF creation and redemption.
- There's no secondary pool, so no premium or discount to NAV and no liquidity to bootstrap.

**Details:**
- The investor pays the spread (existing holders are protected).
- The creator's management fee (up to 2% a year) is taken as dilution.
- `investInKind` lets holders deposit stocks directly.
- See [`NAV.md`](NAV.md).

**SIPs:** `SIPManager` (recurring investments) was built and deployed but has no screen. We cut it from the demo
for time.

### 4a. Measuring a fund: "since inception" from NAV, not a blend (brainstorm, 7 Nov, ~00:15 IST)

**Question (Ramit):** why is the price change only measured against each stock's listing price?

**Why it was that way:**
- Onchain price history started on 6 Nov: listings at 15:02 and 18:46 IST, the first CRE report at 19:47,
  and the US market open at 20:00.
- So there is no earlier close to compare with. The **1D** column (previous close = last CRE price before
  the latest NYSE open) equals "vs listing" until a second trading day exists. The market is closed during
  Saturday judging, so that stays true for the demo.

**The real problem:** funds showed a **weighted blend of their stocks' changes**. That isn't the fund's
performance, because it ignores the fee, idle USDC and when each investor came in.

**Decision:**
- **Funds** show **"since inception" = NAV per share vs 1.00**. Every fund starts at exactly 1.00; investors pay
  their own spread, so existing holders aren't diluted.
  - This is net of the management fee (dilution) and includes idle USDC.
  - Live examples at ~00:30 IST: BCHIP +0.97%, RMT +0.70%, empty funds 0.00%.
- **Stocks** keep 1D plus **"since listing"** (renamed from "vs listing").
- The **Create** preview, a hypothetical basket, keeps the blend, labelled "basket, since listing".

**Status:** built in PR #24.

### 4b. Index-only product: no single-stock buying in the app (brainstorm, 7 Nov, ~00:35 IST)

**Idea (Ramit):** keep Inphinity for index trading only, with no single-stock buying, so the product is
centred on index funds.

**For:**
- **One clear story,** "index funds from any tokenized stock". Single-stock trading is what every
  tokenized-stock venue already offers; user-created funds are the new part.
- **A simpler demo:** create → invest → NAV moves with Chainlink prices → ENS name.
- **A better fit for the "Indian next" angle:** diversified funds are an easier regulatory and product story than
  single-stock trading.
- **Nothing breaks underneath.** Funds still buy and sell their stocks through the StockExchange, so CRE
  prices, Bridge Kit inventory and NAV maths are unchanged.

**Caveat:**
- The exchange contract's `buy`/`sell` stay public onchain. Hiding them in the app doesn't stop a direct
  contract call.
- Locking them to registered funds would need an exchange redeploy. The contract already tracks
  `registeredFunds` through the factory, but `buy` doesn't check it. Too risky the night before judging, so it's
  a next step.

**Proposed app changes (UI only):**
- Indices becomes the home page.
- Markets becomes a read-only **Prices** board: live CRE prices, 1D, since listing, inventory and "in N
  funds", with a "Build a fund with this →" button instead of Buy/Sell.
- Portfolio leads with fund positions.
- Headline: "Index funds from any tokenized stock".

**Status:** **decided** by Ramit on 7 Nov, ~00:50 IST ("make Inphinity index-only"). The UI change is being built in a dedicated session; the onchain lock stays a next step.

## 5. Prices: Chainlink CRE

**Options:**
- Chainlink Data Feeds: no feeds for these mock tokens on Arc testnet.
- Admin-set prices: not credible.
- **Chainlink CRE**: a workflow that fetches prices off-chain and writes a signed report onchain.

**Decision:** a CRE workflow (`cre/price-feed`) that reads **Yahoo Finance** and writes up to 15 prices per run
to the exchange.
- First version: Arc Studio, using TwelveData. Then switched to Yahoo, which needs no API key.
- Runs as a **local simulation with `--broadcast`** on the laptop. No DON deployment, because deploy access is
  gated.
- Rotates the stalest prices first, because of the 15-HTTP-call limit per run.
- Rollback: `setPriceSource(0)` returns the exchange to admin prices.

**Known risk:** the mock forwarder plus the simulator's public workflow owner mean anyone running the simulator
could push prices. Each update is bounded by the 5% cap. Acceptable for a testnet demo; roll back after judging.

## 6. Names: ENSv2 on Sepolia, written through Chainlink CCIP

**Question:** is ENS useful here?

**Answer:** yes, as a **human-readable fund registry**. For example, `bchip.inphinity.eth` resolves to the fund
on Arc, with text records for weights, fee and creator.

**Options:**
1. Studio's first design, `IndexRegistrar.sol`: Durin L2 subnames on Arc. Durin doesn't support Arc, so this
   was superseded.
2. ENS on Ethereum mainnet: real money and real gas, so rejected.
3. **ENSv2 on Sepolia**: UserRegistry, PermissionedResolver and Enhanced Access Control, with an Arc address
   under ENSIP-11 coin type `2152525650`, and deliberately **no** coin type 60 address so nobody sends mainnet
   funds to it.

**Write path:**
- First version: an off-chain relayer, kept only as a fallback.
- Final: **Chainlink CCIP**. The `IndexFactory` calls `ArcEnsRegistrar` on Arc, which sends a CCIP message to
  `InphinityEnsReceiver` on Sepolia, which creates the name.
- Fund creation never reverts because of naming.
- Two designs were explored in parallel (PR #7 and PR #8). We kept #7.
- Lesson: live Sepolia ENS writes need 4.5–7.5M gas, so the CCIP gas limit is 9M.

### 6a. What lives in ENS vs what is read live (brainstorm, 6 Nov, ~23:45 IST)

**Question (Ramit), looking at the fund profile page `/bchip.inphinity.eth`:** NAV per share, AUM and shares
outstanding aren't written to the ENSv2 registry, right?

**Answer:** correct, by design.

| On the profile page | Source | Changes? |
|---|---|---|
| Name, symbol, `bchip.inphinity.eth` | ENS records on Sepolia (`name`, `inphinity.symbol`) | Fixed, written once at fund creation |
| Description, weights, creator, chain, disclaimer | ENS text records | Fixed |
| Fee (1.00% / yr) | ENS `inphinity.fee`, checked against Arc | Fixed (immutable in the fund) |
| Fund address | ENS address record, Arc ENSIP-11 coin type `2152525650` | Fixed |
| **NAV per share, AUM, shares outstanding** | **Read live from the fund contract on Arc** (`navPerShare()`, `nav()`, `totalSupply()`) | Every CRE price update, invest and redeem |

**Why NAV is not written to ENS:**
- **Cost and staleness.** It would take a Sepolia write every few minutes per fund, and the value would still
  lag.
- **Purpose.** ENS holds the fund's **identity** (who it is, where it lives, what it holds). The fund contract is
  the single source of truth for **value**. A copy in ENS would be a second, stale truth.
- **Verification.** The profile page joins the two and verifies them: its "Verified against Arc" panel checks
  that the ENS records (address, symbol, fee, creator) match the onchain fund.

**Option considered: live NAV through ENS with CCIP-Read** (ENSIP-10 / EIP-3668 offchain lookup).
- The resolver would point to a small gateway that reads `navPerShare()` from Arc on each query and returns a
  signed answer, so wallets could resolve `bchip.inphinity.eth` → `nav` with no writes.

**Decision:** **skipped for the hackathon.** It needs a hosted gateway and a resolver change. It's noted as a
post-hackathon item.

**Pitch line:** "Identity lives in ENS, value lives onchain on Arc, and the profile page joins and verifies
them."

## 7. Frontend and design

- React, Vite, wagmi and viem on Arc Testnet. Pages: Markets, Indices, Create, Portfolio, Bridge.
- **Design:** two mockups (clean vs retro). We chose **"analog digitized" retro**: DSEG7 seven-segment hero
  numbers and a VT323 terminal font.
- A later **readability pass** fixed numbers that misread (a "1" that looked like an "8") and brought colours
  up to WCAG AA.

## 8. How we built it: Arc Studio and Claude

| Part | Built with |
|---|---|
| Core contracts | **Arc Studio**: StockExchange, IndexFund, IndexFactory, SIPManager, 145 tests, deployment |
| Everything else | **Claude orchestrator session** plus task-specific **worker sessions**: issuance, CCIP and ENS, frontend, CRE hardening, readability, NAV docs, PR reviews |

**Working rules:**
- One orchestrator holds the testnet-only team wallet and sends every transaction.
- Workers never hold keys.
- Every merge and transaction is logged in `BUILD_LOG.md` and mirrored into Arc Studio.

**Human (Ramit):** product decisions, approvals, merges, wallet funding, and running the CRE simulation.

## 9. Prize tracks

- **Arc:** Bridge Kit for non-USDC assets. CCTP stock tokens move Base → Arc, with an Arc Studio project.
- **Chainlink:** CRE (prices) plus CCIP (fund names, Arc → Sepolia).
- **ENS:** ENSv2 fund registry on Sepolia.

## 10. Open questions and next steps

- **Indian stocks:** NSE prices through CRE, and a licensed issuer or custodian on a home chain.
- **ENS:** live NAV via a CCIP-Read gateway (see 6a).
- **Index-only onchain:** restrict `StockExchange.buy`/`sell` to registered funds (see 4b).
- **Production:** CRE deployed on a DON with the KeystoneForwarder instead of the mock, and real liquidity
  providers for exchange inventory.
- **Product:** a SIP screen, fund rebalancing, and a secondary market for fund shares if demand appears.
