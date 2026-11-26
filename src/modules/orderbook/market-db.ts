// The market's durable state in the CeFi DB (tables: cefi/market-schema.ts):
// the order book and the bot's state, users' balances, orders and fills, the
// trade log, and candles. Synchronous (bun:sqlite), so Market writes each
// engine call's results — book changes and money alike — in the same step as
// the call, in ONE transaction: the book and the balances can't disagree.
// Integers are read as bigint.

import type { Database, Statement } from "bun:sqlite";
import type { RestingOrder } from "../../lib/matching-engine";
import { RESOLUTIONS, USER_ORDER_PREFIX, type Resolution } from "../../config/orderbook";
import type { BotState } from "./bot";
import type { Candle, PublicTrade, UserFill, UserOrder } from "./market";

// Saved state that can't be used. Not retryable: the market stays stopped
// instead of trading against (or overwriting) state it doesn't understand.
export class BookStateError extends Error {
  override readonly name = "BookStateError";
}

export interface SavedBook {
  sequence: number; // the engine's last sequence
  orders: RestingOrder[];
  bot: BotState;
}

export interface TradeRecord extends PublicTrade {
  makerOrderId: string;
  takerOrderId: string;
}

// Everything one engine call changed (or, with book.reset, the whole book).
export interface MarketBatch {
  book: {
    reset?: boolean; // replace every saved order with `upserts`
    upserts: RestingOrder[];
    deletes: string[];
    state: { sequence: number; bot: BotState };
  };
  balances: { userId: string; vnd: bigint; eth: bigint; at: number }[];
  orders: { userId: string; order: UserOrder }[]; // upserts
  fills: { userId: string; fill: UserFill }[];
  trades: TradeRecord[];
  candles: { resolution: Resolution; candle: Candle }[]; // upserts
}

export interface MarketDb {
  // null when no book is saved (a fresh one should be seeded).
  loadBook(): SavedBook | null;
  // Highest trade sequence saved; a reseeded engine must continue above it.
  maxTradeSeq(): number;
  // Highest user order number (the n of u<n>).
  maxOrderNumber(): number;
  // Every open user order, oldest first.
  openOrders(): { userId: string; order: UserOrder }[];
  balance(userId: string): { vnd: bigint; eth: bigint } | null;
  recentTrades(limit: number): PublicTrade[]; // newest first
  candles(resolution: Resolution, limit: number): Candle[]; // oldest first
  commit(batch: MarketBatch): void; // one transaction
  // A user's closed orders and fills, newest first, before a cursor.
  orderHistory(userId: string, limit: number, beforeId?: number): UserOrder[];
  fills(userId: string, limit: number, before?: { seq: number; role: "maker" | "taker" }): UserFill[];
  // Drop trades older than `tradesBefore` (ms) and all but the newest
  // `candlesKept` candles per resolution.
  prune(tradesBefore: number, candlesKept: number): void;
}

const num = (v: bigint | number) => Number(v);
const orderNo = (id: string) => Number(id.slice(USER_ORDER_PREFIX.length));
const big = (v: bigint | number | null) => (v === null ? null : BigInt(v));

type Row = Record<string, bigint | number | string | null>;

function toOrder(r: Row): UserOrder {
  return {
    id: `${USER_ORDER_PREFIX}${num(r.id as bigint)}`,
    side: r.side as UserOrder["side"],
    type: r.type as UserOrder["type"],
    price: big(r.price as bigint | null),
    quantity: BigInt(r.quantity!),
    filled: BigInt(r.filled!),
    quote: BigInt(r.quote!),
    status: r.status as UserOrder["status"],
    createdAt: num(r.created_at as bigint),
    updatedAt: num(r.updated_at as bigint),
  };
}

function toFill(r: Row): UserFill {
  return {
    seq: num(r.seq as bigint),
    orderId: `${USER_ORDER_PREFIX}${num(r.order_id as bigint)}`,
    side: r.side as UserFill["side"],
    price: BigInt(r.price!),
    quantity: BigInt(r.quantity!),
    quote: BigInt(r.quote!),
    role: r.role as UserFill["role"],
    at: num(r.at as bigint),
  };
}

