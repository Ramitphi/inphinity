# Inphinity × Chainlink CCIP: name new funds on Sepolia ENS from Arc

When an index fund is created on **Arc Testnet**, a **Chainlink CCIP** message carries its onchain
data to **Ethereum Sepolia**, where a CCIP receiver contract registers `<label>.inphinity.eth` in our
ENSv2 registry and writes its records. This replaces the off-chain relayer (`ens/src/relayer.ts`),
which stays as a fallback. The names come out identical to the relayer's (the fork test diffs them
record by record).

```
Arc Testnet                                   CCIP 2.0 lane                    Ethereum Sepolia
IndexFactory.createIndex ─► FundNameSender.announce(fund)  ─► Router ─► OnRamp ══► OffRamp ─► Router ─► FundNameReceiver._ccipReceive
                            reads isIndex + name/symbol/creator/                                       ├─ UserRegistry.register(label, creator, ROLE_RENEW only)
                            fee/tokens/weights/token symbols, formats the texts,                       ├─ Resolver.multicall(addr@2152525650 + 11 texts)
                            pays fee in native USDC, refunds excess                                    └─ link <symbol>.inphinity.eth, latest.inphinity.eth
```

## Contracts (`contracts/`)

| Contract | Chain | What it does |
| --- | --- | --- |
| `FundNameSender.sol` | Arc Testnet | `announce(fund)` (anyone) and `announceWithLabel(fund, label)` (creator only). Checks `IndexFactory.isIndex(fund)`, reads every field onchain and formats the relayer's 11 text records, `ccipSend`s to the receiver with `ExtraArgsV3` (gas limit, wait for finality), pays in **native USDC**, refunds the excess, emits `FundAnnounced(fund, messageId, label, fee)`. One announcement per fund. `getFee(fund)` / `getFeeWithLabel` views for the UI. |
| `FundNameReceiver.sol` | Sepolia | `CCIPReceiver`. Accepts only source chain selector `3034092155422581607` (Arc) **and** the sender contract. Same label choice (dedupe `-2`, `-3`, …), role bitmap, expiry and records as the relayer. Idempotent: a fund already named (by the relayer or a previous message) is skipped. Emits `FundNamed(label, fund, messageId)` or `FundSkipped(fund, messageId, reason)`. |
| `FundLabel.sol` | both | The payload struct and the relayer's label rules (`a-z0-9-`, 3 to 32 chars, reserved labels, `-2` dedupe). |

Built on Chainlink's official package `@chainlink/contracts-ccip@2.0.0` (`CCIPReceiver`, `Client`,
`ExtraArgsCodec`, `IRouterClient`). The CCIP state changes happen inside our contracts: `ccipSend` in
the sender, ENS registration and record writes in `_ccipReceive`.

### Trust and roles

- The receiver gets, from the team wallet (`scripts/grant-roles.ts`): UserRegistry root
  `ROLE_REGISTRAR`, and PermissionedResolver root `ROLE_SET_ADDRESS | ROLE_SET_TEXT | ROLE_LINK`.
  No admin roles: it cannot pass roles on, upgrade, unregister names or repoint resolvers. (The live
  resolver disables per-resource `grantRoles`; `grantRootRoles` is its supported path.)
- Fund creators get exactly what the relayer gives them: only `ROLE_RENEW` on their token (see
  `ens/DESIGN.md`).
- Anyone may announce, but only funds the live IndexFactory created, once each, and every record is
  read from the fund contract by the sender, so a caller cannot inject data. Only the creator can
  pick a custom label (the `IndexCreated.label` they chose); otherwise the label comes from the
  symbol, then the name, like the relayer.
- Admin knobs on the sender (owner = deployer): `setReceiver`, `setGasLimit`, `clearAnnouncement`
  (lets a fund be re-sent if a message was abandoned).

### Live constants (checked 2026-11-06)

From the CCIP Directory API (`docs.chain.link/api/ccip/v1/chains`, `/lanes`) and onchain reads:

