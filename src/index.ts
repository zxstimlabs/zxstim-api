import { Elysia } from "elysia";
import { rpc } from "./modules/rpc";
import { pools } from "./modules/pools";

const app = new Elysia()
  .use(rpc)
  .use(pools)
  .get("/", () => "Hello Elysia")
  .listen(8001);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
