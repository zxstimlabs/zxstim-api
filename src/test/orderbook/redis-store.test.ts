// RedisBookStore against a real Redis (skipped without REDIS_URL). Runs in CI
// with a throwaway Redis service. Uses a unique key prefix and deletes it after.

import { describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { MatchingEngine } from "../../lib/matching-engine";
import { OrderbookBot } from "../../modules/orderbook/bot";
import { MemoryBookStore, RedisBookStore } from "../../modules/orderbook/store";
import { mulberry32 } from "../matching-engine/helpers";

const url = process.env.REDIS_URL;

describe.skipIf(!url)("RedisBookStore (needs REDIS_URL)", () => {
  test("the Lua save matches MemoryBookStore step for step, across a reconnect", async () => {
    const prefix = `test:orderbook:${crypto.randomUUID()}`;
    const redis = new RedisBookStore(url!, prefix);
    const memory = new MemoryBookStore();
    try {
      expect(await redis.load()).toBeNull();

      const bot = new OrderbookBot(new MatchingEngine(), mulberry32(9));
      bot.seed();
      const full = bot.fullState();
      await redis.save(full, { reset: true });
      await memory.save(full, { reset: true });
      for (let i = 0; i < 300; i++) {
        bot.step();
        const changes = bot.drainChanges();
        await redis.save(changes);
        await memory.save(changes);
      }

      redis.close(); // the next call must reconnect on its own
      const fromRedis = (await redis.load())!;
      const fromMemory = (await memory.load())!;
      const bySeq = (o: { sequence: number }, p: { sequence: number }) => o.sequence - p.sequence;
      expect(fromRedis.orders.sort(bySeq)).toEqual(fromMemory.orders.sort(bySeq));
      expect(fromRedis.sequence).toBe(bot.engine.sequence);
      expect(fromRedis.bot).toEqual(bot.state);
      expect(MatchingEngine.restore(fromRedis).snapshot()).toEqual(bot.engine.snapshot());

      // reset replaces every stored order
      await redis.save({ sequence: 0, upserts: [], deletes: [], bot: { mid: 1, idSeq: 0 } }, { reset: true });
      expect((await redis.load())!.orders).toEqual([]);
    } finally {
      redis.close();
      const raw = new RedisClient(url!);
      await raw.send("DEL", [`${prefix}:orders`, `${prefix}:meta`]);
      raw.close();
    }
  });
});
