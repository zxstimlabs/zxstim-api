// Cancel, amend (priority retention vs loss), and validation rejects
// (spec scenarios 11–12 plus the validation rules).

import { describe, expect, test } from "bun:test";
import { MatchingEngine, type NewOrder } from "../../lib/matching-engine";
import { accepts, amends, cancels, rejects, trades } from "./helpers";

describe("lifecycle: cancel", () => {
  test("scenario 12: cancelling an unknown id is rejected", () => {
    const engine = new MatchingEngine();
    const events = engine.cancel("nope");
    expect(events).toHaveLength(1);
    expect(rejects(events)[0]).toMatchObject({ orderId: "nope", reason: "unknown_order" });
  });

  test("cancelling a resting order removes it and reports remaining", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "x", side: "buy", type: "limit", price: 100n, quantity: 7n });

    const events = engine.cancel("x");
    expect(cancels(events)[0]).toMatchObject({ orderId: "x", remaining: 7n, reason: "cancelled" });
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });

    // Cancelling again is now unknown.
    expect(rejects(engine.cancel("x"))[0]!.reason).toBe("unknown_order");
  });

  test("cancel reports the reduced remaining after a partial fill", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "rest", side: "buy", type: "limit", price: 100n, quantity: 10n });
    engine.submit({ id: "hit", side: "sell", type: "limit", price: 100n, quantity: 4n });

    const events = engine.cancel("rest");
    expect(cancels(events)[0]).toMatchObject({ orderId: "rest", remaining: 6n });
  });
});

describe("lifecycle: amend", () => {
  test("scenario 11: amending price loses time priority", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "A", side: "buy", type: "limit", price: 99n, quantity: 5n });
    engine.submit({ id: "B", side: "buy", type: "limit", price: 99n, quantity: 5n });

    // Initially A is ahead of B at 99.
    expect(engine.snapshot().bids.map((b) => b.id)).toEqual(["A", "B"]);

    engine.amend("A", { price: 100n }); // A jumps to a new level (new sequence)
    expect(engine.snapshot().bids.map((b) => b.id)).toEqual(["A", "B"]);

    engine.amend("A", { price: 99n }); // back to 99, but now with the newest sequence
    expect(engine.snapshot().bids.map((b) => b.id)).toEqual(["B", "A"]); // A now behind B
  });

  test("amending quantity DOWN keeps priority and reduces remaining in place", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "A", side: "buy", type: "limit", price: 99n, quantity: 10n });
    engine.submit({ id: "B", side: "buy", type: "limit", price: 99n, quantity: 5n });

    const events = engine.amend("A", { quantity: 4n });
    expect(trades(events)).toHaveLength(0);
    const a = amends(events);
    expect(a).toHaveLength(1);
    expect(a[0]!.before).toMatchObject({ id: "A", remaining: 10n });
    expect(a[0]!.after).toMatchObject({ id: "A", quantity: 4n, remaining: 4n });

    // A keeps its place ahead of B.
    expect(engine.snapshot().bids.map((b) => b.id)).toEqual(["A", "B"]);
  });

  test("amending quantity UP loses priority (treated as cancel + resubmit)", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "A", side: "buy", type: "limit", price: 99n, quantity: 5n });
    engine.submit({ id: "B", side: "buy", type: "limit", price: 99n, quantity: 5n });

    engine.amend("A", { quantity: 10n });
    // A re-queued at the back of the 99 level.
    expect(engine.snapshot().bids.map((b) => b.id)).toEqual(["B", "A"]);
    expect(engine.snapshot().bids.find((b) => b.id === "A")).toMatchObject({
      quantity: 10n,
      remaining: 10n,
    });
  });

  test("amending price so the order crosses matches immediately", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "ask", side: "sell", type: "limit", price: 100n, quantity: 5n });
    engine.submit({ id: "bid", side: "buy", type: "limit", price: 95n, quantity: 5n });

    // Re-price the bid up to 100 so it now crosses the resting ask.
    const events = engine.amend("bid", { price: 100n });
    const t = trades(events);
    expect(t).toHaveLength(1);
    expect(t[0]!.trade).toMatchObject({ makerOrderId: "ask", price: 100n, quantity: 5n });

    // order_amended summarizes the net before/after; the bid fully filled.
    const a = amends(events);
    expect(a).toHaveLength(1);
    expect(a[0]!.after).toMatchObject({ id: "bid", remaining: 0n, status: "filled" });
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  test("amending an unknown order is rejected", () => {
    const engine = new MatchingEngine();
    expect(rejects(engine.amend("ghost", { price: 100n }))[0]).toMatchObject({
      orderId: "ghost",
      reason: "unknown_order",
    });
  });

  test("amend respects partial-fill history (reducing below filled clamps to filled)", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "rest", side: "buy", type: "limit", price: 100n, quantity: 10n });
    engine.submit({ id: "hit", side: "sell", type: "limit", price: 100n, quantity: 4n }); // fills 4 of rest

    // Try to shrink total below the 4 already filled -> clamps to 4, remaining 0.
    const events = engine.amend("rest", { quantity: 2n });
    expect(amends(events)[0]!.after).toMatchObject({
      id: "rest",
      quantity: 4n,
      remaining: 0n,
      status: "cancelled",
    });
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });
});

describe("validation rejects", () => {
  test("non-positive quantity is rejected", () => {
    const engine = new MatchingEngine();
    expect(rejects(engine.submit({ id: "a", side: "buy", type: "limit", price: 100n, quantity: 0n }))[0]!.reason).toBe("invalid_quantity");
    expect(rejects(engine.submit({ id: "b", side: "buy", type: "limit", price: 100n, quantity: -3n }))[0]!.reason).toBe("invalid_quantity");
  });

  test("a non-bigint quantity/price is rejected (strict bigint API)", () => {
    const engine = new MatchingEngine();
    // Simulate a plain-JS caller passing numbers; the engine must reject them so
    // float precision can never enter the book.
    const badQty = { id: "a", side: "buy", type: "limit", price: 100n, quantity: 5 } as unknown as NewOrder;
    expect(rejects(engine.submit(badQty))[0]!.reason).toBe("invalid_quantity");
    const badPrice = { id: "b", side: "buy", type: "limit", price: 100.5, quantity: 5n } as unknown as NewOrder;
    expect(rejects(engine.submit(badPrice))[0]!.reason).toBe("invalid_price");
  });

  test("missing price for a priced order type is rejected", () => {
    const engine = new MatchingEngine();
    expect(rejects(engine.submit({ id: "a", side: "buy", type: "limit", quantity: 5n }))[0]!.reason).toBe("missing_price");
  });

  test("duplicate active id is rejected; reusing a freed id is allowed", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "dup", side: "buy", type: "limit", price: 100n, quantity: 5n });
    expect(rejects(engine.submit({ id: "dup", side: "buy", type: "limit", price: 99n, quantity: 5n }))[0]!.reason).toBe("duplicate_id");

    // Free the id, then reuse it.
    engine.cancel("dup");
    expect(accepts(engine.submit({ id: "dup", side: "buy", type: "limit", price: 98n, quantity: 5n }))).toHaveLength(1);
  });

  test("a market order ignores any supplied price", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 5n });
    // price provided but should be ignored; still matches the resting ask.
    const events = engine.submit({ id: "t", side: "buy", type: "market", price: 1n, quantity: 5n });
    expect(trades(events)).toHaveLength(1);
  });
});
