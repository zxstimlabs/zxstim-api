import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import {
  PoolsService,
  RESOLUTION_TO_SECONDS,
  SUPPORTED_POOL_ID,
  type CandleResolution,
} from "./service";

const MAX_CANDLES = 1000;
const DEFAULT_CANDLES = 500;

const candleQuerySchema = t.Object({
  resolution: t.Union([
    t.Literal("1m"),
    t.Literal("5m"),
    t.Literal("15m"),
    t.Literal("1h"),
    t.Literal("4h"),
    t.Literal("1d"),
  ]),
  from: t.Optional(t.Numeric({ minimum: 0 })),
  to: t.Optional(t.Numeric({ minimum: 0 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: MAX_CANDLES })),
});

export const pools = new Elysia({ prefix: "/pools", name: "pools" })
  .use(cors({ origin: true, credentials: false }))
  .get("/:poolId", async ({ params: { poolId }, set }) => {
    if (poolId !== SUPPORTED_POOL_ID) {
      set.status = 404;
      return { error: "Pool not found" };
    }
    const [state, recentSwaps] = await Promise.all([
      PoolsService.getState(),
      PoolsService.getRecentSwaps(),
    ]);
    if (!state) {
      set.status = 503;
      return { error: "Pool state not yet available" };
    }
    return { pool: state, recentSwaps };
  })
  .get(
    "/:poolId/candles",
    async ({ params: { poolId }, query, set }) => {
      if (poolId !== SUPPORTED_POOL_ID) {
        set.status = 404;
        return { error: "Pool not found" };
      }

      const resolution = query.resolution as CandleResolution;
      const bucketSeconds = RESOLUTION_TO_SECONDS[resolution];
      const now = Math.floor(Date.now() / 1000);
      const to = query.to ?? now + bucketSeconds;
      const from = query.from ?? to - bucketSeconds * (query.limit ?? DEFAULT_CANDLES);
      const limit = query.limit ?? DEFAULT_CANDLES;

      if (from >= to) {
        set.status = 400;
        return { error: "`from` must be less than `to`" };
      }

      const candles = await PoolsService.getCandles({
        resolution,
        from,
        to,
        limit,
      });
      return { resolution, bucketSeconds, from, to, candles };
    },
    { query: candleQuerySchema }
  )
  .ws("/:poolId/ws", {
    open(ws) {
      PoolsService.addConnection(ws).catch((err) => {
        console.error("[pools] addConnection error:", err);
      });
    },
    message(ws, message) {
      try {
        const msg =
          typeof message === "string" ? JSON.parse(message) : message;
        if (msg && typeof msg === "object" && "filterAddress" in msg) {
          PoolsService.setFilterAddress(ws, msg.filterAddress || null);
        }
      } catch {
        // ignore malformed messages
      }
    },
    close(ws) {
      PoolsService.removeConnection(ws);
    },
  });
