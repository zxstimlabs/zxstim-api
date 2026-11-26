# zxstim-api

Elysia API running on Bun.

## Development

```bash
bun install
bun run dev
```

Server runs at http://localhost:8001

## Environment Variables

Copy `.env.example` to `.env.local` and fill it in:

```
ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/<YOUR_KEY>
HOT_MANAGER_WALLET_PRIVATE_KEY=0x<YOUR_PRIVATE_KEY>
```

- The hot manager wallet's address is derived from the key; there is no separate address variable.
- Optional: `DEFI_DATABASE_PATH` (default `./data/defi/defi.db`), `BACKFILL_RPC_URL` (indexer backfill/poll endpoint, defaults to the public Arbitrum Sepolia RPC), `HOST` / `PORT` (default `127.0.0.1:8001`; the container image sets `0.0.0.0:8000`), `REDIS_URL` (enables the ETH/VND order-book bot; without it the bot is off).
- **Databases:** two SQLite files with one layout, `data/<name>/<name>.db` with migrations in `drizzle/<name>/`: the DeFi indexer DB (`data/defi/defi.db`, `drizzle/defi/`) and the CeFi accounts DB (`data/cefi/cefi.db`, `drizzle/cefi/`). Paths are relative to the working directory (`/app` in the image, whose DBs are at `/data/defi/defi.db` and `/data/cefi/cefi.db`); `data/` is gitignored and its folders are created on first start.
- On startup the server applies any pending migrations. Generate them locally with `bun db:generate:defi` / `bun db:generate:cefi` and commit them; nothing generates migrations on the server.

## Deployment

