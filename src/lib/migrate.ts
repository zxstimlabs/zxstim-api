import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";

const DATABASE_PATH = process.env.DATABASE_PATH;

if (!DATABASE_PATH) {
  throw new Error("DATABASE_PATH is not set");
}

const sqlite = new Database(DATABASE_PATH);
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "./drizzle" });

console.log("Migration complete.");
