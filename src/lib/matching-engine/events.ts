// Event stream definitions.
//
// Every public operation returns Event[] describing everything that happened,
// in the order it logically occurred (e.g. trades before the resting-remainder
// accept). Events are plain, frozen (immutable) objects discriminated on `type`.

import type { RestingOrder, Trade } from "./types";

// Known reject reasons. Kept as a string union for readability; the
// `order_rejected` event widens to `string` so callers can switch freely.
export type RejectReason =
  | "invalid_quantity"
  | "invalid_price"
  | "missing_price"
  | "duplicate_id"
  | "unknown_order"
  | "fok_unfillable"
  | "post_only_would_cross";

export interface OrderAcceptedEvent {
  type: "order_accepted";
  order: RestingOrder; // snapshot of the order as it rests
}

export interface OrderRejectedEvent {
  type: "order_rejected";
  orderId: string;
  reason: RejectReason;
}

export interface TradeEvent {
  type: "trade";
  trade: Trade;
}

export interface OrderCancelledEvent {
  type: "order_cancelled";
  orderId: string;
  remaining: bigint; // remaining quantity at cancel time
  // Optional note distinguishing an explicit cancel from an automatic one
  // (e.g. an IOC/market remainder that could not be filled).
  reason?: "cancelled" | "ioc_remainder" | "market_remainder_unfilled";
}

export interface OrderAmendedEvent {
  type: "order_amended";
  before: RestingOrder; // snapshot before the amend
  after: RestingOrder; // snapshot after the amend (final state)
}

export interface OrderFilledEvent {
  type: "order_filled";
  orderId: string;
}

export type Event =
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | TradeEvent
  | OrderCancelledEvent
  | OrderAmendedEvent
  | OrderFilledEvent;

// ----------------------------------------------------------------------------
// Constructors. Each returns a frozen object so emitted events can never be
// mutated by later engine activity (snapshots are copied before freezing).
// ----------------------------------------------------------------------------

function freezeSnapshot(order: RestingOrder): RestingOrder {
  // Shallow copy is enough: every field is a primitive.
  return Object.freeze({ ...order });
}

export function orderAccepted(order: RestingOrder): OrderAcceptedEvent {
  return Object.freeze({ type: "order_accepted", order: freezeSnapshot(order) });
}

export function orderRejected(
  orderId: string,
  reason: RejectReason,
): OrderRejectedEvent {
  return Object.freeze({ type: "order_rejected", orderId, reason });
}

export function tradeEvent(trade: Trade): TradeEvent {
  return Object.freeze({ type: "trade", trade: Object.freeze({ ...trade }) });
}

export function orderCancelled(
  orderId: string,
  remaining: bigint,
  reason: OrderCancelledEvent["reason"] = "cancelled",
): OrderCancelledEvent {
  return Object.freeze({ type: "order_cancelled", orderId, remaining, reason });
}

export function orderAmended(
  before: RestingOrder,
  after: RestingOrder,
): OrderAmendedEvent {
  return Object.freeze({
    type: "order_amended",
    before: freezeSnapshot(before),
    after: freezeSnapshot(after),
  });
}

export function orderFilled(orderId: string): OrderFilledEvent {
  return Object.freeze({ type: "order_filled", orderId });
}