Production runs on the **zxstim-rpc** server (Hetzner, Tailscale machine `zxstim-rpc`) next to [eth-rpc](https://github.com/zxstimlabs/eth-rpc), with the same pipeline. `.github/workflows/ci-cd.yml` — push to deploy, nothing manual:

| Event | Jobs | Target |
|---|---|---|
| PR into `main` / `develop` | test → build image → boot test | — |
| push `develop` | test → build → boot test → push → deploy → **smoke test on the server → tear down** | GitHub env **develop** → stack `zxstim-api-dev` on `127.0.0.1:8004`. Throwaway: removed with its volumes and `.env` |
| push `main` | test → build → boot test → push → deploy | GitHub env **production** → stack `zxstim-api` on `127.0.0.1:8003` (nginx: `api.zxstim.com`) |

Ports on the box: `8001` eth-rpc prod, `8002` eth-rpc develop, `8003` zxstim-api prod, `8004` zxstim-api develop, `8005` CeFi API prod (nginx: `api.cefi.vn`), `8006` CeFi API develop.

- **Image:** `ghcr.io/zxstimlabs/zxstim-api:<commit-sha>` (+ `:<branch>`), the `Dockerfile` `runtime` target: the compiled binary plus `drizzle/` (both DBs' migrations) on distroless, as nonroot. It contains no secrets.
- **Tests** (every run): `bun test` (engine, bot, persistence) with a throwaway Redis service, so the Redis store's Lua script is exercised too.
- **Boot test** (every run, PRs too): runs the built image read-only with a random throwaway key and unreachable upstreams, and checks `/health`, that migrations created the tables (`/pools/<id>` → 503, not 500), 404/candles/WebSocket routes, and nonroot. Only an image that passed is pushed.
- **Secrets** (`ARBITRUM_SEPOLIA_RPC_URL`, `HOT_MANAGER_WALLET_PRIVATE_KEY`, `BETTER_AUTH_SECRET`, `CEFI_PIN_PEPPER`) live in the GitHub environment and reach the server only at deploy time, as `/opt/<stack>/.env` (mode 600).
- **Data:** two separate SQLite files, each on its own volume, plus the stack's own Redis (not shared with eth-rpc's):

  | Store | Volume | Holds | If lost |
  |---|---|---|---|
  | `/data/defi/defi.db` | `<stack>_defi-data` | DeFi indexer (pool meta, swaps, states, cursor); migrations `drizzle/defi/` | Rebuilt from chain (a long backfill) |
  | `/data/cefi/cefi.db` | `<stack>_cefi-data` | CeFi accounts, PIN hashes, sessions, passkeys; migrations `drizzle/cefi/` | **Accounts gone: back it up** |
  | Redis (append-only file) | `<stack>_redis-data` | Order book, CeFi session cache, rate limits, PIN lockouts | Book reseeds; users sign in again |

  Deploys, restarts and `up` keep all three. Never run `docker compose down -v` on production.
- **Access:** the runner joins Tailscale with a per-environment OIDC credential as `tag:ci`, which may only SSH to `tag:server` as user `deploy`. The server has no public SSH.
- **On the server:** `deploy/deploy.sh` (same script as eth-rpc's) swaps in the new `.env`, pulls, restarts, checks `/health` for 30s, and **rolls back** to the previous image and `.env` if unhealthy.
- **develop smoke test** (`deploy/smoke-test.sh`, refuses non-dev stacks): `/health`; pool routes answer (503 is fine while the backfill runs); WebSocket upgrade; CORS preflight; `/rpc/arbitrum-sepolia` returns chain `0x66eee` (validates the RPC secret); the order-book bot is saving to Redis (AOF on); the CeFi API creates an account, signs in with the PIN, locks after 5 wrong PINs, hides the raw sign-up route, and allows only the CeFi origins; the DB, the book and a CeFi session survive an app recreate, and the book survives a Redis restart.
- **Shared box:** the app is capped at 1 CPU / 512 MB and its Redis at 0.5 CPU / 256 MB, so a flood on this API can't starve the RPC proxy.
- **Rollback by hand:** re-run the workflow for an earlier commit, or on the server: `IMAGE=<old ref> HOST_PORT=8003 docker compose -p zxstim-api -f /opt/zxstim-api/compose.yaml up -d`.
- **Logs:** on the server, `docker compose -p zxstim-api -f /opt/zxstim-api/compose.yaml logs app`. Workflow logs are public (public repo): nothing in the pipeline prints secrets or the deployed container's logs.

### One-time setup

- **GitHub:** environments `production` (branch `main` only) and `develop` (branch `develop` only), each with secrets `ARBITRUM_SEPOLIA_RPC_URL`, `HOT_MANAGER_WALLET_PRIVATE_KEY`, `BETTER_AUTH_SECRET` and `CEFI_PIN_PEPPER` (the last two random, ≥ 32 chars, different per environment), and variables `TS_CLIENT_ID` / `TS_AUDIENCE` from a Tailscale OIDC federated credential (tag `tag:ci`, issuer GitHub Actions, subject `repo:zxstimlabs@161289539/zxstim-api@1250901918:environment:<env>`; the repo uses GitHub's immutable OIDC subject format, like eth-rpc).
- **Server** (as root): `install -d -o deploy -g deploy -m 750 /opt/zxstim-api /opt/zxstim-api-dev`.
- **nginx + TLS:** `deploy/nginx.conf` → `/etc/nginx/sites-available/zxstim-api` and `deploy/nginx-cefi.conf` → `/etc/nginx/sites-available/zxstim-cefi`, symlinked into `sites-enabled`. Their headers list the certbot steps.
- **DNS:** `api.zxstim.com` and `api.cefi.vn` → the zxstim-rpc server (178.105.70.39).

### The databases: the DeFi indexer backfill, and CeFi backups

Everything in the **DeFi** DB is derived from chain data, so it isn't backed up. But a **fresh DeFi DB starts a full backfill** from block 271232501: tens of millions of blocks, in 5000-block `eth_getLogs` chunks, which takes tens of minutes, and `/pools` returns 503 until it finishes. To move or rebuild production without that gap, seed the volume with a copy of an existing DB: stop the app, put a consistent copy (`sqlite3 <db> ".backup <copy>"`) at `defi.db` in the `<stack>_defi-data` volume, owned by uid 65532, and start it again. It resumes from the saved cursor.

The **CeFi** DB is the opposite: it holds accounts that can't be recreated. **It is not backed up yet.** Options: Hetzner's server backups (whole box, daily), or a scheduled `sqlite3 <volume>/cefi.db ".backup …"` of the `<stack>_cefi-data` volume, copied off the box. Sessions are also cached in Redis, but accounts and PIN hashes exist only in this file.

## ETH/VND order book (matching engine + bot)

A price-time-priority limit order book for one market, **ETH/VND**, kept alive by a background bot and persisted in Redis. **No HTTP routes yet**: it runs inside the server process, library-only.

- **Engine:** `src/lib/matching-engine`, imported from [cex-orderbook-matching-engine](https://github.com/zxstimlabs/cex-orderbook-matching-engine). Integers only (`bigint`): quantities in lots (ETH × 10,000), prices in ticks (VND × 100). Limit, market, IOC, FOK and post-only orders; cancel; amend. Design decisions and invariants: [its README](src/lib/matching-engine/README.md).
- **Bot:** `src/modules/orderbook/bot.ts`, ported from the engine repo's `scripts/test.script.ts`. Every 500 ms it random-walks the mid (45M–55M VND, 50,000 VND levels) and submits a passive limit, a market/IOC taker, a cancel or an amend, keeping at most 10 price levels per side. Parameters: `src/config/orderbook.ts`.
- **Persistence:** after each step, one atomic Lua call saves the orders that changed to `orderbook:ETH-VND:orders` (hash) and the engine sequence plus bot state to `orderbook:ETH-VND:meta`. On boot the book is restored (`MatchingEngine.restore`), so it carries on across deploys. If Redis is unreachable at boot the bot waits rather than seeding over saved state; if a save fails it keeps running in memory and fully re-syncs once Redis is back; if the saved state is invalid it stays stopped and logs which keys to inspect.
- **Off without `REDIS_URL`** (local dev, the CI boot test). To run it locally: `redis-server` then `REDIS_URL=redis://localhost:6379 bun run dev`.
- **Reset the book** (on the server): `docker compose -p zxstim-api -f /opt/zxstim-api/compose.yaml exec redis redis-cli DEL orderbook:ETH-VND:orders orderbook:ETH-VND:meta`, then restart the app; it seeds a fresh book.
- **Logs** only state changes (`[orderbook ETH-VND] seeded / restored / Redis save failed / Redis is back`), never per step.

## CeFi API (api.cefi.vn): accounts without email

For the CeFi simulator web app (cefi.vn, sim.cefi.vn until the move). Separate from the DeFi app: own users, no wallets. **An account is a server-generated account number; users sign in with it plus a 6-digit PIN, or with a passkey.** No email, no verification.

- **Separate listener.** A second Elysia app in the same process, on container port 8001 (`src/modules/cefi`). It can't be a module of the main app: `@elysiajs/cors` hooks are global, and the DeFi modules' "reflect any origin, no credentials" CORS would answer CeFi's preflights and break cookie auth. Here CORS is credentialed and limited to `https://cefi.vn` and `https://sim.cefi.vn`.
- **Same-site cookies.** The API is on `api.cefi.vn`, the same site as the web app, so the session cookie (`__Secure-cefi.session_token`, httpOnly, SameSite=Lax) is first-party. The web app calls with `fetch(…, { credentials: "include" })`.
- **[Better Auth](https://www.better-auth.com) 1.7** (`src/modules/cefi/auth.ts`): `username` plugin (the account number is the username, the PIN is the password) and `@better-auth/passkey` (rpID `cefi.vn`, discoverable + biometric, so one tap signs in without typing the number). Its user table requires an email, so each account gets a `<number>@account.cefi.invalid` placeholder. Tables `cefi_user`, `cefi_session`, `cefi_account`, `cefi_passkey` live in **their own SQLite file**, `CEFI_DATABASE_PATH` (`/data/cefi/cefi.db` in the image, `./data/cefi/cefi.db` locally), separate from the DeFi indexer DB: opened and migrated (`drizzle/cefi/`) only when the CeFi API starts. Generated schema `src/modules/cefi/schema.ts`; regenerate with the command in its header, then `bun db:generate:cefi`. Sessions are stored in SQLite and cached in the stack's Redis, with rate limits and verification data, all under `cefi:`.
- **Account numbers:** 16 Crockford base32 characters (80 random bits), shown as `K7Q2-9XMR-4TDA-WZ3P`; typed input may use any case, spaces or dashes, and I/L/O for 1/0. Treat them as secret: never show one publicly (use a display name).
- **PINs:** exactly 6 digits, enforced at sign-up, sign-in and change. Hashed with argon2id (19 MiB) over an HMAC with `CEFI_PIN_PEPPER`, so a leaked DB alone can't be brute-forced. **Never change the pepper**: every PIN would stop working.
- **Limits:** 5 wrong PINs for an account within an hour → PIN sign-in locked 15 min, doubling per lock up to 24 h (passkeys still work; unknown numbers are counted the same way). Per IP: 10 PIN sign-ins/min, 5 new accounts/hour, 60 auth requests/min. IPs come from nginx's `X-Real-IP`; without it all clients share one bucket.

| Route | |
|---|---|
| `POST /accounts` `{ pin }` | 201 `{ accountNumber }` + session cookie. Needs a CeFi `Origin`. |
| `POST /auth/sign-in/username` `{ username, password }` | Account number + PIN |
| `GET /auth/passkey/generate-register-options`, `POST /auth/passkey/verify-registration` | Add a passkey (signed in) |
| `GET /auth/passkey/generate-authenticate-options`, `POST /auth/passkey/verify-authentication` | Sign in with a passkey |
| `GET /auth/get-session`, `POST /auth/sign-out` | Session |
| `POST /auth/change-password` `{ currentPassword, newPassword }` | Change PIN |
| `GET /auth/list-sessions`, `POST /auth/revoke-session`, `POST /auth/revoke-other-sessions` | Devices |
| `GET /auth/passkey/list-user-passkeys`, `POST /auth/passkey/update-passkey`, `POST /auth/passkey/delete-passkey` | Manage passkeys |
| `GET /health` | 200 while SQLite and Redis answer |

Every other `/auth/*` path is 404 (`AUTH_PATHS` in `src/modules/cefi/app.ts`), including all email, password-reset and social routes and the raw `/auth/sign-up/email`. The web app can use Better Auth's client (`createAuthClient({ baseURL: "https://api.cefi.vn/auth", plugins: [usernameClient(), passkeyClient()] })`, with `credentials: "include"`) for everything except account creation, which is a plain `fetch` to `/accounts`.

**Local dev:** `redis-server`, then `CEFI_ENABLED=1 CEFI_BASE_URL=http://localhost:8002 CEFI_RP_ID=localhost CEFI_EXTRA_ORIGINS=http://localhost:5173 BETTER_AUTH_SECRET=… CEFI_PIN_PEPPER=… REDIS_URL=redis://localhost:6379 bun run dev` (see `.env.example`).

## Pools WebSocket Integration

The `/pools` module streams live Uniswap V4 pool state and swap events to frontend clients over a single WebSocket connection.

### Endpoints

- **REST** `GET /pools/:poolId` — returns latest pool state + recent 50 swaps (read from SQLite)
- **REST** `GET /pools/:poolId/candles?resolution=…&from=…&to=…&limit=…` — OHLCV candles aggregated from indexed swaps
- **WebSocket** `WS /pools/:poolId/ws` — streams pool state updates and swap events in real time

### Data source

All `/pools` endpoints (REST and WS-on-connect) read from a local SQLite indexer. On boot the server backfills every `Swap` event from the pool deploy block to the chain head, then keeps the DB live via a WSS subscription plus a 30 s HTTP catch-up poller. Restarting the server doesn't lose history.

### Pool ID

```
0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257
```

### WebSocket Message Types

All messages are JSON with a `type` field:

#### `pool_state` — sent on every new block

```json
{
  "type": "pool_state",
  "data": {
    "currency0Symbol": "ETH",
    "currency1Symbol": "VND",
    "currency0Decimals": 18,
    "currency1Decimals": 18,
    "sqrtPriceX96": "588100859679867612338768403599633",
    "tick": 178255,
    "protocolFee": 0,
    "lpFee": 500,
    "liquidity": "74228532250072169377684025",
    "feeGrowthGlobal0X128": "346111096686892598082152625",
    "feeGrowthGlobal1X128": "23019849040645226698443971215162792",
    "reserve0": "9999968821516356479511",
    "reserve1": "550989227082318594375578085831",
    "blockNumber": "271312626",
    "updatedAt": 1779814558367
  }
}
```

#### `swap` — sent when a swap occurs in the pool

```json
{
  "type": "swap",
  "data": {
    "poolId": "0x363251ac...",
    "sender": "0x...",
    "userAddress": "0x...",
    "amount0": "-1000000000000000000",
    "amount1": "55000000000000000000000",
    "sqrtPriceX96": "588100859679867612338768403599633",
    "liquidity": "74228532250072169377684025",
    "tick": 178255,
    "fee": 500,
    "price": 55107539.16,
    "transactionHash": "0x...",
    "blockNumber": "271312626",
    "blockTimestamp": 1779814558,
    "timestamp": 1779814558000
  }
}
```

- `sender` is the contract that called the PoolManager (usually the Universal Router)
- `userAddress` is the wallet that initiated the transaction (`tx.from`)
- `amount0`/`amount1` are signed — negative means tokens going in, positive means tokens coming out
- `price` is the post-trade price (currency1 per currency0), pre-computed from `sqrtPriceX96` and the token decimals — use directly for charts
- `blockTimestamp` is the on-chain block time in **unix seconds**; `timestamp` is the same value in **unix milliseconds** (both are block-derived, not server-derived)

#### `recent_swaps` — sent once on connect

```json
{
  "type": "recent_swaps",
  "data": [{ ... }, { ... }]
}
```

Contains the last 50 swap events from the indexer DB (chronological, oldest first). Same shape as `swap` data.

### Filtering Swaps by Address

To only receive swap events for a specific wallet, send a message after connecting:

```json
{ "filterAddress": "0xb4A520D855C21A449d1031727911BDE602FfA7DC" }
```

Pool state updates are always sent regardless of filter. To clear the filter:

```json
{ "filterAddress": null }
```

### REST Response Shape

`GET /pools/:poolId` returns:

```json
{
  "pool": { ... },
  "recentSwaps": [{ ... }, { ... }]
}
```

### React Hook Example

```tsx
import { useState, useEffect, useRef, useCallback } from "react";

interface PoolState {
  currency0Symbol: string;
  currency1Symbol: string;
  currency0Decimals: number;
  currency1Decimals: number;
  sqrtPriceX96: string;
  tick: number;
  protocolFee: number;
  lpFee: number;
  liquidity: string;
  feeGrowthGlobal0X128: string;
  feeGrowthGlobal1X128: string;
  reserve0: string;
  reserve1: string;
  blockNumber: string;
  updatedAt: number;
}

interface SwapEvent {
  poolId: string;
  sender: string;
  userAddress: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
  transactionHash: string;
  blockNumber: string;
  timestamp: number;
}

function usePoolStream(poolId: string, filterAddress?: string) {
  const [pool, setPool] = useState<PoolState | null>(null);
  const [swaps, setSwaps] = useState<SwapEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(
      `ws://localhost:8001/pools/${poolId}/ws`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      if (filterAddress) {
        ws.send(JSON.stringify({ filterAddress }));
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "pool_state":
          setPool(msg.data);
          break;
        case "swap":
          setSwaps((prev) => [...prev, msg.data]);
          break;
        case "recent_swaps":
          setSwaps(msg.data);
          break;
      }
    };

    return () => ws.close();
  }, [poolId, filterAddress]);

  return { pool, swaps };
}
```

Usage:

```tsx
const POOL_ID = "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

