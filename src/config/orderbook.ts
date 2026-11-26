// ETH/VND order book: market units and the background bot's parameters.
// Server-side only. Values from cex-orderbook-matching-engine's
// scripts/test.script.ts.
//
// The engine works in integer base units (bigint):
//   ETH 4 dp -> 1 lot  = 0.0001 ETH -> lots  = ETH * 10_000
//   VND 2 dp -> 1 tick = 0.01 VND   -> ticks = VND * 100

export const ORDERBOOK_MARKET = "ETH-VND";

export const ETH_LOTS = 10_000; // lots per 1 ETH (4 dp)
export const VND_TICKS = 100; // ticks per 1 VND (2 dp)

export const BOT = {
  midStart: 50_000_000, // starting mid, VND per ETH
  midMin: 45_000_000, // the mid random-walks inside this band
  midMax: 55_000_000,
  tickVnd: 50_000, // VND between adjacent price levels
  maxLevels: 10, // price levels kept per side
  ethMin: 0.1, // order size range, ETH (on a 0.01 ETH grid)
  ethMax: 2.0,
  intervalMs: 5_000, // one bot step per interval (fewer trades and rows to store)
} as const;

// --- CeFi users trading on the same book (src/modules/orderbook/market.ts) ---
//
// Balances are simulated. ETH is held in lots; VND in "quote units", the
// product of the engine's units (ticks × lots = VND × 10^6), so every fill's
// cost (price × quantity) is exact with no rounding anywhere.
export const QUOTE_UNITS_PER_VND = VND_TICKS * ETH_LOTS; // 10^6

// User order ids start with this; the bot never cancels, amends or trims them.
// Bot ids are b<n>, a<n> (resting) and t<n> (takers).
export const USER_ORDER_PREFIX = "u";

export const USERS = {
  // Every account starts with this, created on its first order: VND only, so
  // users buy ETH before they can sell any.
  startVnd: 5_000_000,
  startEth: 0,
  minEth: 0.001, // order size bounds, ETH (4 dp, the lot size)
  maxEth: 100,
  // Limit prices are whole VND, within this fraction of the reference price
  // (last trade, else the book's mid): 0.5 → 50%–150% of it.
  priceBand: 0.5,
  maxOpenOrders: 20,
  historyLimit: 100, // closed orders kept per account
  fillsLimit: 100, // fills kept per account
  // Order placements + cancels per account per minute.
  actionsPerMinute: 120,
} as const;

// Public market data. Trades and candles are saved in the CeFi DB; the newest
// are kept in memory for the API.
export const MARKET_DATA = {
  tradesLimit: 100, // recent public trades in memory (the snapshot shows 50)
  depthLevels: 10, // price levels per side in the public snapshot
  candleLimit: 1500, // candles per resolution in memory and in the DB (1m: 25 h, enough for the 24 h ticker)
  // The trade log (every match, bot or user) is kept this long, then pruned:
  // users' own fills are kept for good in their history, and candles summarise
  // the rest. Pruning runs hourly.
  tradeRetentionDays: 30,
  pruneIntervalMs: 60 * 60 * 1000,
} as const;

export const CANDLE_RESOLUTIONS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
} as const;
export type Resolution = keyof typeof CANDLE_RESOLUTIONS;
export const RESOLUTIONS = Object.keys(CANDLE_RESOLUTIONS) as Resolution[];
