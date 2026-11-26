// The CeFi accounts DB and the DeFi indexer DB are separate SQLite files with
// separate migrations; neither may create the other's tables.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openCefiDb } from "../../modules/cefi/db";

const tables = (sqlite: Database) =>
  sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);

describe("separate databases", () => {
  test("the CeFi DB holds only CeFi tables", () => {
    const { sqlite } = openCefiDb(":memory:");
    expect(tables(sqlite)).toEqual(["__drizzle_migrations", "cefi_account", "cefi_passkey", "cefi_session", "cefi_user"]);
    expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  test("the DeFi migrations create no CeFi tables", () => {
    const sqlite = new Database(":memory:");
    migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
    const names = tables(sqlite);
    expect(names).toContain("swaps");
    expect(names.filter((n) => n.startsWith("cefi_"))).toEqual([]);
  });
});
