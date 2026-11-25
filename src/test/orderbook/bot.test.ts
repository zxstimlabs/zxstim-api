// The ETH/VND bot and its persistence loop, against the in-memory store.
// Deterministic: every bot gets a seeded PRNG.

import { describe, expect, test } from "bun:test";
import { MatchingEngine } from "../../lib/matching-engine";
import { BOT } from "../../config/orderbook";
import { OrderbookBot, toLevels, toTicks, type BookChanges } from "../../modules/orderbook/bot";
import { loadRunner } from "../../modules/orderbook";
import { MemoryBookStore } from "../../modules/orderbook/store";
import { assertBookInvariants, mulberry32 } from "../matching-engine/helpers";

// The store holds exactly the live book, sequence and bot state.
async function expectMirrors(store: MemoryBookStore, bot: OrderbookBot): Promise<void> {
  const saved = await store.load();
  expect(saved).not.toBeNull();
  expect(MatchingEngine.restore(saved!).snapshot()).toEqual(bot.engine.snapshot());
  expect(saved!.sequence).toBe(bot.engine.sequence);
  expect(saved!.bot).toEqual(bot.state);
  const { bids, asks } = bot.engine.snapshot();
  expect(store.orders.size).toBe(bids.length + asks.length);
}

class FlakyStore extends MemoryBookStore {
  down = false;
  override async save(c: BookChanges, opts?: { reset?: boolean }): Promise<void> {
    if (this.down) throw new Error("store down");
    return super.save(c, opts);
  }
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

  test("drainChanges keeps a store in step with the live book", async () => {
    const store = new MemoryBookStore();
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(7));
    bot.seed();
    await store.save(bot.fullState(), { reset: true });
    for (let i = 1; i <= 1000; i++) {
      bot.step();
      await store.save(bot.drainChanges());
      if (i % 100 === 0) await expectMirrors(store, bot);
    }
  });
});

describe("loadRunner / OrderbookRunner", () => {
  test("seeds when nothing is saved, and a second runner restores the same book", async () => {
    const store = new MemoryBookStore();
    const first = (await loadRunner(store, mulberry32(3)))!;
    for (let i = 0; i < 300; i++) await first.tick();
    await expectMirrors(store, first.bot);

    const second = (await loadRunner(store, mulberry32(4)))!;
    expect(second.bot.engine.snapshot()).toEqual(first.bot.engine.snapshot());
    expect(second.bot.engine.sequence).toBe(first.bot.engine.sequence);
    expect(second.bot.state).toEqual(first.bot.state);
  });

  test("after failed saves, the next good save fully re-syncs the store", async () => {
    const store = new FlakyStore();
    const runner = (await loadRunner(store, mulberry32(5)))!;
    for (let i = 0; i < 20; i++) await runner.tick();
    store.down = true;
    for (let i = 0; i < 50; i++) await runner.tick(); // these deltas are lost
    store.down = false;
    await runner.tick();
    await expectMirrors(store, runner.bot);
  });

  test("refuses to start on undecodable or invalid saved state (and leaves it alone)", async () => {
    const garbled = new MemoryBookStore();
    garbled.meta.set("sequence", "1").set("mid", String(BOT.midStart)).set("idSeq", "1");
    garbled.orders.set("x", "{not json");
    expect(await loadRunner(garbled)).toBeNull();
    expect(garbled.orders.get("x")).toBe("{not json");

    const crossed = new MemoryBookStore();
    const bot = new OrderbookBot(new MatchingEngine(), mulberry32(6));
    bot.seed();
    const state = bot.fullState();
    const [bid] = state.upserts.filter((o) => o.side === "buy");
    bid!.price = toTicks(BOT.midMax * 2); // above every ask
    await crossed.save(state, { reset: true });
    expect(await loadRunner(crossed)).toBeNull();
  });
});
