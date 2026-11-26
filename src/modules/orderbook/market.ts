// CeFi users trading ETH/VND on the bot's book, plus the public market data
// (recent trades, candles, ticker, depth) built from every trade.
//
// One Market wraps one OrderbookBot. User orders go into the same engine
// through bot.submitFor/cancelFor, and the bot reports the events of every
// engine call (its own and the users') to onEvents, which settles user fills
// and records trades and candles. Everything here is synchronous, so a
// request's checks, its engine call and its settlement happen in one step,
// with no bot step or other request in between.
//
// Persistence: everything is in the CeFi DB (market-db.ts): the book and the
// bot's state, users' balances, orders and fills, the trade log and candles.
// Matching runs in memory; at the end of every engine call, what it changed —
// book orders and money alike — is written in ONE transaction, in the same
// synchronous step. So the saved book and the saved balances always agree,
// and the DB is never behind the engine (a crash loses nothing that was
// answered). On boot the book is restored from the DB and checked against
// the users' open orders.
//
// Money (all integers, see config/orderbook.ts):
//   ETH balances and quantities in lots (ETH × 10^4)
//   prices in ticks (VND × 100)
//   VND balances and fill costs in quote units (ticks × lots = VND × 10^6)
//
// Balances: `vnd`/`eth` are what's available. A resting limit order locks what
// it could spend (buy: price × remaining VND; sell: remaining ETH), taken from
// the available balance when it's placed and given back as it fills or when
// it's cancelled. A limit buy that fills below its price gets the difference
// back. Market orders lock nothing: they are checked against the book and
// settle in the same synchronous call. No fees.

import type { Event, RestingOrder, Side, Trade } from "../../lib/matching-engine";
import {
  CANDLE_RESOLUTIONS,
  ETH_LOTS,
  MARKET_DATA,
  ORDERBOOK_MARKET,
  QUOTE_UNITS_PER_VND,
  RESOLUTIONS,
  USER_ORDER_PREFIX,
  USERS,
  VND_TICKS,
  type Resolution,
} from "../../config/orderbook";
import { isUserOrderId, toLevels, toTicks, type OrderbookBot } from "./bot";
import { BookStateError, type MarketBatch, type MarketDb } from "./market-db";

// --- model -----------------------------------------------------------------

export type UserOrderType = "limit" | "market";
export type UserOrderStatus = "open" | "partially_filled" | "filled" | "cancelled";

export interface UserOrder {
  id: string; // u<n>
  side: Side;
  type: UserOrderType;
  price: bigint | null; // ticks; null for market orders
  quantity: bigint; // lots
  filled: bigint; // lots
  quote: bigint; // quote units paid (buy) or received (sell) so far
  status: UserOrderStatus;
  createdAt: number; // ms
  updatedAt: number;
}

export interface UserFill {
  seq: number; // the trade's engine sequence
  orderId: string;
  side: Side;
  price: bigint; // ticks
  quantity: bigint; // lots
  quote: bigint; // quote units
  role: "maker" | "taker";
  at: number;
}

// The working copy of an account: balances and open orders. Closed orders and
// fills are only in the DB.
export interface Account {
  vnd: bigint; // available, quote units
  eth: bigint; // available, lots
  open: Map<string, UserOrder>; // in placement order
  version: number; // bumps on every change (for ETags; not saved)
}

export interface Candle {
  t: number; // bucket start, unix seconds
  open: bigint; // ticks
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint; // lots
  quote: bigint; // quote units
}

export interface PublicTrade {
  seq: number;
  price: bigint;
  quantity: bigint;
  side: Side; // the taker's side
  at: number;
}

export interface PlaceOrder {
  side: Side;
  type: UserOrderType;
  price?: bigint; // ticks, limit orders only
  quantity: bigint; // lots
}

export type MarketError = { ok: false; status: number; code: string; error: string };
export type MarketResult<T> = { ok: true; value: T } | MarketError;

const fail = (status: number, code: string, error: string): MarketError => ({ ok: false, status, code, error });

