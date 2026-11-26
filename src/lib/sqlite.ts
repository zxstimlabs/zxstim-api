// Opens a SQLite file with the settings both databases share. Each DB follows
// the same layout: data/<name>/<name>.db, migrations in drizzle/<name>/
// (DeFi: src/lib/db.ts, CeFi: src/modules/cefi/db.ts).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openSqlite(path: string): Database {
  // SQLite creates the file but not its folder: make ./data/<name>/ on a fresh
  // checkout. In the image the folder is the volume mount, so this is a no-op.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // WAL mode lets readers and writers proceed concurrently — otherwise any
  // reader (e.g. an Elysia handler) blocks writes and triggers SQLITE_BUSY.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  return sqlite;
}
