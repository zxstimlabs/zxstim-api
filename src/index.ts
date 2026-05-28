import { Elysia } from "elysia";
import { rpc } from "./modules/rpc";
import { pools } from "./modules/pools";
import { delegate } from "./modules/delegate";
import { sponsor } from "./modules/sponsor";
import { claim } from "./modules/claim";
import { PoolIndexer } from "./modules/pools/indexer";

const app = new Elysia()
  .use(rpc)
  .use(pools)
  .use(delegate)
  .use(sponsor)
  .use(claim)
  .get("/", () => "Hello Elysia")
  .listen(8001);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);

// Run the historical backfill, then start live indexing (WSS + http catch-up poller).
// Both run in the background so server boot stays responsive.
(async () => {
  try {
    await PoolIndexer.backfill();
    await PoolIndexer.startLive();
  } catch (err) {
    console.error("[pools-indexer] startup failed:", err);
  }
})();