// All swaps
function GlobalSwapFeed() {
  const { pool, swaps } = usePoolStream(POOL_ID);
  // ...
}

// Only swaps for a specific wallet
function MySwapFeed({ address }: { address: string }) {
  const { pool, swaps } = usePoolStream(POOL_ID, address);
  // ...
}
```

All bigint values are serialized as strings. Parse them with `BigInt(value)` on the frontend.

### Candlestick Chart Integration

Use `GET /pools/:poolId/candles` to seed a chart with arbitrary history, then keep it live by appending the latest swap from the WebSocket stream into the trailing candle.

#### Endpoint

`GET /pools/:poolId/candles?resolution=<r>&from=<sec>&to=<sec>&limit=<n>`

| Param | Required | Description |
|---|---|---|
| `resolution` | yes | One of `1m`, `5m`, `15m`, `1h`, `4h`, `1d` |
| `from` | no | Lower bound (unix **seconds**, inclusive). Default: `to - bucketSeconds * limit` |
| `to` | no | Upper bound (unix **seconds**, exclusive). Default: now + one bucket (so the current in-progress candle is included) |
| `limit` | no | Max candles to return, oldest-first. Default 500, max 1000 |

#### Response

```json
{
  "resolution": "1m",
  "bucketSeconds": 60,
  "from": 1779814000,
  "to": 1779817600,
  "candles": [
    {
      "t": 1779814200,
      "open": 55098750.20,
      "high": 55100749.62,
      "low": 55098750.20,
      "close": 55099103.43,
      "volume0": 4.5e18,
      "volume1": 2.48e26,
      "n": 8
    }
  ]
}
```

- `t` is the bucket-start time in **unix seconds**
- `open`/`high`/`low`/`close` are floats in currency1-per-currency0 (e.g. VND per ETH)
- `volume0`/`volume1` are sums of `|amount0|` / `|amount1|` for the bucket, in raw token base units (float64 — exact up to ~9 × 10¹⁵, fine for charting)
- `n` is the swap count in the bucket
- `candles` is ordered oldest → newest

Candles are aggregated on-demand from the `swaps` table — any resolution and any historical depth work without precomputed tables.

#### Recommended frontend flow

1. **Seed:** call `/candles` to populate the chart with history.
2. **Tail:** open the WS, ignore `recent_swaps` (you already have it), and listen for `swap` events.
3. **On each `swap`:** compute its bucket as `bucketStart = Math.floor(swap.blockTimestamp / bucketSeconds) * bucketSeconds`. If it matches the last candle's `t`, update OHLC and add to volume. Otherwise push a new candle.

```tsx
import { useEffect, useRef, useState } from "react";

type Resolution = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume0: number;
  volume1: number;
  n: number;
}

interface SwapEvent {
  blockTimestamp: number;
  price: number;
  amount0: string;
  amount1: string;
}

const BUCKET_SECONDS: Record<Resolution, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

function applySwapToCandles(
  candles: Candle[],
  swap: SwapEvent,
  bucketSeconds: number
): Candle[] {
  const t = Math.floor(swap.blockTimestamp / bucketSeconds) * bucketSeconds;
  const vol0 = Math.abs(Number(BigInt(swap.amount0)));
  const vol1 = Math.abs(Number(BigInt(swap.amount1)));
  const last = candles[candles.length - 1];

  if (last && last.t === t) {
    const updated: Candle = {
      ...last,
      high: Math.max(last.high, swap.price),
      low: Math.min(last.low, swap.price),
      close: swap.price,
      volume0: last.volume0 + vol0,
      volume1: last.volume1 + vol1,
      n: last.n + 1,
    };
    return [...candles.slice(0, -1), updated];
  }

  const fresh: Candle = {
    t,
    open: swap.price,
    high: swap.price,
    low: swap.price,
    close: swap.price,
    volume0: vol0,
    volume1: vol1,
    n: 1,
  };
  return [...candles, fresh];
}

export function useCandles(
  poolId: string,
  resolution: Resolution,
  apiUrl: string,
  limit = 500
) {
  const bucketSeconds = BUCKET_SECONDS[resolution];
  const [candles, setCandles] = useState<Candle[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(
        `${apiUrl}/pools/${poolId}/candles?resolution=${resolution}&limit=${limit}`
      );
      const json = await res.json();
      if (cancelled) return;
      setCandles(json.candles);

      const ws = new WebSocket(
        `${apiUrl.replace(/^http/, "ws")}/pools/${poolId}/ws`
      );
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type !== "swap") return;
        setCandles((prev) =>
          applySwapToCandles(prev, msg.data as SwapEvent, bucketSeconds)
        );
      };
    })();

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [poolId, resolution, apiUrl, limit, bucketSeconds]);

  return candles;
}
```

Hand `candles` to any OHLC charting library (lightweight-charts, react-financial-charts, recharts, etc.).

## Delegate (EIP-7702 Gas Sponsorship)

The `/delegate` module lets a user delegate their EOA to a contract via [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) without paying gas. The user signs an authorization off-chain, POSTs it to the API, and the server's hot manager wallet sponsors the on-chain transaction.

### Endpoint

**POST** `/delegate/arbitrum-sepolia`

### Request Body

```json
{
  "authorization": {
    "address": "0x<contract to delegate to>",
    "chainId": 421614,
    "nonce": 0,
    "r": "0x...",
    "s": "0x...",
    "yParity": 0
  },
  "authority": "0x<user EOA address>"
}
```

| Field | Description |
|---|---|
| `authorization.address` | Contract address the EOA is delegating to |
| `authorization.chainId` | Chain ID (421614 for Arbitrum Sepolia) |
| `authorization.nonce` | Current nonce of the user's EOA |
| `authorization.r`, `s`, `yParity` | Signature components from `signAuthorization` |
| `authority` | The user's EOA address that signed the authorization |

### Response

**Success (200):**

```json
{
  "transactionHash": "0x..."
}
```

**Error (400):**

```json
{
  "error": "delegation transaction reverted"
}
```

### Frontend Integration (viem)

```ts
import { walletClient } from "./config"; // user's wallet client

