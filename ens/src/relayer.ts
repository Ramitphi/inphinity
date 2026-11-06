// Step 3: mirror every Inphinity index fund on Arc Testnet into ENSv2 on Sepolia.
//
// For each fund created by IndexFactory (backfilled from indexCount()/indexAt(), then polled):
//   1. derive a label (event label, else symbol, else name) and dedupe it (-2, -3, ...),
//   2. register <label>.inphinity.eth in our UserRegistry as an ERC-1155 token owned by the fund
//      creator, with only ROLE_RENEW (no resolver change, no subregistry, no transfer),
//   3. write the fund's own record bundle on the shared Permissioned Resolver from onchain fund
//      data: the fund address under Arc's ENSIP-11 coin type (never coin type 60), plus text
//      records (weights, fee, creator, chain, ...). Creators get no resolver roles: resolver roles
//      are per key, not per name, so only the relayer writes records,
//   4. link <symbol>.inphinity.eth (if free) and latest.inphinity.eth to that bundle (record
//      linking: one bundle, several names, no copies to keep in sync).
// Everything is read from chain before writing, so re-running is safe and cheap.
//
// Usage: PRIVATE_KEY=0x... bun run src/relayer.ts [--once] [--dry-run]
// Env:   POLL_MS (default 15000), ARC_FROM_BLOCK (IndexFactory deploy block), FUND_URL_TEMPLATE
import { zeroAddress, type Address } from "viem";
import { ARC, DRY_RUN, ENS, PARENT_LABEL, PARENT_NAME, arcClient as arc, sepoliaClient as c } from "./config";
import { erc20MetaAbi, indexFactoryAbi, indexFundAbi, registryAbi } from "./abis";
import { CREATOR_TOKEN_ROLES, DISCLAIMER, labelId, loadState, sanitizeLabel, saveState, send, signer, sleep, explain } from "./lib";
import { linkName, readAddr, recordIdOf, syncRecords, unlinkName } from "./records";

const ONCE = process.argv.includes("--once");
const POLL_MS = Number(process.env.POLL_MS ?? 15_000);
const ARC_FROM_BLOCK = BigInt(process.env.ARC_FROM_BLOCK ?? 71_001_972); // IndexFactory deploy block
const LOG_CHUNK = 9_000n; // Arc RPC rejects eth_getLogs ranges of 10k blocks or more

const FUND_URL_TEMPLATE = process.env.FUND_URL_TEMPLATE ?? "https://explorer.testnet.arc.io/address/{address}";

export type FundInfo = {
  fund: Address;
  index: number;
  eventLabel?: string;
  name: string;
  symbol: string;
  creator: Address;
  feeBps: number;
  tokens: Address[];
  tokenSymbols: string[];
  weights: number[];
};

const factory = { address: ARC.indexFactory, abi: indexFactoryAbi } as const;
const indexCreated = indexFactoryAbi.find((x) => x.type === "event" && x.name === "IndexCreated")!;

// ---------------------------------------------------------------------------
// Arc side
// ---------------------------------------------------------------------------

/** fund (lowercase) -> label from the IndexCreated event. */
const eventLabels = new Map<string, string>();
let scannedTo = ARC_FROM_BLOCK - 1n;

async function scanEvents() {
  const head = await arc.getBlockNumber();
  while (scannedTo < head) {
    const from = scannedTo + 1n;
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    const logs = await arc.getLogs({ address: ARC.indexFactory, event: indexCreated, fromBlock: from, toBlock: to });
    for (const l of logs) if (l.args.fund) eventLabels.set(l.args.fund.toLowerCase(), l.args.label ?? "");
    scannedTo = to;
  }
}

async function readFund(index: number): Promise<FundInfo> {
  const fund = await arc.readContract({ ...factory, functionName: "indexAt", args: [BigInt(index)] });
  const f = { address: fund, abi: indexFundAbi } as const;
  const [name, symbol, creator, feeBps, tokens, weights] = await Promise.all([
    arc.readContract({ ...f, functionName: "name" }),
    arc.readContract({ ...f, functionName: "symbol" }),
    arc.readContract({ ...f, functionName: "creator" }),
    arc.readContract({ ...f, functionName: "feeBps" }),
    arc.readContract({ ...f, functionName: "getTokens" }),
    arc.readContract({ ...f, functionName: "getWeights" }),
  ]);
  const tokenSymbols = await Promise.all(
    tokens.map((t) => arc.readContract({ address: t, abi: erc20MetaAbi, functionName: "symbol" }).catch(() => t.slice(0, 8))),
  );
  return {
    fund,
    index,
    eventLabel: eventLabels.get(fund.toLowerCase()),
    name,
    symbol,
    creator,
    feeBps: Number(feeBps),
    tokens: [...tokens],
    tokenSymbols,
    weights: weights.map(Number),
  };
}

// ---------------------------------------------------------------------------
// Sepolia side
// ---------------------------------------------------------------------------

type Ctx = { s: ReturnType<typeof signer>; userRegistry: Address; resolver: Address; parentExpiry: bigint };

const fullName = (label: string) => `${label}.${PARENT_NAME}`;

async function labelState(ctx: Ctx, label: string) {
  return c.readContract({ address: ctx.userRegistry, abi: registryAbi, functionName: "getState", args: [labelId(label)] });
}

