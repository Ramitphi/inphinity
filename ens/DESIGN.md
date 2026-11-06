# Design: ENSv2 as Inphinity's public fund registry

Inphinity lets anyone create an index fund of tokenized stocks on Arc Testnet. A fund is just a
contract address, which makes it easy to fake. `inphinity.eth` on Sepolia is the public,
verifiable registry of every real fund:

- `bchip.inphinity.eth` resolves to the fund's address on Arc.
- Its records state the fund's composition, fee and creator, copied from the fund contract.
- The name token belongs to the fund's creator, who cannot repoint it.

A wallet, explorer or another protocol can look a fund up by name. It gets an answer that only the
registry operator can write, and that always matches the chain.

The ENS side is ENS's own ENSv2 contracts on Sepolia (the live `deploy/mainnet-v2-20261002` set),
configured through their permission system. The only contracts we wrote are the two ends of the
Chainlink CCIP bridge (section 8), which carry fund data from Arc into ENSv2.

## ENSv2 features used, and why each one matters here

### 1. ETH Registrar: stablecoin, commit-reveal registration
`inphinity.eth` was registered through the ENSv2 `ETHRegistrar`: `commit`, then `register` with an
ERC-20 payment token. That fits a product whose whole money layer is USDC.
`register-parent.ts` checks each candidate token against the registrar's price oracle
(`isPaymentToken`) instead of assuming one.

### 2. A dedicated registry per name: UserRegistry + `setSubregistry`
In ENSv2 every name can have its own registry. We deploy a `UserRegistry` for `inphinity.eth` and
attach it with `setSubregistry` on the .eth registry. `setParent` points it back, so names are
canonical. Each fund is an entry in *our* registry, and each entry is an ERC-1155 token owned by
the fund creator.

This is what makes the names more than records. Ownership is onchain and visible in wallets, and
the registry has rules we choose.

### 3. Verifiable Factory
Both our UserRegistry and our Permissioned Resolver are proxies deployed through ENS's
`VerifiableFactory`. Their addresses are deterministic: `predictProxyAddress(teamWallet, salt)`
gives them before deployment, which also makes `setup-registry.ts` idempotent. Anyone can call
`verifyContract(proxy)` to check that they run ENS's audited implementations.

### 4. Enhanced Access Control: the anti-phishing role design (the core of the design)
ENSv2 replaces NameWrapper fuses with per-resource role bitmaps. We use them to make fund names safe
to trust:

| Who | Where | Roles | Why |
| --- | --- | --- | --- |
| Team wallet (operator/relayer) | UserRegistry `ROOT_RESOURCE` | REGISTRAR, RENEW, UNREGISTER, SET_RESOLVER, SET_SUBREGISTRY, SET_PARENT, SET_URI, UPGRADE (+ admin) | Registers funds, and can take down a scam fund or repair a resolver |
| Fund creator | their own name token | **only `ROLE_RENEW`** | Owns the name, but cannot do anything that could mislead users |
| Team wallet | Permissioned Resolver `ROOT_RESOURCE` | all setter roles + LINK + UPGRADE (+ admin) | The only writer of records |
| Fund creator | Permissioned Resolver | **none** | See below |

What the creator's token deliberately lacks:
- **No `ROLE_SET_RESOLVER`.** A creator cannot point `bchip.inphinity.eth` at their own resolver
  and make it resolve to a drainer contract. In ENSv1 this needed a burned `CANNOT_SET_RESOLVER`
  fuse; here it is a role that was never granted.
- **No `ROLE_SET_SUBREGISTRY`.** No `official.bchip.inphinity.eth` look-alikes.
- **No `ROLE_CAN_TRANSFER_ADMIN`.** The token cannot be sold or transferred. The ENS owner of a fund
  name therefore always equals `IndexFund.creator()` on Arc, and `verify.ts` checks that.

Why creators get no resolver roles at all: in the live PermissionedResolver, a role is scoped to a
setter *argument* (a text key, a coin type), not to a name. If a creator held `ROLE_SET_TEXT` for
`description`, they could edit every fund's description. So the relayer writes all records from
onchain data, and creators cannot inject text. `test/fork-e2e.ts` proves each of these denials
against the live contracts.

In ENSv2 terms, the operator keeping root roles leaves the registry *unemancipated*: the contracts
then also refuse safe transfers (`TransferUnsafeUntilRegistryIsEmancipated`). That is the right
trade-off for a curated index. Moving to an emancipated registry later is a matter of revoking
root roles, with no migration.

