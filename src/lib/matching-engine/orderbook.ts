// The book data structure + price-level management.
//
// Design (performance is an explicit NON-goal — we keep it plain and obvious):
//   * Each side is a `Map<bigint, RestingOrder[]>` (price -> FIFO queue). The
//     array at each price is in arrival order, so index 0 is the oldest (highest
//     priority) order. We append on insert, so array order always matches
//     ascending `sequence` within a level.
//   * "Best first" is computed by sorting the price keys on demand (descending
//     for bids, ascending for asks). No clever sorted tree — just `Array.sort`.
//   * A flat `index: Map<id, RestingOrder>` gives O(1) lookup for cancel/amend.

import type { RestingOrder, Side } from "./types";

// One side of the book (all bids, or all asks).
class BookSide {
  readonly side: Side;
  // price -> FIFO queue of resting orders at that price
  private readonly levels = new Map<bigint, RestingOrder[]>();

  constructor(side: Side) {
    this.side = side;
  }

  // Bids: higher price is better (descending). Asks: lower price is better
  // (ascending). Returns prices ordered best-first.
  private sortedPrices(): bigint[] {
    const prices = [...this.levels.keys()];
    // Comparator returns a number; we avoid Number(a - b) so huge bigint gaps
    // can't lose precision in the sort key.
    if (this.side === "buy") {
      prices.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // descending
    } else {
      prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // ascending
    }
    return prices;
  }

  isEmpty(): boolean {
    return this.levels.size === 0;
  }

  // Best price currently available on this side, or undefined if empty.
  bestPrice(): bigint | undefined {
    let best: bigint | undefined;
    for (const price of this.levels.keys()) {
      if (best === undefined) {
        best = price;
      } else if (this.side === "buy" ? price > best : price < best) {
        best = price;
      }
    }
    return best;
  }

  // The single highest-priority order on this side (best price, oldest in queue).
  peekBest(): RestingOrder | undefined {
    const price = this.bestPrice();
    if (price === undefined) return undefined;
    const queue = this.levels.get(price);
    return queue && queue.length > 0 ? queue[0] : undefined;
  }

  // Append an order to the back of its price level (newest = lowest priority).
  add(order: RestingOrder): void {
    const queue = this.levels.get(order.price);
    if (queue) {
      queue.push(order);
    } else {
      this.levels.set(order.price, [order]);
    }
  }

  // Remove an order. Returns true if it was present.
  remove(order: RestingOrder): boolean {
    const queue = this.levels.get(order.price);
    if (!queue) return false;
    const idx = queue.indexOf(order);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    if (queue.length === 0) this.levels.delete(order.price);
    return true;
  }

  // All orders on this side, best price first and FIFO within each level.
  ordersBestFirst(): RestingOrder[] {
    const out: RestingOrder[] = [];
    for (const price of this.sortedPrices()) {
      const queue = this.levels.get(price);
      if (queue) out.push(...queue);
    }
    return out;
  }
}

export class OrderBook {
  private readonly bids = new BookSide("buy");
  private readonly asks = new BookSide("sell");
  // Every currently-resting order, keyed by id, for fast lookup.
  private readonly index = new Map<string, RestingOrder>();

  private sideFor(side: Side): BookSide {
    return side === "buy" ? this.bids : this.asks;
  }

  hasOrder(id: string): boolean {
    return this.index.has(id);
  }

  getOrder(id: string): RestingOrder | undefined {
    return this.index.get(id);
  }

  // Place a resting order on the book.
  add(order: RestingOrder): void {
    this.sideFor(order.side).add(order);
    this.index.set(order.id, order);
  }

  // Remove a resting order by id (used by fills, cancels, amends).
  remove(id: string): RestingOrder | undefined {
    const order = this.index.get(id);
    if (!order) return undefined;
    this.sideFor(order.side).remove(order);
    this.index.delete(id);
    return order;
  }

  // Best (highest-priority) resting order on the given side, or undefined.
  peekBest(side: Side): RestingOrder | undefined {
    return this.sideFor(side).peekBest();
  }

  bestBid(): RestingOrder | undefined {
    return this.bids.peekBest();
  }

  bestAsk(): RestingOrder | undefined {
    return this.asks.peekBest();
  }

  // Snapshot helpers — return live references; the engine copies before exposing.
  bidsBestFirst(): RestingOrder[] {
    return this.bids.ordersBestFirst();
  }

  asksBestFirst(): RestingOrder[] {
    return this.asks.ordersBestFirst();
  }
}
