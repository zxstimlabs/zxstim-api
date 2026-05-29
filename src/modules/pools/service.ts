import { and, eq, desc, lt, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { poolMeta, poolStates, swaps } from "../../lib/schema";
import { POOL_ID } from "../../config/pools";
import { PoolIndexer } from "./indexer";
import type { PoolStateData, SwapEventData } from "./types";

export type CandleResolution = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export const RESOLUTION_TO_SECONDS: Record<CandleResolution, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume0: number;
  volume1: number;
  n: number;
}

export const SUPPORTED_POOL_ID = POOL_ID;

const RECENT_SWAPS_LIMIT = 50;

interface ClientInfo {
  ws: any;
  filterAddress: string | null;
}

const clients = new Map<any, ClientInfo>();

// Forward indexer events to all WS subscribers. Set up at module load so the
// subscription exists before the indexer's startLive() begins emitting.
PoolIndexer.on("swap", (swap) => {
  const payload = JSON.stringify({ type: "swap", data: swap });
  for (const client of clients.values()) {
    try {
      if (
        client.filterAddress &&
        swap.userAddress.toLowerCase() !== client.filterAddress.toLowerCase()
      ) {
        continue;
      }
      client.ws.send(payload);
    } catch {
      clients.delete(client.ws);
    }
  }
});

PoolIndexer.on("pool_state", (state) => {
  const payload = JSON.stringify({ type: "pool_state", data: state });
  for (const client of clients.values()) {
    try {
      client.ws.send(payload);
    } catch {
      clients.delete(client.ws);
    }
  }
});

async function readPoolStateData(): Promise<PoolStateData | null> {
  const stateRows = await db
    .select()
    .from(poolStates)
    .where(eq(poolStates.poolId, POOL_ID))
    .orderBy(desc(poolStates.blockNumber))
    .limit(1);
  if (stateRows.length === 0) return null;

  const metaRows = await db
    .select()
    .from(poolMeta)
    .where(eq(poolMeta.poolId, POOL_ID))
    .limit(1);
  if (metaRows.length === 0) return null;

  const s = stateRows[0];
  const m = metaRows[0];
  return {
    currency0Symbol: m.currency0Symbol,
    currency1Symbol: m.currency1Symbol,
    currency0Decimals: m.currency0Decimals,
    currency1Decimals: m.currency1Decimals,
    sqrtPriceX96: s.sqrtPriceX96,
    tick: s.tick,
    protocolFee: s.protocolFee,
    lpFee: s.lpFee,
    liquidity: s.liquidity,
    feeGrowthGlobal0X128: s.feeGrowthGlobal0,
    feeGrowthGlobal1X128: s.feeGrowthGlobal1,
    reserve0: s.reserve0,
    reserve1: s.reserve1,
    blockNumber: String(s.blockNumber),
    updatedAt: s.updatedAt,
  };
}

async function readRecentSwapsData(
  limit: number = RECENT_SWAPS_LIMIT
): Promise<SwapEventData[]> {
  const rows = await db
    .select()
    .from(swaps)
    .where(eq(swaps.poolId, POOL_ID))
    .orderBy(desc(swaps.blockNumber), desc(swaps.logIndex))
    .limit(limit);

  return rows
    .map((r) => ({
      poolId: r.poolId,
      sender: r.sender,
      userAddress: r.userAddress,
      amount0: r.amount0,
      amount1: r.amount1,
      sqrtPriceX96: r.sqrtPriceX96,
      liquidity: r.liquidity,
      tick: r.tick,
      fee: r.fee,
      price: r.price,
      transactionHash: r.txHash,
      blockNumber: String(r.blockNumber),
      blockTimestamp: r.blockTimestamp,
      timestamp: r.blockTimestamp * 1000,
    }))
    .reverse();
}

interface CandleQuery {
  resolution: CandleResolution;
  from: number;
  to: number;
  limit: number;
}

