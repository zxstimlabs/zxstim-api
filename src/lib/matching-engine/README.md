# Matching engine (`src/lib/matching-engine`)

> Imported from [zxstimlabs/cex-orderbook-matching-engine](https://github.com/zxstimlabs/cex-orderbook-matching-engine)
> at `732a7cb`. Since then: `MatchingEngine.restore` / `getOrder` / `sequence`
> for persistence (decision 10). Used by the ETH/VND bot in
> `src/modules/orderbook`; see the main README.

A single-symbol, price-time-priority (FIFO) limit order book and matching
engine in TypeScript. This is an **educational simulator** — correctness and
readability are the priorities; throughput and latency are explicitly not.

Integer-only arithmetic with **`bigint`**: prices are in **ticks**, quantities
in **lots**. The engine never sees decimals, and because `bigint` is unbounded,
downstream notional math (`price × quantity`) can never overflow JS's 2^53
safe-integer limit — important for real crypto-scale amounts.

### Numbers & precision (e.g. an ETH/VND market)

Callers convert human decimals to integer base units before submitting. The
engine stores everything as `bigint`; `sequence` stays a plain `number` (it's an
internal ordinal, never an amount).

| field | meaning | conversion | example |
|-------|---------|------------|---------|
| `quantity` | base asset (ETH, 4 dp) | `ETH × 10_000n` | `2.5 ETH → 25_000n` |
| `price` | quote per base (VND, 2 dp) | `VND × 100n` | `76_000_000 VND → 7_600_000_000n` |

Why `bigint` matters: with `number`, the product `price × quantity` equals
`notional_VND × 1_000_000`, which exceeds `Number.MAX_SAFE_INTEGER` (≈9.007×10¹⁵)
for any single trade above ~9 billion VND (~$355k) — silently corrupting money.
With `bigint` it's always exact (there's a regression test for this in
`src/test/matching-engine/matching.test.ts`). The engine API is **strict**: prices/quantities must be
`bigint`; a stray `number` is rejected (`invalid_quantity` / `invalid_price`) so
float precision can never leak into the book. Round/parse decimals carefully at
your API boundary *before* converting to base units.

## Tests

```bash
bun test src/test/matching-engine   # engine only (bun test runs everything)
```

## Architecture

The engine is a pure library: no I/O, no env, no `Date`/`Math.random`.

| File | Responsibility |
|------|----------------|
| `types.ts` | Domain types: `Side`, `OrderType`, `NewOrder`, `RestingOrder`, `Trade`, `OrderStatus`. |
| `events.ts` | The discriminated `Event` union and frozen-object constructors. |
| `orderbook.ts` | Book data structure + price-level management (no matching logic). |
| `engine.ts` | `MatchingEngine`: validation, the matching loop, `submit`/`cancel`/`amend`/`snapshot`, and `restore`/`getOrder`/`sequence`. |
| `index.ts` | Public barrel — import everything from `src/lib/matching-engine`. |
| `src/test/matching-engine/*.test.ts` | Matching, order types, lifecycle, invariants/fuzz/replay, and restore tests. |

**Book structure.** Each side is a `Map<price, RestingOrder[]>`. The array at a
price level is a FIFO queue in arrival order (index 0 = oldest = highest
priority). "Best price first" is computed by sorting the price keys on demand
(descending for bids, ascending for asks) — no sorted tree, per the no-premature-
optimization rule. A flat `Map<id, RestingOrder>` gives O(1) cancel/amend lookup.

**Matching.** A taker walks the opposite side, always taking the best price
first and the oldest order within a level. Each fill is
`min(takerRemaining, makerRemaining)` and **executes at the maker's price**. A
maker filled to 0 is removed and emits `order_filled`; a partially-filled maker
stays with reduced `remaining`. The per-type wrappers (limit / market / ioc /
fok / post_only) all share this one matching core.

**Events.** Every operation returns `Event[]` in logical order (trades before
the resting-remainder accept). Every event is `Object.freeze`d, and the
`RestingOrder`/`Trade` snapshots inside them are copied before freezing, so
later book activity can never mutate an already-emitted event.

## Decisions the spec left open (documented as required)

