// ETH/VND market: the matching engine (src/lib/matching-engine) driven by a
// background bot, with CeFi users trading on the same book (market.ts).
// Everything — the book, users' balances, orders and fills, the trade log and
// candles — is in the CeFi DB (market-db.ts), written in one transaction per
// engine call, so the book and the balances can't disagree. HTTP routes: the
// CeFi API (src/modules/cefi/market.ts). Runs only with the CeFi API.
//
// Lifecycle:
//   1. Load the saved book from the DB and restore the engine. No saved book
//      → seed a fresh one (its sequence continues above the DB's last trade,
//      and users' open orders go back on it). Invalid state → log and stay
//      stopped (don't overwrite it).
//   2. Every BOT.intervalMs: one bot step. Each engine call in it saves
//      itself; the runner then saves the bot's state (its mid moves every
//      step). Users' orders save the same way, from the API, in between.
//   3. Hourly: prune old trades and candles.
// Logs only state transitions, never per step.

import { MatchingEngine } from "../../lib/matching-engine";
import { BOT, MARKET_DATA, ORDERBOOK_MARKET } from "../../config/orderbook";
import { OrderbookBot, isUserOrderId } from "./bot";
import { Market } from "./market";
import { BookStateError, type MarketDb } from "./market-db";

const LOG = `[orderbook ${ORDERBOOK_MARKET}]`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// One market (bot + users). tick() is a single bot step; the timer loop lives
// in startOrderbookBot so tests can drive tick() directly.
export class OrderbookRunner {
  constructor(readonly market: Market) {}

  get bot(): OrderbookBot {
    return this.market.bot;
  }

  tick(): void {
    this.bot.step();
    this.market.saveBotState();
  }
}

// Load the saved book from `db` or seed a new one, then the market. Returns
// null if the saved state is invalid or can't be read.
export function loadRunner(
  db: MarketDb,
  rng: () => number = Math.random,
  now: () => number = Date.now,
): OrderbookRunner | null {
  try {
    const saved = db.loadBook();
    let market: Market;
    if (!saved) {
      // Trade sequences are keys in the DB: a new book never reuses one.
      const bot = new OrderbookBot(MatchingEngine.restore({ sequence: db.maxTradeSeq(), orders: [] }), rng);
      bot.seed();
      market = new Market(bot, db, now, { reseeded: true });
      const { bids, asks } = bot.engine.snapshot();
      const users = [...bids, ...asks].filter((o) => isUserOrderId(o.id)).length;
      console.log(`${LOG} no saved book; seeded ${bids.length + asks.length - users} orders` + (users ? `, ${users} users' open orders put back` : ""));
    } else {
      const bot = new OrderbookBot(MatchingEngine.restore(saved), rng, saved.bot);
      market = new Market(bot, db, now);
      console.log(`${LOG} restored ${saved.orders.length} resting orders (sequence ${saved.sequence})`);
    }
    return new OrderbookRunner(market);
  } catch (err) {
    const what = err instanceof BookStateError || message(err).startsWith("restore:") ? "saved book is invalid" : "market failed to load";
    console.error(`${LOG} ${what}, bot NOT started (inspect cefi_book_order / cefi_book_state in the CeFi DB): ${message(err)}`);
    return null;
  }
}

// The running market for the API: null if it failed to load.
export interface MarketHandle {
  current(): OrderbookRunner | null;
}

// Load the market from the CeFi DB and start the bot in the background.
export function startOrderbookBot(db: MarketDb): MarketHandle {
  const runner = loadRunner(db);
  if (runner) run(runner);
  return { current: () => runner };
}

function run(runner: OrderbookRunner): void {
  let lastPrune = 0;
  const timer = setInterval(() => {
    try {
      runner.tick();
    } catch (err) {
      // An engine/bot bug, or a failed DB write (the market stops itself then).
      console.error(`${LOG} bot step failed, bot stopped: ${message(err)}`);
      clearInterval(timer);
      return;
    }
    if (Date.now() - lastPrune >= MARKET_DATA.pruneIntervalMs) {
      lastPrune = Date.now();
      try {
        runner.market.prune();
      } catch (err) {
        console.error(`${LOG} pruning old trades/candles failed: ${message(err)}`);
      }
    }
  }, BOT.intervalMs);
}
