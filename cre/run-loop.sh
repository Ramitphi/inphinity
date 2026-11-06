#!/usr/bin/env bash
# Keeps StockExchange prices live during the demo by re-running the CRE simulation on a timer.
#
#   cd cre && ./run-loop.sh                 # broadcast every 5 minutes, forever
#   INTERVAL=60 ./run-loop.sh               # every minute
#   DRY_RUN=1 MAX_RUNS=1 ./run-loop.sh      # one dry run, no transaction
#
# Env:
#   INTERVAL   seconds between run starts (default 300, minimum 30 = CRE's minimum cron interval)
#   DRY_RUN    1 = omit --broadcast (no transaction is sent)
#   MAX_RUNS   stop after this many runs (default 0 = forever)
#   TARGET     settings target from project.yaml (default arc-testnet-settings)
#   LOG_FILE   append all output here as well (default cre/run-loop.log, git-ignored)
#   CRE_BIN    path to the cre binary (default: `cre` on PATH, then ~/.cre/bin/cre)
#
# Needs: `cre login` done (or CRE_API_KEY exported) and, for broadcast, CRE_ETH_PRIVATE_KEY in cre/.env.
# A failed run is logged and the loop carries on; Ctrl-C stops it.
set -uo pipefail

cd "$(dirname "$0")"

INTERVAL="${INTERVAL:-300}"
DRY_RUN="${DRY_RUN:-0}"
MAX_RUNS="${MAX_RUNS:-0}"
TARGET="${TARGET:-arc-testnet-settings}"
LOG_FILE="${LOG_FILE:-run-loop.log}"

if [[ -n "${CRE_BIN:-}" ]]; then :
elif command -v cre >/dev/null 2>&1; then CRE_BIN="$(command -v cre)"
elif [[ -x "$HOME/.cre/bin/cre" ]]; then CRE_BIN="$HOME/.cre/bin/cre"
else echo "cre CLI not found. Install: https://docs.chain.link/cre/getting-started/cli-installation" >&2; exit 1
fi

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || (( INTERVAL < 30 )); then
  echo "INTERVAL must be an integer >= 30 (got '$INTERVAL')" >&2; exit 1
fi

args=(workflow simulate price-feed --target "$TARGET" --non-interactive --trigger-index 0)
if [[ "$DRY_RUN" != "1" ]]; then
  if [[ ! -f .env ]] || ! grep -Eq '^CRE_ETH_PRIVATE_KEY=.+' .env; then
    if [[ -z "${CRE_ETH_PRIVATE_KEY:-}" ]]; then
      echo "Broadcast needs CRE_ETH_PRIVATE_KEY (in cre/.env or the environment). Use DRY_RUN=1 for a dry run." >&2; exit 1
    fi
  fi
  args+=(--broadcast)
fi

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }
trap 'log "stopped"; exit 0' INT TERM

log "starting: $CRE_BIN ${args[*]} (every ${INTERVAL}s, max runs ${MAX_RUNS})"
run=0; ok=0; failed=0
while :; do
  run=$((run + 1)); started=$(date +%s)
  log "run #$run"
  "$CRE_BIN" "${args[@]}" 2>&1 | tee -a "$LOG_FILE"
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