const CONTRACT_ADDRESS = "0x<contract to delegate to>";

// 1. Sign the authorization (gasless — no tx sent)
const authorization = await walletClient.signAuthorization({
  contractAddress: CONTRACT_ADDRESS,
});

// 2. POST to the API — hot wallet sponsors the gas
const response = await fetch("http://localhost:8001/delegate/arbitrum-sepolia", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    authorization,
    authority: walletClient.account.address,
  }),
});

const result = await response.json();
console.log(result.transactionHash);
```

### Live Price Chart Integration

Each `pool_state` message contains `sqrtPriceX96`, `tick`, and `blockNumber`. You can accumulate these into a time series and render a live price chart.

#### Price Conversion

Convert `sqrtPriceX96` to a human-readable price:

```ts
function sqrtPriceX96ToPrice(
  sqrtPriceX96: string,
  decimals0: number,
  decimals1: number
): number {
  const sqrtPrice = Number(BigInt(sqrtPriceX96)) / Number(BigInt(2) ** BigInt(96));
  const rawPrice = sqrtPrice * sqrtPrice;
  const decimalAdjustment = 10 ** (decimals0 - decimals1);
  return rawPrice * decimalAdjustment;
}
```

#### Price History Hook

Accumulates price points from the WebSocket stream for charting:

```tsx
import { useState, useEffect, useRef } from "react";

interface PricePoint {
  price: number;
  tick: number;
  blockNumber: string;
  timestamp: number;
}

