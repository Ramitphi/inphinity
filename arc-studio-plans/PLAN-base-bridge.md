## Implementation Plan: Bharat Index v2 (US tokenized stocks bridged from Base, as mutual funds)

> This plan supersedes `PLAN.md`. Where they differ, follow this one. Everything is testnet and mock.

### Summary
We issue mock tokenized US stocks on Base Sepolia and make them bridgeable with Circle's CCTPx. They are bridged to Arc Testnet as wrapped tokens and held as inventory by an exchange contract. Anyone can create a mutual fund from those wrapped stocks. Investors buy fund shares with USDC at NAV and redeem them at NAV. They can also trade the fund token in a built-in pool. Each fund token gets an ENS subname that carries its metadata: creator, fee and stock composition. These are mock tokens, not real securities.

### Assumptions (answers not yet confirmed by the user)
- Stocks and ETFs are US ones: tAAPL, tMSFT, tNVDA, tTSLA, tAMZN, tGOOGL, tMETA, tSPY. Prices are USD, with no FX conversion.
- NAV is computed from holdings at current prices. The creator picks the starting NAV per share (1 to 1000 USDC, default 10).
- Investing is USDC only. In-kind deposits of stock tokens are not included.
- "Trade" means a built-in constant-product pool per fund (fund token and USDC), because Uniswap is not on Arc Testnet.
- The redemption-lock fix recommended in the last review is applied (see "Open decision").

### Architecture
- **Chains:**
  - Base Sepolia is where the mock stocks are minted (the home chain).
  - Arc Testnet is where the wrapped tokens, exchange, funds, pools and SIPs live. USDC (ERC-20 at `0x3600000000000000000000000000000000000000`, 6 decimals) is the gas token and the investing currency.
  - Ethereum Sepolia holds the parent ENS name.
- **Stock tokens (CCTPx):**
  - Eight new crosschain tokens (18 decimals) are issued with the "brand-new token" flow: deployed on Base Sepolia with the user's wallet as minter, and a wrapper deployed on Arc Testnet with the same token ID. Rate limits are set on each.
  - The user mints on Base Sepolia, then bridges to Arc into the exchange's inventory.
  - Only a token's issuer can register it with CCTPx, which is why the mock tokens are issued here. Issuance uses the project CCTPx script and a throwaway testnet signer key, with the user's wallet as owner and minter.
  - Step 1 of the build verifies that Base Sepolia to Arc Testnet is a supported route for new tokens. If it is not, the build stops and the user is told before anything else is built.
- **Contracts on Arc Testnet:**
  - `StockExchange` (modified): an inventory venue. It no longer deploys or mints tokens.
    - `addAsset(token, initialPrice)` registers a bridged wrapper token. The token must have 18 decimals.
    - `buy` sends tokens out of inventory at the buy price. `sell` takes tokens in and pays USDC from the reserve. If inventory or the reserve is short, the call reverts with a clear error.
    - It keeps the earlier design: Admin or Feed price source, Chainlink CRE report receiver, 0.5% spread, 5% move cap, 10-minute hold, staleness limit, trusted factory, and the `IStockVenue` interface.
  - `IndexFund` (modified):
    - Starting NAV per share is set at creation. The first deposit mints `usdcIn / startNav` shares. After that, shares are minted at NAV computed from holdings at mid prices.
    - Invest is USDC only. Redeem sells the pro-rata slice back to the exchange.
    - The management fee (up to 2% a year) is paid by minting dilution shares to the creator.
    - It includes the redemption-lock fix and `investFor`.
  - `IndexFactory` (modified): `createIndex(name, symbol, label, stocks[], weightsBps[], feeBps, startNav, description)`. It validates that every stock is a registered asset, registers the fund with the exchange, and mints the ENS subname in the same transaction.
  - `FundPool` and `FundPoolFactory` (new): one constant-product pool per fund for fund token and USDC, with a 0.3% swap fee, LP tokens, a minimum-liquidity lock, and slippage and deadline checks. Anyone can add or remove liquidity. The UI shows pool price against NAV.
  - `SIPManager` (unchanged unless the lock fix needs it): recurring USDC investments into a fund.
  - `IndexRegistrar` (modified):
    - It mints `label.parent.eth` on a Durin registry deployed to Arc Testnet. The registry is deployed from Durin's source, because Arc is not in Durin's published factory list.
    - Address record: the fund token address, under the Arc coin type only.
    - Text records, built on-chain so they cannot be spoofed: `description`, `creator`, `fee` (management fee in bps), `startNav`, `composition` (JSON list of token address, symbol and weight in bps), `venue`, `chain` and `created`.
    - Live NAV is not stored in ENS; the app reads it from the contract.
  - `StockToken.sol` is no longer used.
- **Pricing:**
  - The CRE workflow is simplified for US stocks. It fetches USD quotes from Twelve Data with no FX step, and the Admin fallback switch stays.
  - The UI shows NYSE and Nasdaq hours (9:30 to 16:00 Eastern) and a market-closed label.
  - The workflow can be simulated, but a deployed scheduled run on Arc Testnet is unconfirmed, so Admin mode is the working path until then.
