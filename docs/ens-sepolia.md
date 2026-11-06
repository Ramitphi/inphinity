# Fund names on ENS (Ethereum Sepolia)

Every fund created on Arc Testnet gets an ENS subname on Ethereum Sepolia, such as
`tech.inphinity.eth`. The name's records carry the fund's metadata, so any ENS-aware app can
look a fund up by name.

```
Arc Testnet                         relayer                       Ethereum Sepolia
IndexFactory.createIndex(..label..) ──► scripts/ens-relayer.ts ──► FundNamePublisher.publish
  emits IndexCreated                    reads the fund contract      creates <label>.<parent>
                                                                     writes records on the
                                                                     ENS PublicResolver
```

## Records on each name

| Record | Value |
| --- | --- |
| `addr` (coin type `2152525650`, ENSIP-11 for chain 5042002) | Fund token address on Arc |
| `name`, `symbol` | Fund name and ticker |
| `description` | Text the creator entered |
| `fund` | Fund address (text copy, for clients that ignore multichain addresses) |
| `creator` | Creator wallet |
| `fee` | Management fee in bps (max 200 = 2% a year) |
| `composition` | JSON: `[{"symbol":"tAAPL","token":"0x…","weightBps":5000}, …]` |
| `venue` | Exchange contract the fund trades through |
| `chain` | `eip155:5042002` |
| `created` | Unix time of the creation block |

Live NAV is not stored in ENS; read it from the fund contract.

## Contracts

- `contracts/FundNamePublisher.sol` (Sepolia): creates the subname and writes the records. It
  works with a parent that is wrapped (NameWrapper) or unwrapped (registry only). It keeps
  ownership of every subname so records can only change through it. Only allowlisted publishers
  (the relayer) can publish. Its owner or a publisher can update a single text record later with
  `updateText`, for example to add a `pool` address.
- `contracts/IndexFactory.sol` (Arc): every fund now needs a label, 3 to 20 characters of `a-z`
  and `0-9`, unique per factory (`isLabelAvailable(label)`). `IndexCreated` also carries the
  description. Because labels are unique on Arc, the Sepolia name never clashes.

ENS addresses on Sepolia (from `ensdomains/ens-contracts`, `deployments/sepolia`):

| Contract | Address |
| --- | --- |
| ENSRegistry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |
| NameWrapper | `0x0635513f179D50A207757E05759CbD106d7dFcE8` |
| PublicResolver | `0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5` |

## Setup

1. Own a parent name on Sepolia, such as `inphinity.eth` (register it at sepolia.app.ens.domains).
2. Deploy the publisher to Sepolia:

   ```bash
   PARENT_NAME=inphinity.eth RELAYER_ADDRESS=0xYourRelayer \
     forge script contracts/script/DeployFundNamePublisher.s.sol --rpc-url sepolia --broadcast --account <keystore>
   ```

3. From the parent owner's wallet, approve the publisher. The deploy script prints the exact
   command. For a wrapped parent it is
   `NameWrapper.setApprovalForAll(<publisher>, true)`; for an unwrapped one,
   `ENSRegistry.setApprovalForAll(<publisher>, true)`. Revoking that approval stops publishing.
4. Put these in `.env` and start the relayer:

   ```bash
   INDEX_FACTORY_ADDRESS=0x...        # Arc Testnet
   FUND_NAME_PUBLISHER_ADDRESS=0x...  # Sepolia
   RELAYER_PRIVATE_KEY=0x...          # the allowlisted relayer; needs Sepolia ETH for gas
   FROM_BLOCK=<factory deploy block>
   ```

   ```bash
   bun run ens:relayer
   ```

   `--once` backfills and exits (for a cron job); `--dry-run` prints records without sending.
   Re-running is safe: published names are skipped, and failed ones are retried on the next poll.

## Trust model

The relayer is trusted to copy Arc data faithfully. The publisher checks format (label rules,
weights sum to 10000, 2 to 10 unique holdings, fee cap, JSON-safe symbols), not truth. Keep the
relayer key separate from the owner key; the owner can revoke it with `setPublisher(relayer, false)`.
A Chainlink CRE workflow with a log trigger on Arc could replace the relayer later.

## Tests

- `bun run contracts:test` runs the unit tests, which use ENS mocks that follow the real
  registry, NameWrapper and resolver permission rules.
- `SEPOLIA_RPC_URL=... FORK_PARENT_NAME=yourname.eth forge test --mt testFork` runs the publisher
  against the real Sepolia ENS contracts on a fork, impersonating the parent's owner.
