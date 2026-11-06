> SUPERSEDED: the design changed to US tokenized stocks bridged from Base Sepolia with CCTPx. Follow `PLAN-base-bridge.md` instead.

## Implementation Plan: Bharat Index (tokenized Indian stocks and user-created index funds)

### Summary
A testnet app where you trade mock tokenized Indian stocks (tRELIANCE, tTCS, tINFY and others) with USDC. Anyone can create an index fund from those stocks with fixed weights and an optional management fee. Investors put in USDC, receive fund shares, and redeem them for their share of the fund's NAV. These are mock tokens priced from live NSE market data through a Chainlink CRE workflow (with a manual admin fallback), not real securities.

### Architecture
- **Blockchain:** Arc Testnet only. USDC is the gas token, and the ERC-20 USDC at `0x3600000000000000000000000000000000000000` (6 decimals) is the trading and investing currency.
- **Contracts (Solidity: stock token, exchange, fund, factory, ENS registrar, SIP manager):**
  - `StockToken`: an 18-decimal ERC-20 that only the exchange can mint or burn.
  - `StockExchange` (Ownable2Step, ReentrancyGuard):
    - Creates the stock tokens in its constructor and keeps a registry of them.
    - Holds an admin-set price for each stock, in USDC base units per 1 whole token, with a `lastUpdated` timestamp.
    - `setPrice(token, price)` is owner-only and only works while the price source is set to Admin (see "Price feed" below). Each update is capped at plus or minus 5% by default (owner-configurable) and must be non-zero. The exchange also charges a 0.5% spread each way (owner-configurable, max 2%), and bought stock cannot be sold back by the same address for 10 minutes (owner-configurable, max 1 hour). Funds are exempt from the stock hold and instead apply a per-user redemption lock after each investment. These measures reduce, but do not eliminate, profit from predictable price updates. The UI says so.
    - The exchange also receives Chainlink CRE price reports (see "Price feed" below) and rejects trades in any stock whose price is older than `maxPriceAge`.
    - `buy(token, usdcIn, minOut)` pulls USDC and mints stock tokens at the oracle price.
    - `sell(token, amount, minUsdcOut)` burns stock tokens from the caller and pays USDC from the reserve.
    - Rounding always favors the exchange.
    - Anyone can top up the USDC reserve by transferring USDC to it, and `reserveBalance()` is a view.
    - Views: `stockCount`, `stockAt`, `getStocks`.
    - **Stock issuance:** `listStock(name, symbol, initialPrice)` is owner-only. It deploys a new `StockToken` with the exchange as its only minter, registers it, and emits `StockListed`. Symbols must be unique, the price must be non-zero, and the registry is capped at 50 stocks. Listed stocks are permanent. Delisting is not included, because funds may already hold them.
  - `IndexFund` (ERC-20 shares, 18 decimals):
    - Immutable weights in bps (summing to 10000) and an immutable stock list. It holds the stock tokens plus any idle USDC dust.
    - `nav()` is the sum of balance times price over all holdings, plus idle USDC. `navPerShare()` is a view.
    - `invest(usdcIn, minShares)`: mints shares against the pre-deposit NAV. The first deposit mints at 1 USDC per share, with a minimum of 1 USDC and a small permanent dead-share lock against inflation attacks. Then it splits the USDC by weight and buys each stock through the exchange.
    - `redeem(shares, minUsdcOut)`: burns shares, sells the pro-rata slice of every holding back to the exchange, and pays the idle USDC share plus the sale proceeds to the caller.
    - The management fee is accrued by minting dilution shares to the creator, based on time elapsed. It is capped at 2% a year and settled on invest, redeem and `collectFee()`.
  - `IndexFactory`:
    - `createIndex(name, symbol, stocks[], weightsBps[], feeBps)` is open to anyone.
    - It validates 2 to 10 unique, listed stocks, weights summing to 10000, each weight above 0, and a fee of at most 200 bps.
    - It deploys an `IndexFund` and records it in a registry.
    - Views: `indexCount`, `indexAt`, `getIndexes(offset, limit)`, `indexesByCreator`.
    - It emits `IndexCreated`.
    - **ENS subname on creation:** `createIndex` also takes an ENS label (lowercase letters and digits, 3 to 20 characters, defaulting to the fund symbol) and, in the same transaction, mints `<label>.<your-parent>.eth` through a registrar contract. The creator receives the subname NFT, and the fund address is stored as the Arc address record. If the label is already taken, the whole transaction reverts.
