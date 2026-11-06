# Inphinity on ENSv2: the `inphinity.eth` fund registry (Sepolia)

Every index fund created by Inphinity's `IndexFactory` on Arc Testnet gets a name
`<label>.inphinity.eth` on Sepolia. It resolves to the fund's Arc address and carries its
composition, fee and creator as records. The name is owned by the fund's creator. Why and how this
uses ENSv2 is in [DESIGN.md](./DESIGN.md).

| Name | Resolves to |
| --- | --- |
| `inphinity.eth` | the IndexFactory on Arc, plus registry-wide records |
| `<label>.inphinity.eth` | one fund (token owned by its creator) |
| `<symbol>.inphinity.eth` | the same records as the fund with that symbol (record link) |
| `latest.inphinity.eth` | the newest fund (record link) |
| anything else under `inphinity.eth` | the default bundle: "Not an Inphinity fund", no address |

## Contracts

All ENS contracts are ENS's own live ENSv2 Sepolia deployment, from
[contracts-v2](https://github.com/ensdomains/contracts-v2/tree/deploy/mainnet-v2-20261002/contracts/deployments/sepolia)
(branch `deploy/mainnet-v2-20261002`). That is the set behind the Universal Resolver
`0xeEeE…EeEe` and sepolia.app.ens.domains. The older tags (`sepolia-deployment-2026-06-29`,
`-09-15`) are **not** live. Names registered there do not resolve.

| Contract | Address |
| --- | --- |
| ETH Registry (.eth) | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` |
| ETH Registrar | `0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3` |
| Verifiable Factory | `0xda70306c98e97ece36f997a21368e53298572991` |
| UserRegistry implementation | `0x9bd8a88719068d09ecee662f36c0e3856708366a` |
| PermissionedResolver implementation | `0x115eb53f0c60696633855f90b138178fb40b2b2c` |
| Universal Resolver (proxy) | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` |

Deployed by `setup-registry.ts`. Addresses are deterministic from the team wallet and the salt, so
`--dry-run` predicts them:

| Ours | Address |
| --- | --- |
| UserRegistry proxy for `inphinity.eth` | `0xefC414eb999907620AbdA991decD2BD22aBb9Ac1` |
| PermissionedResolver proxy | `0x26E1611FD97133dfaef7b562D88528e8C1649ae2` |

The ENS side uses only ENS's audited contracts, configured through their roles. The optional
Chainlink CCIP mode adds two small contracts of ours (see below).

## Runbook

Run from `ens/`, with the team wallet key (`0xC658…4C93`, which owns `inphinity.eth`). Every script
reads chain state first and only sends what is missing, so any step can be re-run safely.

```bash
cd ens
bun install
export PRIVATE_KEY=0x...            # team wallet; never commit it
# optional: export SEPOLIA_RPC_URL=...  (default https://ethereum-sepolia-rpc.publicnode.com)

# 0. Preview everything (no key needed, simulates as the team wallet)
bun run register-parent -- --dry-run
bun run setup-registry  -- --dry-run

# 1. Register inphinity.eth (commit, wait 60s, register; pays in a stablecoin)
#    Already done on 2026-11-06 (owner = team wallet, expires 2027-11-06): prints "Nothing to do".
bun run register-parent

# 2. Deploy the UserRegistry + Permissioned Resolver, attach them to inphinity.eth,
#    reserve latest/www/app/admin/official/support, write the default bundle and parent records
bun run setup-registry

# 3. Mirror every fund: backfill from indexCount()/indexAt(), then poll every 15 s
bun run relayer -- --once          # backfill and exit
bun run relayer                    # keep running (Ctrl-C to stop)

# 4. Check what the world sees (read-only, no key)
bun run verify
bun run verify -- bchip.inphinity.eth latest.inphinity.eth
```

Commit `ens/deployments.sepolia.json` after step 2. It records the proxy addresses, which
`relayer.ts` and `verify.ts` read.

### Expected cost (Sepolia ETH)

Gas measured on a fork of the live contracts. Sepolia gas was about 20 wei on 2026-11-06, so real
costs are tiny. The worst case below assumes 10 gwei.

| Step | Gas | At 10 gwei |
| --- | --- | --- |
| register-parent (approve + commit + register) | ~330k | ~0.003 ETH, plus ~8 USDC per year in Circle USDC or free-to-mint ENS MockUSDC |
| setup-registry (2 proxies, attach, 6 reservations, records) | ~2.0M | ~0.02 ETH |
| relayer, per fund (register + 11 records + symbol link) | ~1.1M | ~0.011 ETH |
| relayer, `latest` link update | ~50k | ~0.0005 ETH |

The team wallet's 0.1 Sepolia ETH covers setup plus several dozen funds at that worst case.

### Options

| Env / flag | Used by | Meaning |
| --- | --- | --- |
| `--dry-run` | all writers | simulate every transaction, send nothing, do not touch the state file |
| `--once` | relayer | backfill and exit instead of polling |
| `POLL_MS` | relayer | poll interval, default 15000 |
| `ARC_RPC_URL` | relayer, verify | default `https://rpc.testnet.arc.network` |
| `ARC_FROM_BLOCK` | relayer | first block to scan for `IndexCreated`, default 71001972 (factory deploy) |
| `FUND_URL_TEMPLATE` | relayer | `url` record per fund, default Arc explorer `…/address/{address}` |
| `APP_URL` | setup-registry | `url` record of `inphinity.eth` and the default bundle |
| `ENS_DURATION_DAYS`, `PAYMENT_TOKEN` | register-parent | registration length (default 365) and a forced stablecoin |

## Chainlink CCIP mode: name funds onchain, without the relayer

The relayer is an offchain script. In CCIP mode, naming happens onchain instead: Arc sends each new
fund to Sepolia through Chainlink CCIP, inside the same transaction that creates the fund.

```
Arc Testnet                                        Ethereum Sepolia
IndexFactory.createIndex(label = symbol)           InphinityEnsReceiver.ccipReceive
  -> ArcEnsRegistrar.register  --Chainlink CCIP-->   -> UserRegistry.register(label, creator, ROLE_RENEW)
     reads the fund, pays ~0.51 USDC                 -> resolver: Arc address + text records
     (native) per message                            -> link <symbol> and latest
```

- `contracts/ccip/ArcEnsRegistrar.sol` (Arc) plugs into the factory's existing registrar hook
  (`IndexFactory.setRegistrar`), so the factory is not redeployed. It **never reverts**. If the
  fee balance is empty or CCIP refuses, it emits `NamingSkipped`, the fund is still created, and
  the relayer can name it later.
- `contracts/ccip/InphinityEnsReceiver.sol` (Sepolia) accepts messages only from the Sepolia CCIP
  router, only from Arc's chain selector, and only from our registrar. It writes the same records
  as the relayer, plus `inphinity.ccip` = the CCIP message id. If naming fails, the message is
  stored and anyone can call `retry(messageId)`.
- Lane: Arc Testnet router `0xdE4E…eab8` → Sepolia router `0x0BF3…3A59` (OnRamp 2.0.0).
  Fee ~0.51 USDC per fund, paid in Arc's native USDC from the registrar's balance.
  Delivery takes a few minutes. Track it at https://ccip.chain.link.

```bash
cd ens && export PRIVATE_KEY=0x...      # team wallet: owns IndexFactory and inphinity.eth
bun run ccip-setup -- --dry-run         # preview
bun run ccip-setup                      # deploy both contracts, grant ENSv2 roles, fund 3 USDC
bun run ccip-setup -- --enable          # IndexFactory.setRegistrar(ArcEnsRegistrar): CCIP naming ON
bun run ccip-setup -- --disable         # kill switch: setRegistrar(0), fund creation keeps working
```

Before `--enable`, the app on `main` must send a label in `createIndex`. Once a registrar is set,
the factory rejects an empty label. The frontend in this branch sends one.

Keep the relayer as a backup if you like (`bun run relayer -- --once` now and then). It skips names
CCIP already wrote. Don't run it in watch mode at the same time as CCIP: it could register a fund
before the CCIP message lands, and the message would then take the `-2` label.

**Gas: do not size it from a fork.** Storage writes on live Sepolia cost several times what a
Hardhat fork reports: one new text record is ~384k gas live, against ~70k on the fork. `ccipReceive`
uses ~1.2M gas on a fork, but **~4.5M live for a 3-token fund and up to ~7.5M** for 10 tokens with
long names. The first live message ran with a 2.5M limit and failed. The registrar now requests
**9,000,000** gas (`CCIP_GAS_LIMIT`); `ccip-setup` corrects an existing registrar. The lane accepts
up to ~14.36M. The fee is ~0.53 USDC at 9M, barely more than at 2.5M.

### Live deployment (2026-11-06)

| | Address |
| --- | --- |
| ArcEnsRegistrar (Arc Testnet) | `0x39437a4f9c2ed49c5c3310681d440b26a0cb23cd`, set as `IndexFactory.registrar` |
| InphinityEnsReceiver (Sepolia) | `0x95b9aaba9fc5209e68afe1686d80a69fa03bb23f` |

The first live delivery: `aibuilders.inphinity.eth`, CCIP message `0xac8fffdf…d53b`, delivered in
seconds (see its `inphinity.ccip` record).

### Recovering a failed message (manual execution)

A message can fail on Sepolia, for example from too little gas or a missing role. If the receiver
call **reverts**, CCIP marks the message `FAILED`, stores nothing, and lets anyone re-run it later
with more gas:

1. Fix the cause first, if there is one (grant the role, or for gas, nothing to fix).
2. Check it is eligible:
   `curl -s https://api.ccip.chain.link/v2/messages/<messageId>` should show `"status":"FAILED"`
   and `"readyForManualExecution":true`.
3. Open `https://ccip.chain.link/msg/<messageId>` and connect any wallet on Ethereum Sepolia (it
   only pays Sepolia gas; the team wallet is not required).
4. Click **Manual execution**. Under the gas option, override the gas limit to **9000000**, then
   confirm the transaction.
5. The status turns `SUCCESS`, and `bun run verify -- <label>.inphinity.eth` resolves the name.

If the receiver instead **caught** the error (its own `NamingFailed` event; the message shows
`SUCCESS`), the payload is stored onchain. Run `retry(messageId)` on `InphinityEnsReceiver` from any
Sepolia wallet with a high gas limit (e.g. 9,000,000), after fixing the cause.

Manual execution replays the original message with its original label. If that label has since
been taken by another fund, the receiver still dedupes it to `-2`.

## Verify in the ENS app

1. Open https://sepolia.app.ens.domains/inphinity.eth. The owner should be `0xC658…4C93`, and the
   resolver `0x26E1…9ae2`. Its records include `inphinity.factory` and `inphinity.registry`.
2. Open a fund name, e.g. https://sepolia.app.ens.domains/bchip.inphinity.eth. Check:
   - **Address**: the fund's Arc address under coin type 2152525650, and no ETH address.
   - **Records**: `inphinity.weights`, `inphinity.fee`, `inphinity.creator`, `inphinity.chain`.
   - **Ownership**: the creator owns the name token, and it cannot be transferred.
3. https://sepolia.app.ens.domains/latest.inphinity.eth shows the newest fund's records.
4. Explorer view of the registry: https://sepolia.explorer.ens.domains.

From code, any viem app can resolve a fund (viem must be pointed at the ENSv2 Universal Resolver):

```ts
const fund = await client.getEnsAddress({
  name: "bchip.inphinity.eth",
  coinType: 2152525650n, // 0x80000000 | 5042002, Arc Testnet (ENSIP-11)
  universalResolverAddress: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
});
const weights = await client.getEnsText({ name: "bchip.inphinity.eth", key: "inphinity.weights", universalResolverAddress: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" });
```

## Testing on a fork

`test/fork-e2e.ts` runs the real scripts against a local Hardhat fork of Sepolia. It impersonates
the team wallet, so no key is needed. Three sample funds go through the relayer code, resolution is
checked through the Universal Resolver, and a creator is impersonated to show what they cannot do:
edit records, change the resolver, attach a subregistry, transfer the name, or register names.

```bash
# terminal 1 (publicnode is not an archive node, so pin a recent block)
FORK_BLOCK=$(curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  https://ethereum-sepolia-rpc.publicnode.com | sed 's/.*"result":"\(0x[0-9a-f]*\)".*/\1/' | xargs printf '%d') \
  bun run fork
# terminal 2
export SEPOLIA_RPC_URL=http://127.0.0.1:8545 ENS_STATE_FILE=/tmp/fork-state.json \
       FORK_IMPERSONATE=0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93
curl -s -X POST -H 'content-type: application/json' 127.0.0.1:8545 \
  --data '{"jsonrpc":"2.0","id":1,"method":"hardhat_impersonateAccount","params":["0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93"]}'
bun run register-parent && bun run setup-registry && bun run test:fork
bun run relayer -- --once && bun run verify -- bchip.inphinity.eth
```

Hardhat only mines on transactions, and `register-parent` waits on chain time. If you run it
on a fork for a name that is not registered yet, also mine blocks in the background, e.g.
`while true; do curl -s -X POST -H 'content-type: application/json' 127.0.0.1:8545 --data '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}' >/dev/null; sleep 4; done`.

### Testing the CCIP path on forks

```bash
# two forks (pin recent blocks: publicnode is not an archive node)
FORK_BLOCK=<sepolia block> bun run fork                                   # :8545
# Arc: same idea, chainId 5042002, hardfork cancun, forking https://rpc.testnet.arc.network, port 8546
export SEPOLIA_RPC_URL=http://127.0.0.1:8545 ARC_RPC_URL=http://127.0.0.1:8546 \
       ENS_STATE_FILE=/tmp/fork-state.json FORK_IMPERSONATE=0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93
cp deployments.sepolia.json /tmp/fork-state.json   # impersonate the team wallet on both nodes first
bun run ccip-setup -- --enable && bun run test:ccip
```

`test/ccip-fork-e2e.ts` creates real funds on the Arc fork, so the message goes through the real
Arc router and OnRamp. It checks the OnRamp payload byte-for-byte, then delivers it to the receiver
as the Sepolia router would, and resolves the name through the Universal Resolver. The only hop it
simulates is the Chainlink network carrying the bytes. It also covers duplicate delivery, impostor
senders and chains, label collisions, failure + `retry`, and fund creation with an empty fee
balance.

## Files

| File | What it does |
| --- | --- |
| `src/register-parent.ts` | Commit-reveal registration of `inphinity.eth` via the ETH Registrar, paid in a stablecoin |
| `src/setup-registry.ts` | UserRegistry + Permissioned Resolver via the Verifiable Factory, attach, reserve labels, default bundle |
| `src/relayer.ts` | Arc → ENS: register fund names to creators, write records, maintain symbol and `latest` links |
| `src/ccip-setup.ts` | Deploy and wire the Chainlink CCIP bridge, `--enable` / `--disable` it on the factory |
| `../contracts/ccip/` | `ArcEnsRegistrar` (Arc), `InphinityEnsReceiver` (Sepolia), shared label library; compiled into `ccip-artifacts/` |
| `test/ccip-fork-e2e.ts` | CCIP end-to-end test on Arc + Sepolia forks |
| `src/verify.ts` | Resolve through the Universal Resolver and compare with live Arc data and the token roles |
| `src/records.ts` | Diff-and-write records, record linking helpers |
| `src/lib.ts` | ENSv2 role bitmaps, DNS encoding, label rules, state file, dry-run aware sender |
| `src/config.ts`, `src/abis.ts` | Addresses and minimal ABIs |
| `test/fork-e2e.ts` | End-to-end test on a Sepolia fork |
