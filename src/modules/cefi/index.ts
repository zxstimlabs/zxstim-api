// Start the CeFi API (api.cefi.vn) as a second listener in this process.
//
// Off unless CEFI_ENABLED=1 (local dev, the CI boot test). When enabled it
// fails fast on missing configuration, so a bad deploy fails its health check
// and rolls back instead of running half-configured.
//
// Env:
//   CEFI_ENABLED=1                 turn it on (set in deploy/compose.yaml)
//   CEFI_PORT                      listen port (image: 8001; local default 8002)
//   BETTER_AUTH_SECRET             ≥ 32 chars; signs cookies/tokens (GitHub env secret)
//   CEFI_PIN_PEPPER                ≥ 32 chars; never change it (GitHub env secret)
//   REDIS_URL                      sessions cache, rate limits, PIN lockout
//   CEFI_BASE_URL, CEFI_RP_ID      override for local dev (http://localhost:8002, localhost)
//   CEFI_EXTRA_ORIGINS             comma-separated extra web origins for local dev

import { CEFI } from "../../config/cefi";
import { db, sqlite } from "../../lib/db";
import { createCefiApp } from "./app";
import { createCefiAuth } from "./auth";
import { RedisStorage } from "./storage";

export function startCefi(hostname: string): void {
  if (process.env.CEFI_ENABLED !== "1") {
    console.log("[cefi] CEFI_ENABLED not set; CeFi API disabled");
    return;
  }

  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  const pinPepper = process.env.CEFI_PIN_PEPPER ?? "";
  const redisUrl = process.env.REDIS_URL ?? "";
  const missing = [
    secret.length < 32 && "BETTER_AUTH_SECRET (≥ 32 chars)",
    pinPepper.length < 32 && "CEFI_PIN_PEPPER (≥ 32 chars)",
    !redisUrl && "REDIS_URL",
  ].filter(Boolean);
  if (missing.length) throw new Error(`[cefi] CEFI_ENABLED=1 but missing: ${missing.join(", ")}`);

  const port = Number(process.env.CEFI_PORT ?? 8002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[cefi] CEFI_PORT is not a valid port: ${process.env.CEFI_PORT}`);
  }
  const extra = (process.env.CEFI_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origins = [...CEFI.origins, ...extra];

  const storage = new RedisStorage(redisUrl);
  const auth = createCefiAuth({
    db,
    storage,
    secret,
    pinPepper,
    baseURL: process.env.CEFI_BASE_URL ?? CEFI.baseURL,
    rpID: process.env.CEFI_RP_ID ?? CEFI.rpID,
    origins,
  });
  const app = createCefiApp({
    auth,
    storage,
    origins,
    healthy: async () => {
      sqlite.query("SELECT 1").get();
      await storage.get("health");
      return true;
    },
  }).listen({ hostname, port });

  console.log(`[cefi] CeFi API on http://${app.server?.hostname}:${app.server?.port}`);
}
