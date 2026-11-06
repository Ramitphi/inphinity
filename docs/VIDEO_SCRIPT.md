# Inphinity demo video script

**Target 3:00. Hard limits from ETHGlobal: 2:00 minimum, 4:00 maximum (rejected at upload otherwise), at least 720p.**
- No speed-up (manually checked).
- No AI or text-to-speech voiceover: Ramit speaks.
- No phone recording: record the screen.
- Cutting out waiting time is allowed. Keep the intro under 20 s.

Voice-over (VO) is about 130 words per minute. Cut wherever you see ✂.

## Pre-recording checklist (start 30 min before)

- [ ] **CRE loop running:** `cre/run-loop.sh` on the laptop.
  - Check with `bun price-feed/scripts/status.ts`: `priceSource 1` and a last report under 5 min old. (At 00:55 IST it was 2 min old.)
  - On Saturday the US market is closed, so prices won't move. Use the clip or arcscan link of the tAMD clamp and tNVDA move from Friday (see scene 2).
- [ ] **CCIP registrar funded:** fee ≈ 21.7 USDC per fund.
  - It held **28.2 USDC** at 00:55 IST, which covers **one** naming.
  - Top it up to ≥ 45 USDC if you'll create more than one fund on camera (including retakes).
  - Re-check the quote before recording.
- [ ] **tNFLX transfer started 20 min before scene 6:**
  - Bridge from Base → Admin · issuer → tNFLX → Send to "Exchange inventory". Approve and burn.
  - Keep the Basescan burn link open; the mint lands on Arc ~15–20 min later.
  - This also closes the open item "inventory for the 8 newer stocks".
- [ ] **Wallets:**
  - Demo wallet with ≥ 20 USDC on Arc.
  - Issuer wallet (team wallet `0xC658…4C93`) with Base Sepolia ETH, for the bridge.
  - MetaMask networks added: Arc Testnet (5042002), Base Sepolia, and Sepolia for viewing only.
  - Start on **Arc Testnet**: the app auto-switches before transactions, but avoid the extra popup.
- [ ] **Pre-create a backup fund** (e.g. `DEMO2`) in case CCIP is slow on camera. Delivery is usually minutes, but you can't wait on camera.
- [ ] **Tabs open, in order:**
  1. https://www.inphinity.trade/ (Indices home)
  2. The Prices tab
  3. `/create`
  4. The backup fund's page
  5. https://www.inphinity.trade/bchip.inphinity.eth
  6. `/bridge`
  7. Basescan burn tx of the tNFLX transfer
  8. Arcscan exchange address → token transfers
  9. ccip.chain.link message page (aibuilders: `0xac8fffdf…d53b`)
  10. sepolia.app.ens.domains → `bchip.inphinity.eth`
  11. **Arc Studio project**: contracts tab, chat history
  12. `docs/architecture.png` (or `ARCHITECTURE.md` on GitHub once the repo is public)
- [ ] **Screen:** browser at 1440×900 or 1920×1080, 110% zoom, notifications off, bookmarks bar hidden.
- [ ] **Audio:** an external mic or headset in a quiet room.

---

## Main cut (≈ 3:00)

