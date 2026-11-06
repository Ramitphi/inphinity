# US stock price feed (Chainlink CRE)

A scheduled Chainlink CRE workflow (TypeScript SDK) that keeps the prices on the `StockExchange` contract up to date from Yahoo Finance quotes. No API key is needed. Prices are in USD, with no currency conversion.

## What it does

Every tick, `price-feed/main.ts`:

1. Reads the listed stocks from `StockExchange.getStocks()` on `arc-testnet` (plus `maxMoveBps()`).
2. For each stock, fetches the USD price from `https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>` (`chart.result[0].meta.regularMarketPrice`). The default ticker is the token symbol without the leading `t` (`tAAPL` -> `AAPL`, `tSPY` -> `SPY`). Override it per stock in `config.json` if needed.
3. Each HTTP call runs on every node of the DON and the nodes agree on the **median**.
4. Expresses the price in USDC base units (6 decimals) per whole token. Example: USD 205.50 gives `205500000`.
5. Validates (non-zero, contract timestamp and move-cap rules, see below) and encodes the report **exactly as the contract decodes it**:

   ```
   abi.encode(address[] tokens, uint256[] prices, uint64 timestamp)
   ```

6. Signs it as a CRE report and writes it to the exchange with `writeReport`. The Chainlink forwarder then calls `StockExchange.onReport`.

A stock whose quote fails (HTTP error, bad value, or no consensus) is **skipped and logged**. The run continues with the other stocks.

### Rules taken from `StockExchange.sol`

| Contract rule | What the workflow does |
| --- | --- |
| Price unit: USDC base units (6 decimals) per whole 18-decimal token | `price6 = USD price * 1e6`, rounded to 6 decimals |
| Timestamp must be newer than the stock's `updatedAt` and not after `block.timestamp` | Uses DON time (`runtime.now()`) minus `timestampSkewSeconds` (default 30). A stock whose `updatedAt` is not older than that is skipped for the run |
| Prices must be non-zero | Zero is never sent |
| A move larger than `maxMoveBps` (default 5%) reverts the **whole** report | The workflow reads `maxMoveBps()` and, by default, **clamps** the price to the allowed move (so it converges over several runs). Set `"onMoveExceeded": "skip"` to leave such stocks out instead |
| At most 50 tokens, no duplicates, only listed tokens | Tokens come from `getStocks()`; at most `maxStocksPerRun` (default and maximum 15, the CRE limit of HTTP requests per execution) |
| Reports are ignored in Admin mode, and Feed mode needs a workflow identity | See "Contract settings" below |

## Schedule

`config.json` holds three UTC cron expressions that together cover **every 5 minutes, Monday to Friday, 13:30 to 21:00 UTC**. NYSE hours (9:30 to 16:00 Eastern) are 13:30 to 20:00 UTC in summer time and 14:30 to 21:00 UTC in winter time, so the window covers both. Outside the real session Yahoo keeps returning the last price, so the workflow only rewrites the same value.

- `30,35,40,45,50,55 13 * * 1-5`
- `*/5 14-20 * * 1-5`
- `0 21 * * 1-5`