function usePriceHistory(poolId: string, maxPoints = 500) {
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [pool, setPool] = useState<PoolState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(
      `ws://localhost:8001/pools/${poolId}/ws`
    );
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type !== "pool_state") return;

      const data = msg.data;
      setPool(data);

      const price = sqrtPriceX96ToPrice(
        data.sqrtPriceX96,
        data.currency0Decimals,
        data.currency1Decimals
      );

      setHistory((prev) => {
        // Skip if price hasn't changed (avoids flat duplicates)
        if (prev.length > 0 && prev[prev.length - 1].price === price) {
          return prev;
        }
        const next = [...prev, {
          price,
          tick: data.tick,
          blockNumber: data.blockNumber,
          timestamp: data.updatedAt,
        }];
        // Keep bounded
        if (next.length > maxPoints) next.shift();
        return next;
      });
    };

    return () => ws.close();
  }, [poolId, maxPoints]);

  return { pool, history };
}
```

#### Minimal Chart Component

Using plain SVG (no chart library needed):

```tsx
function PriceChart({ history }: { history: PricePoint[] }) {
  if (history.length < 2) return <p>Collecting data...</p>;

  const width = 600;
  const height = 200;
  const padding = 10;

  const prices = history.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const points = history
    .map((p, i) => {
      const x = padding + (i / (history.length - 1)) * (width - padding * 2);
      const y = height - padding - ((p.price - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className="border rounded">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
```

Usage:

```tsx
const POOL_ID = "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

function LivePriceView() {
  const { pool, history } = usePriceHistory(POOL_ID);

  return (
    <div>
      <h2>{pool?.currency0Symbol}/{pool?.currency1Symbol}</h2>
      <p>
        Current price: {history.length > 0
          ? history[history.length - 1].price.toLocaleString(undefined, { maximumFractionDigits: 6 })
          : "Loading..."}
      </p>
      <PriceChart history={history} />
      <p>{history.length} data points</p>
    </div>
  );
}
```

Note: the chart only shows data from the moment the page loads. For historical charts, persist price snapshots on the backend (e.g. SQLite) and serve them via the REST endpoint.

## Sponsored Trade (Gas Sponsorship)

The `/sponsor/trade` endpoint lets a user execute a batched swap without paying gas. The user signs the batch of calls off-chain, POSTs them to the API, and the server's hot manager wallet submits the transaction on-chain.

This requires the user's EOA to have already been delegated to the `BatchCallAndSponsor` contract via the `/delegate/arbitrum-sepolia` endpoint.

### Endpoint

**POST** `/sponsor/trade`

### Request Body

```json
{
  "authority": "0x<user EOA address>",
  "calls": [
    { "to": "0x<token>", "value": "0", "data": "0x<approve calldata>" },
    { "to": "0x<permit2>", "value": "0", "data": "0x<permit2 approve calldata>" },
    { "to": "0x<router>", "value": "0", "data": "0x<swap calldata>" }
  ],
  "signature": "0x<ECDSA signature>"
}
```

| Field | Description |
|---|---|
| `authority` | The user's EOA address (delegated to `BatchCallAndSponsor`) |
| `calls` | Array of calls to batch-execute: ERC-20 approve, Permit2 approve, Universal Router swap |
| `calls[].to` | Target contract address |
| `calls[].value` | ETH value as a string (use `"0"` for token swaps) |
| `calls[].data` | ABI-encoded calldata for the target function |
| `signature` | ECDSA signature over the current nonce and calls (see signing section below) |

### Response

**Success (200):**

```json
{
  "transactionHash": "0x..."
}
```

**Error (400):**

```json
{
  "error": "sponsored trade transaction reverted"
}
```

### Signing the Batch

The `BatchCallAndSponsor` contract verifies the signature against a digest of:

```
keccak256(abi.encodePacked(nonce, calls[0].to, calls[0].value, calls[0].data, calls[1].to, ...))
```

Wrapped with EIP-191 (`\x19Ethereum Signed Message\n32` prefix).

The nonce is read from the contract and auto-increments after each execution, providing replay protection.

### Frontend Integration (viem)

```ts
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  encodeFunctionData,
  encodePacked,
  keccak256,
  type Address,
  parseUnits,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { V4Planner, Actions } from "@uniswap/v4-sdk";

// --- Constants ---

const CURRENCY0 = "0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a" as Address; // mETH
const CURRENCY1 = "0x46DEA9Be3165024CC358Fa24798458e62BFC1d57" as Address; // mVND
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const UNIVERSAL_ROUTER = "0xeFd1D4bD4cf1e86Da286BB4CB1B8BcED9C10BA47" as Address;
const BATCH_CALL_AND_SPONSOR = "0xBC88C078bf2e0ECeF6F235Df065E7600E95F27F5" as Address;

const POOL_KEY = {
  currency0: CURRENCY0,
  currency1: CURRENCY1,
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000" as Address,
};

const BATCH_CALL_AND_SPONSOR_ABI = [
  {
    inputs: [],
    name: "nonce",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const MAX_UINT256 = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
);

const PERMIT2_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  {
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

// --- Build the V4 swap input ---

function buildV4SwapInput(zeroForOne: boolean, amountIn: bigint): `0x${string}` {
  const inputCurrency = zeroForOne ? CURRENCY0 : CURRENCY1;
  const outputCurrency = zeroForOne ? CURRENCY1 : CURRENCY0;

  const planner = new V4Planner();
  planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
    {
      poolKey: POOL_KEY,
      zeroForOne,
      amountIn: amountIn.toString(),
      amountOutMinimum: "0",
      hookData: "0x",
    },
  ]);
  planner.addAction(Actions.SETTLE_ALL, [inputCurrency, MAX_UINT256.toString()]);
  planner.addAction(Actions.TAKE_ALL, [outputCurrency, "0"]);

  return planner.finalize() as `0x${string}`;
}

// --- Sponsored swap flow ---

async function sponsoredSwap(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  zeroForOne: boolean,
  amount: string,
  apiUrl: string
) {
  const account = walletClient.account!;
  const amountIn = parseUnits(amount, 18);
  const inputToken = zeroForOne ? CURRENCY0 : CURRENCY1;
  const v4SwapInput = buildV4SwapInput(zeroForOne, amountIn);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // 1. Build the calls array
  const calls = [
    {
      to: inputToken,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2, amountIn],
      }),
    },
    {
      to: PERMIT2,
      value: 0n,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [
          inputToken,
          UNIVERSAL_ROUTER,
          amountIn,
          Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        ],
      }),
    },
    {
      to: UNIVERSAL_ROUTER,
      value: 0n,
      data: encodeFunctionData({
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: ["0x10" as `0x${string}`, [v4SwapInput], deadline],
      }),
    },
  ];

  // 2. Read the current nonce from the user's delegated EOA
  const currentNonce = await publicClient.readContract({
    address: account.address,
    abi: BATCH_CALL_AND_SPONSOR_ABI,
    functionName: "nonce",
  });

  // 3. Build the digest: keccak256(abi.encodePacked(nonce, calls[0].to, calls[0].value, calls[0].data, ...))
  const packed = encodePacked(
    ["uint256", ...calls.flatMap(() => ["address", "uint256", "bytes"] as const)],
    [currentNonce, ...calls.flatMap((c) => [c.to, c.value, c.data])] as any
  );
  const digest = keccak256(packed);

  // 4. Sign the digest with EIP-191 personal sign
  const signature = await walletClient.signMessage({
    account,
    message: { raw: digest },
  });

  // 5. POST to the sponsor API
  const response = await fetch(`${apiUrl}/sponsor/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authority: account.address,
      calls: calls.map((c) => ({
        to: c.to,
        value: c.value.toString(),
        data: c.data,
      })),
      signature,
    }),
  });

  return response.json();
}
```

Usage:

```ts
// Sell ETH for VND (zeroForOne = true)
const result = await sponsoredSwap(walletClient, publicClient, true, "1.0", "http://localhost:8001");
console.log(result.transactionHash);

// Buy ETH with VND (zeroForOne = false)
const result = await sponsoredSwap(walletClient, publicClient, false, "55000", "http://localhost:8001");
console.log(result.transactionHash);
```

### Flow Summary

1. **One-time setup**: User delegates EOA to `BatchCallAndSponsor` via `POST /delegate/arbitrum-sepolia`
2. **Each trade**: User builds the calls array, reads the nonce from their delegated EOA, signs `keccak256(abi.encodePacked(nonce, ...calls))` with personal sign, then POSTs to `POST /sponsor/trade`
3. **Server**: Hot wallet calls `execute(calls, signature)` on the user's EOA, paying the gas. The contract verifies the signature matches the EOA owner and increments the nonce for replay protection.

## Claim Mock Tokens

The `/claim/mock-tokens` endpoint lets a user claim a faucet drop of mock ERC-20 tokens (mETH and/or mVND) to their own address. The user signs a canonical claim message with their EOA; the server verifies the signature, then the hot manager wallet transfers a fixed amount of each requested token to the signer.

Tokens are always sent to the signer of the message — there is no custom receiver field.

### Endpoint

**POST** `/claim/mock-tokens`

### Request Body

```json
{
  "requester": "0x<user EOA address>",
  "tokens": [
    "0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a",
    "0x46DEA9Be3165024CC358Fa24798458e62BFC1d57"
  ],
  "nonce": 1779814558367,
  "signature": "0x<EIP-191 signature>"
}
```

| Field | Description |
|---|---|
| `requester` | The user's EOA address. Tokens are sent here. Must match the signer recovered from `signature`. |
| `tokens` | Array of ERC-20 token addresses to claim. Each must be in the server's allowlist (mETH, mVND). |
| `nonce` | Unix timestamp in **milliseconds**. Server rejects if it drifts more than 5 minutes from server time. |
| `signature` | EIP-191 (`personal_sign`) signature over the canonical message (see below). |

### Response

**Success (200):**

```json
{
  "transfers": [
    {
      "token": "0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a",
      "amount": "0.1",
      "transactionHash": "0x..."
    },
    {
      "token": "0x46DEA9Be3165024CC358Fa24798458e62BFC1d57",
      "amount": "5000000",
      "transactionHash": "0x..."
    }
  ]
}
```

`amount` is in human units; the server applies the token's decimals when calling `transfer`. Transfers run sequentially; if one reverts, the prior ones are already on-chain.

**Error (400):**

```json
{ "error": "invalid signature" }
```

Other error messages include: `nonce expired or invalid`, `token <address> is not claimable`, `tokens array is empty`, `claim transfer for <address> reverted`.

### Claimable Tokens

| Symbol | Address | Amount per claim |
|---|---|---|
| mETH | `0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a` | 0.1 |
| mVND | `0x46DEA9Be3165024CC358Fa24798458e62BFC1d57` | 5,000,000 |

Amounts are defined in `src/config/claim.ts` and can be tuned without touching the route logic.

### Signing the Claim

The client must sign exactly this message via `personal_sign`. Addresses are **EIP-55 checksummed** and tokens are joined by a comma with no spaces:

```
zxstim-api claim mock-tokens
requester: 0xAbC...123
tokens: 0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a,0x46DEA9Be3165024CC358Fa24798458e62BFC1d57
nonce: 1779814558367
```

The server reconstructs this exact string from the request body (re-checksumming `requester` and each token), verifies the signature with viem's `verifyMessage`, and rejects if the recovered signer ≠ `requester`.

### Frontend Integration (viem)

```ts
import { getAddress, type Address } from "viem";
import { walletClient } from "./config"; // user's wallet client

const MOCK_ETH = "0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a" as Address;
const MOCK_VND = "0x46DEA9Be3165024CC358Fa24798458e62BFC1d57" as Address;

async function claimMockTokens(tokens: Address[], apiUrl: string) {
  const account = walletClient.account!;
  const requester = getAddress(account.address);
  const normalizedTokens = tokens.map(getAddress);
  const nonce = Date.now();

  // 1. Build the canonical message (must match server format exactly)
  const message = [
    "zxstim-api claim mock-tokens",
    `requester: ${requester}`,
    `tokens: ${normalizedTokens.join(",")}`,
    `nonce: ${nonce}`,
  ].join("\n");

  // 2. Sign with personal_sign (gasless — no tx sent)
  const signature = await walletClient.signMessage({
    account,
    message,
  });

  // 3. POST to the claim API
  const response = await fetch(`${apiUrl}/claim/mock-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requester,
      tokens: normalizedTokens,
      nonce,
      signature,
    }),
  });

  return response.json();
}
```

Usage:

```ts
// Claim both mock tokens in one request
const result = await claimMockTokens(
  [MOCK_ETH, MOCK_VND],
  "http://localhost:8001"
);
console.log(result.transfers);

// Or claim just one
const ethOnly = await claimMockTokens([MOCK_ETH], "http://localhost:8001");
```

### React Hook Example

```tsx
import { useState } from "react";
import { getAddress, type Address } from "viem";
import { useWalletClient } from "wagmi";

interface ClaimTransfer {
  token: Address;
  amount: string;
  transactionHash: string;
}

