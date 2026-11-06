// CCIP naming fallback: names a fund off-chain only when its CCIP naming message can no longer do it.
//
// For every fund in IndexFactory (indexCount()/indexAt()) it reads the ArcEnsRegistrar events and
// the Sepolia state, then decides (pure logic in fallback-decide.ts):
//   - already named (some <label>[-n].inphinity.eth resolves to the fund)    -> skip
//   - NamingSkipped (CCIP never sent, no message can ever arrive)             -> relayer names it
//   - NamingRequested and the receiver stored the failed payload              -> receiver.retry(id)
//   - NamingRequested, older than 2h, still unnamed (OffRamp failure/stall)   -> relayer names it
//   - NamingRequested, younger than 2h                                        -> wait
//   - no registrar event (fund created before CCIP naming was enabled)        -> report only
//
// No double calls:
//   - a lock file (ens/.fallback.lock) so two runs never overlap,
//   - the "already named" check is repeated right before each write,
//   - both writers are idempotent per fund: the relayer's chooseLabel and the receiver's
//     _chooseLabel return the existing label when it already resolves to this fund, so a CCIP
//     message that lands after the fallback only rewrites the same records,
//   - a message younger than 2h is never acted on.
//
// Usage: PRIVATE_KEY=0x... bun run src/fallback.ts [--once] [--dry-run]
//   One pass per run (--once is accepted for symmetry with the relayer). fallback-loop.sh repeats it.
//   --dry-run prints the decision table and sends nothing (no key needed).
// Env: ARC_REGISTRAR_FROM_BLOCK (registrar deploy block, default 71034484), CCIP_API=0 to skip the
//      CCIP explorer status column. The 2h window is a constant on purpose (no env override).
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { parseAbi, type Address, type Hex } from "viem";
import { ARC, DRY_RUN, arcClient as arc, sepoliaClient as c } from "./config";
import { indexFactoryAbi } from "./abis";
import { explain, loadState, sanitizeLabel, saveState, send, signer } from "./lib";
import { linkName, readAddr } from "./records";
import { chooseLabel, fullName, labelState, loadCtx, processFund, readFund, scanEvents, type Ctx, type FundInfo } from "./relayer";
import { STALE_AFTER_SEC, decide, type Decision, type RegistrarEvent } from "./fallback-decide";

const REGISTRAR_FROM_BLOCK = BigInt(process.env.ARC_REGISTRAR_FROM_BLOCK ?? 71_034_484); // ArcEnsRegistrar deploy block
const LOG_CHUNK = 9_000n; // Arc RPC rejects eth_getLogs ranges of 10k blocks or more
const USE_CCIP_API = process.env.CCIP_API !== "0";
const LOCK_FILE = new URL("../.fallback.lock", import.meta.url).pathname;
const LOCK_STALE_MS = 60 * 60 * 1000;
const MAX_SUFFIX = 100; // same bound as the relayer (the receiver stops at 20)

