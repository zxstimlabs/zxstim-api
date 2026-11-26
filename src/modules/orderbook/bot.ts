// Background ETH/VND market maker: keeps the book full and moving, and trades
// now and then, so the market looks alive. Each step (BOT.intervalMs):
//
//   1. Move the price: a random walk in percentage terms (no band), with calm
//      and busy spells, slow trends, and a weak pull back toward
//      BOT.midStart over days. Candles follow this path.
//   2. Re-centre: cancel the bot's orders that are now inside the spread or
//      past the outermost level, so the book always sits around the price
//      (no stale orders left behind for takers to hit at old prices).
//   3. Quote: fill a couple of empty levels per side (the inside first), then
//      1–BOT.quoteActionsMax random adds, cancels or resizes, keeping about
//      BOT.ordersPerSide orders a side. These change only the current book.
//   4. Trade, on average once per BOT.takerEveryMs: an IOC order no more than
//      BOT.takerLimitTicks past the price. It sells into any bid above the
//      price (a user's, say) and buys any ask below it; otherwise either side.
//
// Every engine call goes through submit/cancel/amend below, which record the
// ids of orders that changed (the order itself and any makers it traded
// against). drainChanges() turns those into the upserts/deletes to persist.
//
// CeFi users trade on the same book (market.ts): their orders go through
// submitFor/cancelFor, so they are recorded the same way, and every engine
// call's events go to `listener`. The bot never cancels or resizes a user's
// order (ids starting with USER_ORDER_PREFIX); it only trades with them.
//
// Only the price and the order-id counter are saved (BotState). The spell and
// trend start afresh after a restart.

import {
  MatchingEngine,
  type Event,
  type NewOrder,
  type RestingOrder,
  type Side,
} from "../../lib/matching-engine";
import { BOT, ETH_LOTS, USER_ORDER_PREFIX, VND_TICKS } from "../../config/orderbook";

export interface BotState {
  mid: number; // the price, whole VND per ETH
  idSeq: number; // last order-id number issued
}

// Everything needed to persist the book after a step: the orders that changed
// (current state) or left the book (ids), the engine's sequence, the bot state.
export interface BookChanges {
  sequence: number;
  upserts: RestingOrder[];
  deletes: string[];
  bot: BotState;
}

// Receives the events of every engine call. `takerSide` is the side of the
// order that was submitted (undefined for cancels and amends).
export type EngineListener = (events: Event[], takerSide: Side | undefined) => void;

export const isUserOrderId = (id: string): boolean => id.startsWith(USER_ORDER_PREFIX);

export const toTicks = (vnd: number): bigint => BigInt(vnd) * BigInt(VND_TICKS);

// Group best-first orders into price levels.
export function toLevels(
  orders: readonly RestingOrder[],
): { price: bigint; total: bigint; count: number }[] {
  const out: { price: bigint; total: bigint; count: number }[] = [];
  for (const o of orders) {
    const last = out[out.length - 1];
    if (last && last.price === o.price) {
      last.total += o.remaining;
      last.count += 1;
    } else {
      out.push({ price: o.price, total: o.remaining, count: 1 });
    }
  }
  return out;
}

// --- the price process, per step ---------------------------------------------

const STEPS_PER_DAY = 86_400_000 / BOT.intervalMs;
const STEPS_PER_HOUR = 3_600_000 / BOT.intervalMs;
const SIGMA = BOT.dailyVolatility / Math.sqrt(STEPS_PER_DAY); // log-return σ per step
const PULL = Math.LN2 / (BOT.anchorHalfLifeDays * STEPS_PER_DAY); // share of the log gap closed per step
const SPELL_P = BOT.intervalMs / (BOT.spellMinutes * 60_000); // chance a new spell starts this step
const TREND_P = 1 / (BOT.trendHours * STEPS_PER_HOUR); // chance a new trend starts this step
const TREND_SIGMA = BOT.trendPerHour / STEPS_PER_HOUR; // typical trend, log-return per step
const SPELL_MIN = 0.4; // volatility multiplier of the calmest spell
const SPELL_MAX = 2; // ...and of the busiest
const TAKER_P = BOT.intervalMs / BOT.takerEveryMs; // chance of a bot trade this step