function useClaimMockTokens(apiUrl: string) {
  const { data: walletClient } = useWalletClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<ClaimTransfer[]>([]);

  const claim = async (tokens: Address[]) => {
    if (!walletClient) throw new Error("wallet not connected");
    setLoading(true);
    setError(null);

    try {
      const requester = getAddress(walletClient.account.address);
      const normalizedTokens = tokens.map(getAddress);
      const nonce = Date.now();

      const message = [
        "zxstim-api claim mock-tokens",
        `requester: ${requester}`,
        `tokens: ${normalizedTokens.join(",")}`,
        `nonce: ${nonce}`,
      ].join("\n");

      const signature = await walletClient.signMessage({ message });

      const res = await fetch(`${apiUrl}/claim/mock-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requester,
          tokens: normalizedTokens,
          nonce,
          signature,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "claim failed");

      setTransfers(json.transfers);
      return json.transfers as ClaimTransfer[];
    } catch (e) {
      setError(e instanceof Error ? e.message : "claim failed");
      throw e;
    } finally {
      setLoading(false);
    }
  };

  return { claim, loading, error, transfers };
}
```

### Flow Summary

1. **Client**: Builds the canonical claim message including `requester`, comma-joined checksum `tokens`, and a millisecond `nonce`, then signs it with `personal_sign` (no gas, no tx).
2. **Client → API**: POSTs `{ requester, tokens, nonce, signature }` to `/claim/mock-tokens`.
3. **Server**: Re-checksums the inputs, rebuilds the identical message, recovers the signer with `verifyMessage`, and rejects if it doesn't match `requester` or if the nonce is outside the ±5 min window or any token is not in the allowlist.
4. **Server**: Hot manager wallet calls `transfer(requester, amount)` on each requested ERC-20, waits for the receipt, and returns the list of transfers with their transaction hashes.

### Notes & Caveats

- **Replay window**: The 5-minute nonce check is best-effort. Within that window the same `(requester, tokens, nonce, signature)` tuple could be replayed — if you need strict one-shot semantics, store consumed nonces server-side.
- **No partial rollback**: If the second `transfer` reverts, the first one has already been mined. The error message identifies which token failed.
- **Decimals**: Both mock tokens use 18 decimals; the server's `parseUnits` call assumes that. Update `src/config/claim.ts` if a token with different decimals is added.

## Pools Integration Guide (Frontend)

Self-contained guide for integrating the `/pools` module — covers REST history, OHLCV candles, and the live WebSocket. Anything below is what the frontend needs; ignore the earlier "Pools WebSocket Integration" section, which is superseded by this one.

### Architecture in one paragraph

The server runs an in-process indexer that backfills every historical `Swap` event for the supported pool into a local SQLite database on boot, then keeps the DB live via a WebSocket subscription to the chain plus a 30-second HTTP catch-up poller (so dropped WS events get repaired automatically). All REST and WS endpoints in this section read from that DB. The frontend never talks to the chain directly.

### Base URLs

| | Local dev | Production |
|---|---|---|
| REST | `http://localhost:8001` | provided by ops |
| WS | `ws://localhost:8001` | swap `http://` → `ws://` (or `https://` → `wss://`) |

CORS is enabled with `origin: true` so any frontend origin works.

### Supported pool ID

```
0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257
```

The API is parameterised by `:poolId`, but only this one is currently indexed. Any other ID returns `404 { "error": "Pool not found" }`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/pools/:poolId` | Latest pool state + last 50 swaps |
| GET | `/pools/:poolId/candles` | OHLCV candles (any resolution, any depth) |
| WS  | `/pools/:poolId/ws`     | Live `pool_state` + `swap` stream |

### 1. `GET /pools/:poolId`

Returns the latest pool snapshot and the most recent 50 swaps, both from SQLite.

**Response 200**

```json
{
  "pool": {
    "currency0Symbol": "ETH",
    "currency1Symbol": "VND",
    "currency0Decimals": 18,
    "currency1Decimals": 18,
    "sqrtPriceX96": "588100859679867612338768403599633",
    "tick": 178255,
    "protocolFee": 0,
    "lpFee": 500,
    "liquidity": "74228532250072169377684025",
    "feeGrowthGlobal0X128": "346111096686892598082152625",
    "feeGrowthGlobal1X128": "23019849040645226698443971215162792",
    "reserve0": "9999968821516356479511",
    "reserve1": "550989227082318594375578085831",
    "blockNumber": "271312626",
    "updatedAt": 1779814558367
  },
  "recentSwaps": [ /* SwapEvent[], oldest-first */ ]
}
```

**Other statuses**

- `404 { error: "Pool not found" }` — wrong pool ID
- `503 { error: "Pool state not yet available" }` — server just booted and the indexer hasn't written a state snapshot yet. Retry after a few seconds.

All large integers are JSON strings. Parse with `BigInt(value)` on the frontend.

### 2. `GET /pools/:poolId/candles`

OHLCV candles aggregated on-demand from the indexed swaps. Any resolution and any historical depth work — there are no precomputed tables to fall behind.

**Query parameters**

| Name | Required | Description |
|---|---|---|
| `resolution` | yes | `1m` \| `5m` \| `15m` \| `1h` \| `4h` \| `1d` |
| `from` | no | Lower bound, **unix seconds**, inclusive. Default: `to − bucketSeconds × limit` |
| `to` | no | Upper bound, **unix seconds**, exclusive. Default: `now + bucketSeconds` (so the current in-progress candle is included) |
| `limit` | no | Max candles, oldest-first. Default 500, max 1000 |

**Response 200**

```json
{
  "resolution": "1m",
  "bucketSeconds": 60,
  "from": 1779814000,
  "to": 1779817600,
  "candles": [
    {
      "t": 1779814200,
      "open": 55098750.20,
      "high": 55100749.62,
      "low": 55098750.20,
      "close": 55099103.43,
      "volume0": 4500000000000000000,
      "volume1": 248000000000000000000000,
      "n": 8
    }
  ]
}
```

| Field | Notes |
|---|---|
| `t` | Bucket-start time, **unix seconds**. The bucket covers `[t, t + bucketSeconds)` |
| `open` / `high` / `low` / `close` | Floats, in currency1 per currency0 (e.g. VND per ETH) |
| `volume0` / `volume1` | Sum of `\|amount0\|` / `\|amount1\|` in the bucket, raw token base units. Float64 (exact up to ~9×10¹⁵ — fine for charting; for accounting-grade precision use raw swap events) |
| `n` | Swap count in the bucket |
| `candles` | Ordered oldest → newest |

Buckets with no swaps are **omitted** from the array (sparse). If the chart needs continuous time, fill gaps client-side by carrying `close` forward as `open=high=low=close` and `volume=0`.

**Error**

- `400 { error: "`from` must be less than `to`" }`

### 3. `WS /pools/:poolId/ws`

Bidirectional connection. The server sends typed JSON messages; the client can send a filter command.

#### Server → client messages

Every message is JSON with a `type` field.

**`pool_state`** — sent once on connect, then again whenever any tracked field changes on a new block. Same shape as `pool.{…}` from `GET /pools/:poolId`.

```json
{ "type": "pool_state", "data": { /* PoolState */ } }
```

**`recent_swaps`** — sent once on connect. Last 50 swaps from SQLite, oldest-first.

```json
{ "type": "recent_swaps", "data": [ /* SwapEvent[] */ ] }
```

**`swap`** — sent for each new swap as it's indexed.

```json
{
  "type": "swap",
  "data": {
    "poolId": "0x363251ac...",
    "sender": "0xeFd1D4...",
    "userAddress": "0xb4A520...",
    "amount0": "-1000000000000000000",
    "amount1": "55000000000000000000000",
    "sqrtPriceX96": "588100859679867612338768403599633",
    "liquidity": "74228532250072169377684025",
    "tick": 178255,
    "fee": 500,
    "price": 55107539.16,
    "transactionHash": "0x...",
    "blockNumber": "271312626",
    "blockTimestamp": 1779814558,
    "timestamp": 1779814558000
  }
}
```

| Field | Notes |
|---|---|
| `sender` | Contract that called the PoolManager (usually the Universal Router) |
| `userAddress` | Wallet that initiated the tx (`tx.from`). **Use this for per-user filtering.** |
| `amount0` / `amount1` | Signed strings. Negative = into pool, positive = out of pool |
| `price` | Post-trade price, currency1 per currency0. Pre-computed for charts |
| `blockTimestamp` | On-chain block time, **unix seconds** |
| `timestamp` | Same value, **unix milliseconds** (convenience) |

#### Client → server messages

**Filter swaps by user address** — only the filtered client's swap stream is narrowed; `pool_state` is unaffected.

```json
{ "filterAddress": "0xb4A520D855C21A449d1031727911BDE602FfA7DC" }
```

Clear the filter:

```json
{ "filterAddress": null }
```

The filter compares case-insensitively against `swap.data.userAddress`.

### Recommended frontend flows

#### Flow A — live swap feed (e.g. "recent trades" panel)

1. Open the WS.
2. Render `recent_swaps` on the initial frame.
3. Prepend each `swap` event to the list as it arrives.

#### Flow B — candlestick chart with live update

1. `GET /pools/:poolId/candles?resolution=1m&limit=500` → seed the chart.
2. Open the WS, ignore `recent_swaps` (you already have history), and listen for `swap`.
3. For each `swap`, compute its bucket from `blockTimestamp` and either update the last candle or push a new one. Same code, every resolution.

#### Flow C — pool stats dashboard ("current price", "liquidity", "24h volume")

1. `GET /pools/:poolId` for the snapshot.
2. Open the WS and replace local pool state on each `pool_state` message.
3. For 24h volume, prefer `/candles?resolution=1h&limit=24` summed client-side, or `?resolution=1d&limit=1`.

### Drop-in React examples

#### Live swap feed

```tsx
import { useEffect, useRef, useState } from "react";

interface SwapEvent {
  transactionHash: string;
  userAddress: string;
  amount0: string;
  amount1: string;
  price: number;
  blockTimestamp: number;
}

const POOL_ID =
  "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

export function useSwapFeed(apiUrl: string, filterAddress?: string) {
  const [swaps, setSwaps] = useState<SwapEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const wsUrl = apiUrl.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}/pools/${POOL_ID}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (filterAddress) {
        ws.send(JSON.stringify({ filterAddress }));
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "recent_swaps") {
        setSwaps(msg.data.slice().reverse()); // newest-first for the panel
      } else if (msg.type === "swap") {
        setSwaps((prev) => [msg.data, ...prev].slice(0, 100));
      }
    };

    return () => ws.close();
  }, [apiUrl, filterAddress]);

  return swaps;
}
```

#### Candlestick chart with live update

```tsx
import { useEffect, useRef, useState } from "react";