function toBookOrder(r: Row): RestingOrder {
  if (r.side !== "buy" && r.side !== "sell") throw new BookStateError(`book order ${String(r.id)}: invalid side`);
  if (r.status !== "open" && r.status !== "partially_filled") {
    throw new BookStateError(`book order ${String(r.id)}: invalid status`);
  }
  return {
    id: r.id as string,
    side: r.side,
    price: BigInt(r.price!),
    quantity: BigInt(r.quantity!),
    remaining: BigInt(r.remaining!),
    status: r.status,
    sequence: num(r.sequence as bigint),
  };
}

export class SqliteMarketDb implements MarketDb {
  private readonly q: Record<string, Statement>;
  private readonly tx: (batch: MarketBatch) => void;

  constructor(private readonly sqlite: Database) {
    // Per statement, not for the whole DB: Better Auth shares it and expects numbers.
    // (Statement.safeIntegers is missing from bun-types.)
    const prep = (sql: string) =>
      (sqlite.query(sql) as Statement & { safeIntegers(on: boolean): Statement }).safeIntegers(true);
    this.q = {
      bookState: prep("SELECT * FROM cefi_book_state WHERE id = 1"),
      bookOrders: prep("SELECT * FROM cefi_book_order"),
      maxSeq: prep("SELECT max(seq) AS v FROM cefi_trade"),
      maxFillSeq: prep("SELECT max(seq) AS v FROM cefi_fill"),
      maxOrder: prep("SELECT max(id) AS v FROM cefi_order"),
      open: prep("SELECT * FROM cefi_order WHERE status IN ('open', 'partially_filled') ORDER BY id"),
      balance: prep("SELECT vnd, eth FROM cefi_balance WHERE user_id = ?"),
      trades: prep("SELECT * FROM cefi_trade ORDER BY seq DESC LIMIT ?"),
      candles: prep("SELECT * FROM (SELECT * FROM cefi_candle WHERE resolution = ? ORDER BY t DESC LIMIT ?) ORDER BY t"),
      history: prep(
        "SELECT * FROM cefi_order WHERE user_id = ? AND status IN ('filled', 'cancelled') AND id < ? ORDER BY id DESC LIMIT ?",
      ),
      fills: prep(
        "SELECT * FROM cefi_fill WHERE user_id = ? AND (seq < ? OR (seq = ? AND role < ?)) ORDER BY seq DESC, role DESC LIMIT ?",
      ),
      clearBook: prep("DELETE FROM cefi_book_order"),
      putBookOrder: prep(
        "INSERT INTO cefi_book_order (id, side, price, quantity, remaining, status, sequence) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET side = excluded.side, price = excluded.price, quantity = excluded.quantity, " +
          "remaining = excluded.remaining, status = excluded.status, sequence = excluded.sequence",
      ),
      deleteBookOrder: prep("DELETE FROM cefi_book_order WHERE id = ?"),
      putBookState: prep(
        "INSERT INTO cefi_book_state (id, sequence, mid, id_seq) VALUES (1, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence, mid = excluded.mid, id_seq = excluded.id_seq",
      ),
      putBalance: prep(
        "INSERT INTO cefi_balance (user_id, vnd, eth, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (user_id) DO UPDATE SET vnd = excluded.vnd, eth = excluded.eth, updated_at = excluded.updated_at",
      ),
      putOrder: prep(
        "INSERT INTO cefi_order (id, user_id, side, type, price, quantity, filled, quote, status, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET " +
          "filled = excluded.filled, quote = excluded.quote, status = excluded.status, updated_at = excluded.updated_at",
      ),
      putFill: prep(
        "INSERT INTO cefi_fill (user_id, seq, role, order_id, side, price, quantity, quote, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      putTrade: prep(
        "INSERT INTO cefi_trade (seq, price, quantity, taker_side, maker_order_id, taker_order_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      putCandle: prep(
        "INSERT INTO cefi_candle (resolution, t, open, high, low, close, volume, quote_vnd) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (resolution, t) DO UPDATE SET high = excluded.high, low = excluded.low, close = excluded.close, " +
          "volume = excluded.volume, quote_vnd = excluded.quote_vnd",
      ),
      pruneTrades: prep("DELETE FROM cefi_trade WHERE at < ?"),
      pruneCandles: prep(
        "DELETE FROM cefi_candle WHERE resolution = ? AND t < " +
          "(SELECT t FROM cefi_candle WHERE resolution = ? ORDER BY t DESC LIMIT 1 OFFSET ?)",
      ),
    };
    const q = this.q;
    this.tx = sqlite.transaction((b: MarketBatch) => {
      if (b.book.reset) q.clearBook!.run();
      for (const o of b.book.upserts) {
        q.putBookOrder!.run(o.id, o.side, o.price, o.quantity, o.remaining, o.status, o.sequence);
      }
      for (const id of b.book.deletes) q.deleteBookOrder!.run(id);
      const s = b.book.state;
      q.putBookState!.run(s.sequence, s.bot.mid, s.bot.idSeq);
      for (const x of b.balances) q.putBalance!.run(x.userId, x.vnd, x.eth, x.at);
      for (const { userId, order: o } of b.orders) {
        q.putOrder!.run(orderNo(o.id), userId, o.side, o.type, o.price, o.quantity, o.filled, o.quote, o.status, o.createdAt, o.updatedAt);
      }
      for (const { userId, fill: f } of b.fills) {
        q.putFill!.run(userId, f.seq, f.role, orderNo(f.orderId), f.side, f.price, f.quantity, f.quote, f.at);
      }
      for (const t of b.trades) q.putTrade!.run(t.seq, t.price, t.quantity, t.side, t.makerOrderId, t.takerOrderId, t.at);
      for (const { resolution, candle: c } of b.candles) {
        q.putCandle!.run(resolution, c.t, c.open, c.high, c.low, c.close, c.volume, c.quote / 1_000_000n);
      }
    });
  }

