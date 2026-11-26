// CeFi users trading on the bot's book: settlement, locks, validation, market
// data, and persistence (book, money and trades together in the CeFi DB).
// Real SQLite (in memory, with this repo's migrations); deterministic: seeded
// PRNG and a fake clock.

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MatchingEngine } from "../../lib/matching-engine";
import { BOT, MARKET_DATA, USERS } from "../../config/orderbook";
import { openCefiDb } from "../../modules/cefi/db";
import { OrderbookBot, isUserOrderId, toTicks } from "../../modules/orderbook/bot";
import { Market, START_ETH, START_VND, type PlaceOrder } from "../../modules/orderbook/market";
import { SqliteMarketDb, type MarketBatch } from "../../modules/orderbook/market-db";
import { loadRunner, type OrderbookRunner } from "../../modules/orderbook";
import { assertBookInvariants, mulberry32 } from "../matching-engine/helpers";

const lots = (e: number) => BigInt(Math.round(e * 10_000));
const T0 = Date.UTC(2026, 10, 26, 3, 0, 0);

function newDb() {
  const { sqlite } = openCefiDb(":memory:");
  return { sqlite, db: new SqliteMarketDb(sqlite) };
}

function setup(seed = 1) {
  let clock = T0;
  const { sqlite, db } = newDb();
  const bot = new OrderbookBot(new MatchingEngine(), mulberry32(seed));
  bot.seed();
  const market = new Market(bot, db, () => clock, { reseeded: true });
  return { bot, market, db, sqlite, advance: (ms: number) => (clock += ms) };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

const rows = (sqlite: Database, sql: string, ...args: (string | number)[]) =>
  (sqlite.query(sql) as any).safeIntegers(true).all(...args) as Record<string, any>[];

// Memory, the DB and the book agree, and every account's money adds up.
function assertConsistent(market: Market, sqlite: Database, users: string[]) {
  const { bids, asks } = market.bot.engine.snapshot();
  const onBook = new Map([...bids, ...asks].filter((o) => isUserOrderId(o.id)).map((o) => [o.id, o]));
  let open = 0;
  for (const u of users) {
    market.account(u); // loads it from the DB if it isn't in memory yet
    const a = market.accountState(u);
    const bal = rows(sqlite, "SELECT vnd, eth FROM cefi_balance WHERE user_id = ?", u)[0];
    if (!a) {
      expect(bal).toBeUndefined();
      continue;
    }
    expect(a.vnd).toBeGreaterThanOrEqual(0n);
    expect(a.eth).toBeGreaterThanOrEqual(0n);
    expect(bal).toEqual({ vnd: a.vnd, eth: a.eth }); // the DB has what memory has
    let vndLocked = 0n;
    let ethLocked = 0n;
    for (const o of a.open.values()) {
      expect(onBook.get(o.id)?.remaining).toBe(o.quantity - o.filled);
      if (o.side === "buy") vndLocked += o.price! * (o.quantity - o.filled);
      else ethLocked += o.quantity - o.filled;
      open++;
    }
    const orders = rows(sqlite, "SELECT * FROM cefi_order WHERE user_id = ?", u);
    const dbOpen = orders.filter((o) => o.status === "open" || o.status === "partially_filled");
    expect(dbOpen.map((o) => `u${o.id}`).sort()).toEqual([...a.open.keys()].sort());
    // Balances follow from every order's fills...
    let vnd = START_VND;
    let eth = START_ETH;
    for (const o of orders) {
      if (o.side === "buy") {
        vnd -= o.quote;
        eth += o.filled;
      } else {
        vnd += o.quote;
        eth -= o.filled;
      }
    }
    expect(a.vnd + vndLocked).toBe(vnd);
    expect(a.eth + ethLocked).toBe(eth);
    // ...and each order's fills add up to it.
    const byOrder = new Map<bigint, { q: bigint; quote: bigint }>();
    for (const f of rows(sqlite, "SELECT order_id, quantity, quote FROM cefi_fill WHERE user_id = ?", u)) {
      const s = byOrder.get(f.order_id) ?? { q: 0n, quote: 0n };
      byOrder.set(f.order_id, { q: s.q + f.quantity, quote: s.quote + f.quote });
    }
    for (const o of orders) expect(byOrder.get(o.id) ?? { q: 0n, quote: 0n }).toEqual({ q: o.filled, quote: o.quote });
  }
  expect(open).toBe(onBook.size);
}

const bestBid = (m: Market) => m.bot.engine.snapshot().bids[0]!.price;
const bestAsk = (m: Market) => m.bot.engine.snapshot().asks[0]!.price;

describe("Market: user orders", () => {
  test("a resting limit buy locks price × quantity; cancelling gives it back", () => {
    const { market, sqlite } = setup();
    const price = bestBid(market) - toTicks(BOT.tickVnd);
    const order = ok(market.placeOrder("alice", { side: "buy", type: "limit", price, quantity: lots(0.5) }));
    expect(order).toMatchObject({ status: "open", filled: 0, quantity: 0.5 });
    const a = market.accountState("alice")!;
    expect(a.vnd).toBe(START_VND - price * lots(0.5));
    expect(market.account("alice").balances.vnd.locked).toBe(Number(price * lots(0.5)) / 1e6);
    expect(market.bot.engine.getOrder(order.id)).toBeDefined();
    assertConsistent(market, sqlite, ["alice"]);

    const cancelled = ok(market.cancelOrder("alice", order.id));
    expect(cancelled.status).toBe("cancelled");
    expect(a.vnd).toBe(START_VND);
    expect(a.open.size).toBe(0);
    expect(market.account("alice").orderHistory[0]).toMatchObject({ id: order.id, status: "cancelled" });
    expect(market.bot.engine.getOrder(order.id)).toBeUndefined();
    assertConsistent(market, sqlite, ["alice"]);
  });

  test("a crossing limit buy fills at the makers' prices and refunds the difference", () => {
    const { market, sqlite } = setup();
    const ask = market.bot.engine.snapshot().asks[0]!;
    const q = ask.remaining < lots(0.5) ? ask.remaining : lots(0.5);
    const limit = ask.price + toTicks(10 * BOT.tickVnd);
    const order = ok(market.placeOrder("bob", { side: "buy", type: "limit", price: limit, quantity: q }));
    expect(order.status).toBe("filled");
    const a = market.accountState("bob")!;
    expect(a.eth).toBe(START_ETH + q);
    expect(a.vnd).toBe(START_VND - ask.price * q); // paid the ask, not the limit
    expect(market.account("bob").trades[0]).toMatchObject({ role: "taker", price: Number(ask.price) / 100, quantity: Number(q) / 1e4 });
    assertConsistent(market, sqlite, ["bob"]);
  });

  test("market buy and sell settle against the book", () => {
    const { market, sqlite } = setup();
    const buy = ok(market.placeOrder("carol", { side: "buy", type: "market", quantity: lots(0.3) }));
    expect(buy.status).toBe("filled");
    expect(buy.price).toBeNull();
    const a = market.accountState("carol")!;
    expect(a.eth).toBe(START_ETH + lots(0.3));
    const sell = ok(market.placeOrder("carol", { side: "sell", type: "market", quantity: lots(1.3) }));
    expect(sell.status).toBe("filled");
    expect(a.eth).toBe(0n);
    assertConsistent(market, sqlite, ["carol"]);
  });

  test("rejects bad sizes and prices, unaffordable orders, and unknown cancels; nothing saved", () => {
    const { market, sqlite } = setup();
    const price = bestBid(market);
    const place = (o: PlaceOrder) => market.placeOrder("dave", o);
    const code = (r: ReturnType<typeof place>) => (r.ok ? "ok" : r.code);
    expect(code(place({ side: "buy", type: "limit", price, quantity: lots(0.0009) }))).toBe("invalid_quantity");
    expect(code(place({ side: "buy", type: "limit", price, quantity: lots(101) }))).toBe("invalid_quantity");
    expect(code(place({ side: "buy", type: "limit", price: price + 1n, quantity: lots(0.1) }))).toBe("invalid_price");
    expect(code(place({ side: "buy", type: "limit", quantity: lots(0.1) }))).toBe("invalid_price");
    expect(code(place({ side: "buy", type: "limit", price: price * 2n, quantity: lots(0.1) }))).toBe("price_out_of_band");
    expect(code(place({ side: "buy", type: "limit", price: price / 3n - (price / 3n) % 100n, quantity: lots(0.1) }))).toBe("price_out_of_band");
    expect(code(place({ side: "buy", type: "limit", price, quantity: lots(2) }))).toBe("insufficient_balance"); // ~100M VND
    expect(code(place({ side: "sell", type: "market", quantity: lots(1.5) }))).toBe("insufficient_balance");
    expect(code(market.cancelOrder("dave", "u999"))).toBe("unknown_order");
    expect(market.accountState("dave")).toBeUndefined();
    expect(market.account("dave").balances.vnd.available).toBe(USERS.startVnd);
    expect(rows(sqlite, "SELECT count(*) AS n FROM cefi_order")[0]!.n).toBe(0n);
  });

  test("caps open orders per account", () => {
    const { market } = setup();
    const price = bestBid(market) - toTicks(BOT.tickVnd * 20);
    for (let i = 0; i < USERS.maxOpenOrders; i++) {
      ok(market.placeOrder("erin", { side: "buy", type: "limit", price, quantity: lots(0.01) }));
    }
    const r = market.placeOrder("erin", { side: "buy", type: "limit", price, quantity: lots(0.01) });
    expect(r.ok ? "ok" : r.code).toBe("too_many_orders");
    expect(market.cancelAll("erin")).toBe(USERS.maxOpenOrders);
    expect(market.accountState("erin")!.vnd).toBe(START_VND);
  });

  test("no liquidity: a market order against an empty side is refused", () => {
    const market = new Market(new OrderbookBot(new MatchingEngine(), mulberry32(2)), newDb().db);
    const r = market.placeOrder("frank", { side: "buy", type: "market", quantity: lots(0.1) });
    expect(r.ok ? "ok" : r.code).toBe("no_liquidity");
  });

  test("the bot never cancels, amends or trims users' orders; it only trades with them", () => {
    const { market, bot, sqlite } = setup(11);
    const deep = bestBid(market) - toTicks(BOT.tickVnd * 30); // far below every bot level
    const near = bestAsk(market) + toTicks(BOT.tickVnd); // likely to be hit
    const a = ok(market.placeOrder("gail", { side: "buy", type: "limit", price: deep, quantity: lots(0.1) }));
    const b = ok(market.placeOrder("gail", { side: "sell", type: "limit", price: near, quantity: lots(0.5) }));
    for (let i = 0; i < 2000; i++) bot.step();
    const history = market.account("gail").orderHistory;
    for (const o of history) expect(o.status).toBe("filled");
    expect(market.accountState("gail")!.open.has(a.id) || history.some((o) => o.id === a.id)).toBe(true);
    expect(history.some((o) => o.id === b.id)).toBe(true); // the bot's takers filled it
    assertConsistent(market, sqlite, ["gail"]);
  });

  test("random users interleaved with the bot: memory, DB, book and balances agree", () => {
    const { market, bot, advance, sqlite } = setup(21);
    const rng = mulberry32(99);
    const users = ["u-a", "u-b", "u-c", "u-d", "u-e"];
    let placed = 0;
    for (let i = 0; i < 3000; i++) {
      bot.step();
      advance(500);
      if (rng() < 0.15) {
        const user = users[Math.floor(rng() * users.length)]!;
        const side = rng() < 0.5 ? "buy" : "sell";
        const quantity = BigInt(10 + Math.floor(rng() * 3000)); // 0.001–0.301 ETH
        const r =
          rng() < 0.3
            ? market.placeOrder(user, { side, type: "market", quantity })
            : market.placeOrder(user, {
                side,
                type: "limit",
                price: (side === "buy" ? bestBid(market) : bestAsk(market)) + toTicks(BOT.tickVnd * Math.floor(rng() * 9 - 4)),
                quantity,
              });
        if (r.ok) placed++;
      }
      if (rng() < 0.03) {
        const user = users[Math.floor(rng() * users.length)]!;
        const open = [...(market.accountState(user)?.open.keys() ?? [])];
        if (open.length) ok(market.cancelOrder(user, open[Math.floor(rng() * open.length)]!));
      }
      if (i % 100 === 0) {
        assertBookInvariants(bot.engine);
        assertConsistent(market, sqlite, users);
      }
    }
    assertConsistent(market, sqlite, users);
    expect(placed).toBeGreaterThan(200);
    expect(Number(rows(sqlite, "SELECT count(*) AS n FROM cefi_fill")[0]!.n)).toBeGreaterThan(100);
    // Every trade is in the log, bot or user.
    expect(Number(rows(sqlite, "SELECT count(*) AS n FROM cefi_trade")[0]!.n)).toBeGreaterThan(1000);
  });
});

describe("Market: public data", () => {
  test("trades build candles at every resolution and the 24 h ticker", () => {
    const { market, bot, advance } = setup(5);
    for (let i = 0; i < 1440; i++) {
      bot.step();
      advance(500); // 12 min in all
    }
    const snap = JSON.parse(market.publicSnapshot().body);
    expect(snap.market).toBe("ETH-VND");
    expect(snap.trades.length).toBeGreaterThan(10);
    expect(snap.ticker.last).toBe(snap.trades[0].price);
    expect(snap.ticker.high24h).toBeGreaterThanOrEqual(snap.ticker.low24h);
    expect(snap.depth.bids[0].price).toBeLessThan(snap.depth.asks[0].price);

    const m1 = market.candlesFor("1m", 1000);
    expect(m1.length).toBeGreaterThanOrEqual(11);
    for (let i = 1; i < m1.length; i++) expect(m1[i]!.t).toBeGreaterThan(m1[i - 1]!.t);
    for (const c of m1) {
      expect(c.t % 60).toBe(0);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
    const vol = (cs: { volume: number }[]) => cs.reduce((s, c) => s + c.volume, 0);
    expect(vol(market.candlesFor("15m", 1000))).toBeCloseTo(vol(m1), 6);
    expect(vol(m1)).toBeCloseTo(snap.ticker.volume24h, 6);
  });

  test("the snapshot's ETag holds while nothing changes", () => {
    const { market, bot } = setup(6);
    const a = market.publicSnapshot();
    expect(market.publicSnapshot().etag).toBe(a.etag);
    bot.step();
    expect(market.publicSnapshot().etag).not.toBe(a.etag);
  });
});

describe("persistence: book, money and trades in one DB", () => {
  // Run a runner with a couple of users for `steps` bot steps.
  function trade(runner: OrderbookRunner, clock: { t: number }, steps: number) {
    for (let i = 0; i < steps; i++) {
      runner.tick();
      clock.t += 500;
      if (i % 20 === 0) {
        const user = ["p1", "p2"][(i / 20) % 2]!;
        const bid = runner.bot.engine.snapshot().bids[0]!.price;
        runner.market.placeOrder(user, { side: "buy", type: "limit", price: bid - toTicks(BOT.tickVnd * (i % 3)), quantity: lots(0.05) });
        runner.market.placeOrder(user, { side: "sell", type: "market", quantity: lots(0.02) });
      }
    }
  }

  test("a restart restores the book, accounts, open orders, trades and candles exactly", () => {
    const clock = { t: T0 };
    const now = () => clock.t;
    const { sqlite, db } = newDb();
    const first = loadRunner(db, mulberry32(3), now)!;
    trade(first, clock, 400);
    assertConsistent(first.market, sqlite, ["p1", "p2"]);
    expect(first.market.accountState("p1")!.open.size + first.market.accountState("p2")!.open.size).toBeGreaterThan(0);

    const second = loadRunner(db, mulberry32(4), now)!;
    expect(second.bot.engine.snapshot()).toEqual(first.bot.engine.snapshot()); // same priorities too
    expect(second.bot.engine.sequence).toBe(first.bot.engine.sequence);
    expect(second.bot.state).toEqual(first.bot.state);
    for (const u of ["p1", "p2"]) expect(second.market.account(u)).toEqual(first.market.account(u));
    for (const r of ["1m", "1h", "1d"] as const) expect(second.market.candlesFor(r, 1000)).toEqual(first.market.candlesFor(r, 1000));
    const a = JSON.parse(first.market.publicSnapshot().body);
    const b = JSON.parse(second.market.publicSnapshot().body);
    expect(b.trades).toEqual(a.trades);
    expect(b.depth).toEqual(a.depth);
    expect(b.ticker.quoteVolume24h).toBeCloseTo(a.ticker.quoteVolume24h, -2); // whole VND in the DB
    trade(second, clock, 200);
    assertConsistent(second.market, sqlite, ["p1", "p2"]);
  });

  test("a crash right after any order loses nothing: the DB is never behind", () => {
    const clock = { t: T0 };
    const now = () => clock.t;
    const { sqlite, db } = newDb();
    const live = loadRunner(db, mulberry32(5), now)!;
    for (let i = 0; i < 60; i++) {
      live.tick();
      clock.t += 500;
      const bid = live.bot.engine.snapshot().bids[0]!.price;
      live.market.placeOrder("c1", i % 2
        ? { side: "sell", type: "market", quantity: lots(0.01) }
        : { side: "buy", type: "limit", price: bid - toTicks(BOT.tickVnd * (i % 4)), quantity: lots(0.02) });
      if (i % 10 === 9) {
        // "Crash" now: what a restart would see.
        const after = loadRunner(db, mulberry32(i), now)!;
        expect(after.bot.engine.snapshot()).toEqual(live.bot.engine.snapshot());
        expect(after.market.account("c1")).toEqual(live.market.account("c1"));
      }
    }
    assertConsistent(live.market, sqlite, ["c1"]);
  });

  test("a reset book (its rows deleted): a fresh book, with users' open orders put back", () => {
    const clock = { t: T0 };
    const now = () => clock.t;
    const { sqlite, db } = newDb();
    const first = loadRunner(db, mulberry32(7), now)!;
    const deep = first.bot.engine.snapshot().bids[0]!.price - toTicks(BOT.tickVnd * 30);
    const order = ok(first.market.placeOrder("q1", { side: "buy", type: "limit", price: deep, quantity: lots(0.2) }));
    trade(first, clock, 200);
    sqlite.run("DELETE FROM cefi_book_order");
    sqlite.run("DELETE FROM cefi_book_state");

    const second = loadRunner(db, mulberry32(8), now)!;
    expect(second.bot.engine.getOrder(order.id)?.remaining).toBe(lots(0.2));
    expect(second.market.account("q1")).toEqual(first.market.account("q1"));
    expect(second.bot.engine.sequence).toBeGreaterThanOrEqual(db.maxTradeSeq()); // trade ids continue
    assertConsistent(second.market, sqlite, ["q1", "p1", "p2"]);
    trade(second, clock, 200); // would throw on a duplicate trade sequence
    assertConsistent(second.market, sqlite, ["q1", "p1", "p2"]);
    const third = loadRunner(db, mulberry32(9), now)!; // and it was saved whole
    expect(third.bot.engine.snapshot()).toEqual(second.bot.engine.snapshot());
  });

  test("refuses to start when the saved book and the open orders disagree", () => {
    const setupWithOrder = () => {
      const { sqlite, db } = newDb();
      const r = loadRunner(db, mulberry32(10))!;
      const deep = r.bot.engine.snapshot().bids[0]!.price - toTicks(BOT.tickVnd * 30);
      const order = ok(r.market.placeOrder("r1", { side: "buy", type: "limit", price: deep, quantity: lots(0.2) }));
      return { sqlite, db, order };
    };
    const missing = setupWithOrder();
    missing.sqlite.run(`DELETE FROM cefi_book_order WHERE id = '${missing.order.id}'`);
    expect(loadRunner(missing.db)).toBeNull();

    const orphan = setupWithOrder();
    orphan.sqlite.run(`UPDATE cefi_order SET status = 'cancelled' WHERE id = ${orphan.order.id.slice(1)}`);
    expect(loadRunner(orphan.db)).toBeNull();

    const resized = setupWithOrder();
    resized.sqlite.run(`UPDATE cefi_book_order SET remaining = 1 WHERE id = '${resized.order.id}'`);
    expect(loadRunner(resized.db)).toBeNull();
  });

  test("a failed DB write stops the market instead of trading on unsaved money", () => {
    const { db } = newDb();
    let broken = false;
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
      commit(batch: MarketBatch) {
        if (broken) throw new Error("disk full");
        db.commit(batch);
      },
    });
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(12));
    bot.seed();
    const market = new Market(bot, flaky, Date.now, { reseeded: true });
    ok(market.placeOrder("w1", { side: "buy", type: "market", quantity: lots(0.1) }));
    broken = true;
    expect(() => market.placeOrder("w1", { side: "buy", type: "market", quantity: lots(0.1) })).toThrow("disk full");
    expect(market.healthy).toBe(false);
    broken = false;
    expect(() => market.placeOrder("w1", { side: "buy", type: "market", quantity: lots(0.1) })).toThrow("market stopped");
    expect(() => {
      for (let i = 0; i < 50; i++) bot.step(); // the bot's next trade hits the stopped market
    }).toThrow("market stopped");
  });

  test("prune drops old trades, never users' fills; keeps the newest candles", () => {
    const { market, bot, advance, sqlite, db } = setup(13);
    ok(market.placeOrder("v1", { side: "buy", type: "market", quantity: lots(0.1) }));
    for (let i = 0; i < 200; i++) {
      bot.step();
      advance(61_000); // a new 1m candle on most steps
    }
    const count = (sql: string) => Number(rows(sqlite, sql)[0]!.n);
    const trades = count("SELECT count(*) AS n FROM cefi_trade");
    advance((MARKET_DATA.tradeRetentionDays + 1) * 24 * 60 * 60 * 1000);
    market.prune();
    expect(trades).toBeGreaterThan(20);
    expect(count("SELECT count(*) AS n FROM cefi_trade")).toBe(0);
    expect(count("SELECT count(*) AS n FROM cefi_fill")).toBeGreaterThan(0);
    expect(market.account("v1").trades.length).toBeGreaterThan(0);

    const newest = rows(sqlite, "SELECT t FROM cefi_candle WHERE resolution = '1m' ORDER BY t DESC LIMIT 10").map((r) => r.t);
    expect(count("SELECT count(*) AS n FROM cefi_candle WHERE resolution = '1m'")).toBeGreaterThan(10);
    db.prune(0, 10);
    expect(rows(sqlite, "SELECT t FROM cefi_candle WHERE resolution = '1m' ORDER BY t DESC").map((r) => r.t)).toEqual(newest);
  });
});
