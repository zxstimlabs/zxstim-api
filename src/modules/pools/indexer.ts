import { EventEmitter } from "node:events";
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { desc, eq } from "drizzle-orm";
import { db } from "../../lib/db";
import { indexerCursor, poolMeta, poolStates, swaps } from "../../lib/schema";
import {
  BACKFILL_CHUNK_SIZE,
  CURRENCY0,
  CURRENCY1,
  POOL_DEPLOY_BLOCK,
  POOL_ID,
  POOL_MANAGER,
  STATE_VIEW,
  sqrtPriceX96ToPrice,
  stateViewAbi,
  swapEventAbi,
  tokenMetaAbi,
} from "../../config/pools";
import { HOT_MANAGER_WALLET_ADDRESS } from "../sponsor/service";
import type { PoolStateData, SwapEventData } from "./types";

const ARBITRUM_SEPOLIA_RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC_URL;
if (!ARBITRUM_SEPOLIA_RPC_URL) {
  throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
}

// Both the historical backfill and the live poll use eth_getLogs over a plain
// HTTP RPC instead of an Alchemy WebSocket subscription (which burned compute
// units). The public Arbitrum Sepolia RPC accepts large block ranges and is
// free; override via BACKFILL_RPC_URL if you have a paid endpoint.
const BACKFILL_RPC_URL =
  process.env.BACKFILL_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";

const httpClient: PublicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
  batch: { multicall: true },
});

const backfillClient: PublicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(BACKFILL_RPC_URL),
});

interface PoolMetaCache {
  currency0Symbol: string;
  currency1Symbol: string;
  currency0Decimals: number;
  currency1Decimals: number;
}

let cachedMeta: PoolMetaCache | null = null;

async function ensurePoolMeta(): Promise<PoolMetaCache> {
  if (cachedMeta) return cachedMeta;

  const existing = await db
    .select()
    .from(poolMeta)
    .where(eq(poolMeta.poolId, POOL_ID))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    cachedMeta = {
      currency0Symbol: row.currency0Symbol,
      currency1Symbol: row.currency1Symbol,
      currency0Decimals: row.currency0Decimals,
      currency1Decimals: row.currency1Decimals,
    };
    return cachedMeta;
  }

  const [symbol0, symbol1, decimals0, decimals1] = await Promise.all([
    httpClient.readContract({
      address: CURRENCY0,
      abi: tokenMetaAbi,
      functionName: "symbol",
    }),
    httpClient.readContract({
      address: CURRENCY1,
      abi: tokenMetaAbi,
      functionName: "symbol",
    }),
    httpClient.readContract({
      address: CURRENCY0,
      abi: tokenMetaAbi,
      functionName: "decimals",
    }),
    httpClient.readContract({
      address: CURRENCY1,
      abi: tokenMetaAbi,
      functionName: "decimals",
    }),
  ]);

  cachedMeta = {
    currency0Symbol: symbol0,
    currency1Symbol: symbol1,
    currency0Decimals: decimals0,
    currency1Decimals: decimals1,
  };

  await db.insert(poolMeta).values({
    poolId: POOL_ID,
    ...cachedMeta,
  });

  return cachedMeta;
}

async function readCursor(): Promise<bigint> {
  const rows = await db
    .select()
    .from(indexerCursor)
    .where(eq(indexerCursor.poolId, POOL_ID))
    .limit(1);

  if (rows.length === 0) return POOL_DEPLOY_BLOCK - 1n;
  return BigInt(rows[0].lastIndexedBlock);
}

async function writeCursor(block: bigint): Promise<void> {
  await db
    .insert(indexerCursor)
    .values({ poolId: POOL_ID, lastIndexedBlock: Number(block) })
    .onConflictDoUpdate({
      target: indexerCursor.poolId,
      set: { lastIndexedBlock: Number(block) },
    });
}

interface SwapLog {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
  args: {
    id: `0x${string}`;
    sender: Address;
    amount0: bigint;
    amount1: bigint;
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
    fee: number;
  };
}

interface EnrichedSwap {
  row: typeof swaps.$inferInsert;
  event: SwapEventData;
}