### 5. Reserved entries
`latest`, `www`, `app`, `admin`, `official` and `support` are registered with no owner and no roles,
only a resolver. No token is minted, so no fund can claim them, and they still resolve.

### 6. Permissioned Resolver: one shared resolver, record bundles and record linking
One Permissioned Resolver serves every fund. Each fund has its own record bundle:
- the fund address under **Arc Testnet's ENSIP-11 coin type** `0x80000000 | 5042002 = 2152525650`,
  and deliberately no coin type 60, so nobody sends mainnet ETH to an address that only exists on Arc;
- texts `inphinity.weights` (e.g. `tAAPL:3000,tMSFT:2500,…`), `inphinity.fee` (bps),
  `inphinity.creator`, `inphinity.chain` = `arc-testnet:5042002`, `inphinity.tokens`,
  `inphinity.symbol`, `name`, `description`, `url`.

Record linking (`linkToNode`) lets several names share one bundle with no copies to keep in sync:
- `<symbol>.inphinity.eth` → the fund's bundle (first fund with a symbol wins, and a real fund later
  registering that label takes it over cleanly);
- `latest.inphinity.eth` → the newest fund, re-pointed by the relayer.

The **default bundle** (the empty name) answers for every name without its own bundle, such as the
reserved labels or a name typed by mistake: "Not an Inphinity fund", and no address. Note that a
name with its own bundle does not fall back to the default field by field, so shared fields like the
disclaimer are also written per fund.

### 7. Universal Resolver v2
`verify.ts` and any client resolve through the ENSv2 Universal Resolver (`0xeEeE…EeEe`). It walks
root → .eth registry → our UserRegistry → resolver, then calls the resolver's `resolve(name, data)`.
Linked and default-bundle names work through the same path.

### 8. Chainlink CCIP: Arc writes to ENSv2 directly
Funds live on Arc, but ENS lives on Ethereum, and Arc contracts cannot call Sepolia. A relayer
bridges the gap offchain. CCIP mode makes it onchain:

- `IndexFactory.createIndex` calls our `ArcEnsRegistrar` through the factory's existing registrar
  hook. It reads the new fund (name, symbol, fee, token symbols and weights) and sends one CCIP
  message to Sepolia, paying ~0.51 USDC in Arc's native token. The creator's free-text description
  is deliberately not sent.
- `InphinityEnsReceiver` on Sepolia accepts only the CCIP router, only Arc's chain selector, and
  only our registrar. It then does what the relayer does: registers the name to the creator with
  only `ROLE_RENEW`, writes the record bundle, and links the symbol and `latest`. It also stores
  the CCIP message id in `inphinity.ccip`, so every name points to its own cross-chain proof on
  ccip.chain.link.
- ENSv2 access control is what makes this safe. The receiver holds exactly `ROLE_REGISTRAR` on our
  UserRegistry and `SET_ADDRESS | SET_TEXT | LINK` on the resolver, nothing else. Revoking those
  roles stops it instantly.
- Naming never blocks a fund: the Arc side never reverts. A failed Sepolia step is stored and can
  be retried, and `IndexFactory.setRegistrar(0)` turns the whole path off.

## Data flow

```
Arc Testnet                         relayer.ts                      Sepolia (ENSv2)
IndexFactory.createIndex  ──►  IndexCreated(label) +       ──►  UserRegistry.register(label, creator,
                               indexAt()/fund views              resolver, ROLE_RENEW, expiry)
                               (name, symbol, creator,      ──►  PermissionedResolver.multicall(
                               fee, tokens, weights)              setAddress(Arc coin type), setText…)
                                                            ──►  linkToNode(symbol / latest)
```

The relayer is idempotent. It derives everything from chain state (registry status, current
records, record ids), so a crash between two transactions is repaired by the next run, and a backfill
from `indexCount()` is always safe. Labels come from the event's `label`, else the symbol, else the
name. They are normalised to `a-z0-9-` (3 to 32 chars) and deduplicated with `-2`, `-3`.

## Not hard-coded

Every fund name is created from a real `IndexCreated` event and real fund contract reads on Arc.
`verify.ts` reads the fund contract on Arc *at verification time* and fails if ENS disagrees.

## Limits we accept for a testnet demo

- With the relayer, the team wallet is trusted to copy Arc data faithfully (auditable with
  `verify.ts`). In CCIP mode, that trust moves to Chainlink's CCIP network plus our two small
  contracts. The team wallet still holds the root roles needed to fix or take down a name.
- Records are a snapshot of immutable fund parameters (weights, fee and creator never change after
  creation). Live NAV is not stored in ENS; apps read it from the fund contract.
