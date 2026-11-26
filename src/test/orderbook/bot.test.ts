// The ETH/VND bot, and the runner that keeps its book in the CeFi DB (real
// SQLite, in memory, with this repo's migrations). Deterministic: every bot
// gets a seeded PRNG.

import { describe, expect, test } from "bun:test";
import { MatchingEngine } from "../../lib/matching-engine";
import { BOT } from "../../config/orderbook";
import { openCefiDb } from "../../modules/cefi/db";
import { OrderbookBot, toLevels, toTicks } from "../../modules/orderbook/bot";
import { loadRunner, type OrderbookRunner } from "../../modules/orderbook";
import { SqliteMarketDb } from "../../modules/orderbook/market-db";
import { assertBookInvariants, mulberry32 } from "../matching-engine/helpers";

function newDb() {
  const { sqlite } = openCefiDb(":memory:");
  return { sqlite, db: new SqliteMarketDb(sqlite) };
}

// The DB holds exactly the live book, sequence and bot state.
function expectMirrors(db: SqliteMarketDb, runner: OrderbookRunner): void {
  const saved = db.loadBook();
  expect(saved).not.toBeNull();
  expect(MatchingEngine.restore(saved!).snapshot()).toEqual(runner.bot.engine.snapshot());
  expect(saved!.sequence).toBe(runner.bot.engine.sequence);
  expect(saved!.bot).toEqual(runner.bot.state);
}

describe("OrderbookBot", () => {
  test("seed fills BOT.levels levels per side, straddling the price", () => {
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(1));
    bot.seed();
    const { bids, asks } = bot.engine.snapshot();
    expect(toLevels(bids)).toHaveLength(BOT.levels);
    expect(toLevels(asks)).toHaveLength(BOT.levels);
    expect(bids[0]!.price).toBe(toTicks(bot.bidLevel(0)));
    expect(asks[0]!.price).toBe(toTicks(bot.askLevel(0)));
    expect(bot.bidLevel(0)).toBeLessThan(BOT.midStart);
    expect(bot.askLevel(0)).toBeGreaterThan(BOT.midStart);
    assertBookInvariants(bot.engine);
  });

  test("3,000 steps: quotes stay around the price, the book changes every step, trades stay near the price", () => {
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(42));
    bot.seed();
    let calls = 0;
    const trades: { price: bigint; mid: number }[] = [];
    bot.listener = (events) => {
      calls++;
      for (const e of events) if (e.type === "trade") trades.push({ price: e.trade.price, mid: bot.state.mid });
    };
    const grid = toTicks(BOT.tickVnd);
    const steps = 3000;
    for (let i = 0; i < steps; i++) {
      const before = calls;
      bot.step();
      expect(calls).toBeGreaterThan(before); // something on the book changed
      assertBookInvariants(bot.engine);
      const { bids, asks } = bot.engine.snapshot();
      expect(toLevels(bids).length).toBeLessThanOrEqual(BOT.levels);
      expect(toLevels(asks).length).toBeLessThanOrEqual(BOT.levels);
      for (const o of [...bids, ...asks]) expect(o.price % grid).toBe(0n);
      for (const o of bids) expect(o.price <= toTicks(bot.bidLevel(0)) && o.price >= toTicks(bot.bidLevel(BOT.levels - 1))).toBe(true);
      for (const o of asks) expect(o.price >= toTicks(bot.askLevel(0)) && o.price <= toTicks(bot.askLevel(BOT.levels - 1))).toBe(true);
      expect(bids.length).toBeLessThanOrEqual(BOT.ordersPerSide * 2);
      expect(asks.length).toBeLessThanOrEqual(BOT.ordersPerSide * 2);
    }
    // About one bot trade per BOT.takerEveryMs, each within a few ticks of the price.
    const takers = new Set(trades.map((t) => t.mid)).size;
    expect(takers).toBeGreaterThan(0);
    const expected = (steps * BOT.intervalMs) / BOT.takerEveryMs;
    expect(trades.length).toBeGreaterThan(expected * 0.7);
    expect(trades.length).toBeLessThan(expected * 2.5);
    for (const t of trades) {
      const off = Math.abs(Number(t.price) / 100 - t.mid);
      expect(off).toBeLessThan((BOT.takerLimitTicks + 0.5) * BOT.tickVnd);
    }
    // No band to hit: the price just wanders (≈0.7% σ over 3,000 one-second steps).
    expect(Math.abs(bot.state.mid / BOT.midStart - 1)).toBeLessThan(0.05);
  });

  test("the price has no hard band: it can wander past the old 45M–55M box", () => {
    // Start right at the old ceiling; a band would hold it below 55M.
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(5), { mid: 55_000_000, idSeq: 0 });
    let above = 0;
    for (let i = 0; i < 2000; i++) {
      (bot as unknown as { movePrice(): void }).movePrice();
      if (bot.state.mid > 55_000_000) above++;
    }
    expect(above).toBeGreaterThan(0);
  });

  test("every step leaves the DB holding exactly the live book", () => {
    const { db } = newDb();
    const runner = loadRunner(db, mulberry32(7))!;
    expectMirrors(db, runner);
    for (let i = 1; i <= 1000; i++) {
      runner.tick();
      if (i % 100 === 0) expectMirrors(db, runner);
    }
  });
});

describe("loadRunner", () => {
  test("seeds when nothing is saved, and a second runner restores the same book", () => {
    const { db } = newDb();
    const first = loadRunner(db, mulberry32(3))!;
    for (let i = 0; i < 300; i++) first.tick();
    expectMirrors(db, first);

    const second = loadRunner(db, mulberry32(4))!;
    expect(second.bot.engine.snapshot()).toEqual(first.bot.engine.snapshot());
    expect(second.bot.engine.sequence).toBe(first.bot.engine.sequence);
    expect(second.bot.state).toEqual(first.bot.state);
  });

  test("refuses to start on invalid saved state (and leaves it alone)", () => {
    const garbled = newDb();
    loadRunner(garbled.db, mulberry32(5))!.tick();
    garbled.sqlite.run("UPDATE cefi_book_order SET side = 'hold' WHERE rowid = (SELECT min(rowid) FROM cefi_book_order)");
    expect(loadRunner(garbled.db)).toBeNull();
    expect(garbled.sqlite.query("SELECT count(*) AS n FROM cefi_book_order WHERE side = 'hold'").get()).toEqual({ n: 1 });

    const crossed = newDb();
    loadRunner(crossed.db, mulberry32(6))!.tick();
    crossed.sqlite.run(
      `UPDATE cefi_book_order SET price = ${toTicks(BOT.midStart * 2)} WHERE side = 'buy' AND rowid = (SELECT min(rowid) FROM cefi_book_order WHERE side = 'buy')`,
    );
    expect(loadRunner(crossed.db)).toBeNull();

    const orphans = newDb();
    loadRunner(orphans.db, mulberry32(8))!.tick();
    orphans.sqlite.run("DELETE FROM cefi_book_state");
    expect(loadRunner(orphans.db)).toBeNull(); // orders without the state row
  });
});