export const MIN_LOTS = BigInt(Math.round(USERS.minEth * ETH_LOTS));
export const MAX_LOTS = BigInt(Math.round(USERS.maxEth * ETH_LOTS));
export const START_VND = BigInt(USERS.startVnd) * BigInt(QUOTE_UNITS_PER_VND);
export const START_ETH = BigInt(USERS.startEth * ETH_LOTS);
const TICKS_PER_VND = BigInt(VND_TICKS);
const HISTORY_IN_ACCOUNT = 100; // closed orders and fills in GET /me/account

// --- JSON views (human units, plain numbers) -------------------------------

const vnd = (ticks: bigint) => Number(ticks) / VND_TICKS;
const eth = (lots: bigint) => Number(lots) / ETH_LOTS;
const quoteVnd = (quote: bigint) => Number(quote) / QUOTE_UNITS_PER_VND;

export function orderView(o: UserOrder) {
  return {
    id: o.id,
    side: o.side,
    type: o.type,
    price: o.price === null ? null : vnd(o.price),
    quantity: eth(o.quantity),
    filled: eth(o.filled),
    // Average fill price, VND per ETH.
    avgPrice: o.filled > 0n ? Number(o.quote) / Number(o.filled) / VND_TICKS : null,
    total: quoteVnd(o.quote),
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
export type OrderView = ReturnType<typeof orderView>;

export function fillView(f: UserFill) {
  return {
    // A self-trade gives the account two fills with the same sequence.
    id: `${f.seq}-${f.role}`,
    orderId: f.orderId,
    side: f.side,
    price: vnd(f.price),
    quantity: eth(f.quantity),
    total: quoteVnd(f.quote),
    role: f.role,
    time: f.at,
  };
}

// --- the market ------------------------------------------------------------

export class Market {
  private readonly accounts = new Map<string, Account>(); // loaded or created so far
  private readonly owners = new Map<string, string>(); // open user order id → user id
  private userSeq: number; // last user order number issued
  private trades: PublicTrade[]; // newest first
  private readonly candles = new Map<Resolution, Candle[]>(); // oldest first

  // Changed by the current engine call; written to the DB at its end.
  private pending = emptyPending();
  // Set when a DB write failed: memory is ahead of the record, so stop.
  private failure: Error | null = null;
  // The book state last written (sequence, mid, idSeq), to skip idle saves.
  private savedState = "";

  // Bumps on every engine call; the public snapshot is cached per version.
  private version = 0;
  private cached: { version: number; etag: string; body: string } | null = null;
  // Part of every ETag, so a restart (versions start over) never matches an old one.
  private readonly boot = crypto.randomUUID().slice(0, 8);

  // Loads the users' open orders, recent trades and candles from the DB.
  // `bot`: restored from the DB's saved book, whose user orders must be
  // exactly the DB's open orders (they're written together; anything else is
  // a BookStateError). `reseeded`: there was no saved book (first start, or
  // the book was reset), so `bot` holds a fresh one: it's saved whole, and the
  // users' open orders are put back on it at their remaining size (any that
  // cross trade at once).
  constructor(
    readonly bot: OrderbookBot,
    readonly db: MarketDb,
    private readonly now: () => number = Date.now,
    opts: { reseeded?: boolean } = {},
  ) {
    this.userSeq = db.maxOrderNumber();
    this.trades = db.recentTrades(MARKET_DATA.tradesLimit);
    for (const r of RESOLUTIONS) this.candles.set(r, db.candles(r, MARKET_DATA.candleLimit));

    const open = db.openOrders();
    for (const { userId, order } of open) {
      const account = this.accounts.get(userId) ?? this.loadAccount(userId) ?? newAccount();
      this.accounts.set(userId, account);
      account.open.set(order.id, order);
      this.owners.set(order.id, userId);
    }

    if (opts.reseeded) {
      bot.listener = (events, takerSide) => this.onEvents(events, takerSide);
      this.commitFullBook();
      for (const { order: o } of open) {
        bot.submitFor({ id: o.id, side: o.side, type: "limit", price: o.price!, quantity: o.quantity - o.filled });
      }
      return;
    }

    for (const { userId, order: o } of open) {
      const resting = bot.engine.getOrder(o.id);
      if (!resting || resting.side !== o.side || resting.price !== o.price || resting.remaining !== o.quantity - o.filled) {
        throw new BookStateError(`open order ${o.id} (user ${userId}) doesn't match the saved book`);
      }
    }
    const { bids, asks } = bot.engine.snapshot();
    for (const o of [...bids, ...asks]) {
      if (isUserOrderId(o.id) && !this.owners.has(o.id)) {
        throw new BookStateError(`book order ${o.id} is not an open order of any account`);
      }
    }
    if (db.maxTradeSeq() > bot.engine.sequence) {
      throw new BookStateError(`the book's sequence (${bot.engine.sequence}) is behind the trade log (${db.maxTradeSeq()})`);
    }
    this.savedState = this.stateKey();
    bot.listener = (events, takerSide) => this.onEvents(events, takerSide);
  }

  // False once a DB write has failed: the bot stops and the API refuses
  // orders until a restart rebuilds from the DB.
  get healthy(): boolean {
    return this.failure === null;
  }

  // --- user actions ----------------------------------------------------------

  placeOrder(userId: string, req: PlaceOrder): MarketResult<OrderView> {
    const account = this.accounts.get(userId) ?? this.loadAccount(userId) ?? newAccount();
    const { side, type, quantity } = req;

    if (quantity < MIN_LOTS || quantity > MAX_LOTS) {
      return fail(400, "invalid_quantity", `Quantity must be between ${USERS.minEth} and ${USERS.maxEth} ETH`);
    }
    const { bids, asks } = this.bot.engine.snapshot();
    let cost: bigint; // VND quote units for a buy, ETH lots for a sell
    let price: bigint | null = null;

    if (type === "limit") {
      if (req.price === undefined || req.price <= 0n || req.price % TICKS_PER_VND !== 0n) {
        return fail(400, "invalid_price", "Price must be a whole number of VND");
      }
      price = req.price;
      const ref = this.referencePrice(bids, asks);
      const band = BigInt(Math.round(USERS.priceBand * 1000));
      const lo = (ref * (1000n - band)) / 1000n;
      const hi = (ref * (1000n + band)) / 1000n;
      if (price < lo || price > hi) {
        return fail(400, "price_out_of_band", `Price must be between ${vnd(lo)} and ${vnd(hi)} VND`);
      }
      if (account.open.size >= USERS.maxOpenOrders) {
        return fail(409, "too_many_orders", `At most ${USERS.maxOpenOrders} open orders`);
      }
      cost = side === "buy" ? price * quantity : quantity;
    } else {
      const makers = side === "buy" ? asks : bids;
      if (makers.length === 0) return fail(409, "no_liquidity", "No orders on the other side of the book");
      cost = side === "buy" ? walkCost(makers, quantity) : quantity;
    }

    if (side === "buy" ? account.vnd < cost : account.eth < cost) {
      return fail(409, "insufficient_balance", `Not enough ${side === "buy" ? "VND" : "ETH"}`);
    }
    this.ensureHealthy();

    // Committed from here on.
    this.accounts.set(userId, account);
    const at = this.now();
    const order: UserOrder = {
      id: `${USER_ORDER_PREFIX}${++this.userSeq}`,
      side,
      type,
      price,
      quantity,
      filled: 0n,
      quote: 0n,
      status: "open",
      createdAt: at,
      updatedAt: at,
    };
    if (type === "limit") {
      if (side === "buy") account.vnd -= cost;
      else account.eth -= cost;
    }
    account.open.set(order.id, order);
    this.owners.set(order.id, userId);
    this.touchOrder(userId, order);
    // Fills, resting or closing are applied (and saved) by onEvents during this call.
    this.bot.submitFor({ id: order.id, side, type, price: price ?? undefined, quantity });
    return { ok: true, value: orderView(order) };
  }

  cancelOrder(userId: string, orderId: string): MarketResult<OrderView> {
    const order = this.accounts.get(userId)?.open.get(orderId);
    if (!order) return fail(404, "unknown_order", "No such open order");
    this.ensureHealthy();
    this.bot.cancelFor(orderId);
    return { ok: true, value: orderView(order) };
  }

  cancelAll(userId: string): number {
    const ids = [...(this.accounts.get(userId)?.open.keys() ?? [])];
    if (ids.length) this.ensureHealthy();
    for (const id of ids) this.bot.cancelFor(id);
    return ids.length;
  }

  // Save the bot's state if a step changed it without an engine call (its mid
  // walks every step). Called by the runner after each step.
  saveBotState(): void {
    if (this.stateKey() === this.savedState) return;
    this.ensureHealthy();
    this.commit(this.now());
  }

  // Drop old trades and candles from the DB (hourly, from the runner).
  prune(): void {
    this.db.prune(this.now() - MARKET_DATA.tradeRetentionDays * 24 * 60 * 60 * 1000, MARKET_DATA.candleLimit);
  }

  // --- views -------------------------------------------------------------------

  // The working copy of an account, if loaded (tests and inspection; don't mutate).
  accountState(userId: string): Readonly<Account> | undefined {
    return this.accounts.get(userId);
  }

  account(userId: string) {
    const a = this.accounts.get(userId) ?? this.loadAccount(userId) ?? newAccount();
    let vndLocked = 0n;
    let ethLocked = 0n;
    for (const o of a.open.values()) {
      if (o.side === "buy") vndLocked += o.price! * (o.quantity - o.filled);
      else ethLocked += o.quantity - o.filled;
    }
    return {
      balances: {
        vnd: { available: quoteVnd(a.vnd), locked: quoteVnd(vndLocked) },
        eth: { available: eth(a.eth), locked: eth(ethLocked) },
      },
      openOrders: [...a.open.values()].reverse().map(orderView),
      orderHistory: this.db.orderHistory(userId, HISTORY_IN_ACCOUNT).map(orderView),
      trades: this.db.fills(userId, HISTORY_IN_ACCOUNT).map(fillView),
    };
  }

  accountEtag(userId: string): string {
    return `W/"${this.boot}-${userId}-${this.accounts.get(userId)?.version ?? 0}"`;
  }

  // The public snapshot as JSON text, rebuilt at most once per engine call.
  publicSnapshot(): { etag: string; body: string } {
    if (this.cached?.version !== this.version) {
      const { bids, asks } = this.bot.engine.snapshot();
      const depth = (orders: RestingOrder[]) =>
        toLevels(orders)
          .slice(0, MARKET_DATA.depthLevels)
          .map((l) => ({ price: vnd(l.price), quantity: eth(l.total), count: l.count }));
      const body = JSON.stringify({
        market: ORDERBOOK_MARKET,
        ticker: this.ticker(),
        depth: { bids: depth(bids), asks: depth(asks) },
        trades: this.trades.slice(0, 50).map((t) => ({
          id: t.seq,
          price: vnd(t.price),
          quantity: eth(t.quantity),
          side: t.side,
          time: t.at,
        })),
        updatedAt: this.now(),
      });
      this.cached = { version: this.version, etag: `W/"${this.boot}-${this.version}"`, body };
    }
    return { etag: this.cached.etag, body: this.cached.body };
  }

  // Oldest first, at most `limit`.
  candlesFor(resolution: Resolution, limit: number) {
    return this.candles
      .get(resolution)!
      .slice(-limit)
      .map((c) => ({
        t: c.t,
        open: vnd(c.open),
        high: vnd(c.high),
        low: vnd(c.low),
        close: vnd(c.close),
        volume: eth(c.volume),
      }));
  }

  // Last price and rolling 24 h stats from the 1-minute candles; null before
  // the first trade.
  private ticker() {
    const last = this.trades[0];
    if (!last) return null;
    const since = Math.floor(this.now() / 1000) - 24 * 60 * 60;
    const day = this.candles.get("1m")!.filter((c) => c.t >= since);
    const open = day[0]?.open ?? last.price;
    let high = last.price;
    let low = last.price;
    let volume = 0n;
    let quote = 0n;
    for (const c of day) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
      quote += c.quote;
    }
    const change = last.price - open;
    return {
      last: vnd(last.price),
      open24h: vnd(open),
      high24h: vnd(high),
      low24h: vnd(low),
      change24h: vnd(change),
      changePct24h: open > 0n ? (Number(change) / Number(open)) * 100 : 0,
      volume24h: eth(volume),
      quoteVolume24h: quoteVnd(quote),
    };
  }

  // The price limit orders are banded around: the last trade, else the
  // book's mid, else the bot's mid.
  private referencePrice(bids: RestingOrder[], asks: RestingOrder[]): bigint {
    if (this.trades[0]) return this.trades[0].price;
    const bid = bids[0]?.price;
    const ask = asks[0]?.price;
    if (bid !== undefined && ask !== undefined) return (bid + ask) / 2n;
    return bid ?? ask ?? toTicks(this.bot.state.mid);
  }

  // --- engine events -------------------------------------------------------

  private onEvents(events: Event[], takerSide: Side | undefined): void {
    this.ensureHealthy();
    this.version++;
    // A re-pricing amend re-matches the amended order as the taker.
    const side = takerSide ?? events.find((e) => e.type === "order_amended")?.before.side ?? "buy";
    const at = this.now();
    for (const e of events) {
      switch (e.type) {
        case "trade":
          this.onTrade(e.trade, side, at);
          break;
        case "order_filled":
          this.close(e.orderId, "filled", at);
          break;
        case "order_cancelled":
        case "order_rejected": // never for a user order: they're checked before submitting
          this.close(e.orderId, "cancelled", at);
          break;
        // order_accepted: fills already set the status; order_amended: bot orders only.
      }
    }
    this.commit(at);
  }

  private onTrade(trade: Trade, takerSide: Side, at: number): void {
    const quote = trade.price * trade.quantity;
    const pub: PublicTrade = { seq: trade.sequence, price: trade.price, quantity: trade.quantity, side: takerSide, at };
    this.trades.unshift(pub);
    if (this.trades.length > MARKET_DATA.tradesLimit) this.trades.length = MARKET_DATA.tradesLimit;
    this.pending.trades.push({ ...pub, makerOrderId: trade.makerOrderId, takerOrderId: trade.takerOrderId });
    this.addToCandles(trade.price, trade.quantity, quote, at);
    this.settle(trade.makerOrderId, trade, quote, "maker", at);
    this.settle(trade.takerOrderId, trade, quote, "taker", at);
  }

  // Apply one fill to a user's order and balances (no-op for bot orders).
  private settle(orderId: string, trade: Trade, quote: bigint, role: "maker" | "taker", at: number): void {
    const userId = this.owners.get(orderId);
    if (!userId) return;
    const account = this.accounts.get(userId)!;
    const order = account.open.get(orderId)!;
    const q = trade.quantity;
    if (order.side === "buy") {
      account.eth += q;
      // A limit buy locked price × q for this; refund what it didn't cost.
      if (order.type === "limit") account.vnd += order.price! * q - quote;
      else account.vnd -= quote;
    } else {
      account.vnd += quote;
      // A limit sell's ETH left the balance when it was locked.
      if (order.type === "market") account.eth -= q;
    }
    order.filled += q;
    order.quote += quote;
    order.status = order.filled === order.quantity ? "filled" : "partially_filled";
    order.updatedAt = at;
    this.pending.fills.push({
      userId,
      fill: { seq: trade.sequence, orderId, side: order.side, price: trade.price, quantity: q, quote, role, at },
    });
    this.touchOrder(userId, order);
  }

  // A user's order left the book (or never rested): return what it still
  // locks and close it.
  private close(orderId: string, status: "filled" | "cancelled", at: number): void {
    const userId = this.owners.get(orderId);
    if (!userId) return;
    const account = this.accounts.get(userId)!;
    const order = account.open.get(orderId)!;
    const left = order.quantity - order.filled;
    if (order.type === "limit" && left > 0n) {
      if (order.side === "buy") account.vnd += order.price! * left;
      else account.eth += left;
    }
    order.status = status;
    order.updatedAt = at;
    account.open.delete(orderId);
    this.owners.delete(orderId);
    this.touchOrder(userId, order);
  }

  private addToCandles(price: bigint, quantity: bigint, quote: bigint, at: number): void {
    const sec = Math.floor(at / 1000);
    for (const resolution of RESOLUTIONS) {
      const size = CANDLE_RESOLUTIONS[resolution];
      const t = sec - (sec % size);
      const list = this.candles.get(resolution)!;
      let c = list[list.length - 1];
      // Same bucket, or the clock stepped back: extend the last candle.
      if (c && c.t >= t) {
        if (price > c.high) c.high = price;
        if (price < c.low) c.low = price;
        c.close = price;
        c.volume += quantity;
        c.quote += quote;
      } else {
        c = { t, open: price, high: price, low: price, close: price, volume: quantity, quote };
        list.push(c);
        if (list.length > MARKET_DATA.candleLimit) list.splice(0, list.length - MARKET_DATA.candleLimit);
      }
      this.pending.candles.set(`${resolution}:${c.t}`, { resolution, candle: c });
    }
  }

  // --- persistence ---------------------------------------------------------

  // The order and its account's balances changed.
  private touchOrder(userId: string, order: UserOrder): void {
    this.accounts.get(userId)!.version++;
    this.pending.users.add(userId);
    this.pending.orders.set(order.id, { userId, order });
  }

  // Write what this engine call changed — the book's orders and state, and
  // the money — in one transaction. A failure leaves memory ahead of the DB,
  // so the market stops (healthy = false).
  private commit(at: number, fullBook = false): void {
    const p = this.pending;
    this.pending = emptyPending();
    const book = fullBook ? this.bot.fullState() : this.bot.drainChanges();
    const batch: MarketBatch = {
      book: {
        reset: fullBook,
        upserts: book.upserts,
        deletes: book.deletes,
        state: { sequence: book.sequence, bot: book.bot },
      },
      balances: [...p.users].map((userId) => {
        const a = this.accounts.get(userId)!;
        return { userId, vnd: a.vnd, eth: a.eth, at };
      }),
      orders: [...p.orders.values()],
      fills: p.fills,
      trades: p.trades,
      candles: [...p.candles.values()],
    };
    try {
      this.db.commit(batch);
      this.savedState = this.stateKey();
    } catch (err) {
      this.failure = err instanceof Error ? err : new Error(String(err));
      console.error(`[market] DB write failed; market stopped until restart: ${this.failure.message}`);
      throw this.failure;
    }
  }

  // The whole book, replacing whatever was saved (a reseeded book).
  private commitFullBook(): void {
    this.commit(this.now(), true);
  }

  private stateKey(): string {
    const s = this.bot.state;
    return `${this.bot.engine.sequence}:${s.mid}:${s.idSeq}`;
  }

  private ensureHealthy(): void {
    if (this.failure) throw new Error(`market stopped after a DB write failed: ${this.failure.message}`);
  }

  private loadAccount(userId: string): Account | null {
    const b = this.db.balance(userId);
    if (!b) return null;
    const a: Account = { vnd: b.vnd, eth: b.eth, open: new Map(), version: 0 };
    this.accounts.set(userId, a);
    return a;
  }
}

function emptyPending() {
  return {
    users: new Set<string>(),
    orders: new Map<string, { userId: string; order: UserOrder }>(),
    fills: [] as MarketBatch["fills"],
    trades: [] as MarketBatch["trades"],
    candles: new Map<string, { resolution: Resolution; candle: Candle }>(),
  };
}

function newAccount(): Account {
  return { vnd: START_VND, eth: START_ETH, open: new Map(), version: 0 };
}

// What a market buy of `quantity` would pay against `asks` (best first): the
// fillable part only; the engine cancels any remainder.
function walkCost(asks: readonly RestingOrder[], quantity: bigint): bigint {
  let left = quantity;
  let cost = 0n;
  for (const o of asks) {
    if (left === 0n) break;
    const q = o.remaining < left ? o.remaining : left;
    cost += o.price * q;
    left -= q;
  }
  return cost;
}
