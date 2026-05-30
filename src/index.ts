import { Elysia } from "elysia";
import { rpc } from "./modules/rpc";
import { pools } from "./modules/pools";
import { defi } from "./modules/defi";
import { delegate } from "./modules/delegate";
import { sponsor } from "./modules/sponsor";
import { claim } from "./modules/claim";

const app = new Elysia()
  .use(rpc)
  .use(pools)
  .use(defi)
  .use(delegate)
  .use(sponsor)
  .use(claim)
  .get("/", () => "Hello Elysia")
  .listen({ hostname: "127.0.0.1", port: 8001 });

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