type Resolution = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume0: number;
  volume1: number;
  n: number;
}

interface SwapEvent {
  blockTimestamp: number;
  price: number;
  amount0: string;
  amount1: string;
}

const BUCKET_SECONDS: Record<Resolution, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

const POOL_ID =
  "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

function applySwap(
  candles: Candle[],
  swap: SwapEvent,
  bucketSeconds: number
): Candle[] {
  const t =
    Math.floor(swap.blockTimestamp / bucketSeconds) * bucketSeconds;
  const vol0 = Math.abs(Number(BigInt(swap.amount0)));
  const vol1 = Math.abs(Number(BigInt(swap.amount1)));
  const last = candles[candles.length - 1];

  if (last && last.t === t) {
    return [
      ...candles.slice(0, -1),
      {
        ...last,
        high: Math.max(last.high, swap.price),
        low: Math.min(last.low, swap.price),
        close: swap.price,
        volume0: last.volume0 + vol0,
        volume1: last.volume1 + vol1,
        n: last.n + 1,
      },
    ];
  }

  return [
    ...candles,
    {
      t,
      open: swap.price,
      high: swap.price,
      low: swap.price,
      close: swap.price,
      volume0: vol0,
      volume1: vol1,
      n: 1,
    },
  ];
}

export function useCandles(
  apiUrl: string,
  resolution: Resolution,
  limit = 500
) {
  const bucketSeconds = BUCKET_SECONDS[resolution];
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ready, setReady] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(
        `${apiUrl}/pools/${POOL_ID}/candles?resolution=${resolution}&limit=${limit}`
      );
      const json = await res.json();
      if (cancelled) return;
      setCandles(json.candles);
      setReady(true);

      const wsUrl = apiUrl.replace(/^http/, "ws");
      const ws = new WebSocket(`${wsUrl}/pools/${POOL_ID}/ws`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type !== "swap") return;
        setCandles((prev) =>
          applySwap(prev, msg.data as SwapEvent, bucketSeconds)
        );
      };
    })();

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [apiUrl, resolution, limit, bucketSeconds]);

  return { candles, ready };
}
```

Hand `candles` to any OHLC library (`lightweight-charts`, `react-financial-charts`, `recharts`, etc.).

#### Pool stats dashboard

```tsx
import { useEffect, useRef, useState } from "react";

interface PoolState {
  currency0Symbol: string;
  currency1Symbol: string;
  currency0Decimals: number;
  currency1Decimals: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  reserve0: string;
  reserve1: string;
  blockNumber: string;
  updatedAt: number;
}

const POOL_ID =
  "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

function priceFromSqrtX96(sqrt: string, d0: number, d1: number): number {
  const s = Number(BigInt(sqrt)) / Number(2n ** 96n);
  return s * s * 10 ** (d0 - d1);
}

export function usePoolStats(apiUrl: string) {
  const [pool, setPool] = useState<PoolState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(`${apiUrl}/pools/${POOL_ID}`);
      const json = await res.json();
      if (cancelled) return;
      if (json.pool) setPool(json.pool);

      const wsUrl = apiUrl.replace(/^http/, "ws");
      const ws = new WebSocket(`${wsUrl}/pools/${POOL_ID}/ws`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "pool_state") setPool(msg.data);
      };
    })();

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [apiUrl]);

  const price = pool
    ? priceFromSqrtX96(
        pool.sqrtPriceX96,
        pool.currency0Decimals,
        pool.currency1Decimals
      )
    : null;

  return { pool, price };
}
```

### Common gotchas

- **All large numbers are JSON strings.** `sqrtPriceX96`, `liquidity`, `amount0/1`, `reserve0/1`, `feeGrowth…`, `blockNumber` — wrap with `BigInt(...)` if you need integer math.
- **`price` is already decimal-adjusted.** It's currency1 per currency0 with token decimals baked in. Don't re-multiply by `10^(d0 - d1)`.
- **Two timestamps on swaps.** `blockTimestamp` is unix **seconds**, `timestamp` is unix **milliseconds**. Both are block-derived (not the time the server saw the event).
- **Bucket boundaries are wall-clock based**, computed as `floor(blockTimestamp / bucketSeconds) * bucketSeconds`. They don't shift with `from`. Two clients hitting the same resolution get bucket-aligned candles.
- **Sparse candles.** Empty buckets are omitted from the response — if continuous time is needed, fill gaps client-side.
- **WS reconnects.** No special handling on the server side. If the browser drops, just reopen the WS; you'll get fresh `pool_state` and `recent_swaps` on the new connect. For the candle hook, also re-`GET /candles` to fill any gap from when the WS was down.
- **`recentSwaps` is capped at 50.** For deeper history use `/candles` (chart use case) or, if you really need raw swaps further back, ask backend to expose a `/swaps?before=…&limit=…` endpoint — it isn't there yet.
- **Server may answer `503` briefly on boot.** The first `pool_state` row is written when the first block tick hits after startup. UIs should handle "loading" until that's available.

## Pools Polling Integration (Frontend) — replaces the WebSocket

This section supersedes the live-stream parts of the guide above. Instead of holding a `WS /pools/:poolId/ws` connection, the frontend polls a single REST endpoint, `GET /defi/pools/:poolId`, on a short interval (e.g. once per second). It returns exactly the data a fresh WS client receives on connect — current pool state plus the recent-swaps window — so the migration is a like-for-like swap with no loss of data.

The historical/REST endpoints are unchanged: keep using `GET /pools/:poolId/candles` and `GET /pools/:poolId/users/:address/swaps` exactly as before. **Only the WebSocket is being replaced.**

### Why polling here

The server-side indexer already refreshes pool state at most once per second, so the WebSocket never pushed faster than that. Polling at ~1s matches that cadence with no extra latency, removes all connection lifecycle code (reconnect, heartbeats, missed-event gaps), and is stateless. The `/defi` endpoint is served from an in-memory snapshot refreshed by one cron tick per second, so it costs no per-request database work no matter how many clients poll.

### Endpoint

`GET /defi/pools/:poolId`

| Query param | Required | Description |
|---|---|---|
| `filterAddress` | no | `0x…` (40 hex). Restricts `recentSwaps` to swaps where `userAddress` matches (case-insensitive). `poolState` is always returned in full. Omit for no filter. |

**Response 200**

```json
{
  "poolState": { /* same shape as the WS `pool_state` message `.data` */ },
  "recentSwaps": [ /* SwapEvent[], oldest-first — same as the WS `recent_swaps` `.data` */ ],
  "updatedAt": 1780125059005
}
```

- `updatedAt` is the server time (unix **ms**) the in-memory snapshot was last refreshed from SQLite — useful for a "last updated" indicator and for spotting a stalled feed. (`poolState.updatedAt` is separate: it's the indexer DB row's timestamp.)
- `recentSwaps` is capped at 50 and ordered oldest → newest, identical to the WS `recent_swaps` payload.

**Status codes**

| Status | Meaning | Frontend action |
|---|---|---|
| `200` | Fresh snapshot. Response carries an `ETag` header. | Render it; remember the `ETag`. |
| `304` | Unchanged since your `If-None-Match`. Empty body. | Keep current state; do nothing. |
| `404` | Wrong pool ID. | — |
| `400` | Malformed `filterAddress`. | Fix the address. |
| `503` | Booting; snapshot not ready yet. | Show "loading", keep polling. |

### Conditional requests (skip unchanged payloads)

Each `200` includes an `ETag`. Send it back as `If-None-Match` on the next poll; if nothing changed you get a `304` with an empty body and keep your current state. The ETag already accounts for `filterAddress`, so each filtered view caches independently.

```
GET /defi/pools/0x3632…4257
→ 200, ETag: "272150346:…:50:0x7bca…:1780124709000"

