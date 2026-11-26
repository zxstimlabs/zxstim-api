// Market routes of the CeFi API: public ETH/VND market data, and the signed-in
// user's balances and orders. The market itself (book, bot, accounts,
// settlement) is src/modules/orderbook; these routes parse, authorize, apply
// and render. A placed or cancelled order is in the CeFi DB before the
// response (the market writes each engine call synchronously).
//
//   GET    /market/ETH-VND             ticker, depth, recent trades (ETag)
//   GET    /market/ETH-VND/candles     ?resolution=1m|5m|15m|1h|4h|1d&limit=1..1000
//   GET    /me/account                 balances, open orders, last 100 closed orders and fills (ETag)
//   GET    /me/orders                  closed orders, newest first: ?before=<id>&limit=1..200 → { orders, next }
//   GET    /me/trades                  fills, newest first: ?before=<id>&limit=1..200 → { trades, next }
//   POST   /me/orders                  { side, type, price?, quantity } → 201 { order }
//   DELETE /me/orders/:id              → { order }
//   DELETE /me/orders                  cancel all → { cancelled }
//
// Amounts are JSON numbers in human units (VND, ETH); requests may send them
// as strings too. Errors are { error, code }. The GETs answer 304 to a
// matching If-None-Match, so the web app can poll them every second.

import { Elysia, t } from "elysia";
import {
  ORDERBOOK_MARKET,
  RESOLUTIONS,
  USERS,
  type Resolution,
} from "../../config/orderbook";
import type { OrderbookRunner } from "../orderbook";
import { fillView, orderView, type PlaceOrder } from "../orderbook/market";
import type { CefiAuth } from "./auth";
import type { CefiStorage } from "./storage";

export interface MarketRoutesDeps {
  auth: CefiAuth;
  storage: CefiStorage;
  origins: string[];
  // The running market; null while it loads (or if it's off).
  market: () => OrderbookRunner | null;
}

const err = (code: string, error: string) => ({ error, code });

// ?limit for the history pages: 1–200, default 50; null if invalid.
function pageLimit(v: string | undefined): number | null {
  if (v === undefined) return 50;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : null;
}

// A decimal amount ("0.05", 0.05, "50000000") in base units with `decimals`
// places, exactly (no floats); null if it isn't one.
export function toUnits(v: unknown, decimals: number): bigint | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) return null;
  return BigInt(m[1]! + frac.padEnd(decimals, "0"));
}

