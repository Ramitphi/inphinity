# NSE price feed (Chainlink CRE)

A scheduled Chainlink CRE workflow (TypeScript SDK) that keeps the prices on the `StockExchange` contract up to date from real NSE quotes.

## What it does

Every tick, `price-feed/main.ts`:

1. Reads the listed stocks from `StockExchange.getStocks()` on `arc-testnet` (plus `maxMoveBps()`).
2. For each stock, fetches the NSE price in INR from Twelve Data (`GET /price`). The default ticker is the token symbol without the leading `t` (`tRELIANCE` -> `RELIANCE`). You can override it per stock in `config.json`.
3. Fetches USD/INR from Twelve Data (`GET /exchange_rate`).
4. Each of those HTTP calls runs on every node of the DON and the nodes agree on the **median**.
5. Converts: `price = INR price / USD-INR`, expressed in USDC base units (6 decimals) per whole token. Example: INR 1250 at 85 INR/USD gives `14705882` (14.705882 USDC).
6. Validates (non-zero, USD/INR sanity range, contract timestamp and move-cap rules, see below) and encodes the report **exactly as the contract decodes it**:

   ```
   abi.encode(address[] tokens, uint256[] prices, uint64 timestamp)
   ```

   This is `abi.decode(report, (address[], uint256[], uint64))` in `StockExchange._processReport`: three top-level parameters, not a wrapped struct.
7. Signs it as a CRE report and writes it to the exchange with `writeReport`. The Chainlink forwarder then calls `StockExchange.onReport`.

A stock whose quote fails (HTTP error, provider error, bad value, or no consensus) is **skipped and logged**. The run continues with the other stocks.

### Rules taken from `StockExchange.sol`

| Contract rule | What the workflow does |
| --- | --- |
| Price unit: USDC base units (6 decimals) per whole 18-decimal token | `price6 = inr * 1e4 * 1e8 / (usdInr * 1e6)`, rounded to nearest |
| Timestamp must be newer than the stock's `updatedAt` and not after `block.timestamp` | Uses DON time (`runtime.now()`) minus `timestampSkewSeconds` (default 30). A stock whose `updatedAt` is not older than that is skipped for the run |
| Prices must be non-zero | Zero is never sent |
| A move larger than `maxMoveBps` (default 5%) reverts the **whole** report | The workflow reads `maxMoveBps()` and, by default, **clamps** the price to the allowed move (so it converges over several runs). Set `"onMoveExceeded": "skip"` to leave such stocks out instead |
| At most 50 tokens, no duplicates, only listed tokens | Tokens come from `getStocks()`; at most `maxStocksPerRun` (default 14, because CRE allows 15 HTTP requests per execution and one is used for FX) |
| Reports are ignored in Admin mode, and Feed mode needs a workflow identity | See "Contract settings" below |

## Schedule

`config.json` holds three UTC cron expressions that together cover **every 5 minutes, Monday to Friday, 03:45 to 10:00 UTC** (NSE hours, 09:15 to 15:30 IST):

- `45,50,55 3 * * 1-5` (03:45, 03:50, 03:55)
- `*/5 4-9 * * 1-5` (04:00 to 09:55)
- `0 10 * * 1-5` (10:00)

Edit `schedules` to change it (CRE's minimum interval is 30 seconds). NSE holidays are not modelled: on a holiday the workflow just writes the last available price again.

## Files

| File | Purpose |
| --- | --- |
| `project.yaml` | Project settings: target `arc-testnet-settings` with the `arc-testnet` RPC |
| `secrets.yaml` | Declares the secret name `TWELVE_DATA_API_KEY` (no value) |
| `.env.example` | Names of the environment variables to put in `cre/.env` (git-ignored) |
| `price-feed/workflow.yaml` | Workflow name and artifact paths |
| `price-feed/config.json` | Schedules, exchange address, provider URL, ticker overrides, limits |
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

### 4. Put the Twelve Data API key in the secrets mechanism

`secrets.yaml` maps the secret id `TWELVE_DATA_API_KEY` to the environment variable `TWELVE_DATA_API_KEY_ENV`. For simulation, the CLI reads that variable from your shell or from `cre/.env`:

```bash
cp .env.example .env
# edit .env: set TWELVE_DATA_API_KEY_ENV=<your Twelve Data key>
#            set CRE_ETH_PRIVATE_KEY=<a funded Arc Testnet test wallet key> (only needed with --broadcast and for deploy)
```

Never commit `.env`. For a deployed workflow the key is stored in the Vault DON instead, see step 8.

### 5. Set the exchange address

Edit `price-feed/config.json` and set `exchangeAddress` to your deployed `StockExchange` (it is an empty string until you do). The workflow stops with a clear error while it is empty.

### 6. Simulate

```bash
cre workflow simulate price-feed --target arc-testnet-settings
```

Pick a cron trigger when asked, or run non-interactively:

```bash
cre workflow simulate price-feed --target arc-testnet-settings --non-interactive --trigger-index 0
```

The simulation always runs the handler once immediately, whatever the time of day. Without `--broadcast` it is a dry run: it reads the chain, calls Twelve Data and builds the report, but sends no transaction. To send the transaction, fund the wallet behind `CRE_ETH_PRIVATE_KEY` with Arc Testnet USDC (USDC is the gas token) and add `--broadcast`.

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
cre secrets create secrets.yaml --target arc-testnet-settings   # stores TWELVE_DATA_API_KEY in the Vault DON
cre workflow deploy price-feed --target arc-testnet-settings
cre workflow list
```

Add `--secrets-auth=browser` to the `cre secrets` command if your workflow uses the private registry. See the [Deploying Workflows](https://docs.chain.link/cre/guides/operations/deploying-workflows) guide for the registry choice (`deployment-registry` in `price-feed/workflow.yaml`). Deploying links your wallet address to your organization permanently, and the CLI asks you to confirm.

## Offline test

```bash
cd price-feed
bun test
bun run typecheck
```

The test mocks the exchange and Twelve Data and decodes the report exactly like the contract does (3 parameters, USDC 6-decimal prices, timestamp).

## Important caveats

- **Arc Testnet support is documented for simulation.** Chainlink lists Arc Testnet in its supported networks (CLI v1.0.7+, TypeScript SDK v1.3.1+) and in the simulation forwarder table, and a production forwarder address is listed for it. **Whether a deployed, scheduled workflow actually runs and writes against Arc Testnet is unconfirmed.** Run `cre workflow supported-chains` after login to see what your organization has enabled. Keep the exchange able to fall back to Admin mode (`setPriceSource(Admin)`).
- **Twelve Data plan and data type.** Twelve Data's exchange list shows NSE India (MIC `XNSE`) as requiring at least the Grow plan, with a data type labelled "EOD". Check that your plan returns the NSE quotes you expect (intraday or only end of day) and that its rate limit covers the calls: one FX call plus one call per stock, **per node**, every 5 minutes. A rate-limited or failed quote is skipped. `twelveData.cacheMaxAgeSeconds` can let nodes share one cached response to save credits; it is off by default and its behaviour is unverified.
- The price endpoint carries no timestamp, so the workflow cannot tell a live quote from a stale one (for example on a market holiday). The contract's own timestamp comes from workflow time.
- The Twelve Data API key is sent in an `Authorization: apikey ...` header, not in the URL.
- Only the first `maxStocksPerRun` stocks are updated in one run (CRE limit: 15 HTTP requests per execution).
