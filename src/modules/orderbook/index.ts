// ETH/VND order book: the matching engine (src/lib/matching-engine) driven by
// a background bot, persisted in Redis so the book survives restarts and
// deploys. No HTTP routes yet: the engine is library-only for now.
//
// Lifecycle:
//   1. Load the saved book from Redis. If Redis is unreachable, retry every
//      5 s: never seed over state we couldn't read.
//   2. Nothing saved → seed a fresh book. Saved → MatchingEngine.restore().
//      Undecodable/invalid state → log and stay stopped (don't overwrite it).
//   3. Every BOT.intervalMs: one bot step, then save that step's changes. If a
//      save fails the bot keeps going in memory and does a full re-sync once
//      Redis is back.
// Logs only state transitions (start, Redis lost/back), never per step.

import { MatchingEngine } from "../../lib/matching-engine";
import { BOT, ORDERBOOK_MARKET, ORDERBOOK_REDIS_PREFIX } from "../../config/orderbook";
import { OrderbookBot } from "./bot";
import { BookStateError, RedisBookStore, type BookStore } from "./store";

const LOG = `[orderbook ${ORDERBOOK_MARKET}]`;
// Load retries back off from 0.5 s to 5 s: quick through a blip at boot,
// gentle through a real outage.
const LOAD_RETRY_FIRST_MS = 500;
const LOAD_RETRY_MAX_MS = 5_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// One bot plus its store. tick() is a single step + save; the timer loop lives
// in startOrderbookBot so tests can drive tick() directly.
export class OrderbookRunner {
  private failing = false;

  constructor(
    readonly bot: OrderbookBot,
    private readonly store: BookStore,
    private needsFullSync = false,
  ) {}

  async tick(): Promise<void> {
    this.bot.step();
    const full = this.needsFullSync;
    const changes = full ? this.bot.fullState() : this.bot.drainChanges();
    try {
      await this.store.save(changes, { reset: full });
      this.needsFullSync = false;
      if (this.failing) {
        console.log(`${LOG} Redis is back; book re-synced`);
        this.failing = false;
      }
    } catch (err) {
      this.needsFullSync = true;
      if (!this.failing) {
        console.error(`${LOG} Redis save failed, continuing in memory: ${message(err)}`);
        this.failing = true;
      }
    }
  }
}

// Load the saved book (retrying while Redis is unreachable) or seed a new one.
// Returns null if the saved state is invalid.
export async function loadRunner(
  store: BookStore,
  rng: () => number = Math.random,
): Promise<OrderbookRunner | null> {
  let warned = false;
  let delay = LOAD_RETRY_FIRST_MS;
  for (;;) {
    try {
      const saved = await store.load();
      if (!saved) {
        const bot = new OrderbookBot(new MatchingEngine(), rng);
        bot.seed();
        const { bids, asks } = bot.engine.snapshot();
        console.log(`${LOG} no saved book; seeded ${bids.length + asks.length} orders`);
        return new OrderbookRunner(bot, store, true);
      }
      const engine = MatchingEngine.restore(saved);
      console.log(`${LOG} restored ${saved.orders.length} resting orders (sequence ${saved.sequence})`);
      return new OrderbookRunner(new OrderbookBot(engine, rng, saved.bot), store);
    } catch (err) {
      if (err instanceof BookStateError || message(err).startsWith("restore:")) {
        console.error(`${LOG} saved book is invalid, bot NOT started (inspect or delete ${ORDERBOOK_REDIS_PREFIX}:*): ${message(err)}`);
        return null;
      }
      if (!warned) {
        console.error(`${LOG} Redis unavailable, retrying (up to every ${LOAD_RETRY_MAX_MS / 1000}s): ${message(err)}`);
        warned = true;
      }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, LOAD_RETRY_MAX_MS);
    }
  }
}

// Start the bot in the background. No-op without REDIS_URL (local dev, CI boot test).
export async function startOrderbookBot(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log(`${LOG} REDIS_URL not set; bot disabled`);
    return;
  }
  const runner = await loadRunner(new RedisBookStore(url, ORDERBOOK_REDIS_PREFIX));
  if (!runner) return;

  // Self-scheduling, so a slow save never overlaps the next step.
  const loop = async () => {
    try {
      await runner.tick();
    } catch (err) {
      // tick() handles store errors; anything here is an engine/bot bug.
      console.error(`${LOG} bot step failed, bot stopped: ${message(err)}`);
      return;
    }
    setTimeout(loop, BOT.intervalMs);
  };
  setTimeout(loop, BOT.intervalMs);
}