| | Value |
| --- | --- |
| Arc Testnet Router | `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8` (`Router 1.2.0`, `isChainSupported(Sepolia) = true`) |
| Arc → Sepolia OnRamp | `0x0409822AC30A1A74fCE849E6163a86cF18fe1863` (`OnRamp 2.0.0`, a CCIP 2.0 lane) |
| Sepolia Router | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` (`Router 1.2.0`) |
| Sepolia OffRamp for Arc | `0xc6A246A9AcdAaE651708706494720F79C3E5d0A1` (`OffRamp 2.0.0`) |
| Chain selectors | Arc `3034092155422581607`, Sepolia `16015286601757825753` |
| Arc fee tokens | native USDC (used here), WUSDC `0xbf4B…64EA`, LINK `0x7458…54E0` |

### Gas and fees

**Live Sepolia prices state much higher than a local fork.** Measured on 2026-11-06 with
`eth_estimateGas` on live nodes: a new storage slot costs ~111k gas (22k on a Hardhat fork), code
deposit ~1.5k gas per byte (200), and the block gas limit is ~199M. The relayer's real BCHIP
transactions confirm it: register ~606k, the 12-record multicall ~3.75M. Hardhat fork gas numbers
are therefore ~3x too low, so the gas limit is sized with `test/live-gas.ts`, which runs
`ccipReceive` against live Sepolia state and pricing (state override, read-only).

`ccipReceive` on live Sepolia (register + address record + 11 texts + symbol link + latest link):

| Fund | Live gas |
| --- | --- |
| 3 tokens (BCHIP-like) | ~4.48M |
| 5 tokens | ~5.03M |
| 10 tokens | ~6.38M |
| 10 tokens, 128-char name, 32-char symbol (worst case) | ~7.49M |

The sender requests **10,000,000** gas (`CCIP_GAS_LIMIT`), 33% over the worst case. The Arc →
Sepolia lane accepts up to **~14.36M** (binary search on the live `getFee`), so the full relayer
bundle fits without slimming the records. To keep the receiver deployable, all string formatting
(checksummed addresses, weights, description) happens in the sender on Arc, and the receiver writes
the texts verbatim.

CCIP fee (live quote, native USDC on Arc): 0.51 up to 3M gas, **~0.53 USDC at 10M**, 0.54 at the
lane max. `announce.ts` sends +10% and the contract refunds the rest.

| Step | Gas | Cost on 2026-11-06 |
| --- | --- | --- |
| Deploy sender (Arc) | ~1.9M | ~0.045 USDC (Arc gas ~23 gwei) |
| `setReceiver` (Arc) | ~30k | ~0.001 USDC |
| `announce` (Arc) | ~640k | ~0.015 USDC gas + ~0.53 USDC CCIP fee |
| Deploy receiver (Sepolia) | ~14.2M live (8.9 KB code; under the 16.7M per-tx cap) | negligible (Sepolia gas ~0.00000002 gwei) |
| Grant roles (Sepolia, 2 tx) | ~63k each (fork) | negligible |
| Delivery on Sepolia | see above | paid by CCIP |

The team wallet had 34.9 USDC on Arc and 0.098 Sepolia ETH, which covers all of this many times.

## Runbook

Run from `ccip/` with the team wallet key (`0xC658…4C93`: it owns `inphinity.eth`, holds the admin
roles on the UserRegistry and resolver, and has USDC on Arc). Every script reads chain state first
and only sends what is missing, so any step can be re-run. Each accepts `--dry-run` (simulate, send
nothing, no key needed).

```bash
cd ccip
npm install            # bun install fails here: a transitive git dependency of @chainlink/contracts
npm run build          # compiles contracts/ into out/ with solc 0.8.28 (committed, so optional)
export PRIVATE_KEY=0x...   # team wallet; never commit it
# optional: export ARC_RPC_URL=...  SEPOLIA_RPC_URL=...

# 0. Preview
bun run deploy-sender -- --dry-run

# 1. Arc: deploy FundNameSender                                   -> deployments.json arc.sender
bun run deploy-sender
# 2. Sepolia: deploy FundNameReceiver bound to that sender         -> deployments.json sepolia.receiver
bun run deploy-receiver
# 3. Sepolia: grant the receiver its roles (2 tx from the team wallet)
bun run grant-roles
# 4. Arc: point the sender at the receiver (same script, second run)
bun run deploy-sender

# 5. Announce a fund (pays ~0.51 USDC on Arc). Skips funds that already resolve on ENS unless --force.
bun run announce -- --index 1                     # by factory index
bun run announce -- --fund 0x...                  # by address
bun run announce -- --fund 0x... --label mylabel  # creator only: use the label chosen at createIndex
bun run announce -- --all                         # every factory fund not yet announced

# 6. Watch it (read-only, no key): CCIP status + whether the name resolves to the fund
bun run status -- --message 0x<messageId> --wait
bun run status                                    # every factory fund
```

Commit `deployments.json` after steps 1-2.

### Watching a message

1. `announce` prints the `messageId` and `https://ccip.chain.link/msg/<messageId>`. The CCIP API
   (`https://api.ccip.chain.link/v2/messages/<messageId>`) is what `status.ts` polls. Arc → Sepolia
   messages have been delivering in about 10 s to a few minutes.
2. When the status is `SUCCESS`, open `https://sepolia.app.ens.domains/<label>.inphinity.eth`
   (and `https://sepolia.app.ens.domains/inphinity.eth` for the subnames list). The address record is
   under coin type 2152525650 (Arc), the texts include `inphinity.weights`, `inphinity.fee`,
   `inphinity.creator`, `inphinity.chain`. `latest.inphinity.eth` now shows this fund.
3. If the status is `FAILED` (for example roles were not granted yet), fix the cause and use
   **Manual execution** on the ccip.chain.link message page. The receiver reverts on real errors on
   purpose so this retry works; "already named" and "no free label" only emit `FundSkipped`.

### Relayer coexistence

