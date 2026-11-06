# Inphinity: ETHGlobal Mumbai submission

Copy-paste answers for every field of the ETHGlobal Mumbai project form, in form order. Drafted 7 Nov 2026, ~01:00 IST, from `BUILD_LOG.md`, `DECISIONS.md` and the live contracts.

- The form fields and rules come from Ramit's screenshots of the live form and from ethglobal.com/events/mumbai/prizes and /info/details, all read on 7 Nov.
- `[RAMIT]` marks something only Ramit can fill in or decide.
- `[UNVERIFIED]` marks a claim we couldn't check from here.

> **Blocker before submitting:** the GitHub repo `Ramitphi/inphinity` is **private**. ETHGlobal ("Project should be open source") and ENS ("code needs to be open source") both require a public repo, and every code link below 404s until it is public.
> - Make it public under GitHub → Settings → General → Danger zone → Change visibility.
> - I scanned the full git history for private keys. The only key-shaped value is forge-std's public Anvil test key (`lib/forge-std/test/StdCheats.t.sol`); the rest are tx hashes, token IDs and salts. `.env` files are git-ignored. A quick scan, not an audit.

### Rules that shape these answers

- **Deadline:** Sat 7 Nov, **09:00 IST** (03:30 UTC). You can still edit the project after submitting.
- **Video:** **2 to 4 minutes** (uploads outside that range are rejected) and at least 720p.
  - No speed-up, no AI or text-to-speech voiceover, and no phone recording.
- **Partner prizes:** up to **3 partners**. A partner with several tracks counts once, so Chainlink gives both CRE and CCIP.
  - Per partner the form asks for: a "why applicable" answer (min 20 characters), **one** code link, a 1–10 ease rating, and feedback (min 30 characters).
- **AI use:** say which files were AI-generated or AI-assisted. Spec-driven work must include its plans and prompts (we have `arc-studio-plans/` and `docs/DECISIONS.md`).
- **Finalists:** 4-minute demo plus 3 minutes of Q&A.

---

## 1. Project details

| Field | Answer |
|---|---|
| Project name | **Inphinity** |
| Category | DeFi |
| Emoji | 💰 |
| Demo link | https://www.inphinity.trade/ (also https://inphinity.vercel.app; both load, checked 7 Nov ~00:55 IST) |

### Short description (max 100 characters)

> Index funds from any tokenized stock: CCTP-bridged, Chainlink-priced, ENS-named, on Arc. US now, India next.

(99 characters. Shorter fallback: `Index funds from any tokenized stock, on Arc. US stocks today, Indian stocks next.`, 83 characters.)

### Description (min 280 characters)

> Inphinity lets anyone build an index fund from tokenized stocks and lets anyone invest in it with USDC on Arc.
>
> **The problem.** Tokenized stocks exist, but holding a basket means buying, tracking and rebalancing each token yourself, on whichever chain it was issued. In India, the mutual fund or index fund is how most people invest. Onchain, that product layer is missing.
>
> **What we built (all live on testnets):**
> - **16 mock US stocks** (tAAPL, tNVDA, tNFLX…) are issued on Base Sepolia as **Circle CCTP native cross-chain tokens** and bridged to **Arc Testnet** with Circle **Bridge Kit**: same address on both chains, burn and mint, no wrapped IOU.
> - An oracle-priced **StockExchange** on Arc holds stock inventory and a USDC reserve. It trades at the oracle price ± 0.5%, with a 5% cap per price update and a stale-price freeze.
> - **Chainlink CRE** fetches prices from Yahoo Finance with median consensus and writes signed reports to the exchange every 5 minutes. Real market moves land onchain.
> - **Index funds:** pick 2–10 stocks, set the weights and a fee (up to 2%/yr). Each fund is an ERC-20 whose shares are minted and burned at **NAV**. The investor pays the spread, so existing holders aren't diluted. Performance is NAV per share "since inception" (every fund starts at 1.00).
> - **ENSv2 names:** every fund gets `<name>.inphinity.eth` on Sepolia, written from Arc in the same transaction that creates the fund, through **Chainlink CCIP**. The name resolves to the fund's Arc address and carries its weights, fee and creator. The fund profile page (e.g. `/bchip.inphinity.eth`) reads the ENS records and verifies them against the fund contract on Arc.
>
> Identity lives in ENS, value lives onchain on Arc, and the profile page joins and verifies the two.
>
> Tokens are mocks priced from real market data, not securities. The design takes any tokenized stock, so Indian equities (NSE prices through CRE, an Indian issuer on its home chain) are the next market.