| # | Time | Screen | Clicks | Voice-over |
|---|---|---|---|---|
| 1 | 0:00–0:20 | Title card ("Inphinity · index funds from any tokenized stock"), then the Indices home page | None | "In India, most people invest through mutual funds and index funds, not by picking single stocks. Tokenized stocks are arriving onchain, but there's no fund layer: you buy and track every token yourself. Inphinity lets anyone build an index fund from tokenized stocks, on Arc, in USDC." |
| 2 | 0:20–0:45 | **Prices** tab (read-only board) | Hover a row (tNVDA): price, 1D, since listing, inventory, "in N funds". Open the Arcscan tab: a `PricesUpdated` report tx. Click **Build a fund with this →** on one row to lead into scene 3. | "Funds are built from sixteen US stocks, priced by Chainlink CRE. A workflow fetches Yahoo Finance prices with median consensus and writes a signed report to our exchange on Arc every five minutes. Here's one landing onchain. Each update is capped at five percent; here CRE clamped AMD's jump. There's no single-stock trading here: funds buy their stocks from our exchange at that oracle price, so fund prices track the real market." |
| 3 | 0:45–1:15 | Create index (`/create`) | Name "Mumbai Tech", symbol MTECH → **Next: stocks →** → tap tAAPL, tNVDA, tMSFT, tNFLX (tNFLX is selectable only once the pre-started bridge has landed in exchange inventory; until then the page lists it under "Not yet available on Arc", so use tGOOGL instead) → **Split equally** → **Next: fee & review →** → fee 1% → note the line "ENS: your fund will be listed as mtech.inphinity.eth" → **Create** → confirm in MetaMask | "Creating a fund: pick two to ten stocks, set the weights and a fee. Notice the ENS name: this fund will be named on Ethereum in the same transaction. Confirm. The fund is now its own contract on Arc." ✂ (cut the wait) |
| 4 | 1:15–1:40 | New fund's page (or the backup fund) | Enter 10 USDC → **Invest** → confirm → show NAV / share, Fund value, Holding table | "Invest ten USDC. The fund buys the basket by weight and mints shares at NAV, so I pay my own spread and existing holders aren't diluted. NAV per share started at one dollar; performance is NAV since inception, net of fees, moving with every Chainlink update." |
| 5 | 1:40–2:10 | `/bchip.inphinity.eth`, then the CCIP explorer, then the ENS app | Scroll to **Verified against Arc** → ccip.chain.link tab (SUCCESS) → sepolia.app.ens.domains tab | "Every fund gets an ENSv2 name. Fund creation on Arc sends a Chainlink CCIP message to Sepolia. Our receiver registers the name in our own ENSv2 registry and writes the Arc address, weights and fee. The creator owns the name but, by Enhanced Access Control, can't repoint it: no phishing funds. This page reads ENS and verifies it live against the contract on Arc. Identity in ENS, value onchain." |
| 6 | 2:10–2:35 | `/bridge`, then the Basescan burn, then the Arcscan mint | Show Admin · issuer, tNFLX, "Exchange inventory" (don't resend) → Basescan burn tab → Arcscan exchange token transfers: tNFLX mint | "Where do the stocks come from? The issuer mints them on Base as Circle CCTP cross-chain tokens, same address on both chains, and moves them to Arc with Circle Bridge Kit: burn on Base, Circle attests, and Circle's relayer mints on Arc. I started this tNFLX transfer twenty minutes ago; here it lands in the exchange inventory." |
| 7 | 2:35–2:50 | Arc Studio project | Contracts list (StockExchange, IndexFund, IndexFactory) → scroll the chat history → tests passing | "Arc Studio was our starting point. It wrote, tested and deployed the core contracts: 140 tests. We kept the whole build log and decisions in the Studio project." |
| 8 | 2:50–3:05 | `ARCHITECTURE.md` diagram, then an end card | None | "Base to Arc with Bridge Kit, prices with Chainlink CRE, names over CCIP into ENSv2. Any tokenized stock fits, so Indian stocks are next. Inphinity dot trade. Thanks!" End card: inphinity.trade · github.com/Ramitphi/inphinity · Arc Studio link |

If the main cut runs long: trim scene 2's arcscan detour and scene 7's test scroll. Don't trim scene 6 or 7; Arc requires Studio to appear on screen.

**Written for the index-only app** (Indices is home, Prices is read-only; PR #25). Before recording, re-check the button labels against the merged UI: the PR was not pushed when this script was written.

---

## Backup cut (≈ 2:10): if a live step fails

**Why not 30 seconds:** ETHGlobal rejects uploads under 2:00. This cut uses no live transactions, only pre-existing state, so it can be recorded in one take.

| Time | Screen | VO (short version of above) |
|---|---|---|
| 0:00–0:15 | Title, then Indices | Problem: no fund layer for tokenized stocks; Inphinity builds index funds on Arc. |
| 0:15–0:35 | Prices board + Arcscan report | Chainlink CRE prices every 5 min, 5% cap. |
| 0:35–1:00 | **BCHIP** fund page (existing) | Funds: weights, fee, NAV-priced shares, since inception (+0.97% at 00:30 IST). Show the invest box without sending. |
| 1:00–1:25 | `/bchip.inphinity.eth` + CCIP message (aibuilders) | ENSv2 names over CCIP; EAC roles; verified against Arc. |
| 1:25–1:45 | Bridge page + the verified tAAPL burn/mint links from 6 Nov | CCTP stock tokens via Bridge Kit. |
| 1:45–2:00 | Arc Studio | Built in Arc Studio. |
| 2:00–2:10 | Diagram + end card | Indian stocks next. Links. |

## 30-second spoken pitch (booth / finalist opening, not an upload)

> "Most Indians invest through index funds, not single stocks. Tokenized stocks are coming onchain, but there's no fund layer. Inphinity lets anyone build an index fund from tokenized stocks on Arc. Stocks arrive from Base with Circle Bridge Kit. Chainlink CRE prices them. Each fund is NAV-priced and gets an ENSv2 name written across chains with Chainlink CCIP. US stocks today, Indian stocks next."

## Finalist session (4 min demo + 3 min Q&A)

Run the main cut live, with scene 6 shown from the pre-started transfer.

Likely questions:
- **"Why not an AMM?"** Prices must track the market; thin testnet pools drift.
- **"Is CRE deployed?"** No. It's a simulation with broadcast; DON deploy access is gated. Risk bounded by the 5% cap.
- **"Why ENS on Sepolia?"** ENSv2 plus EAC makes a phishing-safe fund registry; mainnet costs real money.
- **"What did you build vs. AI?"** See the AI-use answer in `SUBMISSION.md`.
