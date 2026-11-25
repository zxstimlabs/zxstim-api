// The CeFi accounts DB: its own SQLite file, separate from the DeFi indexer DB
// (src/lib/db.ts). The DeFi DB is disposable (rebuilt from chain data); this
// one holds accounts that can't be recreated, so it lives on its own volume
// and is backed up/reset on its own (see README).
//
// Opened only when the CeFi API starts, never at import time.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

// Relative to the working directory: the repo root locally, /app in the image.
const MIGRATIONS_FOLDER = "./drizzle-cefi";

export function openCefiDb(path: string) {
  const sqlite = new Database(path);
  // Same settings as the DeFi DB: concurrent readers, and wait for locks
  // instead of failing with SQLITE_BUSY.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { sqlite, db };
}
