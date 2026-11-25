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
  intervalMs: 500, // one bot step per interval
} as const;

// Redis keys: `${prefix}:orders` (hash id -> order JSON) and `${prefix}:meta`
// (hash: sequence, mid, idSeq).
export const ORDERBOOK_REDIS_PREFIX = `orderbook:${ORDERBOOK_MARKET}`;
