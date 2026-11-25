// The spec invariants (1–6), including a fuzz pass and a replay/determinism test.

import { describe, expect, test } from "bun:test";
import { MatchingEngine } from "../../lib/matching-engine";
import type { Event } from "../../lib/matching-engine";
import { applyOp, assertBookInvariants, buildScript, mulberry32 } from "./helpers";


describe("invariants", () => {
  test("invariant 4: every trade executes at a maker's resting price", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 102n, quantity: 10n });
    const events = engine.submit({ id: "t", side: "buy", type: "limit", price: 105n, quantity: 10n });
    const trade = events.find((e) => e.type === "trade");
    expect(trade && trade.type === "trade" && trade.trade.price).toBe(102n);
  });

  test("invariants 1–3 hold after every op in a fuzz run", () => {
    const engine = new MatchingEngine();
    const ops = buildScript(0xc0ffee, 200);

    for (const op of ops) {
      const events = applyOp(engine, op);

      // Invariants 1 & 2 (no crossed book, remaining > 0) after every op.
      assertBookInvariants(engine);

      // Invariant 3: a taker never trades more than its submitted quantity.
      if (op.kind === "submit") {
        let takerFilled = 0n;
        for (const e of events) {
          if (e.type === "trade" && e.trade.takerOrderId === op.order.id) {
            takerFilled += e.trade.quantity;
          }
        }
        expect(takerFilled <= op.order.quantity).toBe(true);
      }
    }
  });

  test("invariant 5: sequence numbers strictly increase across trades and accepts", () => {
    const engine = new MatchingEngine();
    const ops = buildScript(0x1234, 200);

    let prev = 0;
    for (const op of ops) {
      for (const e of applyOp(engine, op)) {
        const seq =
          e.type === "trade"
            ? e.trade.sequence
            : e.type === "order_accepted"
              ? e.order.sequence
              : undefined;
        if (seq !== undefined) {
          expect(seq).toBeGreaterThan(prev);
          prev = seq;
        }
      }
    }
  });

  test("invariant 6: replaying the same script yields byte-identical events", () => {
    const ops = buildScript(0xabcdef, 250);

    const run = (): Event[] => {
      const engine = new MatchingEngine();
      const all: Event[] = [];
      for (const op of ops) all.push(...applyOp(engine, op));
      return all;
    };

    const a = run();
    const b = run();
    expect(a).toEqual(b);
    // Sanity: the script actually exercised the engine (produced trades).
    expect(a.some((e) => e.type === "trade")).toBe(true);
  });

  test("emitted events are immutable (frozen)", () => {
    const engine = new MatchingEngine();
    engine.submit({ id: "m", side: "sell", type: "limit", price: 100n, quantity: 5n });
    const events = engine.submit({ id: "t", side: "buy", type: "limit", price: 100n, quantity: 3n });
    const trade = events.find((e) => e.type === "trade")!;
    expect(Object.isFrozen(trade)).toBe(true);
  });
});