GET /defi/pools/0x3632…4257
If-None-Match: "272150346:…:50:0x7bca…:1780124709000"
→ 304 (empty body)
```

### Migration map

| WebSocket (old) | Polling (new) |
|---|---|
| Open `WS /pools/:poolId/ws` | `GET /defi/pools/:poolId` every ~1s |
| `pool_state` message `.data` | response `.poolState` |
| `recent_swaps` message `.data` | response `.recentSwaps` |
| live `swap` messages | diff `.recentSwaps` between polls (see below) |
| send `{ "filterAddress": "0x…" }` | `?filterAddress=0x…` query param |
| send `{ "filterAddress": null }` | omit the query param |
| `onopen` / `onclose` / reconnect | none — each poll is independent |
| `ws://` / `wss://` base URL | plain `http(s)://`, no protocol swap |

### Detecting new swaps

The WS pushed individual `swap` events. With polling, new swaps simply appear in `recentSwaps` on the next response. To turn the rolling window into an event stream (for a "recent trades" panel or candle updates), diff against what you've already seen using a per-swap key — `transactionHash` alone is **not** unique (a single tx can contain multiple swaps), so combine it with the amounts:

```ts
const swapKey = (s: SwapEvent) =>
  `${s.transactionHash}:${s.sqrtPriceX96}:${s.amount0}:${s.amount1}`;
```

### Drop-in React examples (polling)

These mirror the three hooks in the WebSocket guide above; the public API of each is unchanged, so call sites don't move. They share one small poller primitive.

#### Shared poller

```tsx
import { useEffect, useMemo, useRef, useState } from "react";

const POOL_ID =
  "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

interface PoolState {
  currency0Symbol: string;
  currency1Symbol: string;
  currency0Decimals: number;
  currency1Decimals: number;
  sqrtPriceX96: string;
  tick: number;
  protocolFee: number;
  lpFee: number;
  liquidity: string;
  feeGrowthGlobal0X128: string;
  feeGrowthGlobal1X128: string;
  reserve0: string;
  reserve1: string;
  blockNumber: string;
  updatedAt: number;
}

interface SwapEvent {
  poolId: string;
  sender: string;
  userAddress: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
  price: number;
  transactionHash: string;
  blockNumber: string;
  blockTimestamp: number;
  timestamp: number;
}

// Polls GET /defi/pools/:poolId on an interval, using ETag/If-None-Match so
// unchanged ticks return 304 and cost nothing. Chains setTimeout (not
// setInterval) so a slow request never overlaps the next.
export function usePoolSnapshot(
  apiUrl: string,
  opts: { filterAddress?: string; intervalMs?: number } = {}
) {
  const { filterAddress, intervalMs = 1000 } = opts;
  const [poolState, setPoolState] = useState<PoolState | null>(null);
  const [recentSwaps, setRecentSwaps] = useState<SwapEvent[]>([]);
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    etagRef.current = null; // reset when filter changes
    const qs = filterAddress ? `?filterAddress=${filterAddress}` : "";

    const tick = async () => {
      try {
        const res = await fetch(`${apiUrl}/defi/pools/${POOL_ID}${qs}`, {
          // Manage conditional requests ourselves rather than via the HTTP cache.
          cache: "no-store",
          headers: etagRef.current
            ? { "If-None-Match": etagRef.current }
            : {},
        });
        if (!cancelled && res.status === 200) {
          etagRef.current = res.headers.get("etag");
          const json = await res.json();
          setPoolState(json.poolState);
          setRecentSwaps(json.recentSwaps);
        }
        // 304 → unchanged, keep current state. 503 → not ready yet, just retry.
      } catch {
        // network blip — swallow and retry on the next tick
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiUrl, filterAddress, intervalMs]);

  return { poolState, recentSwaps };
}
```

#### Live swap feed — was `useSwapFeed`

```tsx
export function useSwapFeed(apiUrl: string, filterAddress?: string) {
  const { recentSwaps } = usePoolSnapshot(apiUrl, { filterAddress });
  // newest-first for the panel; the server keeps the window trimmed to 50.
  return useMemo(() => recentSwaps.slice().reverse(), [recentSwaps]);
}
```

#### Candlestick chart with live update — was `useCandles`

Seed from `/pools/:poolId/candles` exactly as before, then fold each *new* swap from the poll into the trailing candle. `applySwap` and `BUCKET_SECONDS` are unchanged from the WebSocket guide above.

```tsx
export function useCandles(
  apiUrl: string,
  resolution: Resolution,
  limit = 500
) {
  const bucketSeconds = BUCKET_SECONDS[resolution];
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ready, setReady] = useState(false);
  const { recentSwaps } = usePoolSnapshot(apiUrl);
  const seenRef = useRef<Set<string>>(new Set());

  // 1. Seed history (authoritative, from the DB).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(
        `${apiUrl}/pools/${POOL_ID}/candles?resolution=${resolution}&limit=${limit}`
      );
      const json = await res.json();
      if (cancelled) return;
      setCandles(json.candles);
      seenRef.current = new Set();
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, resolution, limit]);

  // 2. Apply only swaps we haven't folded in yet.
  useEffect(() => {
    if (!ready) return;
    const fresh = recentSwaps.filter(
      (s) =>
        !seenRef.current.has(
          `${s.transactionHash}:${s.sqrtPriceX96}:${s.amount0}:${s.amount1}`
        )
    );
    if (fresh.length === 0) return;
    setCandles((prev) => {
      let next = prev;
      for (const s of fresh) {
        seenRef.current.add(
          `${s.transactionHash}:${s.sqrtPriceX96}:${s.amount0}:${s.amount1}`
        );
        next = applySwap(next, s, bucketSeconds);
      }
      return next;
    });
  }, [recentSwaps, ready, bucketSeconds]);

  return { candles, ready };
}
```

#### Pool stats dashboard — was `usePoolStats`

```tsx
function priceFromSqrtX96(sqrt: string, d0: number, d1: number): number {
  const s = Number(BigInt(sqrt)) / Number(2n ** 96n);
  return s * s * 10 ** (d0 - d1);
}

export function usePoolStats(apiUrl: string) {
  const { poolState } = usePoolSnapshot(apiUrl);
  const price = poolState
    ? priceFromSqrtX96(
        poolState.sqrtPriceX96,
        poolState.currency0Decimals,
        poolState.currency1Decimals
      )
    : null;
  return { pool: poolState, price };
}
```

### Gotchas (polling-specific)

- **Pick a sane interval.** ~1s matches the server's refresh cadence; faster gains nothing because the snapshot only changes once per second. Add a little random jitter to the first tick if you have many clients, so they don't all hit the same wall-clock second.
- **Use the ETag.** Without `If-None-Match` every poll re-downloads the full snapshot; with it, unchanged seconds are a tiny `304`. The shared poller above does this for you.
- **One poller per page is enough.** Each hook instance opens its own poll loop. If a page uses several of these hooks, lift `usePoolSnapshot` to a context/provider and share its result, rather than running N independent loops. (The server cost is flat either way — this is just client-side tidiness.)
- **`filterAddress` filters the rolling 50-swap window**, mirroring the WS live filter — so a user with no trades among the pool's last 50 swaps returns an empty `recentSwaps`. For a user's *full* recent history regardless of pool volume, use `GET /pools/:poolId/users/:address/swaps` (DB-backed, paginated) instead.
- **Very high swap volume.** If more than 50 swaps land between two polls, the intermediate ones roll off the window before you see them. The seeded `/candles` data is still authoritative; for a busy pool, periodically re-seed from `/candles` rather than relying solely on the live diff. Not a concern at current testnet volumes.
- **No reconnect logic needed.** Each poll is independent and self-correcting — a missed or failed request just resolves on the next tick, with no gap to repair.
- **All large numbers are still JSON strings** and `price` is still decimal-adjusted — the same number/precision rules as the WebSocket section apply unchanged.