- **ENS resolution risk:** Durin's hosted resolver and gateway may not accept Arc Testnet. The build checks with a live lookup. If it fails, the app falls back to raw addresses and ENS resolution waits on a gateway.
- **Frontend (React, wagmi, viem, ConnectKit, Bridge Kit or App Kit):**
  - Tabs: Markets, Bridge, Create Fund, Funds (invest, redeem, trade and SIP panels), Portfolio, Admin.
  - Bridge tab: Base Sepolia to Arc Testnet. It quotes first, bridges only on the user's confirm click, switches chains in the wallet, and supports retry after a soft failure.
  - Admin tab: mint on Base Sepolia (minter only), bridge into the exchange's inventory, add an asset, price source switch, forwarder and workflow settings, reserve and inventory levels.
  - `src/lib/market.ts` holds currency, hours, token IDs and disclaimers.
- **Security:** a balanced review of every contract change and new contract (the pool in particular), then a fork rehearsal before deploying.

### Open decision (carried over)
The last review found that the fund's redemption lock can be abused with dust transfers. This plan assumes the recommended fix:
- Only newly bought shares are locked.
- Locked shares cannot be transferred.
- SIP shares are minted straight to the investor through `investFor`, which only the investor or the configured SIP manager can use.

If the user prefers accepting the problem or dropping the lock, change this before building.

### Files to Create/Modify
1. `contracts/StockExchange.sol` (modify): inventory venue with `addAsset`, buy and sell from inventory.
2. `contracts/IndexFund.sol` (modify): starting NAV, lock fix, `investFor`.
3. `contracts/IndexFactory.sol` (modify): new `createIndex` parameters, exchange registration, ENS metadata.
4. `contracts/IndexRegistrar.sol` (modify): composition, fee and other metadata text records.
5. `contracts/FundPool.sol` and `contracts/FundPoolFactory.sol` (new): the trading pool for each fund.
6. `contracts/SIPManager.sol` (unchanged unless the lock fix needs it).
7. `contracts/test/*.t.sol`: tests for inventory trades, spread, NAV and starting NAV, lock rules, pool swaps and liquidity, and the factory.
8. `scripts/cctpx.ts` (written from the CCTPx skill, not edited) and a small issuance script: issue the 8 tokens, deploy their Arc wrappers, and record token IDs and addresses.
9. `cre/price-feed/main.ts`, `config.json`, `main.test.ts` (modify): US tickers, USD quotes, no FX, weekday schedule 13:30 to 20:00 UTC.
10. `src/lib/market.ts`, `src/lib/contracts.ts`, `src/lib/format.ts`, `src/lib/ens.ts`: market config, addresses, ABIs, formatting, ENS lookups.
11. `src/lib/bridge.ts`: Bridge Kit helpers (quote, execute, retry) for the CCTPx token IDs.
12. `src/hooks/*`: stocks and inventory, funds, pools, portfolio, SIPs, approve-then-act, bridge.
13. `src/components/*`: Header, StockMarket, TradeStockModal, BridgePanel, CreateFundWizard, FundExplorer, FundCard, FundDetail, PoolPanel, Portfolio, DueSipsBanner, AdminPanel.
14. `src/App.tsx`, `src/config.ts`, `src/main.tsx`: tab layout; Base Sepolia and Sepolia added to the chain config.
15. `README.md` and `AGENTS.md`: what is mock, how to issue and bridge, how to run the CRE workflow.

### Build Sequence
1. Check that Base Sepolia to Arc Testnet is a supported CCTPx route for new tokens. If it is not, stop and tell the user.
2. Get the user's wallet address and Sepolia ENS name, and confirm the lock-fix choice.
3. Rework `StockExchange`, `IndexFund`, `IndexFactory` and `IndexRegistrar`; write `FundPool` and `FundPoolFactory`. Run the security review, fix findings, run tests, and rehearse the deploy on a fork.
4. Issue the 8 stock tokens with CCTPx, deploy their Arc wrappers, and wait for delivery. The user mints supply on Base Sepolia and bridges it into the exchange's inventory.
5. Deploy the exchange (with the bridged tokens as assets), the Durin registry, the registrar, the factories and the SIP manager to Arc Testnet.
6. Update the CRE workflow for US stocks. The user runs simulate and, if their account allows it, deploys.
7. Walk the user through the Sepolia ENS resolver step, then check a live name lookup.
8. Build the frontend libraries and hooks, then the components, then wire the app together.
9. Run lint and typecheck, then walk through the whole flow in the preview.

### Done When
- [ ] Eight mock US stock tokens exist on Base Sepolia, and their wrappers exist on Arc Testnet with matching token IDs.
- [ ] You can mint on Base Sepolia, bridge to Arc from the app, and see the wrapped balance arrive.
- [ ] The exchange holds bridged inventory and trades with USDC at the buy and sell prices. It reverts clearly when inventory or the reserve is short.
- [ ] You can create a fund with a chosen starting NAV, a fee up to 2% and 2 to 10 stocks, and its ENS subname is minted in the same transaction.
- [ ] The ENS name resolves to the fund token, and its text records show creator, fee and composition matching the fund.
- [ ] Investing mints shares at NAV, and redeeming returns USDC close to NAV minus the spread.
- [ ] The fund token trades in its pool with slippage protection, and liquidity can be added and removed.
- [ ] The redemption lock cannot be used to freeze another holder.
- [ ] SIPs work as before.
- [ ] Prices update through Admin mode, and from a deployed CRE workflow if the account allows it.
- [ ] The UI says everything is testnet and mock, and shows price age and market hours.
- [ ] `bun run check` passes.

## Ready to build?
