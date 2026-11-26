// The matching engine: validation, the matching loop, and submit/cancel/amend.
//
// NUMBERS: prices and quantities are `bigint` (integer base units). The engine
// only ever subtracts/compares them and never computes price * quantity, so it
// is overflow-proof; downstream notional math should also stay in bigint.
//
// SEQUENCE NUMBERS (invariant 5): a SINGLE shared monotonic counter (a `number`
// ordinal) is used. A new sequence is drawn (a) for each trade as it executes,
// and (b) for an order at the moment it comes to rest on the book (its
// time-priority key). Because each submit fully completes before the next, and
// trades within a submit are drawn before the resting remainder's sequence, the
// sequence numbers carried by emitted events are strictly increasing in
// emission order.
//
// SELF-TRADE: not prevented. This simulator has no concept of accounts, so an
// incoming order may match against a resting order with the same owner — there
// is no owner. Documented here and in the README.
//
// DUPLICATE IDS: an id is "active" while an order with that id rests on the
// book. Resubmitting an active id is rejected (`duplicate_id`). Once an order
// leaves the book (filled / cancelled), its id may be reused. Orders that never
// rest (market / IOC / FOK / a fully-filling limit) do not reserve their id.

import { OrderBook } from "./orderbook";
import {
  type Event,
  orderAccepted,
  orderAmended,
  orderCancelled,
  orderFilled,
  orderRejected,
  tradeEvent,
} from "./events";
import type { NewOrder, RestingOrder, Side, Trade } from "./types";

// bigint min/max (no Math.min/max for bigint).
const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const bmax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const isBig = (x: unknown): x is bigint => typeof x === "bigint";

export class MatchingEngine {
  private readonly book = new OrderBook();
  // One shared monotonic counter for both order sequences and trade sequences.
  private seq = 0;

