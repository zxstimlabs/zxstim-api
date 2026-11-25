// Background ETH/VND market bot: keeps the book alive with random orders.
//
// Ported from cex-orderbook-matching-engine's scripts/test.script.ts (minus the
// terminal rendering). Each step: random-walk the mid within its band, then
// submit a passive limit (58%), an aggressive market/IOC taker (24%), a cancel
// (10%) or an amend (8%), and finally trim each side to BOT.maxLevels levels.
//
// Every engine call goes through submit/cancel/amend below, which record the
// ids of orders that changed (the order itself and any makers it traded
// against). drainChanges() turns those into the upserts/deletes to persist.

import {
  MatchingEngine,
  type Event,
  type NewOrder,
  type RestingOrder,
  type Side,
} from "../../lib/matching-engine";
import { BOT, ETH_LOTS, VND_TICKS } from "../../config/orderbook";

export interface BotState {
  mid: number; // VND per ETH, a multiple of BOT.tickVnd
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

export class OrderbookBot {
  private mid: number;
  private idSeq: number;
  private readonly touched = new Set<string>();

  constructor(
    readonly engine: MatchingEngine,
    private readonly rng: () => number = Math.random,
    state?: BotState,
  ) {
    this.mid = state?.mid ?? BOT.midStart;
    this.idSeq = state?.idSeq ?? 0;
  }

  get state(): BotState {
    return { mid: this.mid, idSeq: this.idSeq };
  }

  // Seed a deep two-sided book: BOT.maxLevels levels per side, 1–2 orders each.
  seed(): void {
    for (let lvl = 1; lvl <= BOT.maxLevels; lvl++) {
      const perLevel = this.randInt(1, 2);
      for (let k = 0; k < perLevel; k++) {
        this.submit({ id: this.nextId("b"), side: "buy", type: "limit", price: toTicks(this.mid - lvl * BOT.tickVnd), quantity: this.randLots() });
        this.submit({ id: this.nextId("a"), side: "sell", type: "limit", price: toTicks(this.mid + lvl * BOT.tickVnd), quantity: this.randLots() });
      }
    }
  }

  step(): void {
    // Random-walk the mid by one tick so the band drifts, but stay bounded.
    if (this.rng() < 0.4) this.mid += this.rng() < 0.5 ? -BOT.tickVnd : BOT.tickVnd;
    this.mid = Math.max(BOT.midMin, Math.min(BOT.midMax, this.mid));

    const snap = this.engine.snapshot();
    const restingIds = [...snap.bids, ...snap.asks].map((o) => o.id);
    const roll = this.rng();

    if (roll < 0.58) {
      // Passive limit resting away from the mid: builds depth across the ladder.
      const side: Side = this.rng() < 0.5 ? "buy" : "sell";
      const offset = this.randInt(1, BOT.maxLevels);
      const priceVnd = side === "buy" ? this.mid - offset * BOT.tickVnd : this.mid + offset * BOT.tickVnd;
      this.submit({ id: this.nextId(side === "buy" ? "b" : "a"), side, type: "limit", price: toTicks(priceVnd), quantity: this.randLots() });
    } else if (roll < 0.82) {
      // An aggressive taker (market or crossing IOC) to chew through depth.
      const side: Side = this.rng() < 0.5 ? "buy" : "sell";
      const quantity = this.randLots();
      const id = this.nextId("t");
      const order: NewOrder =
        this.rng() < 0.5
          ? { id, side, type: "market", quantity }
          : { id, side, type: "ioc", price: toTicks(side === "buy" ? this.mid + 4 * BOT.tickVnd : this.mid - 4 * BOT.tickVnd), quantity };
      this.submit(order);
    } else if (roll < 0.92 && restingIds.length > 0) {
      this.cancel(this.pick(restingIds));
    } else if (restingIds.length > 0) {
      const id = this.pick(restingIds);
      const changes =
        this.rng() < 0.5
          ? { price: toTicks(this.mid + this.randInt(-BOT.maxLevels, BOT.maxLevels) * BOT.tickVnd) }
          : { quantity: this.randLots() };
      this.amend(id, changes);
    }

    this.trimToDepth();
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

  // Keep each side to at most BOT.maxLevels price levels by cancelling the
  // worst-priced (deepest) levels.
  private trimToDepth(): void {
    for (const side of ["buy", "sell"] as const) {
      const snap = this.engine.snapshot();
      const orders = side === "buy" ? snap.bids : snap.asks;
      const levels = toLevels(orders); // best-first
      if (levels.length <= BOT.maxLevels) continue;
      const drop = new Set(levels.slice(BOT.maxLevels).map((l) => l.price));
      for (const o of orders) if (drop.has(o.price)) this.cancel(o.id);
    }
  }

  // --- engine calls, recording what changed --------------------------------

  private submit(order: NewOrder): void {
    this.track(order.id, this.engine.submit(order));
  }

  private cancel(id: string): void {
    this.track(id, this.engine.cancel(id));
  }

  private amend(id: string, changes: { price?: bigint; quantity?: bigint }): void {
    this.track(id, this.engine.amend(id, changes));
  }

  private track(id: string, events: Event[]): void {
    this.touched.add(id);
    for (const e of events) if (e.type === "trade") this.touched.add(e.trade.makerOrderId);
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

  // A random size in [BOT.ethMin, BOT.ethMax] ETH on a 0.01 ETH grid, in lots.
  private randLots(): bigint {
    const lo = Math.round(BOT.ethMin * 100);
    const hi = Math.round(BOT.ethMax * 100);
    return BigInt(this.randInt(lo, hi) * (ETH_LOTS / 100));
  }
}