`[RAMIT]` If you ship the **index-only** version (DECISIONS.md 4b), change one sentence: "It trades at the oracle price ± 0.5%" → "Funds trade through it at the oracle price ± 0.5%; the app offers index funds only, not single-stock trading." Nothing else changes.

### How it's made (min 280 characters)

> **Chains:**
> - Arc Testnet: exchange, funds, fund registry, USDC as gas and settlement.
> - Base Sepolia: the stocks' home chain.
> - Ethereum Sepolia: ENSv2.
>
> **Contracts (Solidity 0.8.28, Foundry, OpenZeppelin).** Arc Studio wrote, tested and deployed the core: `StockExchange`, `IndexFund`, `IndexFactory`, `SIPManager` (140 Foundry tests including invariants).
> - **Exchange:** an inventory exchange, not an AMM, so prices track the real market instead of a thin testnet pool.
> - **Funds:** NAV = Σ balance × oracle price + idle USDC. The management fee is minted as dilution. `investInKind` lets holders deposit stocks directly.
>
> **Stocks (Circle CCTP for non-USDC assets):**
> - Our issuer scripts (`issuer/`, viem) deploy each stock on Base Sepolia through Circle's CrossChainTokenService, and Circle creates the twin on Arc at the same address.
> - The in-app Bridge page uses **Bridge Kit** (`@circle-fin/bridge-kit` + `provider-cctpx`): approve, burn on Base, Circle attests, and Circle's relayer mints on Arc, so the user needs no Arc gas.
> - The issuer bridges stock straight into the exchange's inventory.
>
> **Prices (Chainlink CRE, TypeScript SDK):**
> - Each run reads the listed stocks from the exchange and fetches Yahoo Finance quotes with median consensus.
> - It clamps any move above the exchange's 5% cap, so a report is never rejected, then ABI-encodes and signs a report.
> - The forwarder calls `StockExchange.onReport`.
> - It rotates the 15 stalest stocks per run (the CRE HTTP limit).
> - It runs as `cre workflow simulate --broadcast` every 5 min from a laptop (DON deploy access is gated), at about 0.007 USDC per update.
>
> **Names (Chainlink CCIP + ENSv2):**
> - `IndexFactory.createIndex` calls our `ArcEnsRegistrar`, which `ccipSend`s the fund data to `InphinityEnsReceiver` on Sepolia.
> - The receiver registers the label in our own ENSv2 **UserRegistry**, writes a record bundle on a **PermissionedResolver** (Arc address under ENSIP-11 coin type 2152525650, text records for weights, fee and creator), and links `<symbol>` and `latest` to it.
> - Enhanced Access Control does the safety work. The creator owns the name but holds only `ROLE_RENEW`: no resolver change, no subnames, no transfer, so a fund name can't be repointed to phish investors. The receiver holds only the registrar and setter roles.
> - Naming never reverts fund creation. If CCIP can't deliver (fee too low, out of gas), a fallback relayer names the fund. It only acts when CCIP didn't.
>
> **Frontend:** React 18, Vite, TypeScript, wagmi/viem and ConnectKit in a retro "analog digitized" design, hosted on Vercel.
>
> **Hacky bits:**
> - Live Sepolia ENS writes cost 4.5–7.5M gas against ~1.2M on a fork. The first CCIP message ran out of gas, so we raised the CCIP gas limit to 9M.
> - The testnet CCIP fee jumped from ~0.5 to ~21.7 USDC mid-hackathon, which is why the fallback exists.
> - CRE's simulator signs with a fixed placeholder workflow owner, so the exchange trusts that author. Bounded by the 5% cap; testnet only.

### GitHub repositories

- https://github.com/Ramitphi/inphinity (**must be made public first**, see the blocker above)

---

## 2. Tech stack (form page 2)

