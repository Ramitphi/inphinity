// Pure decision logic for the CCIP naming fallback (src/fallback.ts). No I/O, so it is unit tested
// in test/fallback.test.ts. Every input is read from chain (or the CCIP explorer) by the caller.
import type { Hex } from "viem";

/** Normal CCIP delivery Arc -> Sepolia takes ~20-30 min; act only on messages older than this. */
export const STALE_AFTER_SEC = 2 * 60 * 60;

/** The latest ArcEnsRegistrar event for a fund (the registrar emits at most one per fund). */
export type RegistrarEvent =
  | { kind: "requested"; messageId: Hex; label: string; sentAt: number } // NamingRequested, sentAt = Arc block time (s)
  | { kind: "skipped"; label: string; reason: string }; // NamingSkipped

export type FundFacts = {
  /** Full name that already resolves (Arc coin type) to this fund on Sepolia, if any. */
  namedAs?: string;
  event?: RegistrarEvent;
  /** receiver.failedMessages(messageId) is non-empty (only meaningful for "requested"). */
  failedStored?: boolean;
  /** Unix seconds now. */
  now: number;
};

export type Action = "skip" | "retry" | "relayer" | "wait" | "report";

export type Decision = { action: Action; state: string; note: string };

export function decide(f: FundFacts): Decision {
  // 1. Already named: nothing to do, whichever path named it.
  if (f.namedAs) return { action: "skip", state: "named", note: f.namedAs };

  const e = f.event;
  // 4. Created before CCIP naming was enabled: never act, only report.
  if (!e) return { action: "report", state: "no registrar event", note: "unnamed, pre-CCIP fund: run the relayer by hand if wanted" };

  // 2. CCIP was never sent, so no message can ever arrive: name it off-chain.
  if (e.kind === "skipped") return { action: "relayer", state: `NamingSkipped (${e.reason})`, note: "fallback: name via relayer" };

  // 3. A message was sent.
  const age = f.now - e.sentAt;
  // 3a. The receiver caught a naming error and stored the payload: stay on the CCIP path.
  if (f.failedStored) return { action: "retry", state: "NamingFailed (stored on receiver)", note: "retry(messageId) on receiver" };
  // 3b. Not delivered (or failed at the OffRamp) long after normal delivery time.
  if (age >= STALE_AFTER_SEC) return { action: "relayer", state: `NamingRequested, unnamed after ${fmtAge(age)}`, note: "fallback: name via relayer" };
  // 3c. Still within the normal delivery window.
  return { action: "wait", state: `NamingRequested ${fmtAge(Math.max(age, 0))} ago`, note: `wait (acts after ${fmtAge(STALE_AFTER_SEC)})` };
}

export function fmtAge(sec: number): string {
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