The receiver and the relayer pick labels the same way and both skip a label that already resolves to
the fund, so running both cannot create duplicates for the same label. One difference: the relayer
uses the `IndexCreated.label` for every fund, while `announce` (non-creator) uses the symbol. If a
creator chose a label different from the symbol, either announce with `--label` as that creator, or
let the relayer name it. To make CCIP the only writer, stop the relayer after step 4. It stays the
fallback: `bun run relayer -- --once` in `ens/` backfills anything CCIP missed.

### Frontend hook (for the app worker)

Right after `IndexFactory.createIndex(...)` succeeds, the creator's wallet can call:

```ts
const fee = await readContract({ address: SENDER, abi, functionName: "getFeeWithLabel", args: [fund, label] }); // wei, 18 decimals of native USDC
await writeContract({ address: SENDER, abi, functionName: "announceWithLabel", args: [fund, label], value: (fee * 110n) / 100n });
// or, for any fund and any caller: getFee(fund) + announce(fund)
```

The ABI is in `out/FundNameSender.json`; `SENDER` is `arc.sender` in `deployments.json`. The
`FundAnnounced` event carries the `messageId` to link to `https://ccip.chain.link/msg/<id>`.

## Testing on forks

`test/fork-e2e.ts` runs everything except the CCIP network itself on two local Hardhat forks. It
runs the real deploy and grant scripts (impersonating the team wallet), creates a new fund on the
live IndexFactory, announces it through the live Arc Router and OnRamp (real fee quote, refund),
then delivers the exact bytes the sender built to the receiver by impersonating the live Sepolia
Router, with the sender's gas limit, and resolves the result through the ENSv2 Universal Resolver.

```bash
# terminal 1 and 2 (public RPCs are not archive nodes, so pin recent blocks)
blk() { curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' $1 | sed 's/.*"result":"\(0x[0-9a-f]*\)".*/\1/' | xargs printf '%d'; }
FORK_BLOCK=$(blk https://ethereum-sepolia-rpc.publicnode.com) npm run fork:sepolia   # :8545
FORK_BLOCK=$(blk https://rpc.testnet.arc.network) npm run fork:arc                   # :8546
# terminal 3
npm run build && bun run test:fork
bun run test/live-gas.ts      # live Sepolia gas for ccipReceive and the receiver deploy (no fork needed)
```

What it checks (58 checks, all passing on 2026-11-06, Sepolia block 12076479, Arc block 71026640):

- deploy/grant scripts are idempotent; receiver gets exactly REGISTRAR + SET_ADDRESS|SET_TEXT|LINK, no admin roles;
- sender: non-factory address, non-creator label, underpayment, second announce and non-owner
  `setReceiver` all revert; anyone can announce a factory fund; exactly the fee is paid and the excess
  refunded; the live OnRamp emits a message carrying our payload; label rules match the relayer's
  `sanitizeLabel` on 11 tricky inputs;
- receiver: non-Router caller, wrong source chain and wrong source sender all revert; the new fund
  resolves through the Universal Resolver with the Arc coin type and no coin type 60; symbol link and
  `latest` work; the token is owned by the creator with only `ROLE_RENEW`; redelivery is a no-op;
- records are identical to the relayer's: BCHIP named under a test label has the same address record
  and the same 11 text records as the live, relayer-made `bchip.inphinity.eth`;
- label collision yields `-2`; the worst-case fund is named.

Gas figures printed by the fork test use Hardhat's pricing; `test/live-gas.ts` gives the live ones.

## Files

| File | What it does |
| --- | --- |
| `contracts/FundNameSender.sol` | Arc sender (CCIP `ccipSend`, native USDC fee, refund) |
| `contracts/FundNameReceiver.sol` | Sepolia `CCIPReceiver` that registers the ENS name and writes records |
| `contracts/FundLabel.sol` | Payload struct (label, links, preformatted texts) and label rules |
| `contracts/interfaces/` | Minimal interfaces for the live Inphinity and ENSv2 contracts |
| `scripts/build.ts` | solc-js standard-JSON build with the Chainlink package's remappings (Hardhat 2 cannot resolve `@openzeppelin/contracts@5.3.0/…`) |
| `scripts/deploy-sender.ts` | Deploy and configure the sender on Arc |
| `scripts/deploy-receiver.ts` | Deploy the receiver on Sepolia |
| `scripts/grant-roles.ts` | Grant (or `--revoke`) the receiver's ENS roles |
| `scripts/announce.ts` | Announce funds, with a Sepolia preview and fee quote |
| `scripts/status.ts` | CCIP API status + ENS check |
| `scripts/config.ts` | Addresses, clients, signer, dry-run sender |
| `test/fork-e2e.ts` | Two-fork end-to-end test |
| `test/live-gas.ts` | Live-Sepolia gas measurement for `ccipReceive` and the receiver deploy |
| `out/*.json` | Compiled ABIs and bytecode |
| `deployments.json` | Addresses this folder deployed (written by the scripts) |