  loadBook(): SavedBook | null {
    // One read transaction, so the state row and the orders match.
    return this.sqlite.transaction(() => {
      const s = this.q.bookState!.get() as Row | null;
      const orders = (this.q.bookOrders!.all() as Row[]).map(toBookOrder);
      if (!s) {
        if (orders.length) throw new BookStateError("book orders saved without the book state row");
        return null;
      }
      return {
        sequence: num(s.sequence as bigint),
        orders,
        bot: { mid: num(s.mid as bigint), idSeq: num(s.id_seq as bigint) },
      };
    })();
  }

  maxTradeSeq(): number {
    // Fills outlive pruned trades, so they count too.
    const a = (this.q.maxSeq!.get() as Row).v;
    const b = (this.q.maxFillSeq!.get() as Row).v;
    return Math.max(num((a as bigint) ?? 0n), num((b as bigint) ?? 0n));
  }

  maxOrderNumber(): number {
    return num(((this.q.maxOrder!.get() as Row).v as bigint) ?? 0n);
  }

  openOrders() {
    return (this.q.open!.all() as Row[]).map((r) => ({ userId: r.user_id as string, order: toOrder(r) }));
  }

  balance(userId: string) {
    const r = this.q.balance!.get(userId) as Row | null;
    return r ? { vnd: BigInt(r.vnd!), eth: BigInt(r.eth!) } : null;
  }

  recentTrades(limit: number): PublicTrade[] {
    return (this.q.trades!.all(limit) as Row[]).map((r) => ({
      seq: num(r.seq as bigint),
      price: BigInt(r.price!),
      quantity: BigInt(r.quantity!),
      side: r.taker_side as PublicTrade["side"],
      at: num(r.at as bigint),
    }));
  }

  candles(resolution: Resolution, limit: number): Candle[] {
    return (this.q.candles!.all(resolution, limit) as Row[]).map((r) => ({
      t: num(r.t as bigint),
      open: BigInt(r.open!),
      high: BigInt(r.high!),
      low: BigInt(r.low!),
      close: BigInt(r.close!),
      volume: BigInt(r.volume!),
      quote: BigInt(r.quote_vnd!) * 1_000_000n,
    }));
  }

  commit(batch: MarketBatch): void {
    this.tx(batch);
  }

  orderHistory(userId: string, limit: number, beforeId = Number.MAX_SAFE_INTEGER): UserOrder[] {
    return (this.q.history!.all(userId, beforeId, limit) as Row[]).map(toOrder);
  }

  fills(userId: string, limit: number, before?: { seq: number; role: "maker" | "taker" }): UserFill[] {
    // "~" sorts after both roles: no cursor means from the newest.
    const seq = before?.seq ?? Number.MAX_SAFE_INTEGER;
    return (this.q.fills!.all(userId, seq, seq, before?.role ?? "~", limit) as Row[]).map(toFill);
  }

  prune(tradesBefore: number, candlesKept: number): void {
    this.sqlite.transaction(() => {
      this.q.pruneTrades!.run(tradesBefore);
      for (const r of RESOLUTIONS) this.q.pruneCandles!.run(r, r, candlesKept - 1);
    })();
  }
}