- **Built for testnet, structured so a mainnet move is possible later:**
  - **Scope today:** everything in this plan runs on Arc Testnet with mock stocks. Nothing here deploys to mainnet or touches real securities. A later move to already-tokenized US stocks (for example Dinari dShares) would be a separate project and decision, and this plan does not make it for you.
  - **Venue interface (`IStockVenue`):** `IndexFund`, `IndexFactory` and `SIPManager` talk to stocks only through a small interface: `buy(token, usdcIn, minOut)`, `sell(token, amount, minUsdcOut)`, `price(token)`, `lastUpdated(token)`, and `isListed(token)`. `StockExchange` implements it. A future adapter for real tokenized stocks would implement the same interface, so the fund, factory and SIP code would not need to change. Funds hold a venue address set at creation.
  - **Market config in the frontend (`src/lib/market.ts`):** currency (INR today, USD later), display FX rate, exchange hours and time zone (NSE today), stock metadata keyed by token address per chain, and the disclaimer text. Nothing else in the UI hard-codes INR, NSE or the testnet.
  - **Price feed is provider-agnostic:** the CRE workflow's provider URL, ticker mapping, schedule and currency conversion all live in `config.json`.
  - **What a mainnet move would still need, and this plan does not cover:**
    - A real venue adapter, plus testing against the real tokens' transfer rules. The tokens may restrict who can hold or receive them, so a fund contract holding them may not be allowed. I have not verified this.
    - Eligibility, KYC and legal review. A fund of tokenized stocks may be a regulated product in many countries.
    - Corporate actions: dividends, splits and voting on the real tokens.
    - A full independent security audit, and a mainnet-specific launch decision. This tool's reviews are not a substitute.
- **Price feed (Chainlink CRE, with admin fallback):**
  - **Price source switch:** `StockExchange` has a `priceSource` setting, Admin or Feed, changeable only by the owner. In Admin mode the owner's `setPrice` works and feed reports are ignored. In Feed mode `setPrice` reverts and only feed reports update prices. It starts in Admin mode so the sandbox works before the workflow is live, and the owner can switch back at any time as an emergency fallback.
  - **Receiving reports:** `StockExchange` also inherits Chainlink's `ReceiverTemplate`, so only the Chainlink forwarder can call `onReport`, and only reports from your workflow's owner or ID are accepted. The report is `abi.encode(address[] tokens, uint256[] prices, uint64 timestamp)`, with prices in USDC base units (6 decimals) per whole token. The forwarder address and the expected workflow owner are owner-settable, because simulation uses a mock forwarder and production uses a different one. The forwarder directory lists `0x76c9cf548b4179F8901cda1f8623568b58215E62` for Arc Testnet. The build agent re-checks it against Chainlink's forwarder directory before using it.
  - **Report validation:** the report timestamp must be newer than the stock's last update and not in the future. Each price move is capped (5% by default, owner-configurable, same as manual updates), prices must be non-zero, and tokens must be listed. Invalid entries revert the whole report.
  - **Staleness:** `maxPriceAge` is owner-configurable and defaults to 96 hours, so a weekend plus an Indian market holiday does not freeze trading. `buy`, `sell`, and therefore fund `invest` and `redeem`, revert when any needed stock price is older than that. The UI shows each price's age and a "NSE market closed" label outside roughly 9:15 to 15:30 IST, Monday to Friday.
  - **CRE workflow (`cre/price-feed`, TypeScript):**
    - A scheduled trigger runs every 5 minutes on weekdays during NSE hours. The schedule is configurable in `config.json`.
    - It reads the listed stocks from `StockExchange.getStocks()` on Arc Testnet. The NSE ticker for each stock is its token symbol without the leading "t" (for example tRELIANCE becomes RELIANCE). `config.json` can override this per stock.
    - It fetches each stock's NSE price in INR and the USD/INR rate from Twelve Data (or an equivalent keyed provider), using an HTTP call with the API key stored as a CRE secret (`secrets.yaml`).
    - The nodes agree on the values, the workflow converts to USDC (price in INR divided by USD/INR, times 1e6), and it writes the report to `StockExchange` on `arc-testnet`.
    - You need to check that your Twelve Data plan covers NSE quotes and the request rate. Free plans may not.
  - **Who runs it:** the build agent writes the workflow, config and contract. You run `cre workflow simulate` and, if your Chainlink account has deploy access, deploy the workflow from your own machine with the CRE CLI. Chainlink describes Arc Testnet support as being for workflow simulation. I could not confirm that deployed, scheduled workflows run against Arc Testnet, so the Admin fallback stays available.