async function enrichSwapLogs(
  logs: SwapLog[],
  client: PublicClient,
  meta: PoolMetaCache
): Promise<EnrichedSwap[]> {
  if (logs.length === 0) return [];

  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
  const uniqueTxHashes = [...new Set(logs.map((l) => l.transactionHash))];

  const [blockResults, txResults] = await Promise.all([
    Promise.all(
      uniqueBlocks.map((bn) =>
        client.getBlock({ blockNumber: bn, includeTransactions: false })
      )
    ),
    Promise.all(uniqueTxHashes.map((hash) => client.getTransaction({ hash }))),
  ]);

  const blockTimestamps = new Map<bigint, number>();
  for (const b of blockResults) {
    blockTimestamps.set(b.number, Number(b.timestamp));
  }

  const txUsers = new Map<string, Address>();
  const hotWallet = HOT_MANAGER_WALLET_ADDRESS.toLowerCase();
  for (const tx of txResults) {
    // For sponsored swaps (EIP-7702), tx.from is the hot manager wallet and
    // tx.to is the user's delegated EOA — the real trader. For all other
    // swaps, tx.from is the user. tx.to is non-null here because every swap
    // log comes from a tx that called a contract (router/EOA), never a
    // contract-creation tx.
    const user =
      tx.from.toLowerCase() === hotWallet && tx.to ? tx.to : tx.from;
    txUsers.set(tx.hash, user);
  }

  return logs.map((log) => {
    const price = sqrtPriceX96ToPrice(
      log.args.sqrtPriceX96,
      meta.currency0Decimals,
      meta.currency1Decimals
    );
    const blockTimestamp = blockTimestamps.get(log.blockNumber)!;
    const userAddress = txUsers.get(log.transactionHash) ?? log.args.sender;

    const row = {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      poolId: POOL_ID,
      blockNumber: Number(log.blockNumber),
      blockTimestamp,
      sender: log.args.sender,
      userAddress,
      amount0: log.args.amount0.toString(),
      amount1: log.args.amount1.toString(),
      sqrtPriceX96: log.args.sqrtPriceX96.toString(),
      liquidity: log.args.liquidity.toString(),
      tick: log.args.tick,
      fee: log.args.fee,
      price,
    };

    const event: SwapEventData = {
      poolId: POOL_ID,
      sender: log.args.sender,
      userAddress,
      amount0: row.amount0,
      amount1: row.amount1,
      sqrtPriceX96: row.sqrtPriceX96,
      liquidity: row.liquidity,
      tick: row.tick,
      fee: row.fee,
      price,
      transactionHash: row.txHash,
      blockNumber: log.blockNumber.toString(),
      blockTimestamp,
      timestamp: blockTimestamp * 1000,
    };

    return { row, event };
  });
}

async function persistSwapRows(
  rows: (typeof swaps.$inferInsert)[]
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const inserted = await db
    .insert(swaps)
    .values(rows)
    .onConflictDoNothing()
    .returning({ txHash: swaps.txHash, logIndex: swaps.logIndex });
  return new Set(inserted.map((r) => `${r.txHash}:${r.logIndex}`));
}

async function readLatestPoolStateSig(): Promise<string | null> {
  const rows = await db
    .select()
    .from(poolStates)
    .where(eq(poolStates.poolId, POOL_ID))
    .orderBy(desc(poolStates.blockNumber))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return [
    r.sqrtPriceX96,
    r.tick,
    r.protocolFee,
    r.lpFee,
    r.liquidity,
    r.feeGrowthGlobal0,
    r.feeGrowthGlobal1,
    r.reserve0,
    r.reserve1,
  ].join("|");
}

interface RawPoolState {
  sqrtPriceX96: string;
  tick: number;
  protocolFee: number;
  lpFee: number;
  liquidity: string;
  feeGrowthGlobal0: string;
  feeGrowthGlobal1: string;
  reserve0: string;
  reserve1: string;
  blockNumber: bigint;
  blockTimestamp: number;
}

function stateSig(s: RawPoolState): string {
  return [
    s.sqrtPriceX96,
    s.tick,
    s.protocolFee,
    s.lpFee,
    s.liquidity,
    s.feeGrowthGlobal0,
    s.feeGrowthGlobal1,
    s.reserve0,
    s.reserve1,
  ].join("|");
}

