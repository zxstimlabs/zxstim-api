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
  test("seed builds maxLevels levels per side, one tick either side of the mid", () => {
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(1));
    bot.seed();
    const { bids, asks } = bot.engine.snapshot();
    expect(toLevels(bids)).toHaveLength(BOT.maxLevels);
    expect(toLevels(asks)).toHaveLength(BOT.maxLevels);
    expect(bids[0]!.price).toBe(toTicks(BOT.midStart - BOT.tickVnd));
    expect(asks[0]!.price).toBe(toTicks(BOT.midStart + BOT.tickVnd));
    assertBookInvariants(bot.engine);
  });

  test("2,000 steps keep the book valid, within depth, on the tick grid, mid in band", () => {
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(42));
    bot.seed();
    const grid = toTicks(BOT.tickVnd);
    for (let i = 0; i < 2000; i++) {
      const before = bot.engine.sequence;
      bot.step();
      assertBookInvariants(bot.engine);
      const { bids, asks } = bot.engine.snapshot();
      expect(toLevels(bids).length).toBeLessThanOrEqual(BOT.maxLevels);
      expect(toLevels(asks).length).toBeLessThanOrEqual(BOT.maxLevels);
      for (const o of [...bids, ...asks]) expect(o.price % grid).toBe(0n);
      expect(bot.state.mid).toBeGreaterThanOrEqual(BOT.midMin);
      expect(bot.state.mid).toBeLessThanOrEqual(BOT.midMax);
      expect(bot.engine.sequence).toBeGreaterThanOrEqual(before);
    }
    expect(bot.engine.sequence).toBeGreaterThan(1000); // it actually trades and rests orders
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
      `UPDATE cefi_book_order SET price = ${toTicks(BOT.midMax * 2)} WHERE side = 'buy' AND rowid = (SELECT min(rowid) FROM cefi_book_order WHERE side = 'buy')`,
    );
    expect(loadRunner(crossed.db)).toBeNull();

    const orphans = newDb();
    loadRunner(orphans.db, mulberry32(8))!.tick();
    orphans.sqlite.run("DELETE FROM cefi_book_state");
    expect(loadRunner(orphans.db)).toBeNull(); // orders without the state row
  });
});
