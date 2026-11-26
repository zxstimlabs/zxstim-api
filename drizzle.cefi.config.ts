import { defineConfig } from "drizzle-kit";

// CeFi accounts DB (separate file from the DeFi indexer DB; see README).
// `bun db:generate:cefi` after changing src/modules/cefi/schema.ts (Better
// Auth's tables) or market-schema.ts (balances, orders, fills, trades, candles).
export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/modules/cefi/schema.ts", "./src/modules/cefi/market-schema.ts"],
  out: "./drizzle/cefi",
  dbCredentials: {
    url: process.env.CEFI_DATABASE_PATH ?? "./data/cefi/cefi.db",
  },
});
