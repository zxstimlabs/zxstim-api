import { defineConfig } from "drizzle-kit";

// DeFi indexer DB (separate file from the CeFi accounts DB; see README).
// `bun db:generate:defi` after changing src/lib/schema.ts.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/schema.ts",
  out: "./drizzle/defi",
  dbCredentials: {
    url: process.env.DEFI_DATABASE_PATH ?? "./data/defi/defi.db",
  },
});
