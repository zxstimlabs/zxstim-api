// The CeFi market routes end to end, in process: real Better Auth + Elysia
// app, in-memory SQLite and storage, and a market runner on an in-memory store.

import { describe, expect, test } from "bun:test";
import { openCefiDb } from "../../modules/cefi/db";
import { CEFI } from "../../config/cefi";
import { USERS } from "../../config/orderbook";
import { createCefiApp } from "../../modules/cefi/app";
import { createCefiAuth } from "../../modules/cefi/auth";
import { toUnits } from "../../modules/cefi/market";
import { MemoryStorage } from "../../modules/cefi/storage";
import { loadRunner, type OrderbookRunner } from "../../modules/orderbook";
import { SqliteMarketDb } from "../../modules/orderbook/market-db";
import { mulberry32 } from "../matching-engine/helpers";

const ORIGIN = "https://cefi.vn";
let ipSeq = 0;

async function setup(opts: { marketReady?: boolean } = {}) {
  const { sqlite, db } = openCefiDb(":memory:");
  const storage = new MemoryStorage();
  const origins = [...CEFI.origins];
  const auth = createCefiAuth({
    db,
    storage,
    secret: "test-secret-test-secret-test-secret-0000",
    pinPepper: "test-pepper-test-pepper-test-pepper-0000",
    baseURL: CEFI.baseURL,
    rpID: CEFI.rpID,
    origins,
  });
  const runner: OrderbookRunner | null = opts.marketReady === false ? null : loadRunner(new SqliteMarketDb(sqlite), mulberry32(1));
  for (let i = 0; i < 200 && runner; i++) runner.tick(); // some trades
  const app = createCefiApp({ auth, storage, origins, market: () => runner, healthy: async () => true });

  const client = (ip = `198.51.100.${++ipSeq}`) => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const h = new Headers({ origin: ORIGIN, "x-real-ip": ip, ...headers });
      if (body !== undefined) h.set("content-type", "application/json");
      if (jar.size) h.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await app.handle(
        new Request(`${CEFI.baseURL}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      );
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const [k, ...v] = pair!.split("=");
        jar.set(k!, v.join("="));
      }
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, json };
    };
    return { call };
  };
  const signedIn = async () => {
    const c = client();
    expect((await c.call("POST", "/accounts", { pin: "246810" })).status).toBe(201);
    return c;
  };
  return { client, signedIn, runner, sqlite };
}

describe("public market data", () => {
  test("snapshot: ticker, depth and trades, with an ETag and 304s", async () => {
    const { client } = await setup();
    const c = client();
    const r = await c.call("GET", "/market/ETH-VND");
    expect(r.status).toBe(200);
    expect(r.json.market).toBe("ETH-VND");
    expect(r.json.ticker.last).toBeGreaterThan(0);
    expect(r.json.depth.bids.length).toBeGreaterThan(0);
    expect(r.json.trades.length).toBeGreaterThan(0);
    const etag = r.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    expect(r.headers.get("access-control-expose-headers")).toContain("etag");
    expect((await c.call("GET", "/market/ETH-VND", undefined, { "if-none-match": etag })).status).toBe(304);
    expect((await c.call("GET", "/market/BTC-VND")).status).toBe(404);
  });

  test("candles: validated resolution and limit", async () => {
    const { client } = await setup();
    const c = client();
    const r = await c.call("GET", "/market/ETH-VND/candles?resolution=1m&limit=10");
    expect(r.status).toBe(200);
    expect(r.json.resolution).toBe("1m");
    expect(r.json.candles.length).toBeGreaterThan(0);
    expect(r.json.candles[0]).toEqual({
      t: expect.any(Number), open: expect.any(Number), high: expect.any(Number),
      low: expect.any(Number), close: expect.any(Number), volume: expect.any(Number),
    });
    expect((await c.call("GET", "/market/ETH-VND/candles")).json.resolution).toBe("15m");
    expect((await c.call("GET", "/market/ETH-VND/candles?resolution=2m")).status).toBe(400);
    expect((await c.call("GET", "/market/ETH-VND/candles?limit=0")).status).toBe(400);
    expect((await c.call("GET", "/market/ETH-VND/candles?limit=abc")).status).toBe(400);
  });

  test("503 while the market is loading", async () => {
    const { client, signedIn } = await setup({ marketReady: false });
    expect((await client().call("GET", "/market/ETH-VND")).status).toBe(503);
    expect((await client().call("GET", "/market/ETH-VND/candles")).status).toBe(503);
    const c = await signedIn();
    const r = await c.call("POST", "/me/orders", { side: "buy", type: "market", quantity: "0.01" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("market_unavailable");
  });
});

describe("signed-in trading", () => {
  test("account starts with the grant; place, see, cancel a limit order", async () => {
    const { signedIn, runner } = await setup();
    const c = await signedIn();
    const acct = await c.call("GET", "/me/account");
    expect(acct.status).toBe(200);
    expect(acct.json.balances).toEqual({
      vnd: { available: USERS.startVnd, locked: 0 },
      eth: { available: USERS.startEth, locked: 0 },
    });
    expect(acct.json.openOrders).toEqual([]);
    const etag = acct.headers.get("etag")!;
    expect((await c.call("GET", "/me/account", undefined, { "if-none-match": etag })).status).toBe(304);

    const bid = runner!.bot.engine.snapshot().bids[0]!.price / 100n;
    const price = String(bid - 500_000n);
    const placed = await c.call("POST", "/me/orders", { side: "buy", type: "limit", price, quantity: "0.05" });
    expect(placed.status).toBe(201);
    expect(placed.json.order).toMatchObject({ side: "buy", type: "limit", price: Number(price), quantity: 0.05, status: "open" });

    const after = await c.call("GET", "/me/account", undefined, { "if-none-match": etag });
    expect(after.status).toBe(200);
    expect(after.json.openOrders).toHaveLength(1);
    expect(after.json.balances.vnd.locked).toBe((Number(price) * 5) / 100);
    expect(after.json.balances.vnd.available).toBe(USERS.startVnd - (Number(price) * 5) / 100);

    const id = placed.json.order.id;
    const cancelled = await c.call("DELETE", `/me/orders/${id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.order.status).toBe("cancelled");
    expect((await c.call("DELETE", `/me/orders/${id}`)).status).toBe(404);
    const final = await c.call("GET", "/me/account");
    expect(final.json.openOrders).toEqual([]);
    expect(final.json.orderHistory[0]).toMatchObject({ id, status: "cancelled" });
    expect(final.json.balances.vnd).toEqual({ available: USERS.startVnd, locked: 0 });
  });

  test("a market buy fills, shows up as trades, and is in the DB before the response", async () => {
    const { signedIn, sqlite } = await setup();
    const c = await signedIn();
    const r = await c.call("POST", "/me/orders", { side: "buy", type: "market", quantity: 0.05 });
    expect(r.status).toBe(201);
    expect(r.json.order).toMatchObject({ status: "filled", filled: 0.05, price: null });
    expect(r.json.order.avgPrice).toBeGreaterThan(0);
    const acct = await c.call("GET", "/me/account");
    expect(acct.json.balances.eth.available).toBeCloseTo(USERS.startEth + 0.05, 10);
    expect(acct.json.trades.length).toBeGreaterThan(0);
    expect(acct.json.trades[0]).toMatchObject({ side: "buy", role: "taker" });
    const saved = sqlite.query("SELECT status, filled FROM cefi_order").all();
    expect(saved).toEqual([{ status: "filled", filled: 500 }]);
  });

  test("cancel all", async () => {
    const { signedIn, runner } = await setup();
    const c = await signedIn();
    const bid = runner!.bot.engine.snapshot().bids[0]!.price / 100n;
    for (let i = 1; i <= 3; i++) {
      expect((await c.call("POST", "/me/orders", { side: "buy", type: "limit", price: String(bid - 1_000_000n * BigInt(i)), quantity: "0.01" })).status).toBe(201);
    }
    const r = await c.call("DELETE", "/me/orders");
    expect(r.json).toEqual({ cancelled: 3 });
    expect((await c.call("GET", "/me/account")).json.openOrders).toEqual([]);
  });

  test("bad input → 400 with a code; business rules → 409", async () => {
    const { signedIn, runner } = await setup();
    const c = await signedIn();
    const post = (body: unknown) => c.call("POST", "/me/orders", body);
    expect((await post({ side: "hold", type: "limit", price: "1", quantity: "1" })).json.code).toBe("invalid_side");
    expect((await post({ side: "buy", type: "stop", quantity: "1" })).json.code).toBe("invalid_type");
    expect((await post({ side: "buy", type: "market", quantity: "0.00001" })).json.code).toBe("invalid_quantity");
    expect((await post({ side: "buy", type: "market", quantity: "-1" })).json.code).toBe("invalid_quantity");
    expect((await post({ side: "buy", type: "limit", quantity: "1" })).json.code).toBe("invalid_price");
    expect((await post({ side: "buy", type: "limit", price: "50000000.5", quantity: "0.1" })).json.code).toBe("invalid_price");
    const bid = runner!.bot.engine.snapshot().bids[0]!.price / 100n;
    const poor = await post({ side: "buy", type: "limit", price: String(bid), quantity: "5" });
    expect(poor.status).toBe(409);
    expect(poor.json.code).toBe("insufficient_balance");
  });

  test("signed out → 401; foreign origin → 403", async () => {
    const { client, signedIn } = await setup();
    const anon = client();
    expect((await anon.call("GET", "/me/account")).status).toBe(401);
    expect((await anon.call("POST", "/me/orders", { side: "buy", type: "market", quantity: "0.1" })).status).toBe(401);
    const c = await signedIn();
    const r = await c.call("POST", "/me/orders", { side: "buy", type: "market", quantity: "0.1" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect((await c.call("DELETE", "/me/orders", undefined, { origin: "https://evil.example" })).status).toBe(403);
  });

  test("per-account action rate limit", async () => {
    const { signedIn } = await setup();
    const c = await signedIn();
    let last = 0;
    for (let i = 0; i <= USERS.actionsPerMinute; i++) last = (await c.call("DELETE", "/me/orders")).status;
    expect(last).toBe(429);
  });
});

describe("history pages", () => {
  test("closed orders and fills page back with ?before", async () => {
    const { signedIn, runner } = await setup();
    const c = await signedIn();
    const bid = runner!.bot.engine.snapshot().bids[0]!.price / 100n;
    for (let i = 0; i < 5; i++) {
      await c.call("POST", "/me/orders", { side: "buy", type: "limit", price: String(bid - 2_000_000n), quantity: "0.01" });
      await c.call("POST", "/me/orders", { side: "buy", type: "market", quantity: "0.01" });
    }
    await c.call("DELETE", "/me/orders");

    const p1 = await c.call("GET", "/me/orders?limit=4");
    expect(p1.status).toBe(200);
    expect(p1.json.orders).toHaveLength(4);
    const p2 = await c.call("GET", `/me/orders?limit=4&before=${p1.json.next}`);
    const p3 = await c.call("GET", `/me/orders?limit=4&before=${p2.json.next}`);
    const ids = [...p1.json.orders, ...p2.json.orders, ...p3.json.orders].map((o: { id: string }) => o.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toEqual([...ids].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))));
    expect(p3.json.next).toBeNull();

    const all = (await c.call("GET", "/me/trades?limit=200")).json.trades as { id: string }[];
    expect(all.length).toBeGreaterThanOrEqual(5);
    const t1 = await c.call("GET", "/me/trades?limit=2");
    const t2 = await c.call("GET", `/me/trades?limit=2&before=${t1.json.next}`);
    expect([...t1.json.trades, ...t2.json.trades].map((t: { id: string }) => t.id)).toEqual(all.slice(0, 4).map((t) => t.id));

    expect((await c.call("GET", "/me/orders?before=x1")).status).toBe(400);
    expect((await c.call("GET", "/me/trades?limit=500")).status).toBe(400);
  });
});

describe("toUnits", () => {
  test("exact decimal parsing", () => {
    expect(toUnits("0.05", 4)).toBe(500n);
    expect(toUnits(0.05, 4)).toBe(500n);
    expect(toUnits("1.2500", 4)).toBe(12500n);
    expect(toUnits("50000000", 2)).toBe(5_000_000_000n);
    expect(toUnits("0.00001", 4)).toBeNull();
    expect(toUnits("1e-3", 4)).toBeNull();
    expect(toUnits("-1", 4)).toBeNull();
    expect(toUnits("", 4)).toBeNull();
    expect(toUnits(null, 4)).toBeNull();
    expect(toUnits(Number.NaN, 4)).toBeNull();
  });
});
