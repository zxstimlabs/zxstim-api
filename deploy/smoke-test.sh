#!/usr/bin/env bash
#
# Post-deploy smoke test. Runs ON THE SERVER as `deploy`, against a stack
# that deploy.sh just started:
#
#   smoke-test.sh <stack> <host-port>
#
# For the throwaway "develop" stack only: it recreates the app container and
# restarts Redis, so never point it at production.
#
# A fresh develop DB starts a full indexer backfill (tens of minutes), so pool
# state may still be 503 here. The test checks that the schema exists, the
# routes answer, the RPC secret reaches the right chain, the CeFi API creates
# accounts and signs in with a PIN (with lockout and strict CORS), the ETH/VND
# market trades and settles a signed-in order, and the DBs, the book, balances
# and a CeFi session survive a recreate (the market also a Redis restart) —
# not that the backfill has finished.
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

echo "== this stack's Redis (CeFi sessions, rate limits, PIN lockouts)"
redis() { compose exec -T redis redis-cli "$@" 2>/dev/null; }
check "$(redis config get appendonly | sed -n 2p)" yes "Redis append-only persistence on"

echo "== CeFi API (api.cefi.vn): accounts, PIN sign-in, lockout, CORS"
cport=$(sed -n 's/^CEFI_HOST_PORT=//p' "$dir/.env")
cb=http://127.0.0.1:${cport:-0}
corigin=https://cefi.vn
hdr=$(mktemp)
# POST JSON to the CeFi API: cpost <path> <json> <client-ip> [origin] → status code.
# Response headers land in $hdr, the body in $hdr.body.
cpost() {
  curl -s -m 15 -o "$hdr.body" -D "$hdr" -w '%{http_code}' -H "Origin: ${4:-$corigin}" \
    -H 'Content-Type: application/json' -H "X-Real-IP: $3" -d "$2" "$cb$1"
}
# The cookies are Secure and this is plain http to localhost, so carry them by
# hand rather than in a curl jar (which would drop them).
cookies() { tr -d '\r' < "$hdr" | awk 'tolower($1)=="set-cookie:"{sub(/^[^:]*: /,""); split($0,a,";"); print a[1]}' | paste -sd ';' - | sed 's/;/; /g'; }
session_user() { curl -s -m 10 -H "Origin: $corigin" -H "Cookie: $1" "$cb/auth/get-session" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p'; }

check "$(code "$cb/health")" 200 "GET /health on the CeFi port"
check "$(code -X POST "$base/accounts")" 404 "the main API has no CeFi routes"
check "$(cpost /accounts '{"pin":"135790"}' 192.0.2.10)" 201 "POST /accounts"
acct=$(sed -n 's/.*"accountNumber":"\([^"]*\)".*/\1/p' "$hdr.body")
canon=$(printf '%s' "$acct" | tr -d -)
[[ "$acct" =~ ^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$ ]] && pass "account number has the XXXX-XXXX-XXXX-XXXX format" || fail "unexpected account number format"
cookie=$(cookies)
[ -n "$cookie" ] && pass "session cookie set" || fail "no session cookie"
[ -n "$canon" ] && [ "$(session_user "$cookie")" = "$canon" ] && pass "GET /auth/get-session returns the new account" || fail "get-session did not return the new account"
check "$(cpost /auth/sign-in/username "{\"username\":\"$acct\",\"password\":\"135790\"}" 192.0.2.11)" 200 "sign in with account number + PIN"
check "$(cpost /auth/sign-in/username "{\"username\":\"$acct\",\"password\":\"000000\"}" 192.0.2.12)" 401 "wrong PIN"
for _ in 2 3 4 5; do cpost /auth/sign-in/username "{\"username\":\"$acct\",\"password\":\"000000\"}" 192.0.2.12 >/dev/null; done
check "$(cpost /auth/sign-in/username "{\"username\":\"$acct\",\"password\":\"135790\"}" 192.0.2.13)" 429 "right PIN after 5 wrong ones: locked (per account)"
check "$(cpost /auth/sign-up/email '{}' 192.0.2.14)" 404 "raw /auth/sign-up/email is not exposed"
check "$(cpost /accounts '{"pin":"135790"}' 192.0.2.15 https://evil.example)" 403 "POST /accounts from another origin"
pre() {
  curl -s -m 5 -o /dev/null -D - -X OPTIONS -H "Origin: $1" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' "$cb/auth/sign-in/username" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}'
}
check "$(pre "$corigin")" "$corigin" "CORS preflight allows $corigin"
check "$(pre https://evil.example)" "" "CORS preflight allows no other origin"
[ "$(redis --scan --pattern 'cefi:*' | grep -c .)" -gt 0 ] && pass "auth state is in this stack's Redis (cefi:*)" || fail "no cefi:* keys in Redis"
# A second account (the first one is now locked) for the CeFi DB persistence
# check after the recreate: signing in needs the user + PIN rows from cefi.db.
check "$(cpost /accounts '{"pin":"246802"}' 192.0.2.16)" 201 "POST /accounts (second account)"
acct2=$(sed -n 's/.*"accountNumber":"\([^"]*\)".*/\1/p' "$hdr.body")
cookie2=$(cookies)

echo "== ETH/VND market (book and balances in the CeFi DB): data, the bot, a signed-in order"
check "$(code "$cb/market/ETH-VND")" 200 "GET /market/ETH-VND"
# The snapshot's updatedAt only moves when the book changed: a moving value
# means the bot is trading. Values aren't printed (public log).
market_at() { curl -s -m 10 "$cb/market/ETH-VND" | sed -n 's/.*"updatedAt":\([0-9]*\).*/\1/p'; }
bot_active() { local a b; a=$(market_at); sleep 2; b=$(market_at); [ "${b:-0}" -gt "${a:-0}" ] 2>/dev/null; }
curl -s -m 10 "$cb/market/ETH-VND" | grep -q '"bids":\[{' && pass "the book has resting bids" || fail "the book has no bids"
bot_active && pass "bot is active (the book keeps changing)" || fail "bot is not active"
check "$(code "$cb/market/ETH-VND/candles?resolution=1m&limit=10")" 200 "GET /market/ETH-VND/candles"
check "$(code "$cb/me/account")" 401 "GET /me/account signed out"
check "$(code -H "Cookie: $cookie2" "$cb/me/account")" 200 "GET /me/account signed in"
check "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Origin: $corigin" -H "Cookie: $cookie2" \
  -H 'Content-Type: application/json' -d '{"side":"buy","type":"market","quantity":"0.01"}' "$cb/me/orders")" 201 "POST /me/orders (market buy)"
