# US stock price feed (Chainlink CRE)

A Chainlink CRE workflow (TypeScript SDK) that acts as the orchestration layer between an external API (Yahoo Finance) and a blockchain (Arc Testnet): every run it reads the listed stocks from the `StockExchange` contract, fetches each USD price with DON median consensus, and writes a signed report that updates the on-chain prices.

- Exchange: `StockExchange` `0x93662de514b981f8c7bf97085e359e0f18034804`, Arc Testnet (chain 5042002, CRE chain name `arc-testnet`)
- Workflow: `price-feed/main.ts`, workflow name `stock-price-feed`, target `arc-testnet-settings`
- No API key is needed for Yahoo. Prices are USD, with no currency conversion.

## What one run does

1. Reads `getStocks()` and `maxMoveBps()` from the exchange.
2. For each stock, `GET https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>` on every node; the nodes agree on the **median** of `chart.result[0].meta.regularMarketPrice`. Ticker = symbol without the leading `t` (`tAAPL` -> `AAPL`), overridable in `config.json` (`tickerOverrides`).
3. Converts to USDC base units (6 decimals) per whole 18-decimal token: USD 205.50 -> `205500000`.
4. Filters or clamps each stock so the contract cannot reject the batch (table below).
5. Encodes `abi.encode(address[] tokens, uint256[] prices, uint64 timestamp)`, exactly what `StockExchange._processReport` decodes, signs it as a CRE report and calls `writeReport`. The forwarder then calls `StockExchange.onReport`.

The contract applies a report all-or-nothing, so any per-stock problem must be handled in the workflow:

| Contract rule (`StockExchange.sol`) | Workflow behaviour |
| --- | --- |
| Price = USDC base units per whole token, non-zero | `USD * 1e6` rounded to 6 dp; a zero or negative price is never sent |
| `timestamp > stock.updatedAt` and `timestamp <= block.timestamp` | `timestamp = DON time (runtime.now()) - timestampSkewSeconds (30)`. A stock whose `updatedAt` is not older is skipped (no HTTP call spent on it) |
| `|next - prev| <= prev * maxMoveBps / 10000` (rounded down), else the whole report reverts | Reads `maxMoveBps()` live. Default `onMoveExceeded: "clamp"` sends the furthest allowed price (converges over several runs); `"skip"` leaves the stock out |
| Only listed tokens, no duplicates, at most 50 | Tokens come from `getStocks()`, de-duplicated, at most `maxStocksPerRun` (15 = CRE HTTP calls per execution) |
| Reports ignored unless `priceSource == Feed` (1) | See "Owner actions" |

