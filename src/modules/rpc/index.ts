import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { RpcService } from "./service";

const ARBITRUM_SEPOLIA_RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC_URL;

if (!ARBITRUM_SEPOLIA_RPC_URL) {
  throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
}

export const rpc = new Elysia({ prefix: "/rpc" })
  .use(cors({ origin: true, credentials: false }))
  .all("/arbitrum-sepolia", ({ request }) =>
    RpcService.proxy(request, ARBITRUM_SEPOLIA_RPC_URL)
  );
