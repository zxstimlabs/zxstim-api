import { Elysia } from "elysia";
import { rpc } from "./modules/rpc";
import { pools } from "./modules/pools";
import { defi } from "./modules/defi";
import { delegate } from "./modules/delegate";
import { sponsor } from "./modules/sponsor";
import { claim } from "./modules/claim";
import { sqlite } from "./lib/db";
import { startOrderbookBot } from "./modules/orderbook";

// Local dev: 127.0.0.1:8001. The container image sets HOST=0.0.0.0 and
// PORT=8000, and compose publishes that on the host's 127.0.0.1 only.
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8001);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`PORT is not a valid port: ${process.env.PORT}`);
}

const app = new Elysia()
  .use(rpc)
  .use(pools)
  .use(defi)
  .use(delegate)
  .use(sponsor)
  .use(claim)
  .get("/", () => "Hello Elysia")
  // For deploy checks and monitoring: 200 while the SQLite DB answers. It
  // does not wait for the indexer backfill (/pools returns 503 until then).
  .get("/health", ({ set }) => {
    try {
      sqlite.query("SELECT 1").get();
      return "ok";
    } catch {
      set.status = 503;
      return "database unavailable";
    }
  })
  .listen({ hostname: HOST, port: PORT });

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);

// ETH/VND order-book bot (Redis-backed, no routes). Runs in the background and
// never blocks or fails the HTTP server; disabled without REDIS_URL.
void startOrderbookBot().catch((err) => {
  console.error("[orderbook] failed to start:", err);
});