async function fetchPoolState(blockNumber: bigint): Promise<RawPoolState | null> {
  // Read state over the public RPC (free) rather than Alchemy. The explicit
  // multicall action calls Multicall3 directly, so it needs no batch config.
  const results = await backfillClient.multicall({
    blockNumber,
    contracts: [
      {
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [POOL_ID],
      },
      {
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getLiquidity",
        args: [POOL_ID],
      },
      {
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getFeeGrowthGlobals",
        args: [POOL_ID],
      },
      {
        address: CURRENCY0,
        abi: tokenMetaAbi,
        functionName: "balanceOf",
        args: [POOL_MANAGER],
      },
      {
        address: CURRENCY1,
        abi: tokenMetaAbi,
        functionName: "balanceOf",
        args: [POOL_MANAGER],
      },
    ],
  });

  const slot0 = results[0].status === "success" ? results[0].result : null;
  const liquidity = results[1].status === "success" ? results[1].result : null;
  const feeGrowth = results[2].status === "success" ? results[2].result : null;
  const balance0 = results[3].status === "success" ? results[3].result : null;
  const balance1 = results[4].status === "success" ? results[4].result : null;

  if (!slot0 || liquidity == null || !feeGrowth || balance0 == null || balance1 == null) {
    return null;
  }

  const block = await backfillClient.getBlock({ blockNumber, includeTransactions: false });

  return {
    sqrtPriceX96: slot0[0].toString(),
    tick: slot0[1],
    protocolFee: slot0[2],
    lpFee: slot0[3],
    liquidity: liquidity.toString(),
    feeGrowthGlobal0: feeGrowth[0].toString(),
    feeGrowthGlobal1: feeGrowth[1].toString(),
    reserve0: balance0.toString(),
    reserve1: balance1.toString(),
    blockNumber,
    blockTimestamp: Number(block.timestamp),
  };
}

function buildPoolStateData(s: RawPoolState, meta: PoolMetaCache): PoolStateData {
  return {
    currency0Symbol: meta.currency0Symbol,
    currency1Symbol: meta.currency1Symbol,
    currency0Decimals: meta.currency0Decimals,
    currency1Decimals: meta.currency1Decimals,
    sqrtPriceX96: s.sqrtPriceX96,
    tick: s.tick,
    protocolFee: s.protocolFee,
    lpFee: s.lpFee,
    liquidity: s.liquidity,
    feeGrowthGlobal0X128: s.feeGrowthGlobal0,
    feeGrowthGlobal1X128: s.feeGrowthGlobal1,
    reserve0: s.reserve0,
    reserve1: s.reserve1,
    blockNumber: s.blockNumber.toString(),
    updatedAt: Date.now(),
  };
}

export type PoolEvents = {
  swap: (data: SwapEventData) => void;
  pool_state: (data: PoolStateData) => void;
};

const emitter = new EventEmitter();

export abstract class PoolIndexer {
  private static lastStateSig: string | null = null;
  private static ready = false;
  private static polling = false;

  static on<E extends keyof PoolEvents>(event: E, listener: PoolEvents[E]): void {
    emitter.on(event, listener as (...args: unknown[]) => void);
  }

  static off<E extends keyof PoolEvents>(event: E, listener: PoolEvents[E]): void {
    emitter.off(event, listener as (...args: unknown[]) => void);
  }

