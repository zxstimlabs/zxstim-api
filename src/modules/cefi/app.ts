// The CeFi HTTP app (api.cefi.vn). A separate Elysia app on its own port, not
// a module of the main app: @elysiajs/cors installs a global onRequest hook,
// and the DeFi modules' "reflect any origin, no credentials" CORS would answer
// CeFi's preflights and break (or, combined with credentials, weaken) cookie
// auth. Here CORS is credentialed and limited to the CeFi web origins.
//
// Routes:
//   GET  /health     200 while SQLite and Redis answer
//   POST /accounts   { pin } → 201 { accountNumber } + session cookie
//   *    /auth/*     Better Auth, allowlisted endpoints only (AUTH_PATHS)
//   /market/*, /me/* ETH/VND market data and the user's orders (market.ts)

import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { CEFI } from "../../config/cefi";
import {
  formatAccountNumber,
  generateAccountNumber,
  isValidPin,
  placeholderEmail,
} from "./account";
import type { CefiAuth } from "./auth";
import { marketRoutes } from "./market";
import type { CefiStorage } from "./storage";
import type { OrderbookRunner } from "../orderbook";

// The Better Auth endpoints the web app uses. Everything else, including all
// email/password-reset/social routes and the raw /sign-up/email, is 404 here;
// accounts are created only through POST /accounts.
export const AUTH_PATHS = new Set([
  "/sign-in/username",
  "/sign-out",
  "/get-session",
  "/change-password",
  "/list-sessions",
  "/revoke-session",
  "/revoke-other-sessions",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
]);

export interface CefiAppDeps {
  auth: CefiAuth;
  storage: CefiStorage;
  origins: string[];
  healthy: () => Promise<boolean>;
  // The ETH/VND market; null while it loads. Absent: the market routes 503.
  market?: () => OrderbookRunner | null;
}

export function createCefiApp({ auth, storage, origins, healthy, market = () => null }: CefiAppDeps) {
  return new Elysia({ name: "cefi" })
    // ETag is exposed so the web app can poll with If-None-Match.
    .use(cors({ origin: origins, credentials: true, maxAge: 600, exposeHeaders: ["etag", "retry-after"] }))
    .get("/health", async ({ set }) => {
      if (await healthy().catch(() => false)) return "ok";
      set.status = 503;
      return "unavailable";
    })
    .post(
      "/accounts",
      async ({ body, request, set }) => {
        // Browsers always send Origin on these requests; anything else isn't the web app.
        if (!origins.includes(request.headers.get("origin") ?? "")) {
          set.status = 403;
          return { error: "Origin not allowed" };
        }
        if (!isValidPin(body.pin)) {
          set.status = 400;
          return { error: `PIN must be exactly ${CEFI.pinLength} digits` };
        }
        const ip = request.headers.get("x-real-ip") ?? "unknown";
        const made = await storage.increment(`signup-ip:${ip}`, CEFI.signUpPerIp.windowSeconds);
        if (made > CEFI.signUpPerIp.max) {
          set.status = 429;
          set.headers["retry-after"] = String(CEFI.signUpPerIp.windowSeconds);
          return { error: "Too many new accounts from this network. Try again later." };
        }

        const accountNumber = generateAccountNumber();
        const res = await auth.api.signUpEmail({
          body: {
            email: placeholderEmail(accountNumber),
            password: body.pin,
            name: formatAccountNumber(accountNumber),
            username: accountNumber,
          },
          headers: request.headers,
          asResponse: true,
        });
        if (!res.ok) return res;

        // Keep Better Auth's session cookie; replace its body (which carries
        // the placeholder email) with just the account number.
        set.status = 201;
        for (const cookie of res.headers.getSetCookie()) {
          const prev = set.headers["set-cookie"];
          set.headers["set-cookie"] = prev ? [...(Array.isArray(prev) ? prev : [prev]), cookie] : cookie;
        }
        return { accountNumber: formatAccountNumber(accountNumber) };
      },
      { body: t.Object({ pin: t.String({ maxLength: 32 }) }) },
    )
    .all(
      "/auth/*",
      ({ request, params, set }) => {
        if (!AUTH_PATHS.has(`/${params["*"]}`)) {
          set.status = 404;
          return { error: "Not found" };
        }
        return auth.handler(request);
      },
      // Better Auth reads the body itself.
      { parse: "none" },
    )
    .use(marketRoutes({ auth, storage, origins, market }));
}
