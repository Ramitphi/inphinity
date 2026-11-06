# Inphinity build log

Timestamped record of how Inphinity was built at ETHGlobal Mumbai (hacking started Thu 5 Nov 2026, 21:00 IST; submission due Sat 7 Nov, 09:00 IST). Times are **IST (UTC+5:30)** with UTC in brackets. Every entry links to a commit or an onchain transaction. Testnet only; mock tokens, not real securities.

## Who built what (AI-use disclosure)

| Part | Built with |
|---|---|
| Arc contracts (StockExchange, IndexFund, IndexFactory, SIPManager), tests, deploys | **Arc Studio** (driven from its web workspace and the Arc Studio CLI) |
| CCTP stock issuance, bridging, exchange setup scripts (`issuer/`) | Claude Code (orchestrator session) |
| Web app (`src/`), retro design, Bridge Kit screen | Claude Code worker session ("frontend") |
| Chainlink CRE price workflow (`cre/`) | Arc Studio (first version) + Claude Code worker ("CRE") |
| ENSv2 fund registry (`ens/`), CCIP fund naming (`contracts/ccip/`) | Claude Code worker ("ENS") |
| CCIP announce variant (`ccip/`, PR #8, not used) | Claude Code worker ("CCIP") |
| Product decisions, approvals, merges, wallet funding, CRE simulation on a laptop | Human (Ramit) |

The orchestrator session holds the testnet-only team wallet `0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93` and sends every onchain transaction; worker sessions never hold keys.

## Timeline

### Friday 6 November

| IST (UTC) | What happened | Proof |
|---|---|---|
| 02:39 (Thu 21:09) | Arc Studio project created; first plan: mock Indian stocks + user-created index funds | Arc Studio app `7582b931` |
| 13:53 (08:23) | Arc Studio project exported to GitHub | `8fbeca3` |
| 13:59 (08:29) | CCTP issuer scripts (Base Sepolia → Arc) | `4183842` |
| 14:11 (08:41) | **Arc Studio deploys** StockExchange (inventory model), IndexFactory, SIPManager to Arc Testnet; 145 unit tests pass | `a68f056`, [exchange](https://testnet.arcscan.app/address/0x93662de514b981f8c7bf97085e359e0f18034804) |
| 14:21 (08:51) | Switched to 8 mock US stocks; CRE price workflow moved to Yahoo Finance (via Arc Studio CLI) | `0125d65`, `ebe7267` |
| 14:44–16:08 (09:14–10:38) | **8 stocks deployed on Base Sepolia as Circle CCTP cross-chain tokens**, Arc copies created by Circle, listed on the exchange at live prices, 10,000 of each bridged into the exchange, 40 USDC reserve | `0de7960`, `707bf45`, `6d62136`, [setTrustedFactory](https://testnet.arcscan.app/tx/0x44fd3187e23ae8a4666f66333a5fc5c71c606833e2ebfd2ff035418b7823d64f), [reserve](https://testnet.arcscan.app/tx/0xcd5cf5d5833e3bd40282d049ae14fc650f3159c73a0b4fe9408a4d4a649c81f2) |
| 16:19–16:21 (10:49–10:51) | Design mockups: clean and retro "analog digitized" (retro chosen) | `3133b43`, `6ade36b` |
| 16:31 (11:01) | CRE workflow hardened (stale quotes, 5% move cap, report encoding) | `91e59c8`, `f529499` |
| 16:33–16:54 (11:03–11:24) | **Web app** merged (PR #1): markets, indices, create, portfolio; retro design | `08e0df6`, `2f562bf` |
| 16:44 (11:14) | Demo fund **BCHIP** (AAPL 30 / MSFT 25 / NVDA 25 / GOOGL 20) created, 5 USDC invested | `497d3fc`, [createIndex](https://testnet.arcscan.app/tx/0x75eef05176a93ab077519a0b8fd1fec5991f7cbc1da65110cafe4beaa28a3851) |
| 17:09 (11:39) | **ENSv2 registry on Sepolia**: `inphinity.eth`, UserRegistry + PermissionedResolver, `bchip.inphinity.eth` → BCHIP on Arc; all verify checks pass | `29e525b`, `548e63c`, [setResolver](https://sepolia.etherscan.io/tx/0x0d470a2b7be066d96e24a363dd39da2b9a27795dcfac54ac5cf97b8fbb7aa22d) |
| 17:13 (11:43) | **Bridge from Base** screen with **Circle Bridge Kit** (PR #5) | `2a9bda9` |
| ~17:30 (~12:00) | **Bridge Kit verified end to end**: 1 tAAPL Base Sepolia → Arc in ~15 min | [approve](https://sepolia.basescan.org/tx/0x7eb93dc3b9d5d81766b8041341cbda0754a993b95f6ed1620ea9ceaec642020f), [burn](https://sepolia.basescan.org/tx/0xb2039183fa749a498824b50e3004a474aa1fe55ec5f7fc89e7651e33ded26225), [mint on Arc](https://testnet.arcscan.app/tx/0x555f7dfb4a96c29c811284a8a5ae1560c9a275a3620cf19d92d7e3b841a1554d) |
| 17:25 (11:55) | CRE fix: config URL validation fails inside the WASM runtime (found by the first laptop simulation) | `6fcb88e` |
| 17:26 (11:56) | ENS names shown in the app (PR #6) | `1db6994` |
| 17:57 (12:27) | CRE rotates updates to the stalest prices (16 stocks > 15 HTTP calls per run) | `8449733` |
| 18:00–18:03 (12:30–12:33) | Admin bridging in the UI; **CCIP fund naming** (PR #7, factory registrar hook) | `6db6e69`, `81b00b6` |
| 18:45 (13:15) | CCIP announce variant (PR #8) deployed, later unused | `43ba72f` |
| ~18:50 (~13:20) | **8 more stocks** issued and listed (NFLX, AMD, JPM, V, WMT, KO, DIS, ORCL) | `72e4796`, [tNFLX listing](https://testnet.arcscan.app/tx/0x626a738f4846c834f1c781f0f8908942c151c6e823e589e7d02f6290c9462a51) |
| ~19:00 (~13:30) | **CCIP bridge (PR #7) deployed and enabled**: ArcEnsRegistrar on Arc, InphinityEnsReceiver on Sepolia | [setRegistrar](https://testnet.arcscan.app/tx/0x0287a3d7813a742c38bacb739e30e1c0af7f09ac1ebda8faf5fea6eda1c9dee8) |
| ~19:05 (~13:35) | First CCIP naming (`ccipdemo`) **failed on Sepolia: out of gas** (2.5M limit; live Sepolia needs ~4.5–7.5M). Fixed with `setGasLimit(9,000,000)` | [failed exec](https://sepolia.etherscan.io/tx/0xfc64cafbe69a5f1130fdec9e27570572e4b00a05a0caf9a57fc99735fc529b8a), [setGasLimit](https://testnet.arcscan.app/tx/0x8b6bd8e0b6a0f40bc13a4f00dd38788ac7d8218e45baec85e7daf7606022e623) |
| ~19:10 (~13:40) | Fund **AIBLD** (`aibuilders`) created to retest CCIP naming | [createIndex](https://testnet.arcscan.app/tx/0x8be78a15a78f26199739b43f0d8cfa72f64bf7275fafd8479483c009a8bc4eba) |
| ~19:25 (~13:55) | **CCIP naming works end to end**: Chainlink delivered the message and `aibuilders.inphinity.eth` resolves on Sepolia to the AIBLD fund on Arc, with weights and fee | [CCIP message](https://ccip.chain.link/msg/0xac8fffdffacd3e1cba6a7597fd9e690fd71e39506c9faee406c6e58aa3f0d53b), [Sepolia exec](https://sepolia.etherscan.io/tx/0x5399b805fa22da85cf294e92d7a1a7468ae45f217fe1e7e99794016c8d284e2a) |
| 19:11 (13:41) | **Readability pass** (PR #13): legible table prices (VT323), WCAG AA colours, labels ≥ 18px, slower ticker; CSS only | [PR #13](https://github.com/Ramitphi/inphinity/pull/13) |
| 19:14 (13:44) | Full project audit by the orchestrator; dedicated CRE worker session started to drive the laptop run | — |
| 19:18 (13:48) | **CRE dry run passes on the laptop**: 15/15 Yahoo prices fetched, "Wrote 15 prices (0 skipped)" | `feat/cre` |
| 19:25–19:26 (13:55–13:56) | **Exchange switched to Chainlink prices**: CRE gas wallet funded (2 USDC), `setExpectedAuthor(0xAAAA…AAAA)` (simulator workflow owner), `setPriceSource(Feed)`. Approved by Ramit | [fund gas wallet](https://testnet.arcscan.app/tx/0x9aadfacd98021d8d9cf63697b2bc93a55362c7de64599d4014fb1b0783db93e4), [setExpectedAuthor](https://testnet.arcscan.app/tx/0xa3dd4bdea44175b70c1f7778af18c339891a7a75f5f16ea657e3b7890af2dde0), [setPriceSource](https://testnet.arcscan.app/tx/0x6a6e60eb7955cbc23f3b15eb18d6463147e6399afa1361997b06cecb99154342) |
| 19:47 (14:17) | **First live Chainlink CRE report on Arc**: `cre workflow simulate --broadcast` → Chainlink forwarder → StockExchange; 15 prices written, `lastReportAt` set. Cost 278,986 gas × 25 gwei ≈ 0.007 USDC per update | [report tx](https://testnet.arcscan.app/tx/0xd2a96bfedcf3733d8da9e38332221142d5996ebf6f8307aa78b9936d5779375e) |
| 19:50 (14:20) | CRE runbook: measured cost, `.env` override gotcha (an empty `CRE_ETH_PRIVATE_KEY=` line beats an exported variable), `run-loop.sh` refuses an empty key | `ae425fc` |
| 19:50 (14:20) | Audit finding: CCIP naming fee quote jumped from ~0.5 to ~21.9 USDC (testnet fee data); registrar holds 1.96 USDC, so new funds skip naming until topped up. Fund creation is unaffected | [ArcEnsRegistrar](https://testnet.arcscan.app/address/0x39437a4f9c2ed49c5c3310681d440b26a0cb23cd) |

## Live addresses

| What | Network | Address |
|---|---|---|
| StockExchange | Arc Testnet | `0x93662de514b981f8c7bf97085e359e0f18034804` |
| IndexFactory | Arc Testnet | `0x9fa4034efb237a7c154adea20b1ccfa0cd538b11` |
| SIPManager | Arc Testnet | `0xd96ea5a6c776eac72e5da4f7abb838b5da053f3a` |
| ArcEnsRegistrar (CCIP sender) | Arc Testnet | `0x39437a4f9c2ed49c5c3310681d440b26a0cb23cd` |
| InphinityEnsReceiver (CCIP receiver) | Sepolia | `0x95b9aaba9fc5209e68afe1686d80a69fa03bb23f` |
| inphinity.eth UserRegistry / PermissionedResolver | Sepolia | `0xefC414eb999907620AbdA991decD2BD22aBb9Ac1` / `0x26E1611FD97133dfaef7b562D88528e8C1649ae2` |
| 16 stock tokens (same address on Base Sepolia and Arc) | Base Sepolia, Arc | see `issuer/README.md` |

## Open items (updated as they close)

- [x] Chainlink CRE: laptop simulation passes, `setExpectedAuthor` + `setPriceSource(Feed)`, live `--broadcast` report on Arc
- [ ] CRE `run-loop.sh` running through the demo (US market opens 20:00 IST)
- [ ] Top up the CCIP registrar before the demo (fee ~21.9 USDC at 19:50 IST)
- [ ] Inventory for the 8 newer stocks (tNFLX…tORCL)
- [x] CCIP naming retest (`aibuilders`) delivered on Sepolia
- [ ] Public hosting of the web app
- [ ] Arc Studio project synced with GitHub `main`
- [ ] README, architecture diagram, demo video, ETHGlobal submission