/** Finds the label already used for this fund, or the first free candidate. */
async function chooseLabel(ctx: Ctx, f: FundInfo): Promise<{ label: string; registered: boolean }> {
  const base =
    sanitizeLabel(f.eventLabel ?? "") ?? sanitizeLabel(f.symbol) ?? sanitizeLabel(f.name) ?? `fund-${f.index}`;
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const label = base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
    const st = await labelState(ctx, label);
    if (st.status === 2) {
      const addr = (await readAddr(ctx.resolver, fullName(label))).toLowerCase();
      if (addr === f.fund.toLowerCase()) return { label, registered: true };
      // An earlier run may have died between register and writing records: same creator, no address.
      if (addr === "0x" && st.latestOwner.toLowerCase() === f.creator.toLowerCase()) return { label, registered: true };
      continue; // taken by another fund
    }
    if (st.status === 1) continue; // reserved entry
    return { label, registered: false };
  }
  throw new Error(`no free label for fund ${f.fund}`);
}

export async function processFund(ctx: Ctx, f: FundInfo): Promise<string> {
  const { s, userRegistry, resolver } = ctx;
  const { label, registered } = await chooseLabel(ctx, f);
  const name = fullName(label);

  if (!registered) {
    // The label may currently be a symbol link to another fund's bundle. Detach it first, or the
    // records below would overwrite that other fund's bundle. A real fund name beats a symbol link.
    await unlinkName(s, resolver, name);
    await send(s, `register ${name} -> creator ${f.creator}`, {
      address: userRegistry,
      abi: registryAbi,
      functionName: "register",
      args: [label, f.creator, zeroAddress, resolver, CREATOR_TOKEN_ROLES, ctx.parentExpiry],
    });
  }

  const weights = f.tokenSymbols.map((sym, i) => `${sym}:${f.weights[i]}`).join(",");
  await syncRecords(s, resolver, name, {
    arcAddress: f.fund,
    texts: {
      name: f.name,
      description: `${f.name} (${f.symbol}): an Inphinity index fund on Arc Testnet holding ${f.tokenSymbols.join(", ")}.`,
      url: FUND_URL_TEMPLATE.replace("{address}", f.fund),
      "inphinity.symbol": f.symbol,
      "inphinity.weights": weights,
      "inphinity.tokens": f.tokens.join(","),
      "inphinity.fee": String(f.feeBps),
      "inphinity.creator": f.creator,
      "inphinity.chain": `arc-testnet:${ARC.chainId}`,
      "inphinity.index": String(f.index),
      // A name with its own bundle does not fall back to the default bundle field by field.
      "inphinity.disclaimer": DISCLAIMER,
    },
  });

  // Symbol link: <symbol>.inphinity.eth shares this fund's bundle. First fund with a symbol wins.
  const sym = sanitizeLabel(f.symbol);
  if (sym && sym !== label) {
    const st = await labelState(ctx, sym);
    const symName = fullName(sym);
    if (st.status === 0 && (await recordIdOf(resolver, symName)) === 0n) {
      await linkName(s, resolver, symName, name);
    }
  }
  return name;
}

async function main() {
  const state = loadState();
  const s = signer();
  if (!state.userRegistry || !state.resolver) throw new Error("Run setup-registry.ts first (no UserRegistry/resolver in deployments.sepolia.json).");
  const onchainSub = await c.readContract({ address: ENS.ethRegistry, abi: registryAbi, functionName: "getSubregistry", args: [PARENT_LABEL] });
  if (onchainSub.toLowerCase() !== state.userRegistry.toLowerCase()) throw new Error(`${PARENT_NAME} subregistry is ${onchainSub}, expected ${state.userRegistry}.`);
  const parentExpiry = await c.readContract({ address: ENS.ethRegistry, abi: registryAbi, functionName: "getExpiry", args: [labelId(PARENT_LABEL)] });
  const ctx: Ctx = { s, userRegistry: state.userRegistry, resolver: state.resolver, parentExpiry };
  console.log(`Relayer: Arc IndexFactory ${ARC.indexFactory} -> ${PARENT_NAME} (UserRegistry ${ctx.userRegistry})${DRY_RUN ? " (dry-run)" : ""}`);

  let done = 0; // funds fully processed in this run
  for (;;) {
    try {
      await scanEvents();
      const count = Number(await arc.readContract({ ...factory, functionName: "indexCount" }));
      let newest: string | undefined;
      for (let i = done; i < count; i++) {
        const f = await readFund(i);
        const name = await processFund(ctx, f);
        console.log(`  #${i} ${f.symbol} ${f.fund} -> ${name}`);
        state.funds ??= {};
        state.funds[f.fund.toLowerCase()] = { label: name, fund: f.fund, creator: f.creator };
        saveState(state);
        newest = name;
        done = i + 1;
      }
      if (newest) await linkName(ctx.s, ctx.resolver, fullName("latest"), newest);
      if (count === 0 && done === 0) console.log("  no funds on Arc yet");
    } catch (e) {
      console.error(`  error (will retry): ${explain(e)}`);
      if (ONCE) process.exit(1);
    }
    if (ONCE) break;
    await sleep(POLL_MS);
  }
  console.log(`Processed ${done} fund(s).`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
