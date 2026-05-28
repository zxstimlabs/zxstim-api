import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";

const DATABASE_PATH = process.env.DATABASE_PATH;

if (!DATABASE_PATH) {
  throw new Error("DATABASE_PATH is not set");
}

const sqlite = new Database(DATABASE_PATH);

// WAL mode lets readers and writers proceed concurrently — otherwise any reader
// (e.g. an Elysia handler) blocks the indexer's writes and triggers SQLITE_BUSY.
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA busy_timeout = 5000;");

export const db = drizzle(sqlite);
