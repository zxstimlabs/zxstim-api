import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { PoolsService, SUPPORTED_POOL_ID } from "./service";

await PoolsService.init().catch((err) => {
  console.error("[pools] failed to initialize:", err);
  process.exit(1);
});

export const pools = new Elysia({ prefix: "/pools", name: "pools" })
  .use(cors({ origin: true, credentials: false }))
  .get("/:poolId", ({ params: { poolId }, set }) => {
    if (poolId !== SUPPORTED_POOL_ID) {
      set.status = 404;
      return { error: "Pool not found" };
    }
    const state = PoolsService.getState();
    if (!state) {
      set.status = 503;
      return { error: "Pool state not yet available" };
    }
    return {
      pool: state,
      recentSwaps: PoolsService.getRecentSwaps(),
    };
  })
  .ws("/:poolId/ws", {
    open(ws) {
      PoolsService.addConnection(ws);
    },
    message(ws, message) {
      try {
        const msg =
          typeof message === "string" ? JSON.parse(message) : message;
        if ("filterAddress" in msg) {
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