Edit `schedules` to change it (CRE's minimum interval is 30 seconds). US market holidays are not modelled.

## Files

| File | Purpose |
| --- | --- |
| `project.yaml` | Project settings: target `arc-testnet-settings` with the `arc-testnet` RPC |
| `.env.example` | Names of the environment variables to put in `cre/.env` (git-ignored) |
| `price-feed/workflow.yaml` | Workflow name and artifact paths |
| `price-feed/config.json` | Schedules, exchange address, Yahoo endpoint, ticker overrides, limits |
| `price-feed/main.ts` | The workflow |
| `price-feed/main.test.ts` | Offline test with mocked chain and provider (`bun test`) |

## Steps

Run these from your own machine, from the `cre/` folder unless noted.

### 1. Install the CRE CLI and Bun

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash
cre version
```

You also need [Bun](https://bun.sh) (the TypeScript SDK compiles with it).

### 2. Log in

```bash
cre login
cre whoami
```

`cre whoami` also shows whether your organization has deploy access.

### 3. Install the workflow dependencies

```bash
cd price-feed
bun install
cd ..
```

### 4. Environment

```bash
cp .env.example .env
# set CRE_ETH_PRIVATE_KEY=<a funded Arc Testnet test wallet key> (only needed with --broadcast and for deploy)
```

Never commit `.env`. The workflow needs no API key.

### 5. Exchange address

`price-feed/config.json` already points at the Arc Testnet `StockExchange` (`0x93662de514b981f8c7bf97085e359e0f18034804`). Change `exchangeAddress` if you redeploy.

### 6. Simulate

```bash
cre workflow simulate price-feed --target arc-testnet-settings
```

Pick a cron trigger when asked, or run non-interactively:

```bash
cre workflow simulate price-feed --target arc-testnet-settings --non-interactive --trigger-index 0
```

The simulation always runs the handler once immediately, whatever the time of day. Without `--broadcast` it is a dry run: it reads the chain, calls Yahoo Finance and builds the report, but sends no transaction. To send the transaction, fund the wallet behind `CRE_ETH_PRIVATE_KEY` with Arc Testnet USDC (USDC is the gas token) and add `--broadcast`. The exchange must have at least one listed stock, otherwise the run ends with "no stocks".

Contract settings for simulation (see the next section): the exchange's forwarder must be the **mock** forwarder, the exchange stays in **Admin** mode, and do **not** set an expected author or workflow ID (the mock forwarder sends no metadata, so any identity check would revert).

### 7. Contract settings (owner calls on `StockExchange`)

| Purpose | Forwarder address to set with `setForwarderAddress` |
| --- | --- |
| `cre workflow simulate --broadcast` | Mock forwarder for `arc-testnet`: `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| Deployed workflow | Production forwarder for `arc-testnet`: `0x76c9cf548b4179F8901cda1f8623568b58215E62` |

Both are from Chainlink's [Forwarder Directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory). Re-check them there before use.

For a deployed workflow, also set the workflow identity (the contract refuses Feed mode without it), then switch the source:

1. `setExpectedAuthor(<workflow owner address>)`, the address linked to your CRE account that deploys the workflow. Optionally also `setExpectedWorkflowId(<id>)` (shown after deploy).
2. `setPriceSource(Feed)`.

What simulation can and cannot prove with this contract:

- **Admin mode** (the default): the exchange accepts a report from the forwarder and ignores it (`ReportIgnored`). A broadcast simulation therefore proves the whole pipeline up to a delivered report, but prices on the exchange do not change.
- **Feed mode** requires a workflow identity, and Chainlink documents that the simulation's mock forwarder does not provide workflow metadata. Expect a Feed-mode report from a simulation to revert on the identity check. So a price update that actually lands on-chain can only be confirmed with a deployed workflow.

### 8. Deploy (only if your account has deploy access)

```bash
cre account access        # shows your status or lets you request deploy access
cre workflow deploy price-feed --target arc-testnet-settings
cre workflow list
```

See the [Deploying Workflows](https://docs.chain.link/cre/guides/operations/deploying-workflows) guide for the registry choice (`deployment-registry` in `price-feed/workflow.yaml`). Deploying links your wallet address to your organization permanently, and the CLI asks you to confirm.

## Offline test

```bash
cd price-feed
bun test
bun run typecheck
```

The test mocks the exchange and Yahoo Finance and decodes the report exactly like the contract does (3 parameters, USDC 6-decimal prices, timestamp).

## Important caveats

- **Arc Testnet support is documented for simulation.** Chainlink lists Arc Testnet in its supported networks (CLI v1.0.7+, TypeScript SDK v1.3.1+) and in the simulation forwarder table, and a production forwarder address is listed for it. **Whether a deployed, scheduled workflow actually runs and writes against Arc Testnet is unconfirmed.** Run `cre workflow supported-chains` after login to see what your organization has enabled. Keep the exchange able to fall back to Admin mode (`setPriceSource(Admin)`).
- **Yahoo Finance is an unofficial, unauthenticated endpoint.** It has no service guarantee and can rate limit or block requests. Every node of the DON calls it for each stock on each run, so a rate-limited quote is skipped. `yahoo.cacheMaxAgeSeconds` can let nodes share one cached response; it is off by default and its behaviour is unverified. For anything beyond a testnet demo, use a licensed data provider.
- The quote carries no freshness check in this workflow, so it cannot tell a live quote from the last close (weekends, holidays, after hours). The contract's own timestamp comes from workflow time.
- Only the first `maxStocksPerRun` stocks are updated in one run (CRE limit: 15 HTTP requests per execution).
