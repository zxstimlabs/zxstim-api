// MatchingEngine.restore / getOrder / sequence (persistence support added in
// zxstim-api). The contract: a restored engine is indistinguishable from the
// original — same book, same FIFO order, same events for any later operations.

import { describe, expect, test } from "bun:test";
import { MatchingEngine, type RestingOrder } from "../../lib/matching-engine";
import { applyOp, assertBookInvariants, buildScript } from "./helpers";

const stateOf = (engine: MatchingEngine) => {
  const { bids, asks } = engine.snapshot();
  return { sequence: engine.sequence, orders: [...bids, ...asks] };
};

const order = (over: Partial<RestingOrder>): RestingOrder => ({
  id: "o",
  side: "buy",
  price: 100n,
  quantity: 5n,
  remaining: 5n,
  status: "open",
  sequence: 1,
  ...over,
});

describe("restore", () => {
  test("a fresh engine has sequence 0 and restores to an empty book", () => {
    const engine = MatchingEngine.restore({ sequence: 0, orders: [] });
    expect(engine.sequence).toBe(0);
    expect(engine.snapshot()).toEqual({ bids: [], asks: [] });
  });

  test("getOrder returns a copy of a resting order, undefined otherwise", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "a", side: "sell", type: "limit", price: 101n, quantity: 3n });
    const copy = engine.getOrder("a")!;
    expect(copy).toMatchObject({ id: "a", remaining: 3n, status: "open" });
    copy.remaining = 0n; // mutating the copy must not touch the book
    expect(engine.getOrder("a")!.remaining).toBe(3n);
    expect(engine.getOrder("nope")).toBeUndefined();
  });

  test("round trip after a fuzz run: same book, then identical events for later ops", () => {
    for (const seed of [1, 0xbeef, 0xc0ffee]) {
      const original = new MatchingEngine();
      for (const op of buildScript(seed, 300)) applyOp(original, op);

      const restored = MatchingEngine.restore(stateOf(original));
      expect(restored.snapshot()).toEqual(original.snapshot());
      expect(restored.sequence).toBe(original.sequence);

      // FIFO within levels and the sequence counter both carry over, so the
      // two engines must now behave identically.
      for (const op of buildScript(seed + 1, 300)) {
        expect(applyOp(restored, op)).toEqual(applyOp(original, op));
        assertBookInvariants(restored);
      }
      expect(restored.snapshot()).toEqual(original.snapshot());
    }
  });

  test("restore re-queues by sequence, whatever order the input is in", () => {
    const engine = MatchingEngine.restore({
      sequence: 5,
      orders: [
        order({ id: "late", side: "sell", price: 100n, sequence: 4 }),
        order({ id: "early", side: "sell", price: 100n, sequence: 2 }),
      ],
    });
    const events = engine.submit({ id: "t", side: "buy", type: "limit", price: 100n, quantity: 5n });
    const makers = events.flatMap((e) => (e.type === "trade" ? [e.trade.makerOrderId] : []));
    expect(makers).toEqual(["early"]); // oldest at the level fills first
    expect(engine.sequence).toBe(6); // continues after the restored counter
  });

  test.each([
    ["a negative sequence", { sequence: -1, orders: [] }],
    ["a duplicate id", { sequence: 2, orders: [order({ sequence: 1 }), order({ sequence: 2 })] }],
    ["a number price", { sequence: 1, orders: [order({ price: 100 as unknown as bigint })] }],
    ["remaining 0", { sequence: 1, orders: [order({ remaining: 0n })] }],
    ["remaining > quantity", { sequence: 1, orders: [order({ remaining: 6n })] }],
    ["a filled status", { sequence: 1, orders: [order({ status: "filled" })] }],
    ["a sequence past the counter", { sequence: 1, orders: [order({ sequence: 2 })] }],
    ["a duplicate sequence", { sequence: 1, orders: [order({ id: "a" }), order({ id: "b", side: "sell", price: 101n })] }],
    [
      "a crossed book",
      {
        sequence: 2,
        orders: [order({ id: "b", side: "buy", price: 101n, sequence: 1 }), order({ id: "a", side: "sell", price: 100n, sequence: 2 })],
      },
    ],
  ] as const)("rejects %s", (_, state) => {
    expect(() => MatchingEngine.restore(state as { sequence: number; orders: RestingOrder[] })).toThrow(/^restore:/);
  });
});
