// Shared test utilities (not a *.test.ts file, so the runner won't execute it).

import type {
  NewOrder,
  OrderType,
  Side,
  Event,
  OrderAcceptedEvent,
  OrderAmendedEvent,
  OrderCancelledEvent,
  OrderFilledEvent,
  OrderRejectedEvent,
  TradeEvent,
} from "../../lib/matching-engine";
import { MatchingEngine } from "../../lib/matching-engine";

// Typed filters for pulling specific events out of a result list.
export const trades = (events: Event[]): TradeEvent[] =>
  events.filter((e): e is TradeEvent => e.type === "trade");

export const accepts = (events: Event[]): OrderAcceptedEvent[] =>
  events.filter((e): e is OrderAcceptedEvent => e.type === "order_accepted");

export const rejects = (events: Event[]): OrderRejectedEvent[] =>
  events.filter((e): e is OrderRejectedEvent => e.type === "order_rejected");

export const cancels = (events: Event[]): OrderCancelledEvent[] =>
  events.filter((e): e is OrderCancelledEvent => e.type === "order_cancelled");

export const fills = (events: Event[]): OrderFilledEvent[] =>
  events.filter((e): e is OrderFilledEvent => e.type === "order_filled");

export const amends = (events: Event[]): OrderAmendedEvent[] =>
  events.filter((e): e is OrderAmendedEvent => e.type === "order_amended");

// Assert the core book invariants on the engine's current state.
export function assertBookInvariants(engine: MatchingEngine): void {
  const { bids, asks } = engine.snapshot();

  // Invariant 2: every resting order has remaining > 0.
  for (const o of [...bids, ...asks]) {
    if (o.remaining <= 0n) {
      throw new Error(`remaining <= 0 for resting order ${o.id}`);
    }
  }

  // Invariant 1: book is never crossed.
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (bestBid && bestAsk && bestBid.price >= bestAsk.price) {
    throw new Error(
      `crossed book: best bid ${bestBid.price} >= best ask ${bestAsk.price}`,
    );
  }

  // bids best-first => descending price; asks best-first => ascending price.
  for (let i = 1; i < bids.length; i++) {
    if (bids[i]!.price > bids[i - 1]!.price) {
      throw new Error("bids not sorted best-first (descending)");
    }
  }
  for (let i = 1; i < asks.length; i++) {
    if (asks[i]!.price < asks[i - 1]!.price) {
      throw new Error("asks not sorted best-first (ascending)");
    }
  }
}

// --- A small, deterministic op-script generator (no Math.random / Date) ------

export type Op =
  | { kind: "submit"; order: NewOrder }
  | { kind: "cancel"; id: string }
  | { kind: "amend"; id: string; changes: { price?: bigint; quantity?: bigint } };

// mulberry32: a tiny seeded PRNG so the script is fixed and reproducible.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildScript(seed: number, count: number): Op[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  // Returns a bigint in [lo, hi].
  const bigIn = (lo: number, hi: number) => BigInt(lo + Math.floor(rnd() * (hi - lo + 1)));

  const ids = ["o0", "o1", "o2", "o3", "o4", "o5", "o6", "o7"] as const;
  const sides: Side[] = ["buy", "sell"];
  const types: OrderType[] = ["limit", "market", "ioc", "fok", "post_only"];

  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rnd();
    if (roll < 0.7) {
      const type = pick(types);
      const order: NewOrder = {
        id: pick(ids),
        side: pick(sides),
        type,
        quantity: bigIn(1, 9),
      };
      if (type !== "market") order.price = bigIn(95, 105);
      ops.push({ kind: "submit", order });
    } else if (roll < 0.85) {
      ops.push({ kind: "cancel", id: pick(ids) });
    } else {
      const changes: { price?: bigint; quantity?: bigint } = {};
      if (rnd() < 0.5) changes.price = bigIn(95, 105);
      if (rnd() < 0.5) changes.quantity = bigIn(1, 9);
      ops.push({ kind: "amend", id: pick(ids), changes });
    }
  }
  return ops;
}

export function applyOp(engine: MatchingEngine, op: Op): Event[] {
  switch (op.kind) {
    case "submit":
      return engine.submit(op.order);
    case "cancel":
      return engine.cancel(op.id);
    case "amend":
      return engine.amend(op.id, op.changes);
  }
}