# Balances are in the CeFi DB (not Redis): checked again after the recreate below.
me_eth() { curl -s -m 10 -H "Cookie: $cookie2" "$cb/me/account" | sed -n 's/.*"eth":{"available":\([0-9.]*\).*/\1/p'; }
[ "$(me_eth)" = 1.01 ] && pass "the buy settled (ETH balance 1 → 1.01)" || fail "the buy did not settle"

echo "== DB survives a container recreate (named volume)"
# Wait for the indexer to start backfilling (it saves its cursor per chunk),
# then replace the container. A persisted DB resumes from the saved cursor.
started=""; for _ in $(seq 1 30); do log_has "[pools-indexer] backfill: " && { started=1; break; }; sleep 1; done
if [ -z "$started" ]; then
  fail "indexer never started its backfill within 30s"
else
  sleep 5
  compose up -d --no-build --no-deps --force-recreate app >/dev/null 2>&1
  if wait_healthy; then pass "healthy again after recreate"; else fail "not healthy within 30s of recreate"; fi
  resumed=""; for _ in $(seq 1 30); do
    log_has "resuming from saved cursor" && { resumed=1; break; }
    log_has "no saved cursor" && break
    sleep 1
  done
  [ -n "$resumed" ] && pass "indexer resumed from its saved cursor" || fail "indexer did not resume from a saved cursor (DB not persisted?)"
  for _ in $(seq 1 15); do [ "$(code "$cb/health")" = 200 ] && break; sleep 1; done
  restored=""; for i in $(seq 1 20); do
    log_has "[orderbook ETH-VND] restored" && { restored=$i; break; }
    log_has "[orderbook ETH-VND] no saved book" && break
    log_has "bot NOT started" && break
    sleep 1
  done
  [ -n "$restored" ] && pass "order book restored from the CeFi DB after recreate (seen within ~${restored}s)" || fail "order book was not restored after recreate"
  # The market's own fixed-format lines (counts, sequence, error text; no
  # secrets) so a slow or failed boot is diagnosable from the public log.
  compose logs --no-color --no-log-prefix app 2>/dev/null | grep -F -e '[orderbook ETH-VND]' -e '[market]' | cut -c1-200 | sed 's/^/    log: /'
  bot_active && pass "bot active again after recreate" || fail "bot not active after recreate"
  [ -n "$canon" ] && [ "$(session_user "$cookie")" = "$canon" ] && pass "CeFi session survives the app recreate" || fail "CeFi session lost on app recreate"
  check "$(cpost /auth/sign-in/username "{\"username\":\"$acct2\",\"password\":\"246802\"}" 192.0.2.17)" 200 "CeFi accounts DB survives the app recreate (PIN sign-in)"
  [ "$(me_eth)" = 1.01 ] && pass "CeFi balances survive the app recreate (CeFi DB)" || fail "CeFi balance lost on app recreate"
fi

echo "== a Redis restart: the market doesn't depend on it, sessions come back"
compose restart redis >/dev/null 2>&1
up=""; for _ in $(seq 1 20); do [ "$(redis ping)" = PONG ] && { up=1; break; }; sleep 1; done
[ -n "$up" ] || fail "Redis did not come back within 20s"
bot_active && pass "bot kept trading through the Redis restart" || fail "bot not active after the Redis restart"
check "$(code -H "Cookie: $cookie2" "$cb/me/account")" 200 "signed-in GET /me/account after the Redis restart"
rm -f "$hdr" "$hdr.body"

echo
if [ $fails -eq 0 ]; then echo "smoke-test: all checks passed"; else echo "smoke-test: $fails check(s) FAILED"; fi
exit $(( fails > 0 ))
