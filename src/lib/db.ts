// The DeFi indexer DB: data/defi/defi.db, migrations in drizzle/defi/.
// Disposable (rebuilt from chain data), unlike the CeFi accounts DB
// (src/modules/cefi/db.ts), which is a separate file.

import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openSqlite } from "./sqlite";

// The image sets /data/defi/defi.db (a volume); locally it defaults to the repo.
export const DEFI_DATABASE_PATH = process.env.DEFI_DATABASE_PATH ?? "./data/defi/defi.db";

// Committed migrations, relative to the working directory: the repo root
// locally, /app in the container image.
const MIGRATIONS_FOLDER = "./drizzle/defi";

export const sqlite = openSqlite(DEFI_DATABASE_PATH);

export const db = drizzle(sqlite);

// Apply pending migrations before anything queries the DB. The bun:sqlite
// migrator is synchronous, so the schema is current by the time any module
// importing `db` runs. Migrations must be generated locally
// (`bun db:generate:defi`) and committed; the server never generates them.
migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
