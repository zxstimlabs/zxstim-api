// The ETH/VND market's tables in the CeFi DB (cefi.db), next to Better Auth's
// tables (schema.ts): the order book, users' balances, orders and fills, the
// trade log and candles. Written synchronously by
// src/modules/orderbook/market.ts, one transaction per engine call, so the
// book and the money in it never disagree. Read and written with raw
// bun:sqlite statements (integers as bigint) in market-db.ts; this file
// defines the tables for drizzle-kit (`bun db:generate:cefi`).
//
// Units (src/config/orderbook.ts): ETH in lots (ETH × 10^4), prices in ticks
// (VND × 100), VND balances and fill costs in quote units (ticks × lots = VND
// × 10^6). `user_id` is cefi_user.id (no foreign key: the market doesn't
// depend on Better Auth's tables, and accounts are never deleted).

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The resting orders of the book (bot and users), as the matching engine holds
// them. Rebuilt with MatchingEngine.restore on boot.
export const cefi_book_order = sqliteTable("cefi_book_order", {
  id: text("id").primaryKey(), // engine id: u<n> users, b/a<n> bot
  side: text("side").notNull(),
  price: integer("price").notNull(), // ticks
  quantity: integer("quantity").notNull(), // lots
  remaining: integer("remaining").notNull(), // lots
  status: text("status").notNull(), // open | partially_filled
  sequence: integer("sequence").notNull(), // time priority
});

// One row (id = 1): the engine's sequence counter and the bot's state. No row
// means no saved book: a fresh one is seeded.
export const cefi_book_state = sqliteTable("cefi_book_state", {
  id: integer("id").primaryKey(),
  sequence: integer("sequence").notNull(),
  mid: integer("mid").notNull(), // the bot's mid, VND
  idSeq: integer("id_seq").notNull(), // the bot's last order number
});

// Available balances. What open orders lock is not here: it follows from them.
export const cefi_balance = sqliteTable("cefi_balance", {
  userId: text("user_id").primaryKey(),
  vnd: integer("vnd").notNull(), // quote units
  eth: integer("eth").notNull(), // lots
  updatedAt: integer("updated_at").notNull(), // ms
});

// Every user order, open and closed. The id is the n of the engine id u<n>.
export const cefi_order = sqliteTable(
  "cefi_order",
  {
    id: integer("id").primaryKey(),
    userId: text("user_id").notNull(),
    side: text("side").notNull(), // buy | sell
    type: text("type").notNull(), // limit | market
    price: integer("price"), // ticks; null for market orders
    quantity: integer("quantity").notNull(), // lots
    filled: integer("filled").notNull(), // lots
    quote: integer("quote").notNull(), // quote units paid/received so far
    status: text("status").notNull(), // open | partially_filled | filled | cancelled
    createdAt: integer("created_at").notNull(), // ms
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("cefi_order_user_idx").on(t.userId, t.id), index("cefi_order_status_idx").on(t.status)],
);

// Users' fills: their trade history, kept for good. A self-trade gives the
// account two fills (maker and taker) for one trade.
export const cefi_fill = sqliteTable(
  "cefi_fill",
  {
    userId: text("user_id").notNull(),
    seq: integer("seq").notNull(), // the trade's engine sequence
    role: text("role").notNull(), // maker | taker
    orderId: integer("order_id").notNull(),
    side: text("side").notNull(),
    price: integer("price").notNull(), // ticks
    quantity: integer("quantity").notNull(), // lots
    quote: integer("quote").notNull(), // quote units
    at: integer("at").notNull(), // ms
  },
  (t) => [primaryKey({ columns: [t.userId, t.seq, t.role] })],
);

// The trade log: every match, bot or user. Pruned after
// MARKET_DATA.tradeRetentionDays.
export const cefi_trade = sqliteTable(
  "cefi_trade",
  {
    seq: integer("seq").primaryKey(), // engine sequence
    price: integer("price").notNull(), // ticks
    quantity: integer("quantity").notNull(), // lots
    takerSide: text("taker_side").notNull(),
    makerOrderId: text("maker_order_id").notNull(), // engine ids: u<n> users, b/a/t<n> bot
    takerOrderId: text("taker_order_id").notNull(),
    at: integer("at").notNull(), // ms
  },
  (t) => [index("cefi_trade_at_idx").on(t.at)],
);

// OHLC candles built from the trades, one row per resolution and bucket.
// Pruned to MARKET_DATA.candleLimit per resolution.
export const cefi_candle = sqliteTable(
  "cefi_candle",
  {
    resolution: text("resolution").notNull(), // 1m 5m 15m 1h 4h 1d
    t: integer("t").notNull(), // bucket start, unix seconds
    open: integer("open").notNull(), // ticks
    high: integer("high").notNull(),
    low: integer("low").notNull(),
    close: integer("close").notNull(),
    volume: integer("volume").notNull(), // lots
    // Whole VND, not quote units: a busy day's quote units could pass 2^63.
    quoteVnd: integer("quote_vnd").notNull(),
  },
  (t) => [primaryKey({ columns: [t.resolution, t.t] })],
);