const TICK = BOT.tickVnd;

export class OrderbookBot {
  private mid: number; // VND, unrounded
  private idSeq: number;
  private spell = 1; // volatility multiplier of the current spell
  private trend = 0; // drift, log-return per step
  private readonly touched = new Set<string>();
  listener: EngineListener | null = null;

  constructor(
    readonly engine: MatchingEngine,
    private readonly rng: () => number = Math.random,
    state?: BotState,
  ) {
    this.mid = state?.mid ?? BOT.midStart;
    this.idSeq = state?.idSeq ?? 0;
  }

  get state(): BotState {
    return { mid: Math.round(this.mid), idSeq: this.idSeq };
  }

  // Seed a full two-sided book: BOT.levels levels per side, 1–2 orders each.
  seed(): void {
    for (let k = 0; k < BOT.levels; k++) {
      const perLevel = this.randInt(1, 2);
      for (let n = 0; n < perLevel; n++) {
        this.add("buy", k);
        this.add("sell", k);
      }
    }
  }

  step(): void {
    this.movePrice();
    this.recentre();
    this.quote();
    if (this.rng() < TAKER_P) this.take();
  }

  // The bot's price levels: level 0 is the inside quote, half a tick or more
  // from the price, so the bot's spread is one or two ticks.
  bidLevel(k: number): number {
    return (Math.floor((this.mid - TICK / 2) / TICK) - k) * TICK;
  }

  askLevel(k: number): number {
    return (Math.ceil((this.mid + TICK / 2) / TICK) + k) * TICK;
  }

  // The orders touched since the last drain, as upserts (still resting) and
  // deletes (left the book, or never rested).
  drainChanges(): BookChanges {
    const upserts: RestingOrder[] = [];
    const deletes: string[] = [];
    for (const id of this.touched) {
      const order = this.engine.getOrder(id);
      if (order) upserts.push(order);
      else deletes.push(id);
    }
    this.touched.clear();
    return { sequence: this.engine.sequence, upserts, deletes, bot: this.state };
  }

  // The whole book, for a full re-sync (store with reset).
  fullState(): BookChanges {
    this.touched.clear();
    const { bids, asks } = this.engine.snapshot();
    return { sequence: this.engine.sequence, upserts: [...bids, ...asks], deletes: [], bot: this.state };
  }

  // --- one step ---------------------------------------------------------------

  private movePrice(): void {
    if (this.rng() < SPELL_P) this.spell = this.logUniform(SPELL_MIN, SPELL_MAX);
    if (this.rng() < TREND_P) this.trend = this.gaussian() * TREND_SIGMA;
    const gap = Math.log(this.mid / BOT.midStart);
    this.mid *= Math.exp(this.trend - PULL * gap + SIGMA * this.spell * this.gaussian());
  }

  // Cancel the bot's orders inside the spread or past the outermost level.
  private recentre(): void {
    const [bidTop, bidEnd] = [toTicks(this.bidLevel(0)), toTicks(this.bidLevel(BOT.levels - 1))];
    const [askTop, askEnd] = [toTicks(this.askLevel(0)), toTicks(this.askLevel(BOT.levels - 1))];
    const { bids, asks } = this.engine.snapshot();
    for (const o of bids) if (!isUserOrderId(o.id) && (o.price > bidTop || o.price < bidEnd)) this.cancel(o.id);
    for (const o of asks) if (!isUserOrderId(o.id) && (o.price < askTop || o.price > askEnd)) this.cancel(o.id);
  }