  private nextSeq(): number {
    return ++this.seq;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  submit(order: NewOrder): Event[] {
    const events: Event[] = [];

    // --- Validation (deterministic order: quantity, price, duplicate id) ---
    // Prices/quantities MUST be bigint; a stray `number` is rejected so float
    // precision can never leak into the book.
    if (!isBig(order.quantity) || order.quantity <= 0n) {
      events.push(orderRejected(order.id, "invalid_quantity"));
      return events;
    }

    if (order.type !== "market") {
      if (order.price === undefined) {
        events.push(orderRejected(order.id, "missing_price"));
        return events;
      }
      if (!isBig(order.price)) {
        events.push(orderRejected(order.id, "invalid_price"));
        return events;
      }
    }

    if (this.book.hasOrder(order.id)) {
      events.push(orderRejected(order.id, "duplicate_id"));
      return events;
    }

    // --- Dispatch by order type ---
    switch (order.type) {
      case "limit":
        this.processLimit(order, events);
        break;
      case "market":
        this.processMarket(order, events);
        break;
      case "ioc":
        this.processIoc(order, events);
        break;
      case "fok":
        this.processFok(order, events);
        break;
      case "post_only":
        this.processPostOnly(order, events);
        break;
    }

    return events;
  }

  cancel(orderId: string): Event[] {
    const order = this.book.getOrder(orderId);
    if (!order) {
      return [orderRejected(orderId, "unknown_order")];
    }
    const remaining = order.remaining;
    this.book.remove(orderId);
    order.status = "cancelled";
    return [orderCancelled(orderId, remaining, "cancelled")];
  }

  amend(
    orderId: string,
    changes: { price?: bigint; quantity?: bigint },
  ): Event[] {
    const order = this.book.getOrder(orderId);
    if (!order) {
      return [orderRejected(orderId, "unknown_order")];
    }

    // Validate the requested changes (same rules as submit).
    if (changes.quantity !== undefined) {
      if (!isBig(changes.quantity) || changes.quantity <= 0n) {
        return [orderRejected(orderId, "invalid_quantity")];
      }
    }
    if (changes.price !== undefined && !isBig(changes.price)) {
      return [orderRejected(orderId, "invalid_price")];
    }

    const before = this.copy(order);
    const newPrice = changes.price ?? order.price;
    const newQuantity = changes.quantity ?? order.quantity;
    const filled = order.quantity - order.remaining;

    const priceChanged = newPrice !== order.price;
    const quantityIncreased = newQuantity > order.quantity;

    // Priority-LOSING amend: price changed OR quantity increased.
    // Implemented as cancel + new submit, so it gets a fresh (higher) sequence
    // and may immediately match. See README for the event-ordering rationale.
    if (priceChanged || quantityIncreased) {
      this.book.remove(orderId);
      // Carry over only the still-open portion at the new price.
      const carriedRemaining = bmax(0n, newQuantity - filled);
      const events: Event[] = [];
      if (carriedRemaining === 0n) {
        // Nothing left to work; the amend simply retires the order.
        const after = this.copy(order);
        after.quantity = filled;
        after.remaining = 0n;
        after.status = "cancelled";
        events.push(orderAmended(before, after));
        return events;
      }
      // Re-match the carried quantity as a fresh passive limit.
      const taker: TakerState = {
        id: order.id,
        side: order.side,
        limitPrice: newPrice,
        remaining: carriedRemaining,
        original: carriedRemaining,
      };
      this.matchTaker(taker, events);
      const after = this.restOrFinalize(taker, newQuantity, filled);
      events.push(orderAmended(before, after));
      return events;
    }

    // Priority-PRESERVING amend: same price, quantity unchanged or decreased.
    // Clamp so we never reduce total below what's already filled.
    const clampedQuantity = bmax(newQuantity, filled);
    order.quantity = clampedQuantity;
    order.remaining = clampedQuantity - filled;
    if (order.remaining === 0n) {
      // Reduced all the way down to the filled amount: order leaves the book.
      this.book.remove(orderId);
      order.status = "cancelled";
    } else {
      order.status = filled > 0n ? "partially_filled" : "open";
    }
    return [orderAmended(before, this.copy(order))];
  }

  // Read-only view for tests/inspection. Both sides are best-first and the
  // returned objects are copies, so callers can't mutate the live book.
  snapshot(): { bids: RestingOrder[]; asks: RestingOrder[] } {
    return {
      bids: this.book.bidsBestFirst().map((o) => this.copy(o)),
      asks: this.book.asksBestFirst().map((o) => this.copy(o)),
    };
  }

  // -------------------------------------------------------------------------
  // Persistence support (added in zxstim-api)
  // -------------------------------------------------------------------------

  // The last sequence number drawn (0 for a fresh engine). Persist it with the
  // book so a restored engine keeps issuing strictly increasing sequences.
  get sequence(): number {
    return this.seq;
  }

  // A copy of one resting order, or undefined if it is not on the book.
  getOrder(orderId: string): RestingOrder | undefined {
    const order = this.book.getOrder(orderId);
    return order ? this.copy(order) : undefined;
  }

  // Rebuild an engine from persisted state: the resting orders plus the
  // sequence counter. Orders are re-inserted in ascending `sequence`, so FIFO
  // order within each price level is exactly what it was, and the restored
  // engine produces the same events as the original for any later operations.
  // Throws on input the engine could never have produced (it validates rather
  // than repairs, so corruption surfaces instead of being traded against).
  static restore(state: {
    sequence: number;
    orders: readonly RestingOrder[];
  }): MatchingEngine {
    if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
      throw new Error(`restore: invalid sequence ${String(state.sequence)}`);
    }
    const ids = new Set<string>();
    const sequences = new Set<number>();
    for (const o of state.orders) {
      const at = `restore: order ${JSON.stringify(o.id)}`;
      if (typeof o.id !== "string" || o.id === "") throw new Error(`${at}: invalid id`);
      if (ids.has(o.id)) throw new Error(`${at}: duplicate id`);
      if (o.side !== "buy" && o.side !== "sell") throw new Error(`${at}: invalid side`);
      if (!isBig(o.price) || !isBig(o.quantity) || !isBig(o.remaining)) {
        throw new Error(`${at}: price/quantity/remaining must be bigint`);
      }
      if (o.remaining <= 0n || o.remaining > o.quantity) {
        throw new Error(`${at}: remaining must be in (0, quantity]`);
      }
      if (o.status !== "open" && o.status !== "partially_filled") {
        throw new Error(`${at}: a resting order can't be ${String(o.status)}`);
      }
      if (
        !Number.isSafeInteger(o.sequence) ||
        o.sequence < 1 ||
        o.sequence > state.sequence
      ) {
        throw new Error(`${at}: sequence must be in [1, ${state.sequence}]`);
      }
      if (sequences.has(o.sequence)) throw new Error(`${at}: duplicate sequence`);
      ids.add(o.id);
      sequences.add(o.sequence);
    }

    const engine = new MatchingEngine();
    const ordered = [...state.orders].sort((a, b) => a.sequence - b.sequence);
    for (const o of ordered) engine.book.add({ ...o });
    engine.seq = state.sequence;

    const bid = engine.book.bestBid();
    const ask = engine.book.bestAsk();
    if (bid && ask && bid.price >= ask.price) {
      throw new Error(`restore: crossed book (best bid ${bid.price} >= best ask ${ask.price})`);
    }
    return engine;
  }

