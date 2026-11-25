// Better Auth "secondary storage" (sessions cache, rate-limit counters,
// short-lived verification data) and our PIN-lockout counters.
//
// RedisStorage: production. Keys are namespaced under `cefi:` so they sit
// apart from the order book's keys in the stack's Redis.
// MemoryStorage: tests and local dev without Redis.

import type { BetterAuthOptions } from "better-auth";
import { LazyRedis } from "../../lib/redis";

export type CefiStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;

// Both stores define their methods as arrow-function properties, not class
// methods: Better Auth calls some of them detached (the rate limiter does
// `const increment = storage.increment; increment(key, ttl)`), which would
// lose `this`.

const PREFIX = "cefi:";
const ttlSeconds = (ttl: number) => Math.max(1, Math.ceil(ttl));

// Fixed-window counter: the TTL is set when the key is created, then the
// count only grows until it expires (what Better Auth's rate limiter expects).
const INCREMENT_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return v
`;

export class RedisStorage implements CefiStorage {
  private readonly redis: LazyRedis;

  constructor(url: string) {
    this.redis = new LazyRedis(url);
  }

  get = (key: string) => {
    return this.redis.run((c) => c.get(PREFIX + key));
  }

  getAndDelete = (key: string) => {
    return this.redis.run((c) => c.send("GETDEL", [PREFIX + key]));
  }

  increment = async (key: string, ttl: number): Promise<number> => {
    const v = await this.redis.run((c) =>
      c.send("EVAL", [INCREMENT_SCRIPT, "1", PREFIX + key, String(ttlSeconds(ttl))]),
    );
    return Number(v);
  }

  set = async (key: string, value: string, ttl?: number) => {
    await this.redis.run((c) =>
      ttl
        ? c.send("SET", [PREFIX + key, value, "EX", String(ttlSeconds(ttl))])
        : c.send("SET", [PREFIX + key, value]),
    );
  }

  delete = async (key: string) => {
    await this.redis.run((c) => c.send("DEL", [PREFIX + key]));
  }

  close(): void {
    this.redis.close();
  }
}

export class MemoryStorage implements CefiStorage {
  private readonly data = new Map<string, { value: string; expiresAt: number | null }>();

  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  get = (key: string) => {
    return this.live(key)?.value ?? null;
  }

  getAndDelete = (key: string) => {
    const v = this.get(key);
    this.data.delete(key);
    return v;
  }

  increment = (key: string, ttl: number): number => {
    const e = this.live(key);
    const next = (e ? Number(e.value) : 0) + 1;
    this.data.set(key, {
      value: String(next),
      expiresAt: e ? e.expiresAt : Date.now() + ttlSeconds(ttl) * 1000,
    });
    return next;
  }

  set = (key: string, value: string, ttl?: number) => {
    this.data.set(key, { value, expiresAt: ttl ? Date.now() + ttlSeconds(ttl) * 1000 : null });
  }

  delete = (key: string) => {
    this.data.delete(key);
  }
}
