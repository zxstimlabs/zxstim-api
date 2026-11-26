// Persistence for the ETH/VND book. One writer (the bot) at a time.
//
// Redis layout (prefix from config/orderbook.ts):
//   <prefix>:orders  hash  order id -> order JSON (bigints as decimal strings)
//   <prefix>:meta    hash  sequence, mid, idSeq
// Each save is ONE atomic Lua call, so readers never see half a step, and a
// crash between steps loses at most the step in flight.

import { RedisClient } from "bun";
import type { RestingOrder } from "../../lib/matching-engine";
import type { BookChanges, BotState } from "./bot";

export interface PersistedBook {
  sequence: number;
  orders: RestingOrder[];
  bot: BotState;
}

export interface BookStore {
  // null when nothing has been saved yet (a fresh book should be seeded).
  load(): Promise<PersistedBook | null>;
  // reset: replace every stored order with `changes.upserts` (full re-sync).
  save(changes: BookChanges, opts?: { reset?: boolean }): Promise<void>;
}

// Stored data that can't be decoded. Not retryable: the runner stops instead of
// trading against (or overwriting) state it doesn't understand.
export class BookStateError extends Error {
  override readonly name = "BookStateError";
}

// --- serialization ---------------------------------------------------------

export function encodeOrder(o: RestingOrder): string {
  return JSON.stringify({
    ...o,
    price: o.price.toString(),
    quantity: o.quantity.toString(),
    remaining: o.remaining.toString(),
  });
}

export function decodeOrder(json: string): RestingOrder {
  try {
    const o = JSON.parse(json);
    return {
      id: o.id,
      side: o.side,
      price: BigInt(o.price),
      quantity: BigInt(o.quantity),
      remaining: BigInt(o.remaining),
      status: o.status,
      sequence: o.sequence,
    };
  } catch (err) {
    throw new BookStateError(`undecodable order: ${(err as Error).message}`);
  }
}

function intField(meta: Record<string, string>, name: string): number {
  const v = Number(meta[name]);
  if (!Number.isSafeInteger(v)) throw new BookStateError(`meta.${name} is not an integer`);
  return v;
}

function decodeBook(orders: Record<string, string>, meta: Record<string, string>): PersistedBook | null {
  const hasOrders = Object.keys(orders).length > 0;
  if (Object.keys(meta).length === 0) {
    if (hasOrders) throw new BookStateError("orders stored without meta");
    return null;
  }
  return {
    sequence: intField(meta, "sequence"),
    orders: Object.values(orders).map(decodeOrder),
    bot: { mid: intField(meta, "mid"), idSeq: intField(meta, "idSeq") },
  };
}

// --- in-memory (tests) -----------------------------------------------------

export class MemoryBookStore implements BookStore {
  readonly orders = new Map<string, string>();
  readonly meta = new Map<string, string>();

  async load(): Promise<PersistedBook | null> {
    return decodeBook(Object.fromEntries(this.orders), Object.fromEntries(this.meta));
  }

  async save(c: BookChanges, opts: { reset?: boolean } = {}): Promise<void> {
    if (opts.reset) this.orders.clear();
    this.meta.set("sequence", String(c.sequence));
    this.meta.set("mid", String(c.bot.mid));
    this.meta.set("idSeq", String(c.bot.idSeq));
    for (const o of c.upserts) this.orders.set(o.id, encodeOrder(o));
    for (const id of c.deletes) this.orders.delete(id);
  }
}

// --- Redis -----------------------------------------------------------------

// KEYS: orders hash, meta hash.
// ARGV: reset (0|1), sequence, mid, idSeq, upsert count N, N (id, json) pairs,
//       then the ids to delete. Same semantics as MemoryBookStore.save.
const SAVE_SCRIPT = `
if ARGV[1] == '1' then redis.call('DEL', KEYS[1]) end
redis.call('HSET', KEYS[2], 'sequence', ARGV[2], 'mid', ARGV[3], 'idSeq', ARGV[4])
local n = tonumber(ARGV[5])
local i = 6
for _ = 1, n do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
  i = i + 2
end
while i <= #ARGV do
  redis.call('HDEL', KEYS[1], ARGV[i])
  i = i + 1
end
return n
`;

export class RedisBookStore implements BookStore {
  private client: RedisClient | null = null;
  private readonly ordersKey: string;
  private readonly metaKey: string;

  constructor(
    private readonly url: string,
    prefix: string,
  ) {
    this.ordersKey = `${prefix}:orders`;
    this.metaKey = `${prefix}:meta`;
  }

  async load(): Promise<PersistedBook | null> {
    const [orders, meta] = await this.run((c) =>
      Promise.all([c.hgetall(this.ordersKey), c.hgetall(this.metaKey)]),
    );
    return decodeBook(orders ?? {}, meta ?? {});
  }

  async save(c: BookChanges, opts: { reset?: boolean } = {}): Promise<void> {
    const args = [
      opts.reset ? "1" : "0",
      String(c.sequence),
      String(c.bot.mid),
      String(c.bot.idSeq),
      String(c.upserts.length),
    ];
    for (const o of c.upserts) args.push(o.id, encodeOrder(o));
    args.push(...c.deletes);
    await this.run((client) =>
      client.send("EVAL", [SAVE_SCRIPT, "2", this.ordersKey, this.metaKey, ...args]),
    );
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }

  // Connect on first use. On any failure drop the client so the next call
  // reconnects from scratch, however long Redis was away. No offline queue:
  // while Redis is down calls fail fast instead of piling up in memory.
  private async run<T>(fn: (c: RedisClient) => Promise<T>): Promise<T> {
    try {
      if (!this.client) {
        const client = new RedisClient(this.url, {
          autoReconnect: false,
          enableOfflineQueue: false,
          connectionTimeout: 5_000,
        });
        await client.connect();
        this.client = client;
      }
      return await fn(this.client);
    } catch (err) {
      this.close();
      throw err;
    }
  }
}