async function readCandles({
  resolution,
  from,
  to,
  limit,
}: CandleQuery): Promise<Candle[]> {
  const bucket = RESOLUTION_TO_SECONDS[resolution];

  const rows = await db.all<{
    t: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume0: number;
    volume1: number;
    n: number;
  }>(sql`
    WITH ranked AS (
      SELECT
        (block_timestamp / ${bucket}) * ${bucket} AS t,
        price,
        block_timestamp,
        log_index,
        amount0,
        amount1,
        ROW_NUMBER() OVER (
          PARTITION BY (block_timestamp / ${bucket})
          ORDER BY block_timestamp, log_index
        ) AS rn_asc,
        ROW_NUMBER() OVER (
          PARTITION BY (block_timestamp / ${bucket})
          ORDER BY block_timestamp DESC, log_index DESC
        ) AS rn_desc
      FROM swaps
      WHERE pool_id = ${POOL_ID}
        AND block_timestamp >= ${from}
        AND block_timestamp < ${to}
    ),
    aggregated AS (
      SELECT
        t,
        MAX(CASE WHEN rn_asc = 1 THEN price END) AS open,
        MAX(price) AS high,
        MIN(price) AS low,
        MAX(CASE WHEN rn_desc = 1 THEN price END) AS close,
        SUM(ABS(CAST(amount0 AS REAL))) AS volume0,
        SUM(ABS(CAST(amount1 AS REAL))) AS volume1,
        COUNT(*) AS n
      FROM ranked
      GROUP BY t
      ORDER BY t DESC
      LIMIT ${limit}
    )
    SELECT * FROM aggregated ORDER BY t ASC
  `);

  return rows;
}

interface UserSwapsQuery {
  address: string;
  limit: number;
  before?: number;
}

async function readUserSwapsData({
  address,
  limit,
  before,
}: UserSwapsQuery): Promise<SwapEventData[]> {
  const addrLower = address.toLowerCase();
  const filters = [
    eq(swaps.poolId, POOL_ID),
    sql`lower(${swaps.userAddress}) = ${addrLower}`,
  ];
  if (before !== undefined) {
    filters.push(lt(swaps.blockTimestamp, before));
  }

  const rows = await db
    .select()
    .from(swaps)
    .where(and(...filters))
    .orderBy(desc(swaps.blockNumber), desc(swaps.logIndex))
    .limit(limit);

  return rows.map((r) => ({
    poolId: r.poolId,
    sender: r.sender,
    userAddress: r.userAddress,
    amount0: r.amount0,
    amount1: r.amount1,
    sqrtPriceX96: r.sqrtPriceX96,
    liquidity: r.liquidity,
    tick: r.tick,
    fee: r.fee,
    price: r.price,
    transactionHash: r.txHash,
    blockNumber: String(r.blockNumber),
    blockTimestamp: r.blockTimestamp,
    timestamp: r.blockTimestamp * 1000,
  }));
}

export abstract class PoolsService {
  static async getState(): Promise<PoolStateData | null> {
    return readPoolStateData();
  }

  static async getRecentSwaps(limit?: number): Promise<SwapEventData[]> {
    return readRecentSwapsData(limit);
  }

  static async getUserSwaps(query: UserSwapsQuery): Promise<SwapEventData[]> {
    return readUserSwapsData(query);
  }

  static async getCandles(query: CandleQuery): Promise<Candle[]> {
    return readCandles(query);
  }

  static async addConnection(ws: any): Promise<void> {
    clients.set(ws, { ws, filterAddress: null });
    const [state, recent] = await Promise.all([
      readPoolStateData(),
      readRecentSwapsData(),
    ]);
    if (state) {
      ws.send(JSON.stringify({ type: "pool_state", data: state }));
    }
    if (recent.length > 0) {
      ws.send(JSON.stringify({ type: "recent_swaps", data: recent }));
    }
  }

  static removeConnection(ws: any): void {
    clients.delete(ws);
  }

  static setFilterAddress(ws: any, address: string | null): void {
    const client = clients.get(ws);
    if (client) {
      client.filterAddress = address;
    }
  }
}