| Question | Select / type |
|---|---|
| Ethereum developer tools | Foundry, viem, wagmi, OpenZeppelin, Hardhat (used only for the ENS fork test) |
| Blockchain networks | Arc Testnet, Base Sepolia, Ethereum Sepolia |
| Programming languages | Solidity, TypeScript, Bash |
| Web frameworks | React, Vite, Tailwind CSS |
| Databases | None |
| Design tools | None (the mockups are HTML files in `docs/design/`) |
| Other technologies | Arc Studio, Circle CCTP (non-USDC assets / CCTPx), Circle Bridge Kit, Chainlink CRE (TypeScript SDK, CRE CLI), Chainlink CCIP, ENSv2 (UserRegistry, PermissionedResolver), ConnectKit, Bun, Vercel, Yahoo Finance API, Claude Code |

### Describe how AI tools were used

> AI did most of the code, under one human's direction.
>
> **Ramit (solo builder)** made every product decision:
> - stocks → funds;
> - CCTP instead of wrapped tokens;
> - an inventory exchange instead of an AMM;
> - ENS as the fund registry;
> - NAV "since inception";
> - the index-only scope.
>
> He also reviewed and merged every PR, approved and funded every onchain transaction, and ran the Chainlink CRE simulation on his laptop. The reasoning behind each decision is in `docs/DECISIONS.md`, and the timeline in `docs/BUILD_LOG.md`.
>
> **Arc Studio (Circle's AI builder):** wrote, tested (140 Foundry tests) and deployed the core contracts: `contracts/StockExchange.sol`, `IndexFund.sol`, `IndexFactory.sol`, `SIPManager.sol`, `contracts/test/*`. It also produced the app scaffold and the first CRE workflow. Its plans are in `arc-studio-plans/`.
>
> **Claude Code** (one orchestrator session plus task-specific worker sessions, each delivering a reviewed PR):
> - the CCTP issuer scripts (`issuer/`);
> - the web app (`src/`);
> - the CRE hardening and Yahoo switch (`cre/`);
> - the ENSv2 registry tooling and fallback (`ens/`);
> - the CCIP contracts (`contracts/ccip/`);
> - the docs.
>
> Only the orchestrator held the testnet-only team key; worker sessions never held keys.

---

## 3. Prizes (form page 4): pick these 3 partners

| Partner | Track(s) | Fit |
|---|---|---|
| **Arc** | Best Use of Bridge Kit for Non-USDC Assets, Built in Arc Studio | Strong: CCTP stock tokens, Bridge Kit page, Arc Studio contracts |
| **Chainlink** | Best workflow with CRE **and** Best use of Chainlink CCIP 2.0 (one partner slot) | Strong: CRE is live onchain; CCIP makes a state change on Sepolia from inside our contracts |
| **ENS** | Best Use of ENSv2 (not the Continuity track) | Strong: our own UserRegistry, PermissionedResolver, EAC roles, record linking, live on Sepolia |

"Which other partners' technologies have you used?" Nothing else from the list: Circle is covered under Arc. `[RAMIT]` Check whether "Circle" appears separately in that dropdown.

### Arc: $15,000

**Why you're applicable**
> Submitting for **Best Use of Bridge Kit for Non-USDC Assets**.
>
> - **Arc Studio was the starting point.** Arc Studio wrote, tested (140 Foundry tests) and deployed our core contracts on Arc, StockExchange, IndexFund and IndexFactory, and the project lives in Studio: `[RAMIT: Arc Studio share URL]`.
> - **The non-USDC assets.** We issued 16 tokenized stocks on Base Sepolia as **CCTP native cross-chain tokens** (same address on both chains, burn and mint).
> - **The bridge.** Our Bridge page uses **Bridge Kit** to move them to Arc in one flow, where Circle's relayer mints them, so no Arc gas is needed.
> - **USDC on Arc.** They settle against USDC: the exchange prices them in USDC, and index funds take USDC deposits.
> - **Verified end to end:** tAAPL Base → Arc, [burn](https://sepolia.basescan.org/tx/0xb2039183fa749a498824b50e3004a474aa1fe55ec5f7fc89e7651e33ded26225) → [mint on Arc](https://testnet.arcscan.app/tx/0x555f7dfb4a96c29c811284a8a5ae1560c9a275a3620cf19d92d7e3b841a1554d).

**Link to the line of code**
> https://github.com/Ramitphi/inphinity/blob/main/src/lib/bridge.ts#L96

(The `kit.bridge(...)` call. Its setup with `new BridgeKit()` and the viem adapter is at L59–L62.)

**Ease (1–10):** `[RAMIT]` Suggested **7**.
- Bridge Kit itself was simple.
- CCTPx issuance needed Circle's token-service calls and a 15–20 minute wait for Base finality, and Arc Studio's own issuance attempt was blocked by a lack of Base Sepolia ETH for its signer.

**Feedback (min 30 characters)**
> - **Bridge Kit + CCTPx worked first time** for a non-USDC token: one `kit.bridge` call, and the relayer mint means users need no Arc gas.
> - **What would help:**
>   - (1) A status/resume API for a transfer after a page reload, since Standard transfers take 15–20 min and users close the tab.
>   - (2) A documented CCTPx example for issuing a brand-new token (CrossChainTokenService + token IDs) next to the bridging docs.
>   - (3) Arc Studio: a way to fund or bring a signer for another chain (Studio's Base Sepolia issuance stalled for lack of Base ETH).
>   - (4) A "copy to GitHub" sync that also pulls changes back into Studio.

### Chainlink: $5,000

**Why you're applicable**
> We use **both CRE and CCIP**, each making real state changes.
>
> **CRE** is our price oracle:
> - The workflow reads the listed stocks from our Arc exchange, fetches Yahoo Finance quotes with median consensus, clamps each move to the exchange's 5% cap, and writes a signed report.
> - The forwarder calls `StockExchange.onReport`.
> - It has run every 5 min via `cre workflow simulate --broadcast` since 6 Nov ([first live report](https://testnet.arcscan.app/tx/0xd2a96bfedcf3733d8da9e38332221142d5996ebf6f8307aa78b9936d5779375e)), and fund NAVs move with it.
>
> **CCIP** names funds cross-chain:
> - `IndexFactory.createIndex` on Arc calls our `ArcEnsRegistrar`, which `ccipSend`s the fund data to `InphinityEnsReceiver` on Sepolia.
> - The receiver registers the fund's ENSv2 name and records.
> - Live: [CCIP message](https://ccip.chain.link/msg/0xac8fffdffacd3e1cba6a7597fd9e690fd71e39506c9faee406c6e58aa3f0d53b) → `aibuilders.inphinity.eth`.

**Link to the line of code**
> https://github.com/Ramitphi/inphinity/blob/main/contracts/ccip/ArcEnsRegistrar.sol#L152

(The `router.ccipSend` call; CCIP is required "inside your smart contracts". Mention the CRE report write in the text if there's room: `cre/price-feed/main.ts#L415`, received at `contracts/StockExchange.sol#L227`.)

**Ease (1–10):** `[RAMIT]` Suggested **6**.
- The CRE SDK was pleasant.
- The CCIP gas sizing and fee spikes cost us hours.

**Feedback (min 30 characters)**
> - **CRE:** the TypeScript SDK and the simulator made a real oracle easy.
>   - Gotchas: a `cre/.env` line `CRE_ETH_PRIVATE_KEY=` (empty) silently overrides an exported variable, and the CLI falls back to an unfunded default key.
>   - URL validation fails inside the WASM runtime.
>   - The 15-HTTP-call limit forced stalest-first rotation.
>   - The simulator's fixed placeholder workflow owner (`0xAAAA…`) means a receiver can't tell a real simulation from a hand-made report. A documented "trusted simulation" mode would help hackathon teams.
> - **CCIP:**
>   - The receiver's gas on live Sepolia was 4–6× what a fork measured (ENS storage writes). The first message failed out of gas, and we recovered with manual execution.
>   - The Arc → Sepolia fee jumped from ~0.5 to ~21.7 USDC during the event.
>   - Please surface live-gas guidance and fee volatility on testnet lanes in the docs.

### ENS: $10,000

**Why you're applicable**
> **Best Use of ENSv2.** ENSv2 is Inphinity's fund registry, not a cosmetic add-on.
>
> **What gets created:** every fund created on Arc gets `<label>.inphinity.eth` on Sepolia, in the same transaction, through Chainlink CCIP. We run our **own UserRegistry** under `inphinity.eth`, plus a **PermissionedResolver**.
>
> **What a fund's name holds:**
> - its Arc address (ENSIP-11 coin type, deliberately no ETH address);
> - weights, fee and creator as text records;
> - links: `<symbol>` and `latest` share the record bundle via `linkToNode`;
> - a default bundle that answers "Not an Inphinity fund" for every unknown name.
>
> **Enhanced Access Control** is the anti-phishing design. Each creator owns the fund's name token but holds only `ROLE_RENEW`: no resolver change, no subregistry, no transfer. The CCIP receiver holds only the registrar and setter roles.
>
> **Live, nothing hard-coded:** https://www.inphinity.trade/bchip.inphinity.eth reads the ENS records and verifies them against the fund contract on Arc.

**Link to the line of code**
> https://github.com/Ramitphi/inphinity/blob/main/contracts/ccip/InphinityEnsReceiver.sol#L119

(The `userRegistry.register(label, creator, …, ROLE_RENEW, expiry)` call. Record linking is at L129–L132 and the Arc address at L165. The role design is explained in `ens/DESIGN.md`, section 4.)

**Ease (1–10):** `[RAMIT]` Suggested **6**.
- Powerful primitives.
- Finding the *live* Sepolia deployment took time: older tags aren't the set behind the Universal Resolver.

**Feedback (min 30 characters)**
> - **Enhanced Access Control made a safe fund registry possible:** creators own names but can't repoint them. And record linking (`<symbol>`, `latest`) removed all copy-sync code.
> - **Pain points:**
>   - (1) The live Sepolia ENSv2 addresses are on branch `deploy/mainnet-v2-20261002`; older `sepolia-deployment-*` tags look current but don't resolve. One canonical "live addresses" page would save hours.
>   - (2) Live storage gas is far above fork estimates (~384k vs ~70k per new text record), which matters for cross-chain writers.
>   - (3) Resolver roles are scoped per setter argument, not per name, so per-name delegated text editing isn't possible. An example covering that would help.
>   - (4) An ENSIP-11 example for non-EVM-mainnet chains like Arc.

---

## 4. Demo video

See [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md). Main cut ~3:00. Backup cut ~2:10: the 2:00 minimum rules out a 30-second upload, so the 30-second version is a spoken pitch for booths and the finalist intro.

## 5. Images (form page 2: "Upload images")

`[RAMIT]` Suggested screenshots, at desktop width:
1. Markets board with live prices.
2. Create index review step.
3. A fund page (NAV / share, since inception).
4. `/bchip.inphinity.eth` profile with "Verified against Arc".
5. Bridge from Base page.
6. The architecture diagram (render `docs/ARCHITECTURE.md` on GitHub).
7. The Arc Studio project.

## 6. Contract addresses

| Contract | Network | Address |
|---|---|---|
| StockExchange | Arc Testnet (5042002) | [`0x93662de514b981f8c7bf97085e359e0f18034804`](https://testnet.arcscan.app/address/0x93662de514b981f8c7bf97085e359e0f18034804) |
| IndexFactory | Arc Testnet | [`0x9fa4034efb237a7c154adea20b1ccfa0cd538b11`](https://testnet.arcscan.app/address/0x9fa4034efb237a7c154adea20b1ccfa0cd538b11) |
| SIPManager (no UI) | Arc Testnet | [`0xd96ea5a6c776eac72e5da4f7abb838b5da053f3a`](https://testnet.arcscan.app/address/0xd96ea5a6c776eac72e5da4f7abb838b5da053f3a) |
| ArcEnsRegistrar (CCIP sender) | Arc Testnet | [`0x39437a4f9c2ed49c5c3310681d440b26a0cb23cd`](https://testnet.arcscan.app/address/0x39437a4f9c2ed49c5c3310681d440b26a0cb23cd) |
| CRE mock forwarder (simulation) | Arc Testnet | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| InphinityEnsReceiver (CCIP receiver) | Ethereum Sepolia | [`0x95b9aaba9fc5209e68afe1686d80a69fa03bb23f`](https://sepolia.etherscan.io/address/0x95b9aaba9fc5209e68afe1686d80a69fa03bb23f) |
| `inphinity.eth` UserRegistry | Ethereum Sepolia | `0xefC414eb999907620AbdA991decD2BD22aBb9Ac1` |
| PermissionedResolver | Ethereum Sepolia | `0x26E1611FD97133dfaef7b562D88528e8C1649ae2` |
| Circle CrossChainTokenService | all testnets | `0x63753E722bd2C2A5DF6EE19C5106662208B81077` |
| tAAPL (same on Base Sepolia and Arc) | Base Sepolia, Arc | `0x4572E4D21199deA83a5E069361871512c31a3bBd` |
| Other 15 stock tokens | Base Sepolia, Arc | see `issuer/README.md` and `issuer/deployments.json` |
| USDC | Arc Testnet | `0x3600000000000000000000000000000000000000` |

Live state read 7 Nov ~00:55 IST: `priceSource = 1` (Chainlink feed), last CRE report 2 min old, 5 funds, CCIP registrar balance 28.2 USDC.

## 7. Key proof links

| Claim | Proof |
|---|---|
| Arc Studio deployed the core contracts | commit `a68f056`; [exchange on Arcscan](https://testnet.arcscan.app/address/0x93662de514b981f8c7bf97085e359e0f18034804) |
| Bridge Kit, Base → Arc | [approve](https://sepolia.basescan.org/tx/0x7eb93dc3b9d5d81766b8041341cbda0754a993b95f6ed1620ea9ceaec642020f), [burn](https://sepolia.basescan.org/tx/0xb2039183fa749a498824b50e3004a474aa1fe55ec5f7fc89e7651e33ded26225), [mint](https://testnet.arcscan.app/tx/0x555f7dfb4a96c29c811284a8a5ae1560c9a275a3620cf19d92d7e3b841a1554d) |
| First live CRE report | [tx](https://testnet.arcscan.app/tx/0xd2a96bfedcf3733d8da9e38332221142d5996ebf6f8307aa78b9936d5779375e) |
| CRE clamping a >5% move (tAMD) | [tx](https://testnet.arcscan.app/tx/0xa7f89be402cdb17989978331ac60a34f09de08e669eacd04c5fbc5fd3a5f5847) |
| CCIP naming, end to end | [CCIP message](https://ccip.chain.link/msg/0xac8fffdffacd3e1cba6a7597fd9e690fd71e39506c9faee406c6e58aa3f0d53b), [Sepolia exec](https://sepolia.etherscan.io/tx/0x5399b805fa22da85cf294e92d7a1a7468ae45f217fe1e7e99794016c8d284e2a) |
| ENSv2 registry setup | [setResolver](https://sepolia.etherscan.io/tx/0x0d470a2b7be066d96e24a363dd39da2b9a27795dcfac54ac5cf97b8fbb7aa22d) |
| Demo fund BCHIP | [createIndex](https://testnet.arcscan.app/tx/0x75eef05176a93ab077519a0b8fd1fec5991f7cbc1da65110cafe4beaa28a3851), https://www.inphinity.trade/bchip.inphinity.eth |

## 8. Honest limits (say them if asked)

- **Mock tokens:** tokens are mocks priced from real data, not securities. There is no KYC.
- **CRE runs as a simulation:** it runs as a local simulation with `--broadcast`, not a deployed DON workflow. The exchange trusts the simulator's public placeholder author, so anyone could push prices within the 5% cap. Testnet only; roll back with `setPriceSource(0)`.
- **CCIP fee:** the testnet CCIP fee is ~21.7 USDC per fund. While the registrar holds less than that, new funds aren't named by CCIP; they get `NamingSkipped` and the fallback names them.
- **Fallback relayer:** it is built and dry-run tested but not yet started (open item in BUILD_LOG). Fund **RMT** and fund **AICHIP** (`ccipdemo`) are unnamed until it runs.
- **SIPManager:** it is deployed but has no UI.
- **Public `buy`/`sell`:** `StockExchange.buy/sell` stay public onchain even in an index-only app.

## 9. Gaps only Ramit can fill

1. **Make the repo public** (blocker).
2. **Arc Studio shareable project URL** (judges must be able to open it): app `7582b931-f752-4b46-a210-d0898b2062a7`.
3. Ease ratings (suggested above), and the index-only go/no-go (one sentence in the description).
4. Team / social handles for the showcase, if the form asks.
5. Arc: confirm that we name only the Bridge Kit track. The DeFi / Onchain Finance track ("trading with tokenized RWAs") also fits, but Arc asks you to state which bounty.
