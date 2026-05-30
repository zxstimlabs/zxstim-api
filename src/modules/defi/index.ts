import { Elysia, t } from "elysia";
import { cron } from "@elysia/cron";
import { cors } from "@elysiajs/cors";
import { PoolsService, SUPPORTED_POOL_ID } from "../pools/service";
import type { PoolStateData, SwapEventData } from "../pools/types";

const addressPattern = /^0x[a-fA-F0-9]{40}$/;

// Polling-friendly mirror of the pools WebSocket. `GET /defi/pools/:poolId`
// returns the same data a fresh WS client receives on connect — the current
// pool state plus the recent-swaps window.
//
// A single cron reads SQLite once per second and caches the result in memory;
// every request returns that cached value. So DB load is fixed at one read
// cycle per second regardless of how many clients poll — it does not scale with
// the number of clients.
//
// Frontend integration:
//   - Poll this (e.g. every 1s). `poolState` maps to the WS `pool_state`
//     message data; `recentSwaps` maps to the WS `recent_swaps` data
//     (oldest → newest, like the WS connect snapshot).
//   - Send the previous response's ETag back as `If-None-Match` to get a 304
//     (empty body) on unchanged ticks.
//   - Detect new swaps by diffing `recentSwaps` against what you've rendered
//     (e.g. by `transactionHash`).
//   - Pass `?filterAddress=0x…` to restrict `recentSwaps` to a single user,
//     mirroring the WS `{ filterAddress }` message. `poolState` is pool-global
//     and always returned in full.

interface PoolSnapshot {
  poolState: PoolStateData | null;
  recentSwaps: SwapEventData[];
  etag: string;
  updatedAt: number;
}

let snapshot: PoolSnapshot = {
  poolState: null,
  recentSwaps: [],
  etag: '"0"',
  updatedAt: 0,
};

// Deterministic ETag from the snapshot's content, so unchanged seconds keep the
// same value and the route can answer 304.
function computeEtag(
  poolState: PoolStateData | null,
  recentSwaps: SwapEventData[]
): string {
  if (!poolState) return '"0"';
  const last = recentSwaps[recentSwaps.length - 1];
  const sig = [
    poolState.blockNumber,
    poolState.sqrtPriceX96,
    poolState.tick,
    poolState.liquidity,
    poolState.reserve0,
    poolState.reserve1,
    recentSwaps.length,
    last?.transactionHash ?? "",
    last?.timestamp ?? 0,
  ].join(":");
  return `"${sig}"`;
}

// Fold a normalized filterAddress into the snapshot's ETag so each filtered view
// gets its own value. The base ETag already changes whenever the underlying
// snapshot does, so this stays correct: a 304 is only ever returned when both
// the snapshot and the filter are unchanged.
function etagWithFilter(base: string, filter: string | null): string {
  if (!filter) return base;
  return `${base.slice(0, -1)}:${filter}"`;
}

// Read the current pool state + recent swaps from SQLite (via the pools service)
// and replace the cached snapshot. Runs once per second from the cron below.
let refreshing = false;
async function refreshSnapshot(): Promise<void> {
  // Skip a tick if the previous read is still running, so a slow DB read never
  // stacks overlapping queries.
  if (refreshing) return;
  refreshing = true;
  try {
    const [poolState, recentSwaps] = await Promise.all([
      PoolsService.getState(),
      PoolsService.getRecentSwaps(),
    ]);
    snapshot = {
      poolState,
      recentSwaps,
      etag: computeEtag(poolState, recentSwaps),
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.error("[defi] snapshot refresh error:", err);
  } finally {
    refreshing = false;
  }
}

// Warm the cache once at boot so the first poll right after startup has data,
// rather than waiting up to a second for the first cron tick.
void refreshSnapshot();

export const defi = new Elysia({ prefix: "/defi", name: "defi" })
  .use(cors({ origin: true, credentials: false }))
  .use(
    cron({
      name: "defi-pools-snapshot",
      pattern: "* * * * * *",
      run() {
        void refreshSnapshot();
      },
    })
  )
  .get(
    "/pools/:poolId",
    ({ params: { poolId }, query, set, headers }) => {
      if (poolId !== SUPPORTED_POOL_ID) {
        set.status = 404;
        return { error: "Pool not found" };
      }

      // Empty/missing means no filter (matches the WS `msg.filterAddress || null`
      // leniency); a present-but-malformed address is a 400.
      let filterAddress: string | null = null;
      if (query.filterAddress) {
        if (!addressPattern.test(query.filterAddress)) {
          set.status = 400;
          return { error: "Invalid filterAddress" };
        }
        filterAddress = query.filterAddress.toLowerCase();
      }

      if (!snapshot.poolState) {
        set.status = 503;
        return { error: "Pool state not yet available" };
      }

      const recentSwaps = filterAddress
        ? snapshot.recentSwaps.filter(
            (s) => s.userAddress.toLowerCase() === filterAddress
          )
        : snapshot.recentSwaps;
      const etag = etagWithFilter(snapshot.etag, filterAddress);

      if (headers["if-none-match"] === etag) {
        set.status = 304;
        return;
      }

      set.headers["etag"] = etag;
      set.headers["cache-control"] = "no-cache";
      return {
        poolState: snapshot.poolState,
        recentSwaps,
        updatedAt: snapshot.updatedAt,
      };
    },
    { query: t.Object({ filterAddress: t.Optional(t.String()) }) }
  );
