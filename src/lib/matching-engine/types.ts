// Domain model for the matching engine.
//
// NUMBERS: prices and quantities are `bigint`, in integer base units.
//   * `price` is in *ticks* (integer number of minimum price increments).
//   * `quantity` is in *lots* (integer number of minimum size increments).
// `bigint` is unbounded, so notional math (price * quantity) downstream can
// never overflow JS's 2^53 safe-integer limit — important for real money sizes.
// Callers convert human decimals to integer base units before submitting; the
// engine never sees decimals. All arithmetic stays in integers.
//
// Example mapping for an ETH/VND market (ETH = base, VND = quote):
//   ETH has 4 dp  -> 1 lot  = 0.0001 ETH, so quantity = ETH * 10_000n
//   VND has 2 dp  -> 1 tick = 0.01  VND, so price    = VND * 100n   (VND per ETH)
//
// `sequence` stays a plain `number`: it is an internal monotonic ordinal (a time
// -priority key / event counter), never an amount, and will not approach 2^53.

export type Side = "buy" | "sell";

export type OrderType =
  | "limit" // rest on book if not fully filled
  | "market" // match against best available, never rests
  | "ioc" // immediate-or-cancel: fill what's possible now, cancel the remainder
  | "fok" // fill-or-kill: fill entirely now or reject entirely (no partial)
  | "post_only"; // limit that must NOT cross; reject if it would take liquidity

// The shape a caller submits. `id` is client-supplied and must be unique among
// currently-resting orders (see engine duplicate-id handling).
export interface NewOrder {
  id: string;
  side: Side;
  type: OrderType;
  price?: bigint; // ticks. Required for limit/ioc/fok/post_only. Omitted/ignored for market.
  quantity: bigint; // lots, must be > 0n
}

export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

// An order as it lives on the book. `sequence` is assigned by the engine when
// the order comes to rest and is the time-priority key (lower = earlier = higher
// priority within a price level).
export interface RestingOrder {
  id: string;
  side: Side;
  price: bigint; // ticks
  quantity: bigint; // original lots
  remaining: bigint; // lots still open (always > 0n while on the book)
  status: OrderStatus;
  sequence: number; // engine-assigned monotonic ordinal, used for time priority
}

// One fill. The price is ALWAYS the resting (maker) order's price.
export interface Trade {
  takerOrderId: string;
  makerOrderId: string;
  price: bigint; // ticks — the resting (maker) order's price
  quantity: bigint; // lots
  sequence: number; // engine-assigned monotonic ordinal
}