export const registrarEventsAbi = parseAbi([
  "event NamingRequested(address indexed fund, address indexed creator, string label, bytes32 indexed messageId, uint256 fee)",
  "event NamingSkipped(address indexed fund, string label, string reason)",
]);
export const receiverAbi = parseAbi([
  "function failedMessages(bytes32 messageId) view returns (bytes)",
  "function processed(bytes32 messageId) view returns (bool)",
  "function retry(bytes32 messageId)",
  "error NothingToRetry()",
  "error NoFreeLabel()",
]);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** fund (lowercase) -> latest registrar event for it. */
async function registrarEvents(registrar: Address): Promise<Map<string, RegistrarEvent>> {
  const out = new Map<string, RegistrarEvent>();
  const head = await arc.getBlockNumber();
  const blockTime = new Map<bigint, number>();
  for (let from = REGISTRAR_FROM_BLOCK; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    const logs = await arc.getLogs({ address: registrar, events: registrarEventsAbi, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const fund = l.args.fund!.toLowerCase();
      if (l.eventName === "NamingSkipped") {
        out.set(fund, { kind: "skipped", label: l.args.label ?? "", reason: l.args.reason ?? "" });
      } else {
        let t = blockTime.get(l.blockNumber);
        if (t === undefined) {
          t = Number((await arc.getBlock({ blockNumber: l.blockNumber })).timestamp);
          blockTime.set(l.blockNumber, t);
        }
        out.set(fund, { kind: "requested", label: l.args.label ?? "", messageId: l.args.messageId!, sentAt: t });
      }
    }
  }
  return out;
}

/** Label bases either writer could have used: the registrar's label, then the relayer's own choice. */
export function candidateBases(f: Pick<FundInfo, "eventLabel" | "symbol" | "name">, ev?: RegistrarEvent): string[] {
  const all = [ev?.label, f.eventLabel, f.symbol, f.name].map((x) => sanitizeLabel(x ?? ""));
  return [...new Set(all.filter((x): x is string => !!x))];
}

const withSuffix = (base: string, n: number) => {
  const suffix = n === 1 ? "" : `-${n}`;
  return base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
};

/** The full name that already resolves (Arc coin type) to this fund, or undefined. */
export async function findName(ctx: Ctx, f: FundInfo, ev?: RegistrarEvent): Promise<string | undefined> {
  for (const base of candidateBases(f, ev)) {
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const label = withSuffix(base, n);
      const st = await labelState(ctx, label);
      if (st.status === 0) break; // both writers stop at the first free label
      if (st.status !== 2) continue; // reserved
      const addr = await readAddr(ctx.resolver, fullName(label)).catch(() => "0x" as Hex);
      if (addr.toLowerCase() === f.fund.toLowerCase()) return fullName(label);
    }
  }
  return undefined;
}

async function failedStored(receiver: Address, messageId: Hex): Promise<boolean> {
  const data = await c.readContract({ address: receiver, abi: receiverAbi, functionName: "failedMessages", args: [messageId] });
  return data !== "0x";
}