  // -------------------------------------------------------------------------
  // Per-type processing
  // -------------------------------------------------------------------------

  private processLimit(order: NewOrder, events: Event[]): void {
    // price is guaranteed present/bigint by validation above.
    const taker = this.makeTaker(order, order.price as bigint);
    this.matchTaker(taker, events);
    if (taker.remaining > 0n) {
      // Rest the remainder on the book at its limit price.
      const resting = this.makeResting(taker, taker.limitPrice as bigint);
      this.book.add(resting);
      events.push(orderAccepted(this.copy(resting)));
    } else {
      events.push(orderFilled(order.id));
    }
  }

  private processMarket(order: NewOrder, events: Event[]): void {
    // No price bound: cross any available liquidity. Never rests.
    const taker = this.makeTaker(order, undefined);
    this.matchTaker(taker, events);
    if (taker.remaining > 0n) {
      // DOCUMENTED CHOICE: unfilled market remainder is reported as an
      // order_cancelled (reason "market_remainder_unfilled"); it never rests.
      events.push(
        orderCancelled(order.id, taker.remaining, "market_remainder_unfilled"),
      );
    } else {
      events.push(orderFilled(order.id));
    }
  }

  private processIoc(order: NewOrder, events: Event[]): void {
    const taker = this.makeTaker(order, order.price as bigint);
    this.matchTaker(taker, events);
    if (taker.remaining > 0n) {
      // Immediate-or-cancel: the remainder is cancelled, never rests.
      events.push(orderCancelled(order.id, taker.remaining, "ioc_remainder"));
    } else {
      events.push(orderFilled(order.id));
    }
  }

  private processFok(order: NewOrder, events: Event[]): void {
    const limitPrice = order.price as bigint;
    // Fill-or-kill: simulate the full walk WITHOUT mutating the book first.
    if (!this.canFillFully(order.side, limitPrice, order.quantity)) {
      events.push(orderRejected(order.id, "fok_unfillable"));
      return;
    }
    // Fully fillable — now execute for real. It will consume exactly quantity.
    const taker = this.makeTaker(order, limitPrice);
    this.matchTaker(taker, events);
    // taker.remaining is 0n here by construction.
    events.push(orderFilled(order.id));
  }

  private processPostOnly(order: NewOrder, events: Event[]): void {
    const price = order.price as bigint;
    if (this.wouldCross(order.side, price)) {
      // Must not take liquidity — reject instead of crossing.
      events.push(orderRejected(order.id, "post_only_would_cross"));
      return;
    }
    // Purely passive: rest like a limit, no matching.
    const taker = this.makeTaker(order, price);
    const resting = this.makeResting(taker, price);
    this.book.add(resting);
    events.push(orderAccepted(this.copy(resting)));
  }

  // -------------------------------------------------------------------------
  // Matching core
  // -------------------------------------------------------------------------

