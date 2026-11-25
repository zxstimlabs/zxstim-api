// A Redis connection that (re)connects on demand, using Bun's built-in client.
//
// Connects on first use. On any failure the client is dropped, so the next
// call reconnects from scratch however long Redis was away. No offline queue:
// while Redis is down, calls fail fast instead of piling up in memory.

import { RedisClient } from "bun";

export class LazyRedis {
  private client: RedisClient | null = null;

  constructor(private readonly url: string) {}

  async run<T>(fn: (c: RedisClient) => Promise<T>): Promise<T> {
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

  close(): void {
    this.client?.close();
    this.client = null;
  }
}
