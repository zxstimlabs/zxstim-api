import { Elysia } from "elysia";
import { rpc } from "./modules/rpc";
import { pools } from "./modules/pools";
import { delegate } from "./modules/delegate";
import { sponsor } from "./modules/sponsor";

const app = new Elysia()
  .use(rpc)
  .use(pools)
  .use(delegate)
  .use(sponsor)
  .get("/", () => "Hello Elysia")
  .listen(8001);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