  // Walk the opposite side, filling against the best maker first and the oldest
  // order within each level. Mutates the book (reduces/removes makers) and
  // pushes `trade` + maker `order_filled` events. Updates taker.remaining.
  private matchTaker(taker: TakerState, events: Event[]): void {
    const makerSide: Side = taker.side === "buy" ? "sell" : "buy";

    while (taker.remaining > 0n) {
      const maker = this.book.peekBest(makerSide);
      if (!maker) break; // no liquidity left
      if (!this.crosses(taker.side, taker.limitPrice, maker.price)) break;

      const fillQty = bmin(taker.remaining, maker.remaining);
      const trade: Trade = {
        takerOrderId: taker.id,
        makerOrderId: maker.id,
        price: maker.price, // execution price is always the maker's price
        quantity: fillQty,
        sequence: this.nextSeq(),
      };
      events.push(tradeEvent(trade));

      taker.remaining -= fillQty;
      maker.remaining -= fillQty;

      if (maker.remaining === 0n) {
        maker.status = "filled";
        this.book.remove(maker.id);
        events.push(orderFilled(maker.id));
      } else {
        maker.status = "partially_filled";
      }
    }
  }

  // Does a taker at `limitPrice` cross a resting maker at `makerPrice`?
  // A market order (undefined limit) crosses anything.
  private crosses(
    takerSide: Side,
    limitPrice: bigint | undefined,
    makerPrice: bigint,
  ): boolean {
    if (limitPrice === undefined) return true; // market order
    return takerSide === "buy"
      ? limitPrice >= makerPrice
      : limitPrice <= makerPrice;
  }

  // FOK fillability check: can the whole quantity be filled at acceptable
  // prices given the CURRENT book? Pure simulation — never mutates.
  private canFillFully(
    side: Side,
    limitPrice: bigint,
    quantity: bigint,
  ): boolean {
    const makers =
      side === "buy" ? this.book.asksBestFirst() : this.book.bidsBestFirst();
    let need = quantity;
    for (const maker of makers) {
      if (!this.crosses(side, limitPrice, maker.price)) break;
      need -= maker.remaining;
      if (need <= 0n) return true;
    }
    return false;
  }

  // post_only: would this order immediately match (take liquidity)?
  private wouldCross(side: Side, price: bigint): boolean {
    if (side === "buy") {
      const bestAsk = this.book.bestAsk();
      return bestAsk !== undefined && price >= bestAsk.price;
    }
    const bestBid = this.book.bestBid();
    return bestBid !== undefined && price <= bestBid.price;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private makeTaker(order: NewOrder, limitPrice: bigint | undefined): TakerState {
    return {
      id: order.id,
      side: order.side,
      limitPrice,
      remaining: order.quantity,
      original: order.quantity,
    };
  }

  // Build the resting order from a taker's leftover, assigning a fresh sequence.
  private makeResting(taker: TakerState, price: bigint): RestingOrder {
    const filled = taker.original - taker.remaining;
    return {
      id: taker.id,
      side: taker.side,
      price,
      quantity: taker.original,
      remaining: taker.remaining,
      status: filled > 0n ? "partially_filled" : "open",
      sequence: this.nextSeq(),
    };
  }

  // After re-matching an amended order: either rest its remainder (priority
  // lost — fresh sequence) or return a "filled" snapshot if it fully matched.
  // `totalQuantity`/`alreadyFilled` describe the amended order's full lifetime
  // so the snapshot reports cumulative quantity, not just the carried slice.
  private restOrFinalize(
    taker: TakerState,
    totalQuantity: bigint,
    alreadyFilled: bigint,
  ): RestingOrder {
    const newlyFilled = taker.original - taker.remaining;
    if (taker.remaining > 0n) {
      const resting: RestingOrder = {
        id: taker.id,
        side: taker.side,
        price: taker.limitPrice as bigint,
        quantity: totalQuantity,
        remaining: taker.remaining,
        status: alreadyFilled + newlyFilled > 0n ? "partially_filled" : "open",
        sequence: this.nextSeq(),
      };
      this.book.add(resting);
      return this.copy(resting);
    }
    // Fully filled by the re-match: not on the book.
    return {
      id: taker.id,
      side: taker.side,
      price: taker.limitPrice as bigint,
      quantity: totalQuantity,
      remaining: 0n,
      status: "filled",
      sequence: this.seq, // last sequence touched (the final trade)
    };
  }

  private copy(order: RestingOrder): RestingOrder {
    return { ...order };
  }
}

// Mutable working state for an in-flight taker order during matching.
// (Distinct from RestingOrder: a taker doesn't have a sequence until it rests.)
interface TakerState {
  id: string;
  side: Side;
  limitPrice: bigint | undefined; // undefined => market (no price bound)
  remaining: bigint;
  original: bigint;
}
