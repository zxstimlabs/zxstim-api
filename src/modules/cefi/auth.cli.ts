// Temporary entry for `auth generate` (schema only; dummy, non-secret values).
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createCefiAuth } from "./auth";
import { MemoryStorage } from "./storage";

export const auth = createCefiAuth({
  db: drizzle(new Database(":memory:")),
  storage: new MemoryStorage(),
  secret: "schema-generation-only-not-a-secret-000000",
  pinPepper: "schema-generation-only",
  baseURL: "http://localhost:8001",
  rpID: "localhost",
  origins: [],
});