- **SIP / DCA (`SIPManager`, new contract):** a recurring investment into a fund, paid in USDC.
  - **Creating a SIP:** `createSIP(fund, amount, interval, maxInstallments, startNow)`. The fund must have been created by `IndexFactory` (the factory gets an `isIndex(address)` view for this). The minimum amount is 1 USDC. Intervals are 5 minutes (demo only, so you can test without waiting a month), 1 day, 7 days and 30 days. `maxInstallments` of 0 means no end. Each user can have at most 20 active SIPs. If `startNow` is true, the first installment runs inside the same transaction.
  - **Pull model, no custody:** the SIP manager never holds your money between installments. You approve USDC to it once (the UI suggests an allowance of amount times the number of installments, not unlimited), and each installment pulls USDC from your wallet, invests it in the fund, and forwards the new shares to you.
  - **Execution:** `executeSIP(id)` can be called by anyone once `nextDue` has passed. It runs one installment per call, and a SIP that is far behind does not backfill: the next due time moves to `now + interval`. `executeDue(ids[])` batches several SIPs and skips any that fail (no allowance, no balance) instead of reverting the whole batch. A SIP is paused automatically after 3 failed installments in a row.
  - **Controls:** the SIP owner can `pause`, `resume`, and `cancel`. Cancelling also lets you revoke the allowance.
  - **Views:** `getSIP(id)`, `sipsByOwner(owner)`, `isDue(id)`, and per-SIP totals for installments done and USDC invested. Events: `SIPCreated`, `SIPExecuted`, `SIPFailed`, `SIPPaused`, `SIPCancelled`.
  - **No keeper in this plan:** there is no backend, so installments only run when someone opens the app. The app checks for due SIPs and prompts the owner to run them, and it shows a "SIPs due" banner. This means a SIP is not truly automatic, and the UI says so. An optional keeper script run from a funded wallet is a possible later addition.
- **ENS subnames (onchain, Durin):**
  - **Parent name:** the Sepolia ENS name you own. The build agent asks you for it, and for the Sepolia wallet that controls it.
  - **Registry on Arc Testnet:** Durin's `L2Registry` is deployed on Arc Testnet (chain 5042002). It stores each subname as an ERC-721 NFT, with address and text records. Durin's published factory list does not include Arc, so deploy the registry from the Durin contracts directly.
  - **`IndexRegistrar` (new contract):** registered on the registry with `addRegistrar()`, and callable only by `IndexFactory`. It validates the label, mints the subname to the creator, sets the address record using the Arc coin type (ENSIP-11, `0x80000000 | 5042002`), and sets text records for description and creator. It deliberately does not set the Ethereum (coin type 60) address, so nobody sends funds to a fund address that does not exist on Ethereum.
  - **Resolution:** on Sepolia, set your parent name's resolver to Durin's L1 resolver and call `setL2Registry(registry, 5042002)`, from your parent-name wallet (no Arc Studio tooling can do this for you). Names are resolved through the CCIP-Read gateway.
  - **Open risk:** Durin's gateway code lists Arc Testnet, but I could not confirm that its hosted resolver and gateway accept it. The build agent checks this with a live lookup right after the setup. If it fails, the app still works with raw addresses, and ENS resolution is held back until a gateway is arranged (a self-hosted gateway is out of scope for this plan).
  - **Frontend:** Sepolia is added to the wagmi config for lookups. Fund cards, fund detail and Portfolio show the ENS name, and the Funds tab can be searched by name.