  private quote(): void {
    // Keep the levels filled, the inside first: at most two new orders a side.
    for (const side of ["buy", "sell"] as const) {
      const prices = new Set(this.sideOrders(side, true).map((o) => o.price));
      let added = 0;
      for (let k = 0; k < BOT.levels && added < 2; k++) {
        if (!prices.has(toTicks(this.levelPrice(side, k)))) {
          this.add(side, k);
          added++;
        }
      }
    }
    // Then a few random changes, holding each side near BOT.ordersPerSide.
    const actions = this.randInt(1, BOT.quoteActionsMax);
    for (let i = 0; i < actions; i++) {
      const side: Side = this.rng() < 0.5 ? "buy" : "sell";
      const mine = this.sideOrders(side, false);
      const roll = this.rng();
      const grow = mine.length < BOT.ordersPerSide;
      if (mine.length === 0 || (grow && roll < 0.6) || (!grow && roll < 0.15)) {
        // Inside levels are likelier: k = levels × u² puts about a quarter on level 0.
        this.add(side, Math.floor(BOT.levels * this.rng() ** 2));
      } else if (roll < 0.85) {
        this.cancel(this.pick(mine).id);
      } else {
        this.amend(this.pick(mine).id, { quantity: this.makerLots() });
      }
    }
  }

  // A bot trade near the price.
  private take(): void {
    const { bids, asks } = this.engine.snapshot();
    const price = toTicks(Math.round(this.mid));
    let side: Side;
    if (bids[0] && bids[0].price > price) side = "sell";
    else if (asks[0] && asks[0].price < price) side = "buy";
    else side = this.rng() < 0.5 ? "buy" : "sell";
    const limit = side === "buy" ? this.askLevel(BOT.takerLimitTicks - 1) : this.bidLevel(BOT.takerLimitTicks - 1);
    this.submit({ id: this.nextId("t"), side, type: "ioc", price: toTicks(limit), quantity: this.takerLots() });
  }

  private add(side: Side, k: number): void {
    const id = this.nextId(side === "buy" ? "b" : "a");
    this.submit({ id, side, type: "limit", price: toTicks(this.levelPrice(side, k)), quantity: this.makerLots() });
  }

  private levelPrice(side: Side, k: number): number {
    return side === "buy" ? this.bidLevel(k) : this.askLevel(k);
  }

  private sideOrders(side: Side, withUsers: boolean): RestingOrder[] {
    const { bids, asks } = this.engine.snapshot();
    const orders = side === "buy" ? bids : asks;
    return withUsers ? orders : orders.filter((o) => !isUserOrderId(o.id));
  }

  // --- engine calls for others (CeFi users), recorded like the bot's own ----

  submitFor(order: NewOrder): Event[] {
    return this.submit(order);
  }

  cancelFor(id: string): Event[] {
    return this.cancel(id);
  }

  // --- engine calls, recording what changed --------------------------------

  private submit(order: NewOrder): Event[] {
    return this.track(order.id, this.engine.submit(order), order.side);
  }

  private cancel(id: string): Event[] {
    return this.track(id, this.engine.cancel(id));
  }

  private amend(id: string, changes: { price?: bigint; quantity?: bigint }): Event[] {
    return this.track(id, this.engine.amend(id, changes));
  }

  private track(id: string, events: Event[], takerSide?: Side): Event[] {
    this.touched.add(id);
    for (const e of events) if (e.type === "trade") this.touched.add(e.trade.makerOrderId);
    this.listener?.(events, takerSide);
    return events;
  }

  // --- randomness -----------------------------------------------------------

  private nextId(prefix: string): string {
    return `${prefix}${++this.idSeq}`;
  }

  private randInt(lo: number, hi: number): number {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rng() * xs.length)]!;
  }

  private logUniform(lo: number, hi: number): number {
    return lo * (hi / lo) ** this.rng();
  }

  // Standard normal (Box–Muller).
  private gaussian(): number {
    const u = 1 - this.rng(); // (0, 1]
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rng());
  }

  // A log-uniform size in ETH, on a 0.001 ETH grid, in lots.
  private lots(minEth: number, maxEth: number): bigint {
    const steps = Math.max(1, Math.round(this.logUniform(minEth, maxEth) * 1000));
    return BigInt(steps * (ETH_LOTS / 1000));
  }

  private makerLots(): bigint {
    return this.lots(BOT.makerEthMin, BOT.makerEthMax);
  }

  private takerLots(): bigint {
    return this.lots(BOT.takerEthMin, BOT.takerEthMax);
  }
}