A quote is skipped (logged as `Skipped <symbol> (...)`) when: HTTP error, non-JSON body, no chart result, `currency` not USD, invalid price, no `regularMarketTime`, or the quote is older than `maxQuoteAgeSeconds` (default 4 days, so Friday's close is still served over a weekend). If every stock is skipped the run writes nothing (`no prices`).

## Files

| File | Purpose |
| --- | --- |
| `project.yaml` | Target `arc-testnet-settings` with the `arc-testnet` RPC |
| `.env.example` | Variables for `cre/.env` (git-ignored) |
| `run-loop.sh` | Re-runs the simulation on a timer to keep prices live during the demo |
| `price-feed/workflow.yaml` | Workflow name and artifact paths |
| `price-feed/config.json` | Schedules, exchange address, Yahoo endpoint, limits |
| `price-feed/main.ts` | The workflow |
| `price-feed/main.test.ts` | Offline tests (mocked chain and Yahoo) |
| `price-feed/scripts/status.ts` | Read-only status: price source, identity settings, prices vs Yahoo, recent events |

## Runbook

All commands from `cre/` unless noted.

### 1. Prerequisites

- [Bun](https://bun.sh) 1.2+.
- CRE CLI ([install guide](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux)):
  ```bash
  curl -sSL https://app.chain.link/cre/install.sh | bash
  cre version
  ```
- A CRE account: `cre login` (browser), then `cre whoami`. For headless use, export `CRE_API_KEY` instead.
- For `--broadcast`: an Arc Testnet wallet with some USDC (USDC is Arc's gas token; each 15-stock report costs about 0.007 USDC, measured). Any wallet works: the exchange checks the forwarder and the report metadata, not who paid the gas. Use a throwaway key, not the exchange owner key.
- Workflow dependencies:
  ```bash
  (cd price-feed && bun install && bun test)
  ```

### 2. Environment

```bash
cp .env.example .env
# edit .env: CRE_ETH_PRIVATE_KEY=0x<funded Arc Testnet test wallet key>
```

| Variable | Needed for |
| --- | --- |
| `CRE_ETH_PRIVATE_KEY` | `--broadcast` and `cre workflow deploy` (the wallet that sends the forwarder transaction) |
| `CRE_API_KEY` | Optional, replaces `cre login` for non-interactive runs |

The CLI loads `cre/.env` itself, and a `CRE_ETH_PRIVATE_KEY=` line there **overrides an exported shell variable, even when it is empty** (as copied from `.env.example`). The CLI then falls back to its built-in, unfunded default key and prints `Using default private key for chain write simulation`. Either fill the line in or delete it. `run-loop.sh` refuses to start with an empty or malformed line.

To create a fresh gas wallet without the key ever appearing on screen (from `cre/`; prints only the address):

```bash
cd price-feed && bun -e 'import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";import { existsSync, writeFileSync } from "fs";const f="../.env";if (existsSync(f)) { console.log("cre/.env already exists, not touching it"); process.exit(1) };const pk = generatePrivateKey();writeFileSync(f, `CRE_ETH_PRIVATE_KEY=${pk}\n`, { mode: 0o600 });console.log("Gas wallet address:", privateKeyToAccount(pk).address);' ; cd ..
```

### 3. Dry-run simulation (no transaction)

```bash
cre workflow simulate price-feed --target arc-testnet-settings --non-interactive --trigger-index 0
```

Expected log lines: one `tXXXX (XXXX): <price> USDC base units` per stock and a final `Wrote 15 prices (0 skipped)`. `--trigger-index 0` runs the first cron handler once, immediately, whatever the time of day or the cron schedule.

### 4. Owner actions on `StockExchange` (orchestrator, owner key)

Current state (read with `bun price-feed/scripts/status.ts`): forwarder = simulation `MockKeystoneForwarder` `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`, `priceSource = 0` (Admin), no identity set.

`setPriceSource(1)` reverts with `WorkflowIdentityRequired` unless an expected author or workflow ID is set first.

**A. Live prices from `cre workflow simulate --broadcast` (the demo)**

The CRE simulator writes fixed placeholder metadata into every report: workflow ID `0x1111…1111`, workflow owner `0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, and the mock forwarder passes it on to `onReport`. (Checked on Arc Testnet: every simulation report sent to the mock forwarder carries these values, and a read-only `eth_estimateGas` against the deployed exchange with `expectedAuthor` overridden to `0xAAAA…` passes the identity check while `0xBBBB…` fails it.) Chainlink's docs say the mock forwarder "does not provide workflow metadata"; in practice it provides these placeholders. So:

```bash
EX=0x93662de514b981f8c7bf97085e359e0f18034804
RPC=https://rpc.testnet.arc.network
cast send $EX "setExpectedAuthor(address)" 0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --rpc-url $RPC --private-key $OWNER_PK
cast send $EX "setPriceSource(uint8)" 1 --rpc-url $RPC --private-key $OWNER_PK
```

Do not call `setExpectedWorkflowName` for the simulation setup (the simulator's name encoding is unverified against the contract; a mismatch reverts every report). `setExpectedWorkflowId(0x1111…)` is possible but adds nothing.

> **Security caveat (testnet only):** with the mock forwarder and the placeholder author, anyone who runs a CRE simulation with `--broadcast` against this exchange can push prices. Each update is still bounded by the 5% move cap and the timestamp rules. Acceptable for the hackathon demo; switch to setup B for anything real.

**B. Deployed workflow (production forwarder)**

After `cre workflow deploy` (needs deploy access, see step 8):

```bash
cast send $EX "setForwarderAddress(address)" 0x76c9cf548b4179F8901cda1f8623568b58215E62 --rpc-url $RPC --private-key $OWNER_PK  # KeystoneForwarder, arc-testnet
cast send $EX "setExpectedAuthor(address)" <workflow owner address from deploy / cre whoami> --rpc-url $RPC --private-key $OWNER_PK
cast send $EX "setExpectedWorkflowId(bytes32)" <workflow ID printed by deploy> --rpc-url $RPC --private-key $OWNER_PK              # optional, recommended
cast send $EX "setPriceSource(uint8)" 1 --rpc-url $RPC --private-key $OWNER_PK                                                      # if not already 1
```

`setExpectedWorkflowName("stock-price-feed")` is optional and only meaningful with the author set. Forwarder addresses: [Forwarder Directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory).

### 5. Simulation with broadcast (one live update)

```bash
cre workflow simulate price-feed --target arc-testnet-settings --non-interactive --trigger-index 0 --broadcast
```

The run ends with `Wrote N prices (M skipped). tx 0x…`. If the exchange is still in Admin mode the transaction succeeds but the exchange emits `ReportIgnored` and prices do not change.

**Verified on Arc Testnet (2026-11-06):** first live report [`0xd2a96bfe…375e`](https://testnet.arcscan.app/tx/0xd2a96bfedcf3733d8da9e38332221142d5996ebf6f8307aa78b9936d5779375e). It was sent by a throwaway gas wallet to the mock forwarder, and its logs contain `PricesUpdated` (15 stocks) and `ReportProcessed`. **Cost: 278,986 gas × 25 gwei = about 0.007 USDC per update** for 15 stocks, so the 5-minute loop costs about 0.08 USDC per hour and 2 USDC lasts about 24 hours.

### 6. Keep prices live during the demo

```bash
./run-loop.sh                       # broadcast every 5 minutes until Ctrl-C, logs to cre/run-loop.log
INTERVAL=120 ./run-loop.sh          # every 2 minutes
DRY_RUN=1 MAX_RUNS=1 ./run-loop.sh  # one dry run
```

Run it inside `tmux`/`screen` so it survives a closed terminal. A failed run is logged and the loop continues. With the market closed (the demo is on a Saturday) Yahoo returns Friday's close, so each run re-writes the same prices with a fresh timestamp; that still shows the pipeline working and keeps `price()` from going stale (`maxPriceAge` = 4 days).

### 7. Verify

```bash
cd price-feed && bun scripts/status.ts          # source, identity, prices vs Yahoo, recent events
```

Or with `cast`:

```bash
cast call $EX "priceSource()(uint8)" --rpc-url $RPC                                     # 1 = Feed
cast call $EX "lastReportAt()(uint256)" --rpc-url $RPC                                  # block time of the last applied report
cast call $EX "price(address)(uint256)" 0x4572E4D21199deA83a5E069361871512c31a3bBd --rpc-url $RPC   # tAAPL, USDC 6 dp
cast logs --address $EX "PricesUpdated(address[],uint256[],uint64)" --from-block <recent block> --rpc-url $RPC
```

On the explorer (https://testnet.arcscan.app) the broadcast transaction goes to the mock forwarder (`report(...)`); its logs should contain `PricesUpdated` from the exchange and `ReportProcessed(..., result = true)` from the forwarder. `result = false` means `onReport` reverted: check identity settings (`getExpectedAuthor()`), forwarder (`getForwarderAddress()`), and the workflow log for clamp/skip lines.

### 8. Deploy (optional, needs deploy access)

```bash
cre account access
cre workflow deploy price-feed --target arc-testnet-settings
cre workflow list
```

The `schedules` in `config.json` run every 5 minutes, Mon-Fri 13:30-21:00 UTC (US market hours in both summer and winter time). A deployed workflow therefore does nothing on weekends; add a schedule if you need it to run then. Whether Arc Testnet is enabled for deployed workflows in your organization is unconfirmed: check `cre workflow supported-chains`.

### 9. Rollback

```bash
cast send $EX "setPriceSource(uint8)" 0 --rpc-url $RPC --private-key $OWNER_PK   # back to Admin: reports are ignored, owner setPrice/setPrices work again
```

Stop `run-loop.sh` with Ctrl-C. Clearing the identity is optional and only possible in Admin mode: `setExpectedAuthor(0x0000000000000000000000000000000000000000)` (clear any workflow name first).

## Offline tests

```bash
cd price-feed
bun test             # 20 tests: report decoding, clamp/skip, cap rounding, stale/bad quotes, timestamps, limits
bun run typecheck
bunx cre-compile main.ts /tmp/price-feed.wasm   # optional: the same WASM build the CLI does
```

## Caveats

- **Yahoo Finance is unofficial and unauthenticated.** No service guarantee; it can rate limit. A failed quote is skipped, not fatal. For anything beyond a testnet demo use a licensed data provider.
- **Simulation-driven updates are a demo setup**, see the security caveat in step 4A.
- Only the first `maxStocksPerRun` (15) stocks are updated per run.