/** CCIP explorer status (SUCCESS, FAILED, SENT, ...). Informational only; decisions use chain state. */
async function ccipStatus(messageId: Hex): Promise<string> {
  if (!USE_CCIP_API) return "";
  try {
    const r = await fetch(`https://api.ccip.chain.link/v2/messages/${messageId}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return `http ${r.status}`;
    const j = (await r.json()) as { status?: string; readyForManualExecution?: boolean };
    return `${j.status ?? "?"}${j.readyForManualExecution ? " (manual exec ready)" : ""}`;
  } catch {
    return "unreachable";
  }
}

// ---------------------------------------------------------------------------
// Lock: one run at a time
// ---------------------------------------------------------------------------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function acquireLock(path = LOCK_FILE): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {}
      };
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => (release(), process.exit(130)));
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const [pidStr, at] = readFileSync(path, "utf8").trim().split(" ");
      const pid = Number(pidStr);
      const ageMs = Date.now() - (Date.parse(at ?? "") || 0);
      // A run takes minutes; after LOCK_STALE_MS the pid may have been reused by another process.
      if (pid && alive(pid) && ageMs < LOCK_STALE_MS) throw new Error(`another fallback run (pid ${pid}) holds ${path}; not starting`);
      console.log(`  removing stale lock from pid ${pid || "?"}`);
      if (existsSync(path)) unlinkSync(path);
    }
  }
  throw new Error(`could not take ${path}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Row = { f: FundInfo; ev?: RegistrarEvent; d: Decision; ccip: string };

function printTable(rows: Row[]) {
  const cells = rows.map((r) => [String(r.f.index), r.f.symbol, r.f.fund, r.d.state, r.d.action === "skip" ? `named: ${r.d.note}` : r.d.note, r.ccip]);
  const head = ["#", "symbol", "fund", "state", "action", "ccip explorer"];
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => "  " + c.map((x, i) => x.padEnd(w[i])).join(" | ").trimEnd();
  console.log(line(head));
  console.log("  " + w.map((n) => "-".repeat(n)).join("-|-"));
  for (const c of cells) console.log(line(c));
}

async function main() {
  const release = DRY_RUN ? () => {} : acquireLock();
  const state = loadState();
  const s = signer();
  const ctx = await loadCtx(s, state);
  const registrar = state.arcEnsRegistrar as Address | undefined;
  const receiver = state.ensReceiver as Address | undefined;
  if (!registrar || !receiver) throw new Error("No arcEnsRegistrar/ensReceiver in deployments.sepolia.json (run ccip-setup.ts).");
  console.log(`CCIP fallback as ${s.from}${DRY_RUN ? " (dry-run)" : ""}: registrar ${registrar} (Arc) -> receiver ${receiver} (Sepolia), acts on messages older than ${STALE_AFTER_SEC / 3600}h`);

  await scanEvents(); // IndexCreated labels, used as label candidates
  const events = await registrarEvents(registrar);
  const count = Number(await arc.readContract({ address: ARC.indexFactory, abi: indexFactoryAbi, functionName: "indexCount" }));
  const now = Math.floor(Date.now() / 1000);

  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const f = await readFund(i);
    const ev = events.get(f.fund.toLowerCase());
    const namedAs = await findName(ctx, f, ev);
    const stored = !namedAs && ev?.kind === "requested" ? await failedStored(receiver, ev.messageId) : false;
    const d = decide({ namedAs, event: ev, failedStored: stored, now });
    const ccip = ev?.kind === "requested" ? await ccipStatus(ev.messageId) : "";
    rows.push({ f, ev, d, ccip });
  }
  printTable(rows);

  const todo = rows.filter((r) => r.d.action === "relayer" || r.d.action === "retry");
  if (DRY_RUN) {
    console.log(`\n[dry-run] ${todo.length} action(s) planned, nothing sent.`);
    return;
  }

  let errors = 0;
  for (const { f, ev, d } of todo) {
    try {
      // Re-check right before writing: CCIP (or a manual execution) may have landed meanwhile.
      const named = await findName(ctx, f, ev);
      if (named) {
        console.log(`  #${f.index} ${f.symbol}: named meanwhile as ${named}; nothing to do`);
        continue;
      }
      if (d.action === "retry" && ev?.kind === "requested") {
        if (!(await failedStored(receiver, ev.messageId))) {
          console.log(`  #${f.index} ${f.symbol}: stored message ${ev.messageId} is gone (retried elsewhere); skipping`);
          continue;
        }
        await send(s, `receiver.retry(${ev.messageId}) for ${f.symbol}`, { address: receiver, abi: receiverAbi, functionName: "retry", args: [ev.messageId] });
        console.log(`  #${f.index} ${f.symbol}: retried on the CCIP receiver`);
        continue;
      }
      // Relayer path: use the label the CCIP message carried, so both writers pick the same base.
      const fund: FundInfo = ev?.label ? { ...f, eventLabel: ev.label } : f;
      const { label } = await chooseLabel(ctx, fund);
      console.log(`  #${f.index} ${f.symbol}: naming via relayer as ${fullName(label)}`);
      const name = await processFund(ctx, fund);
      if (f.index === count - 1) await linkName(ctx.s, ctx.resolver, fullName("latest"), name); // only the newest fund owns `latest`
      state.funds ??= {};
      state.funds[f.fund.toLowerCase()] = { label: name, fund: f.fund, creator: f.creator };
      saveState(state);
      console.log(`  #${f.index} ${f.symbol} ${f.fund} -> ${name}`);
    } catch (e) {
      errors++;
      console.error(`  #${f.index} ${f.symbol}: ${d.action} failed: ${explain(e)}`);
    }
  }
  console.log(`Done: ${todo.length - errors} ok, ${errors} failed, ${rows.length - todo.length} without action.`);
  release();
  if (errors) process.exit(1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
