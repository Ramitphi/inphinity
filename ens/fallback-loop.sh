#!/usr/bin/env bash
# CCIP naming fallback on a timer: runs `bun run src/fallback.ts --once` every 30 minutes.
# Each run only acts on funds whose CCIP naming can no longer do it (see src/fallback.ts).
#
#   cd ens && ./fallback-loop.sh                # every 30 minutes, forever
#   INTERVAL=600 ./fallback-loop.sh             # every 10 minutes
#   DRY_RUN=1 MAX_RUNS=1 ./fallback-loop.sh     # one dry run: decision table only, no transaction
#
# Env:
#   INTERVAL   seconds between run starts (default 1800, minimum 60)
#   DRY_RUN    1 = pass --dry-run (no transaction is sent, no key needed)
#   MAX_RUNS   stop after this many runs (default 0 = forever)
#   LOG_FILE   append all output here as well (default ens/fallback-loop.log, git-ignored)
#
# Needs, unless DRY_RUN=1: PRIVATE_KEY of the dedicated fallback key in ens/.env (bun loads it) or
# exported. Not the team key: grant the fallback key its roles with src/grant-fallback-roles.ts.
# A failed run is logged and the loop carries on; Ctrl-C stops it. fallback.ts also takes a lock
# file (ens/.fallback.lock), so a second loop or a manual run cannot overlap with this one.
set -uo pipefail

cd "$(dirname "$0")"

INTERVAL="${INTERVAL:-1800}"
DRY_RUN="${DRY_RUN:-0}"
MAX_RUNS="${MAX_RUNS:-0}"
LOG_FILE="${LOG_FILE:-fallback-loop.log}"

command -v bun >/dev/null 2>&1 || { echo "bun not found. Install: https://bun.sh" >&2; exit 1; }

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || (( INTERVAL < 60 )); then
  echo "INTERVAL must be an integer >= 60 (got '$INTERVAL')" >&2; exit 1
fi
if ! [[ "$MAX_RUNS" =~ ^[0-9]+$ ]]; then echo "MAX_RUNS must be an integer (got '$MAX_RUNS')" >&2; exit 1; fi

KEY_RE='^[[:space:]]*(export[[:space:]]+)?PRIVATE_KEY=["'"'"']?(0x)?[0-9a-fA-F]{64}["'"'"']?[[:space:]]*$'
args=(run src/fallback.ts --once)
if [[ "$DRY_RUN" == "1" ]]; then
  args+=(--dry-run)
else
  # bun loads ens/.env. A PRIVATE_KEY= line there (even empty, as copied from .env.example) must
  # hold a real key, or the run would fail every 30 minutes. Accept 64 hex with or without 0x.
  if [[ -f .env ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?PRIVATE_KEY=' .env; then
    if ! grep -Eq "$KEY_RE" .env; then
      echo "ens/.env has an empty or invalid PRIVATE_KEY line. Put the fallback key there (64 hex, 0x optional) or delete the line." >&2; exit 1
    fi
  elif [[ -z "${PRIVATE_KEY:-}" ]]; then
    echo "Needs PRIVATE_KEY (in ens/.env or the environment). Use DRY_RUN=1 for a dry run." >&2; exit 1
  elif ! [[ "PRIVATE_KEY=$PRIVATE_KEY" =~ $KEY_RE ]]; then
    echo "Exported PRIVATE_KEY is not 64 hex characters (0x optional)." >&2; exit 1
  fi
fi

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }
trap 'log "stopped"; exit 0' INT TERM

log "starting: bun ${args[*]} (every ${INTERVAL}s, max runs ${MAX_RUNS})"
run=0; ok=0; failed=0
while :; do
  run=$((run + 1)); started=$(date +%s)
  log "run #$run"
  bun "${args[@]}" 2>&1 | tee -a "$LOG_FILE"
  status=${PIPESTATUS[0]}
  if (( status == 0 )); then
    ok=$((ok + 1)); log "run #$run ok (${ok} ok / ${failed} failed)"
  else
    failed=$((failed + 1)); log "run #$run FAILED (exit ${status}; ${ok} ok / ${failed} failed)"
  fi
  if (( MAX_RUNS > 0 && run >= MAX_RUNS )); then log "done after $run runs"; break; fi
  elapsed=$(( $(date +%s) - started ))
  (( elapsed < INTERVAL )) && sleep $(( INTERVAL - elapsed ))
done