1. **Sequence numbers — one shared monotonic counter.** A new sequence is drawn
   (a) for each trade at execution, and (b) for an order *at the moment it comes
   to rest* (its time-priority key). Because each operation completes before the
   next and a submit draws its trades before its resting-remainder sequence, the
   sequence numbers carried by emitted `trade` and `order_accepted` events are
   strictly increasing in emission order (invariant 5). Orders that never rest
   (market/ioc/fok/fully-filling limit) never draw an order sequence.

2. **Market-order remainder → `order_cancelled`.** An unfilled market remainder
   is reported as `order_cancelled` with `reason: "market_remainder_unfilled"`
   (chosen over an `order_rejected` for the remainder). Market orders carry no
   price and never rest. A fully-filled market order instead emits `order_filled`.

3. **IOC remainder → `order_cancelled`** with `reason: "ioc_remainder"`.

4. **Taker `order_filled`.** `order_filled` is emitted whenever *any* order's
   `remaining` reaches 0 — makers during the walk, and the taker itself when it
   fully fills (limit/market/ioc/fok).

5. **Duplicate-id semantics.** An id is "active" while an order with that id
   rests on the book; resubmitting an active id is rejected (`duplicate_id`).
   Once an order leaves the book (filled/cancelled) its id may be reused. Orders
   that never rest do not reserve their id.

6. **Self-trade allowed.** With no concept of accounts, an incoming order may
   match a resting order; self-trade prevention is intentionally not implemented.

7. **Validation (strict bigint).** Prices/quantities must be `bigint`; a stray
   `number` (e.g. a float) is rejected as `invalid_quantity` / `invalid_price`,
   so float precision can never enter the book. `quantity` must be `> 0n`. Per
   spec, the engine does not additionally forbid zero/negative ticks (only the
   bigint type is required). Validation order is: `invalid_quantity` →
   `missing_price` / `invalid_price` → `duplicate_id`.

8. **Amend event model.**
   - *Priority-preserving* (same price, quantity unchanged or **decreased**):
     the order is mutated in place and a single `order_amended(before, after)`
     is emitted, keeping its sequence/queue position. If the decrease drives
     `remaining` to 0, the order leaves the book and the `after` snapshot shows
     `remaining: 0, status: "cancelled"`. Reducing total below the
     already-filled amount clamps to the filled amount (you can't un-fill).
   - *Priority-losing* (price changed **or** quantity increased): implemented as
     cancel + resubmit of the still-open remainder as a fresh passive limit at
     the new price (new, higher sequence — so it may immediately match). Events:
     any resulting `trade`s first, then a single `order_amended(before, after)`
     summarizing the net result (`after` is the resting snapshot, or a
     `status: "filled"` snapshot if it fully matched). No separate
     `order_accepted`/`order_cancelled` is emitted for an amend.

9. **Within-level ordering** relies on the invariant that we always append on
   insert, so array order equals ascending `sequence` within a price level (a
   re-queued amend appends to the back, correctly losing priority).

10. **Restore (persistence).** `MatchingEngine.restore({ sequence, orders })`
    rebuilds an engine from its resting orders plus the sequence counter
    (`engine.sequence`). Orders are re-inserted in ascending `sequence`, so
    decision 9's FIFO order is exactly reproduced, and the counter continues,
    so invariant 5 holds across a restore. A restored engine emits the same
    events as the original for any later ops (tested on fuzz runs). It
    validates instead of repairing: duplicate ids/sequences, non-bigint
    amounts, `remaining` outside `(0, quantity]`, a non-resting status, a
    sequence past the counter, or a crossed book all throw `restore: …`.

## Invariants (all tested, see `src/test/matching-engine/invariants.test.ts`)

1. The book is never crossed: `best_bid_price < best_ask_price`.
2. Every resting order has `remaining > 0` (filled orders are removed).
3. A taker's total traded quantity never exceeds its submitted quantity.
4. Every trade price equals some maker's resting price.
5. Sequence numbers strictly increase across all trades and accepts.
6. Determinism: replaying the same op script on a fresh engine produces
   deeply-equal event streams (no `Date`/`Math.random` in the engine).

Invariants 1–3 and 5 are additionally checked after every op in a 200-op fuzz
run; invariant 6 replays a 250-op script twice and deep-compares.

## Stretch goals

Not implemented yet (kept out so the core stays clean): a JSON-driven CLI,
stop / stop-limit orders, iceberg orders, and a `level2()` aggregated view.
