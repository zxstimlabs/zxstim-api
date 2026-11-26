// Public surface of the matching engine library.
//
// Imported from zxstimlabs/cex-orderbook-matching-engine @ 732a7cb. Changes
// since: MatchingEngine.restore / getOrder / sequence (persistence support).
// Design notes and invariants: ./README.md.
//
//   import { MatchingEngine, type NewOrder, type Event } from "../lib/matching-engine";

export { MatchingEngine } from "./engine";
export { OrderBook } from "./orderbook";

export type {
  Side,
  OrderType,
  NewOrder,
  OrderStatus,
  RestingOrder,
  Trade,
} from "./types";

export type {
  Event,
  RejectReason,
  OrderAcceptedEvent,
  OrderRejectedEvent,
  TradeEvent,
  OrderCancelledEvent,
  OrderAmendedEvent,
  OrderFilledEvent,
} from "./events";