export function marketRoutes({ auth, storage, origins, market }: MarketRoutesDeps) {
  const sessionUser = async (headers: Headers) => (await auth.api.getSession({ headers }))?.user.id ?? null;

  // Shared gate for the signed-in routes. Returns the user and market, or the
  // error to send (with set.status already set).
  async function gate(
    request: Request,
    set: { status?: number | string; headers: Record<string, string | number> },
    mutation: boolean,
  ) {
    // Browsers always send Origin on these requests; anything else isn't the web app.
    if (mutation && !origins.includes(request.headers.get("origin") ?? "")) {
      set.status = 403;
      return { error: err("forbidden_origin", "Origin not allowed") };
    }
    const userId = await sessionUser(request.headers);
    if (!userId) {
      set.status = 401;
      return { error: err("unauthenticated", "Sign in first") };
    }
    const runner = market();
    if (!runner || !runner.market.healthy) {
      set.status = 503;
      set.headers["retry-after"] = "5";
      return { error: err("market_unavailable", "The market is unavailable, try again shortly") };
    }
    if (mutation) {
      const n = await storage.increment(`market-actions:${userId}`, 60);
      if (n > USERS.actionsPerMinute) {
        set.status = 429;
        set.headers["retry-after"] = "60";
        return { error: err("rate_limited", "Too many orders, slow down") };
      }
    }
    return { userId, runner };
  }

  return new Elysia({ name: "cefi-market" })
    .get("/market/:market", ({ params, headers, set }) => {
      if (params.market !== ORDERBOOK_MARKET) {
        set.status = 404;
        return err("unknown_market", "Unknown market");
      }
      const runner = market();
      if (!runner) {
        set.status = 503;
        return err("market_unavailable", "The market is starting, try again shortly");
      }
      const { etag, body } = runner.market.publicSnapshot();
      set.headers["etag"] = etag;
      set.headers["cache-control"] = "no-cache";
      if (headers["if-none-match"] === etag) {
        set.status = 304;
        return;
      }
      set.headers["content-type"] = "application/json; charset=utf-8";
      return body;
    })
    .get(
      "/market/:market/candles",
      ({ params, query, set }) => {
        if (params.market !== ORDERBOOK_MARKET) {
          set.status = 404;
          return err("unknown_market", "Unknown market");
        }
        const resolution = (query.resolution ?? "15m") as Resolution;
        if (!RESOLUTIONS.includes(resolution)) {
          set.status = 400;
          return err("invalid_resolution", `resolution must be one of ${RESOLUTIONS.join(", ")}`);
        }
        const limit = query.limit === undefined ? 500 : Number(query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          set.status = 400;
          return err("invalid_limit", "limit must be 1–1000");
        }
        const runner = market();
        if (!runner) {
          set.status = 503;
          return err("market_unavailable", "The market is starting, try again shortly");
        }
        set.headers["cache-control"] = "no-cache";
        return { market: ORDERBOOK_MARKET, resolution, candles: runner.market.candlesFor(resolution, limit) };
      },
      { query: t.Object({ resolution: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
    )
    .get("/me/account", async ({ request, headers, set }) => {
      const g = await gate(request, set, false);
      if ("error" in g) return g.error;
      const etag = g.runner.market.accountEtag(g.userId);
      set.headers["etag"] = etag;
      set.headers["cache-control"] = "no-cache, private";
      if (headers["if-none-match"] === etag) {
        set.status = 304;
        return;
      }
      return { market: ORDERBOOK_MARKET, ...g.runner.market.account(g.userId) };
    })
    .get(
      "/me/orders",
      async ({ request, query, set }) => {
        const g = await gate(request, set, false);
        if ("error" in g) return g.error;
        const limit = pageLimit(query.limit);
        const before = query.before === undefined ? undefined : (/^u(\d{1,15})$/.exec(query.before)?.[1] ?? null);
        if (limit === null || before === null) {
          set.status = 400;
          return err("invalid_page", "limit must be 1–200; before an order id (u<n>)");
        }
        const rows = g.runner.market.db.orderHistory(g.userId, limit, before === undefined ? undefined : Number(before));
        return { orders: rows.map(orderView), next: rows.length === limit ? rows[rows.length - 1]!.id : null };
      },
      { query: t.Object({ before: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
    )
    .get(
      "/me/trades",
      async ({ request, query, set }) => {
        const g = await gate(request, set, false);
        if ("error" in g) return g.error;
        const limit = pageLimit(query.limit);
        const m = query.before === undefined ? undefined : /^(\d{1,15})-(maker|taker)$/.exec(query.before);
        if (limit === null || m === null) {
          set.status = 400;
          return err("invalid_page", "limit must be 1–200; before a trade id (<seq>-<role>)");
        }
        const before = m ? { seq: Number(m[1]), role: m[2] as "maker" | "taker" } : undefined;
        const rows = g.runner.market.db.fills(g.userId, limit, before);
        const trades = rows.map(fillView);
        return { trades, next: rows.length === limit ? trades[trades.length - 1]!.id : null };
      },
      { query: t.Object({ before: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
    )
    .post("/me/orders", async ({ request, body, set }) => {
      const g = await gate(request, set, true);
      if ("error" in g) return g.error;
      const b = (body ?? {}) as Record<string, unknown>;
      if (b.side !== "buy" && b.side !== "sell") {
        set.status = 400;
        return err("invalid_side", 'side must be "buy" or "sell"');
      }
      if (b.type !== "limit" && b.type !== "market") {
        set.status = 400;
        return err("invalid_type", 'type must be "limit" or "market"');
      }
      const quantity = toUnits(b.quantity, 4);
      if (quantity === null) {
        set.status = 400;
        return err("invalid_quantity", "quantity must be an ETH amount with at most 4 decimals");
      }
      const order: PlaceOrder = { side: b.side, type: b.type, quantity };
      if (b.type === "limit") {
        const price = toUnits(b.price, 2);
        if (price === null) {
          set.status = 400;
          return err("invalid_price", "price must be a whole number of VND");
        }
        order.price = price;
      }
      const result = g.runner.market.placeOrder(g.userId, order);
      if (!result.ok) {
        set.status = result.status;
        return err(result.code, result.error);
      }
      set.status = 201;
      return { order: result.value };
    })
    .delete("/me/orders/:id", async ({ request, params, set }) => {
      const g = await gate(request, set, true);
      if ("error" in g) return g.error;
      const result = g.runner.market.cancelOrder(g.userId, params.id);
      if (!result.ok) {
        set.status = result.status;
        return err(result.code, result.error);
      }
      return { order: result.value };
    })
    .delete("/me/orders", async ({ request, set }) => {
      const g = await gate(request, set, true);
      if ("error" in g) return g.error;
      const cancelled = g.runner.market.cancelAll(g.userId);
      return { cancelled };
    });
}
