import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";

const DATABASE_PATH = process.env.DATABASE_PATH;

if (!DATABASE_PATH) {
  throw new Error("DATABASE_PATH is not set");
}

// Committed migrations, relative to the working directory: the repo root
// locally, /app in the container image.
const MIGRATIONS_FOLDER = "./drizzle";

export const sqlite = new Database(DATABASE_PATH);

// WAL mode lets readers and writers proceed concurrently — otherwise any reader
// (e.g. an Elysia handler) blocks the indexer's writes and triggers SQLITE_BUSY.
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA busy_timeout = 5000;");

export const db = drizzle(sqlite);

// Apply pending migrations before anything queries the DB. The bun:sqlite
// migrator is synchronous, so the schema is current by the time any module
// importing `db` runs. Migrations must be generated locally (`bun db:generate`)
// and committed; the server never generates them.
migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
