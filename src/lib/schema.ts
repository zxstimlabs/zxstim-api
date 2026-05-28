import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";

export const poolMeta = sqliteTable("pool_meta", {
  poolId: text("pool_id").primaryKey(),
  currency0Symbol: text("currency0_symbol").notNull(),
  currency1Symbol: text("currency1_symbol").notNull(),
  currency0Decimals: integer("currency0_decimals").notNull(),
  currency1Decimals: integer("currency1_decimals").notNull(),
});

export const indexerCursor = sqliteTable("indexer_cursor", {
  poolId: text("pool_id").primaryKey(),
  lastIndexedBlock: integer("last_indexed_block").notNull(),
});

export const swaps = sqliteTable(
  "swaps",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    poolId: text("pool_id").notNull(),
    blockNumber: integer("block_number").notNull(),
    blockTimestamp: integer("block_timestamp").notNull(),
    sender: text("sender").notNull(),
    userAddress: text("user_address").notNull(),
    amount0: text("amount0").notNull(),
    amount1: text("amount1").notNull(),
    sqrtPriceX96: text("sqrt_price_x96").notNull(),
    liquidity: text("liquidity").notNull(),
    tick: integer("tick").notNull(),
    fee: integer("fee").notNull(),
    price: real("price").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("swaps_pool_ts_idx").on(t.poolId, t.blockTimestamp),
    index("swaps_pool_block_idx").on(t.poolId, t.blockNumber),
    index("swaps_pool_user_idx").on(t.poolId, t.userAddress),
  ]
);

export const poolStates = sqliteTable(
  "pool_states",
  {
    poolId: text("pool_id").notNull(),
    blockNumber: integer("block_number").notNull(),
    blockTimestamp: integer("block_timestamp").notNull(),
    sqrtPriceX96: text("sqrt_price_x96").notNull(),
    tick: integer("tick").notNull(),
    protocolFee: integer("protocol_fee").notNull(),
    lpFee: integer("lp_fee").notNull(),
    liquidity: text("liquidity").notNull(),
    feeGrowthGlobal0: text("fee_growth_global_0").notNull(),
    feeGrowthGlobal1: text("fee_growth_global_1").notNull(),
    reserve0: text("reserve0").notNull(),
    reserve1: text("reserve1").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.poolId, t.blockNumber] })]
);
