// IOC, FOK, post-only, and market behavior (spec scenarios 5–10).

import { describe, expect, test } from "bun:test";
import { MatchingEngine } from "../../lib/matching-engine";
import { accepts, cancels, fills, rejects, trades } from "./helpers";

describe("order types: fok / ioc / post_only / market", () => {
  test("scenario 5: FOK that cannot fully fill is rejected, book unchanged", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 6n });

    const before = engine.snapshot();
    const events = engine.submit({ id: "t", side: "buy", type: "fok", price: 100n, quantity: 10n });

    expect(trades(events)).toHaveLength(0);
    expect(rejects(events)).toHaveLength(1);
    expect(rejects(events)[0]).toMatchObject({ orderId: "t", reason: "fok_unfillable" });
    expect(engine.snapshot()).toEqual(before); // nothing consumed
  });

  test("scenario 6: FOK that can fully fill executes completely", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 6n });

    const events = engine.submit({ id: "t", side: "buy", type: "fok", price: 100n, quantity: 6n });

    expect(trades(events)).toHaveLength(1);
    expect(trades(events)[0]!.trade).toMatchObject({ price: 100n, quantity: 6n });
    expect(fills(events).map((f) => f.orderId).sort()).toEqual(["m", "t"]);
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  test("FOK can fill across multiple price levels when total liquidity suffices", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "a100", side: "sell", type: "limit", price: 100n, quantity: 4n });
    engine.submit({ id: "a101", side: "sell", type: "limit", price: 101n, quantity: 4n });

    const events = engine.submit({ id: "t", side: "buy", type: "fok", price: 101n, quantity: 8n });
    expect(trades(events)).toHaveLength(2);
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  test("FOK respects the limit price when judging fillability", () => {
    const engine = new MatchingEngine();
    // Only 4 lots are at/below 100; the rest is too expensive for the FOK limit.
    engine.submit({ id: "a100", side: "sell", type: "limit", price: 100n, quantity: 4n });
    engine.submit({ id: "a105", side: "sell", type: "limit", price: 105n, quantity: 10n });

    const events = engine.submit({ id: "t", side: "buy", type: "fok", price: 100n, quantity: 8n });
    expect(rejects(events)[0]).toMatchObject({ reason: "fok_unfillable" });
    expect(trades(events)).toHaveLength(0);
  });

  test("scenario 7: IOC fills what it can and cancels the remainder", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 4n });

    const events = engine.submit({ id: "t", side: "buy", type: "ioc", price: 100n, quantity: 10n });

    expect(trades(events)[0]!.trade.quantity).toBe(4n);
    const c = cancels(events);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ orderId: "t", remaining: 6n, reason: "ioc_remainder" });
    // Nothing rests.
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  test("scenario 8: post-only that would cross is rejected", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 5n });

    const before = engine.snapshot();
    const events = engine.submit({ id: "t", side: "buy", type: "post_only", price: 100n, quantity: 5n });

    expect(rejects(events)[0]).toMatchObject({ orderId: "t", reason: "post_only_would_cross" });
    expect(trades(events)).toHaveLength(0);
    expect(engine.snapshot()).toEqual(before);
  });

  test("scenario 9: passive post-only rests as the new best bid", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "b99", side: "buy", type: "limit", price: 99n, quantity: 5n });

    const events = engine.submit({ id: "t", side: "buy", type: "post_only", price: 100n, quantity: 5n });

    expect(trades(events)).toHaveLength(0);
    expect(accepts(events)[0]!.order).toMatchObject({ id: "t", price: 100n, status: "open" });

    const { bids } = engine.snapshot();
    expect(bids.map((b) => b.id)).toEqual(["t", "b99"]); // t is now best bid
  });

  test("scenario 10: market order against an empty book rests nothing", () => {
    const engine = new MatchingEngine();
    const events = engine.submit({ id: "t", side: "buy", type: "market", quantity: 5n });

    expect(trades(events)).toHaveLength(0);
    expect(cancels(events)[0]).toMatchObject({
      orderId: "t",
      remaining: 5n,
      reason: "market_remainder_unfilled",
    });
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  test("a fully-filled market order emits order_filled and rests nothing", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 5n });

    const events = engine.submit({ id: "t", side: "buy", type: "market", quantity: 5n });
    expect(cancels(events)).toHaveLength(0);
    expect(fills(events).map((f) => f.orderId).sort()).toEqual(["m", "t"]);
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });
});
