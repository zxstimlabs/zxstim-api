// RedisStorage against a real Redis (skipped without REDIS_URL; CI provides one).
// Every method is called detached, the way Better Auth calls them.

import { describe, expect, test } from "bun:test";
import { RedisStorage } from "../../modules/cefi/storage";

const url = process.env.REDIS_URL;

describe.skipIf(!url)("RedisStorage (needs REDIS_URL)", () => {
  test("get/set/getAndDelete/delete/increment, detached, with TTLs", async () => {
    const storage = new RedisStorage(url!);
    const { get, set, getAndDelete, increment, delete: del } = storage;
    const k = `test:${crypto.randomUUID()}`;
    try {
      expect(await get(k)).toBeNull();
      await set(k, "v");
      expect(await get(k)).toBe("v");
      expect(await getAndDelete(k)).toBe("v");
      expect(await get(k)).toBeNull();

      // Fixed window: the TTL starts with the first increment.
      expect(await increment(`${k}:n`, 1)).toBe(1);
      expect(await increment(`${k}:n`, 100)).toBe(2);
      await set(`${k}:t`, "x", 1);
      await Bun.sleep(1_200);
      expect(await get(`${k}:n`)).toBeNull();
      expect(await get(`${k}:t`)).toBeNull();

      await set(k, "y");
      await del(k);
      expect(await get(k)).toBeNull();
    } finally {
      for (const key of [k, `${k}:n`, `${k}:t`]) await del(key);
      storage.close();
    }
  });
});
