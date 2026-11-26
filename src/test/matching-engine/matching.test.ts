// Crossing, partial fills, and price-time priority (spec scenarios 1–4).

import { describe, expect, test } from "bun:test";
import { MatchingEngine } from "../../lib/matching-engine";
import { accepts, fills, trades } from "./helpers";

describe("matching: crossing & price-time priority", () => {
  test("scenario 1: simple cross executes at the maker's price", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m1", side: "sell", type: "limit", price: 102n, quantity: 10n });

    const events = engine.submit({
      id: "t1",
      side: "buy",
      type: "limit",
      price: 105n,
      quantity: 10n,
    });

    const t = trades(events);
    expect(t).toHaveLength(1);
    expect(t[0]!.trade).toMatchObject({
      takerOrderId: "t1",
      makerOrderId: "m1",
      price: 102n, // maker price, NOT the taker's 105
      quantity: 10n,
    });

    // Both orders fully filled; book empty.
    expect(fills(events).map((f) => f.orderId).sort()).toEqual(["m1", "t1"]);
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  test("scenario 2: partial fill, taker rests with the remainder", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 4n });

    const events = engine.submit({
      id: "t",
      side: "buy",
      type: "limit",
      price: 100n,
      quantity: 10n,
    });

    expect(trades(events)).toHaveLength(1);
    expect(trades(events)[0]!.trade.quantity).toBe(4n);

    const accepted = accepts(events);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.order).toMatchObject({
      id: "t",
      side: "buy",
      price: 100n,
      quantity: 10n,
      remaining: 6n,
      status: "partially_filled",
    });

    const { bids, asks } = engine.snapshot();
    expect(asks).toEqual([]);
    expect(bids).toHaveLength(1);
    expect(bids[0]).toMatchObject({ id: "t", remaining: 6n, status: "partially_filled" });
  });

  test("scenario 3: market order walks multiple levels, best price first", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "a101", side: "sell", type: "limit", price: 101n, quantity: 5n });
    engine.submit({ id: "a100", side: "sell", type: "limit", price: 100n, quantity: 5n });

    const events = engine.submit({ id: "t", side: "buy", type: "market", quantity: 8n });

    const t = trades(events);
    expect(t).toHaveLength(2);
    // Best (cheapest) ask first.
    expect(t[0]!.trade).toMatchObject({ makerOrderId: "a100", price: 100n, quantity: 5n });
    expect(t[1]!.trade).toMatchObject({ makerOrderId: "a101", price: 101n, quantity: 3n });

    const { asks } = engine.snapshot();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ id: "a101", price: 101n, remaining: 2n, status: "partially_filled" });
  });

  test("scenario 4: time priority within a level — oldest fills first", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "A", side: "sell", type: "limit", price: 100n, quantity: 5n });
    engine.submit({ id: "B", side: "sell", type: "limit", price: 100n, quantity: 5n });

    const events = engine.submit({
      id: "t",
      side: "buy",
      type: "limit",
      price: 100n,
      quantity: 5n,
    });

    const t = trades(events);
    expect(t).toHaveLength(1);
    expect(t[0]!.trade.makerOrderId).toBe("A"); // earlier sequence consumed first

    const { asks } = engine.snapshot();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ id: "B", remaining: 5n }); // B untouched
  });

  test("a buy limit below the best ask does not cross and simply rests", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "ask", side: "sell", type: "limit", price: 105n, quantity: 5n });

    const events = engine.submit({ id: "bid", side: "buy", type: "limit", price: 100n, quantity: 5n });
    expect(trades(events)).toHaveLength(0);
    expect(accepts(events)).toHaveLength(1);

    const { bids, asks } = engine.snapshot();
    expect(bids[0]!.price).toBe(100n);
    expect(asks[0]!.price).toBe(105n);
  });

  test("large notional stays exact — bigint cannot overflow 2^53", () => {
    const engine = new MatchingEngine();
    // ETH/VND-scale numbers: price ≈ 76,000,000.00 VND in ticks, qty = 150 ETH in lots.
    const price = 7_600_000_000n; // 76,000,000 VND * 100
    const qty = 1_500_000n; // 150 ETH * 10_000
    engine.submit({ id: "m", side: "sell", type: "limit", price, quantity: qty });
    const events = engine.submit({ id: "t", side: "buy", type: "limit", price, quantity: qty });

    const t = trades(events)[0]!.trade;
    // notional would be 1.14e16 — beyond Number.MAX_SAFE_INTEGER — yet exact here.
    expect(t.price * t.quantity).toBe(11_400_000_000_000_000n);
  });
});
