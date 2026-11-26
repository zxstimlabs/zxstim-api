// The CeFi accounts DB: data/cefi/cefi.db, migrations in drizzle/cefi/. Its
// own SQLite file, separate from the DeFi indexer DB (src/lib/db.ts). The DeFi
// DB is disposable (rebuilt from chain data); this one holds accounts that
// can't be recreated, so it lives on its own volume and is backed up/reset on
// its own (see README).
//
// Opened only when the CeFi API starts, never at import time.

import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openSqlite } from "../../lib/sqlite";

// The image sets /data/cefi/cefi.db (a volume); locally it defaults to the repo.
export const CEFI_DEFAULT_DATABASE_PATH = "./data/cefi/cefi.db";

// Relative to the working directory: the repo root locally, /app in the image.
const MIGRATIONS_FOLDER = "./drizzle/cefi";

export function openCefiDb(path: string) {
  const sqlite = openSqlite(path);
  sqlite.exec("PRAGMA foreign_keys = ON;");
  // Balances and the order book: fsync every commit, so a power cut or kernel
  // crash can't drop the last ones (WAL's default, NORMAL, can). Measured at
  // tens of µs per market write locally; far inside the bot's 1 s step.
  sqlite.exec("PRAGMA synchronous = FULL;");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { sqlite, db };
}