  /**
   * One-shot historical backfill from cursor (or POOL_DEPLOY_BLOCK if none) up
   * to the current head. Chunked at BACKFILL_CHUNK_SIZE blocks; cursor advances
   * per chunk so a crash mid-backfill resumes cleanly. Idempotent.
   */
  static async backfill(): Promise<void> {
    const meta = await ensurePoolMeta();
    const cursor = await readCursor();
    const head = await backfillClient.getBlockNumber();

    // A persisted cursor only ever advances from POOL_DEPLOY_BLOCK - 1, so this
    // sentinel value means no progress was saved — i.e. a fresh DB.
    const isFresh = cursor === POOL_DEPLOY_BLOCK - 1n;

    let from = cursor + 1n;
    if (from > head) {
      console.log(
        `[pools-indexer] backfill: up to date at block ${head} (cursor=${cursor})`
      );
      return;
    }

    if (isFresh) {
      console.warn(
        `[pools-indexer] no saved cursor — running a FULL backfill from deploy block ${POOL_DEPLOY_BLOCK}. ` +
          `If you see this on EVERY restart, the DB at DATABASE_PATH is not persisting ` +
          `(check that the path is absolute and on a durable volume).`
      );
    } else {
      console.log(
        `[pools-indexer] resuming from saved cursor ${cursor} — incremental catch-up`
      );
    }

    console.log(
      `[pools-indexer] backfill: ${from} → ${head} (${head - from + 1n} blocks)`
    );

    let totalSwaps = 0;
    const startedAt = Date.now();

    while (from <= head) {
      const to =
        from + BACKFILL_CHUNK_SIZE - 1n > head
          ? head
          : from + BACKFILL_CHUNK_SIZE - 1n;

      const logs = await backfillClient.getLogs({
        address: POOL_MANAGER,
        event: swapEventAbi,
        args: { id: POOL_ID },
        fromBlock: from,
        toBlock: to,
      });

      if (logs.length > 0) {
        const enriched = await enrichSwapLogs(logs as SwapLog[], backfillClient, meta);
        const insertedKeys = await persistSwapRows(enriched.map((e) => e.row));
        totalSwaps += insertedKeys.size;
        console.log(
          `[pools-indexer] backfill ${from}-${to}: ${logs.length} logs (${insertedKeys.size} new)`
        );
      }

      await writeCursor(to);
      from = to + 1n;
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[pools-indexer] backfill complete: ${totalSwaps} swaps in ${elapsed}s`
    );
  }

  /**
   * Prepare for live polling: ensure the historical backfill has run, cache
   * pool meta, and load the latest persisted pool-state signature. Once this
   * resolves, `ready` is set and poll() begins doing work. Idempotent.
   */
  static async start(): Promise<void> {
    if (this.ready) return;
    await this.backfill();
    await ensurePoolMeta();
    this.lastStateSig = await readLatestPoolStateSig();
    this.ready = true;
    console.log("[pools-indexer] ready; live polling enabled");
  }

  /**
   * One polling cycle, driven by the cron job every second. Reads the current
   * head over HTTP, ingests any new Swap logs from the cursor up to head via
   * eth_getLogs, then refreshes pool state at head. Returns early until start()
   * has completed, and skips re-entrant ticks so a slow cycle never overlaps
   * the next one.
   */
  static async poll(): Promise<void> {
    if (!this.ready || this.polling) return;
    this.polling = true;
    try {
      const head = await backfillClient.getBlockNumber();
      await this.ingestNewSwaps(head);
      await this.refreshPoolState(head);
    } catch (err) {
      console.error("[pools-indexer] poll error:", err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Ingest Swap logs from cursor+1 up to `head` via chunked eth_getLogs. Same
   * chunked, cursor-per-chunk, dedup-on-insert flow as backfill, so any overlap
   * is harmless and a crash mid-poll resumes cleanly.
   */
  private static async ingestNewSwaps(head: bigint): Promise<void> {
    const meta = await ensurePoolMeta();
    const cursor = await readCursor();

    let from = cursor + 1n;
    if (from > head) return;

    while (from <= head) {
      const to =
        from + BACKFILL_CHUNK_SIZE - 1n > head
          ? head
          : from + BACKFILL_CHUNK_SIZE - 1n;

      const logs = await backfillClient.getLogs({
        address: POOL_MANAGER,
        event: swapEventAbi,
        args: { id: POOL_ID },
        fromBlock: from,
        toBlock: to,
      });

      if (logs.length > 0) {
        // Enrich over the same (free) public RPC used for getLogs so the swap
        // pipeline never touches Alchemy CU.
        const enriched = await enrichSwapLogs(logs as SwapLog[], backfillClient, meta);
        const insertedKeys = await persistSwapRows(enriched.map((e) => e.row));
        if (insertedKeys.size > 0) {
          console.log(
            `[pools-indexer] poll ${from}-${to}: ${insertedKeys.size} new swaps`
          );
          for (const { row, event } of enriched) {
            if (insertedKeys.has(`${row.txHash}:${row.logIndex}`)) {
              emitter.emit("swap", event);
            }
          }
        }
      }

      await writeCursor(to);
      from = to + 1n;
    }
  }

  private static async refreshPoolState(blockNumber: bigint): Promise<void> {
    const state = await fetchPoolState(blockNumber);
    if (!state) return;

    const sig = stateSig(state);
    const changed = sig !== this.lastStateSig;

    if (changed) {
      await db
        .insert(poolStates)
        .values({
          poolId: POOL_ID,
          blockNumber: Number(state.blockNumber),
          blockTimestamp: state.blockTimestamp,
          sqrtPriceX96: state.sqrtPriceX96,
          tick: state.tick,
          protocolFee: state.protocolFee,
          lpFee: state.lpFee,
          liquidity: state.liquidity,
          feeGrowthGlobal0: state.feeGrowthGlobal0,
          feeGrowthGlobal1: state.feeGrowthGlobal1,
          reserve0: state.reserve0,
          reserve1: state.reserve1,
          updatedAt: Date.now(),
        })
        .onConflictDoNothing();
      this.lastStateSig = sig;
    }

    const meta = await ensurePoolMeta();
    emitter.emit("pool_state", buildPoolStateData(state, meta));
  }
}