- **Stock issuance model:** only the exchange owner can issue new stocks, which keeps the market curated. Anyone can then include a listed stock in an index. Open issuance by any user is a possible later change, but it would let spam or fake tickers appear, so it is not in this plan.
- **Seeded stocks (8 mock tokens):** tRELIANCE, tTCS, tINFY, tHDFCBANK, tICICIBANK, tITC, tSBIN, tBHARTIARTL. Starting prices are the approximate INR price divided by a fixed demo rate of 85 INR per USDC. If one constructor deploying all eight tokens exceeds gas limits, seed the stocks through a follow-up owner call instead.
- **Owner and trust model:** the exchange owner (the user's wallet, supplied at deploy time) chooses the price source, sets prices manually only while the source is Admin, configures the forwarder and staleness limit, and can transfer ownership. This is a testnet trust assumption, and the UI says so. Redemptions can fail if the exchange's USDC reserve is too low after prices rise. The UI surfaces the reserve balance and shows a clear error.
- **Frontend (React + Vite + Tailwind, wagmi + viem):**
  - Tabs: Markets, Create Index, Funds, Portfolio, and an Admin tab visible only to the owner.
  - Flows: a two-step approve-then-action flow, balance and allowance reads, slippage guards, and toasts via sonner.
  - Display: INR equivalents using the fixed demo rate, plus a "testnet mock, not real securities" notice.
- **Wallet:** ConnectKit with the injected connector, as already set up in `src/config.ts`. The chain is Arc Testnet.
- **Review:** the contracts get a balanced security review before deploy and are verified on a fork of Arc Testnet first.

### Files to Create/Modify
1. `contracts/StockToken.sol`: mock stock ERC-20 with exchange-only mint and burn.
2. `contracts/StockExchange.sol`: stock registry, admin price feed, USDC buy and sell, reserve.
3. `contracts/IndexFund.sol`: fund share token with invest, redeem, NAV and management fee.
4. `contracts/IndexFactory.sol`: validated fund creation and registry.
4a. `contracts/IndexRegistrar.sol`: factory-only registrar that mints the ENS subname on the Durin `L2Registry` and sets its address and text records. The Durin `L2Registry` contracts are pulled in as dependencies, and the registry is deployed to Arc Testnet.
4b. `contracts/SIPManager.sol`: recurring USDC investments into funds (pull-based, anyone can execute due installments). `IndexFactory` gets the `isIndex(address)` view it needs.
4c. `contracts/ReceiverTemplate.sol` and `contracts/interfaces/IReceiver.sol`: Chainlink's report-receiver base contract and interface, vendored from Chainlink's documentation (no assumption that an npm package provides them), inherited by `StockExchange`.
4d. `cre/project.yaml`, `cre/secrets.yaml` and `cre/README.md`: CRE project setup with `arc-testnet` as the target, the Twelve Data API key declared as a secret, and step-by-step simulate and deploy instructions.
4e. `cre/price-feed/workflow.yaml`, `cre/price-feed/config.json`, `cre/price-feed/package.json` and `cre/price-feed/main.ts`: the scheduled price workflow (reads stocks, fetches prices, converts to USDC, writes the report).
4f. `contracts/interfaces/IStockVenue.sol`: the interface that `IndexFund`, `IndexFactory` and `SIPManager` use to trade and price stocks. `StockExchange` implements it.
5. `contracts/test/StockExchange.t.sol` and `contracts/test/IndexFund.t.sol`: unit tests for pricing, NAV, invest and redeem round trips, fee accrual and revert paths. Only if the review level calls for tests.
6. `src/lib/contracts.ts`: deployed addresses (from `contracts/contract-metadata/`), ABIs, and the USDC address.
7. `src/lib/stocks.ts`: static stock metadata (company name, sector, reference INR price, demo FX rate). Stocks issued later fall back to the on-chain name and symbol, with sector shown as "Other".
8. `src/lib/format.ts`: USDC (6 dec), share and token (18 dec) formatting, INR conversion, and bps to percent.
8a. `src/lib/ens.ts`: parent-name constant, label validation and availability check, and name-to-address and address-to-name lookups using the Arc coin type.
8b. `src/lib/market.ts`: per-chain market config (currency, display FX rate, exchange hours and time zone, stock metadata by token address, disclaimer text). Today it holds the Arc Testnet and NSE settings.
9. `src/hooks/useStocks.ts`: reads the stock list, prices and the user's token balances (batched).
10. `src/hooks/useIndexes.ts`: reads the fund list with per-fund NAV, NAV per share, TVL, weights, fee and creator.
11. `src/hooks/usePortfolio.ts`: the user's stock balances and fund share balances, valued in USDC and INR.
12. `src/hooks/useApprovedAction.ts`: shared approve-then-execute helper with receipt waiting.
13. `src/components/Header.tsx`: branding, tab navigation, ConnectKit button, USDC balance.
14. `src/components/StockMarket.tsx` and `src/components/TradeStockModal.tsx`: stock list with price in USDC and INR, the time since each price was updated, a stale-price warning, a market-open or closed label, and buy/sell dialog with quote and slippage.
15. `src/components/CreateIndexWizard.tsx`: three steps (name, symbol and ENS label with a live availability check; pick 2 to 10 stocks with weight sliders that must total 100%; fee and review showing the final `label.parent.eth`), then submit.
16. `src/components/FundExplorer.tsx`, `src/components/FundCard.tsx` and `src/components/FundDetail.tsx`: browse and filter funds, with a detail view showing holdings, weights, NAV per share, fee, creator, an invest/redeem panel with share estimates, and a "Start SIP" panel (amount, frequency, number of installments, start now, allowance step).
17. `src/components/Portfolio.tsx`: your funds and stocks, total value, and per-holding value, plus a "My SIPs" list (fund, amount, frequency, next due, installments done, total invested, pause/resume/cancel, and "run now" when due).
17a. `src/hooks/useSIPs.ts`: reads the user's SIPs, checks which are due (refreshing every 15 seconds), and runs `executeSIP`.
17b. `src/components/DueSipsBanner.tsx`: a banner shown app-wide when any of your SIPs is due, with a one-click run.
18. `src/components/AdminPanel.tsx`: a price source switch (Admin or Feed) with the forwarder address, expected workflow owner, maximum price age and last report time, owner-only manual price updates (enabled only in Admin mode), an "Issue new stock" form (company name, ticker symbol, starting price in INR converted to USDC), reserve balance with a top-up shortcut, and an ownership note.
19. `src/App.tsx`: layout and tab state (replaces the empty scaffold).
20. `src/main.tsx` and `src/config.ts`: check that the wagmi, react-query and ConnectKit providers are in place, and modify only if something is missing. Add Sepolia to the chain and transport config for ENS lookups.

### Build Sequence
1. Confirm the providers in `src/main.tsx`, and which wallet address will own the exchange.
2. Write `StockToken`, `StockExchange`, `IndexFund` and `IndexFactory`. Use OpenZeppelin 5.6.1 (already pinned) with SafeERC20, ReentrancyGuard and Ownable2Step.
3. Run the security review and apply fixes, run unit tests if the level calls for them, then rehearse the deploy on a fork.
4. Deploy `StockExchange` (owner, USDC address, seed stock arrays) to Arc Testnet.
4a. Deploy the Durin `L2Registry` on Arc Testnet and `IndexRegistrar`, then `IndexFactory` (exchange, USDC, registrar). Call `addRegistrar(IndexRegistrar)` on the registry and authorize the factory on the registrar.
4b. Walk you through the Sepolia step: set your parent name's resolver to Durin's L1 resolver and call `setL2Registry(registry, 5042002)` from your parent-name wallet. Then run a live lookup of a test subname to confirm resolution works.
4c. Deploy `SIPManager` (USDC, factory) to Arc Testnet.
4d. Write the CRE project and price workflow under `cre/`. Check the forwarder address against Chainlink's directory, set it on the exchange, and hand you the commands to simulate the workflow (`cre workflow simulate`) and, if your account has deploy access, deploy it. The exchange stays in Admin mode, with prices seeded at deploy, until you switch it to Feed.
4e. Once your workflow is live and has written a report, switch the exchange to Feed in the Admin tab and check that prices update on their own.
5. Write `src/lib/contracts.ts`, `stocks.ts` and `format.ts` from the deployed ABIs and addresses.
6. Write the read hooks (`useStocks`, `useIndexes`, `usePortfolio`) and `useApprovedAction`.
7. Build the Markets tab and the buy/sell dialog. Check the trade flow with testnet USDC from the in-app faucet.
8. Build the Create Index wizard and the Fund explorer and detail view with invest and redeem.
9. Build the SIP panel in fund detail, then the Portfolio "My SIPs" list, the due-SIPs banner, and the Admin tab. Wire everything into `App.tsx` and `Header.tsx`.
10. Polish: loading and empty states, error messages (insufficient reserve, slippage, weights not totaling 100%), the testnet disclaimer, and responsive layout.
11. Run `bun run check` for lint and typecheck, then walk through the full flow in the preview.

### Done When
- [ ] Contracts are deployed on Arc Testnet and the addresses are wired into the app.
- [ ] The Markets tab shows 8 stocks with USDC and INR prices, and you can buy and sell with testnet USDC.
- [ ] In Admin mode the owner can update a price in the Admin tab (including the 5% move cap), and non-owners cannot. In Feed mode manual updates are rejected.
- [ ] The exchange accepts a price report only from the configured forwarder and workflow. Stale, non-increasing, zero, oversized-move and unlisted-token reports are rejected. A fork test with a mock forwarder shows a valid report updating prices.
- [ ] Trades and fund invest or redeem revert when a needed price is older than `maxPriceAge`, and the UI shows the price age and market-open status.
- [ ] The CRE workflow code runs under `cre workflow simulate` against Arc Testnet and produces the expected report from the provider data. If your account has deploy access, a deployed run updates prices on its own.
- [ ] The owner can issue a new stock from the Admin tab. It appears in Markets, can be bought and sold, and can be picked in the Create Index wizard. Non-owners cannot issue, and duplicate symbols are rejected.
- [ ] The Create Index wizard rejects weights that don't total 100%, duplicate stocks, and fees above 2%, and creates a fund that appears in the explorer.
- [ ] Creating a fund also mints `label.parent.eth` to the creator. A taken or invalid label is rejected before the transaction is sent.
- [ ] The subname resolves to the fund address with the Arc coin type, and fund cards, fund detail and Portfolio show the ENS name. If resolution fails, the app falls back to the raw address and says so.
- [ ] Investing USDC in a fund mints shares at the correct NAV, and the fund holds the stock tokens at the chosen weights.
- [ ] Redeeming shares returns USDC close to the share's NAV value, and the NAV per share reflects price changes.
- [ ] The creator's management fee accrues as dilution shares and can be collected.
- [ ] Portfolio shows your stocks and fund shares with values.
- [ ] You can start a SIP from a fund page. With "start now" on, the first installment invests immediately and the shares arrive in your wallet.
- [ ] With the 5-minute demo interval, a second installment becomes due, the banner appears, and running it invests again. Running it before it is due is rejected.
- [ ] A SIP with too little balance or allowance is skipped without breaking other SIPs, and is paused after 3 failures in a row.
- [ ] You can pause, resume and cancel a SIP, and only its owner can. The UI states that SIPs only run when someone opens the app.
- [ ] The UI states clearly that this is a testnet mock, not real securities.
- [ ] `IndexFund`, `IndexFactory` and `SIPManager` reference stocks only through `IStockVenue`, and a test shows a second mock venue contract working with the same fund code.
- [ ] No component hard-codes INR, NSE or testnet-specific text. They read it from `src/lib/market.ts`.
- [ ] `bun run check` passes with no errors.

## Ready to build?
