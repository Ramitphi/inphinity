// Unit tests for the CCIP fallback decision logic. Run: bun test test/fallback.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_AFTER_SEC, decide, fmtAge, type RegistrarEvent } from "../src/fallback-decide";
import { acquireLock, candidateBases } from "../src/fallback";

const now = 1_800_000_000;
const id = `0x${"ab".repeat(32)}` as const;
const requested = (ageSec: number): RegistrarEvent => ({ kind: "requested", messageId: id, label: "rmt", sentAt: now - ageSec });
const skipped: RegistrarEvent = { kind: "skipped", label: "rmt", reason: "fee balance too low" };

describe("decide", () => {
  test("already named: skip, whatever the event", () => {
    for (const event of [undefined, skipped, requested(10), requested(3 * 3600)]) {
      const d = decide({ namedAs: "rmt.inphinity.eth", event, failedStored: true, now });
      expect(d.action).toBe("skip");
      expect(d.note).toBe("rmt.inphinity.eth");
    }
  });

  test("no registrar event: report only, never act", () => {
    expect(decide({ now }).action).toBe("report");
  });

  test("NamingSkipped: name via relayer (no message can ever arrive)", () => {
    const d = decide({ event: skipped, now });
    expect(d.action).toBe("relayer");
    expect(d.state).toContain("fee balance too low");
    expect(d.note).toBe("fallback: name via relayer");
  });

  test("NamingRequested with a stored failed payload: retry on the receiver, even if young", () => {
    expect(decide({ event: requested(60), failedStored: true, now }).action).toBe("retry");
    expect(decide({ event: requested(5 * 3600), failedStored: true, now }).action).toBe("retry");
  });

  test("NamingRequested, unnamed, older than 2h: relayer", () => {
    expect(decide({ event: requested(STALE_AFTER_SEC), now }).action).toBe("relayer");
    expect(decide({ event: requested(STALE_AFTER_SEC + 1), failedStored: false, now }).action).toBe("relayer");
  });

  test("NamingRequested younger than 2h: wait (never act)", () => {
    expect(decide({ event: requested(0), now }).action).toBe("wait");
    expect(decide({ event: requested(STALE_AFTER_SEC - 1), now }).action).toBe("wait");
    // clock skew: a message "from the future" also waits
    expect(decide({ event: requested(-120), now }).action).toBe("wait");
  });

  test("the window is 2 hours", () => {
    expect(STALE_AFTER_SEC).toBe(7200);
  });
});

describe("helpers", () => {
  test("fmtAge", () => {
    expect(fmtAge(59)).toBe("0m");
    expect(fmtAge(25 * 60)).toBe("25m");
    expect(fmtAge(2 * 3600 + 5 * 60)).toBe("2h05m");
  });

  test("candidateBases: registrar label first, then relayer choices, deduped and sanitized", () => {
    expect(candidateBases({ eventLabel: "ccipdemo", symbol: "AICHIP", name: "AI Chip Leaders" }, { ...skipped, label: "ccipdemo" })).toEqual([
      "ccipdemo",
      "aichip",
      "ai-chip-leaders",
    ]);
    expect(candidateBases({ eventLabel: "", symbol: "RMT", name: "x" })).toEqual(["rmt"]);
  });
});

describe("lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "fallback-lock-"));

  test("a second run cannot take the lock while the first holds it", () => {
    const path = join(dir, "a.lock");
    const release = acquireLock(path);
    expect(existsSync(path)).toBe(true);
    expect(() => acquireLock(path)).toThrow(/another fallback run/);
    release();
    expect(existsSync(path)).toBe(false);
    acquireLock(path)(); // free again
  });

  test("a stale lock from a dead process is taken over", () => {
    const path = join(dir, "b.lock");
    writeFileSync(path, "999999999 2026-01-01T00:00:00Z\n");
    const release = acquireLock(path);
    expect(existsSync(path)).toBe(true);
    release();
  });

  test("a lock older than 1h is stale even if its pid is alive (pid reuse)", () => {
    const path = join(dir, "c.lock");
    writeFileSync(path, `${process.pid} 2020-01-01T00:00:00Z\n`);
    acquireLock(path)();
    writeFileSync(path, `${process.pid} ${new Date().toISOString()}\n`);
    expect(() => acquireLock(path)).toThrow(/another fallback run/);
  });
});
