#!/usr/bin/env bash
#
# Post-deploy smoke test. Runs ON THE SERVER as `deploy`, against a stack
# that deploy.sh just started:
#
#   smoke-test.sh <stack> <host-port>
#
# For the throwaway "develop" stack only: it recreates the app container, so
# never point it at production.
#
# A fresh develop DB starts a full indexer backfill (tens of minutes), so pool
# state may still be 503 here. The test checks that the schema exists, the
# routes answer, the RPC secret reaches the right chain, and the DB survives a
# container recreate — not that the backfill has finished.
#
# Output goes to the public workflow log, so it prints only status codes,
# chain ids and pass/fail lines — never URLs, response bodies, or container
# logs. Exits non-zero if any check fails.

set -uo pipefail

stack=$1 port=$2
dir=/opt/$stack
base=http://127.0.0.1:$port
pool=0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257
fails=0

case "$stack" in
  *-dev) ;;
  *) echo "smoke-test: refusing to run against '$stack' (develop stacks only)" >&2; exit 2 ;;
esac

compose() { IMAGE=$(cat "$dir/.image") HOST_PORT=$port docker compose -p "$stack" -f "$dir/compose.yaml" "$@"; }
pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; fails=$((fails + 1)); }
check() { if [ "$1" = "$2" ]; then pass "$3 ($1)"; else fail "$3 (got '$1', want '$2')"; fi; }
code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$@"; }
log_has() { compose logs --no-color --no-log-prefix app 2>/dev/null | grep -qF "$1"; }
wait_healthy() { for _ in $(seq 1 30); do [ "$(code "$base/health")" = 200 ] && return 0; sleep 1; done; return 1; }

echo "== health"
check "$(code "$base/health")" 200 "GET /health"

echo "== pools routes (schema migrated, handlers answer)"
c=$(code "$base/pools/$pool")
case "$c" in
  200) pass "GET /pools/<pool> (200)" ;;
  503) pass "GET /pools/<pool> (503: backfill still running)" ;;
  *) fail "GET /pools/<pool> (got '$c', want 200 or 503)" ;;
esac
check "$(code "$base/pools/0xdead")" 404 "GET /pools/<unknown pool>"
check "$(code "$base/pools/$pool/candles?resolution=1h")" 200 "GET /pools/<pool>/candles"
check "$(code "$base/pools/$pool/users/nope/swaps")" 400 "GET /pools/<pool>/users/<bad address>/swaps"

echo "== WebSocket upgrade"
# curl exits 28 (timeout) once the socket is open; the status code is still printed.
check "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$base/pools/$pool/ws")" 101 "WS /pools/<pool>/ws"

echo "== CORS preflight answered locally"
pre=$(curl -s -m 5 -o /dev/null -D - -X OPTIONS -H 'origin: https://app.example.com' \
  -H 'access-control-request-method: GET' "$base/pools/$pool" | tr -d '\r')
check "$(printf '%s' "$pre" | awk 'NR==1{print $2}')" 204 "OPTIONS /pools/<pool>"
printf '%s' "$pre" | grep -qi '^access-control-allow-origin:' && pass "Access-Control-Allow-Origin present" || fail "Access-Control-Allow-Origin missing"

echo "== /rpc/arbitrum-sepolia reaches Arbitrum Sepolia (validates this environment's RPC secret)"
got=$(curl -s -m 20 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$base/rpc/arbitrum-sepolia" \
  | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')
check "${got:-none}" 0x66eee "eth_chainId"

echo "== DB survives a container recreate (named volume)"
# Wait for the indexer to start backfilling (it saves its cursor per chunk),
# then replace the container. A persisted DB resumes from the saved cursor.
started=""; for _ in $(seq 1 30); do log_has "[pools-indexer] backfill: " && { started=1; break; }; sleep 1; done
if [ -z "$started" ]; then
  fail "indexer never started its backfill within 30s"
else
  sleep 5
  compose up -d --no-build --force-recreate app >/dev/null 2>&1
  if wait_healthy; then pass "healthy again after recreate"; else fail "not healthy within 30s of recreate"; fi
  resumed=""; for _ in $(seq 1 30); do
    log_has "resuming from saved cursor" && { resumed=1; break; }
    log_has "no saved cursor" && break
    sleep 1
  done
  [ -n "$resumed" ] && pass "indexer resumed from its saved cursor" || fail "indexer did not resume from a saved cursor (DB not persisted?)"
fi

echo
if [ $fails -eq 0 ]; then echo "smoke-test: all checks passed"; else echo "smoke-test: $fails check(s) FAILED"; fi
exit $(( fails > 0 ))
