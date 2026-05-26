import {
  createPublicClient,
  http,
  webSocket,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";
import { arbitrumSepolia } from "viem/chains";

const ARBITRUM_SEPOLIA_RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const ARBITRUM_SEPOLIA_WSS_URL = process.env.ARBITRUM_SEPOLIA_WSS_URL;

if (!ARBITRUM_SEPOLIA_RPC_URL) {
  throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
}
if (!ARBITRUM_SEPOLIA_WSS_URL) {
  throw new Error("ARBITRUM_SEPOLIA_WSS_URL is not set");
}

const httpClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
  batch: { multicall: true },
});

const wssClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: webSocket(ARBITRUM_SEPOLIA_WSS_URL),
});

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
);

const POOL_ID =
  "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257" as `0x${string}`;
const CURRENCY0 = "0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a" as Address;
const CURRENCY1 = "0x46DEA9Be3165024CC358Fa24798458e62BFC1d57" as Address;
const POOL_MANAGER = "0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317" as Address;
const STATE_VIEW = "0x9d467fa9062b6e9b1a46e26007ad82db116c67cb" as Address;

const MAX_RECENT_SWAPS = 50;

export const SUPPORTED_POOL_ID = POOL_ID;

export interface PoolState {
  currency0Symbol: string;
  currency1Symbol: string;
  currency0Decimals: number;
  currency1Decimals: number;
  sqrtPriceX96: string;
  tick: number;
  protocolFee: number;
  lpFee: number;
  liquidity: string;
  feeGrowthGlobal0X128: string;
  feeGrowthGlobal1X128: string;
  reserve0: string;
  reserve1: string;
  blockNumber: string;
  updatedAt: number;
}

export interface SwapEventData {
  poolId: string;
  sender: string;
  userAddress: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
  transactionHash: string;
  blockNumber: string;
  timestamp: number;
}

interface ClientInfo {
  ws: any;
  filterAddress: string | null;
}

let currency0Symbol = "mETH";
let currency1Symbol = "mVND";
let currency0Decimals = 18;
let currency1Decimals = 18;

export abstract class PoolsService {
  private static cache: PoolState | null = null;
  private static clients = new Map<any, ClientInfo>();
  private static recentSwaps: SwapEventData[] = [];
  private static seenSwapHashes = new Set<string>();
  private static initialized = false;

  static async init(): Promise<void> {
    if (this.initialized) return;

    const staticResults = await httpClient.multicall({
      contracts: [
        { address: CURRENCY0, abi: erc20Abi, functionName: "symbol" },
        { address: CURRENCY1, abi: erc20Abi, functionName: "symbol" },
        { address: CURRENCY0, abi: erc20Abi, functionName: "decimals" },
        { address: CURRENCY1, abi: erc20Abi, functionName: "decimals" },
      ],
    });

    if (staticResults[0].status === "success")
      currency0Symbol = staticResults[0].result;
    if (staticResults[1].status === "success")
      currency1Symbol = staticResults[1].result;
    if (staticResults[2].status === "success")
      currency0Decimals = staticResults[2].result;
    if (staticResults[3].status === "success")
      currency1Decimals = staticResults[3].result;

    await this.fetchDynamicState();

    wssClient.watchBlockNumber({
      onBlockNumber: async (blockNumber) => {
        try {
          await this.fetchDynamicState(blockNumber);
        } catch (err) {
          console.error("[pools] fetchDynamicState error:", err);
        }
      },
      onError: (error) => {
        console.error("[pools] watchBlockNumber error:", error);
      },
    });

    wssClient.watchContractEvent({
      address: POOL_MANAGER,
      abi: [swapEvent],
      eventName: "Swap",
      args: { id: POOL_ID },
      onLogs: (logs) => {
        for (const log of logs) {
          this.handleSwapLog(log).catch((err) => {
            console.error("[pools] handleSwapLog error:", err);
          });
        }
      },
      onError: (error) => {
        console.error("[pools] watchContractEvent error:", error);
      },
    });

    this.initialized = true;
    console.log(
      `[pools] initialized — watching pool ${POOL_ID.slice(0, 10)}…`
    );
  }

  private static async handleSwapLog(log: any): Promise<void> {
    const txHash = log.transactionHash as string;
    if (this.seenSwapHashes.has(txHash)) return;
    this.seenSwapHashes.add(txHash);

    // Keep the set bounded
    if (this.seenSwapHashes.size > MAX_RECENT_SWAPS * 2) {
      const excess = this.seenSwapHashes.size - MAX_RECENT_SWAPS;
      let removed = 0;
      for (const h of this.seenSwapHashes) {
        if (removed >= excess) break;
        this.seenSwapHashes.delete(h);
        removed++;
      }
    }

    let userAddress = log.args.sender as string;
    try {
      const tx = await httpClient.getTransaction({
        hash: txHash,
      });
      userAddress = tx.from;
    } catch {
      // fall back to sender (likely the router)
    }

    const swap: SwapEventData = {
      poolId: POOL_ID,
      sender: log.args.sender as string,
      userAddress,
      amount0: (log.args.amount0 as bigint).toString(),
      amount1: (log.args.amount1 as bigint).toString(),
      sqrtPriceX96: (log.args.sqrtPriceX96 as bigint).toString(),
      liquidity: (log.args.liquidity as bigint).toString(),
      tick: log.args.tick as number,
      fee: log.args.fee as number,
      transactionHash: log.transactionHash as string,
      blockNumber: (log.blockNumber as bigint).toString(),
      timestamp: Date.now(),
    };

    this.recentSwaps.push(swap);
    if (this.recentSwaps.length > MAX_RECENT_SWAPS) {
      this.recentSwaps.shift();
    }

    this.broadcastSwap(swap);
  }

  private static async fetchDynamicState(blockNumber?: bigint): Promise<void> {
    const block = blockNumber ?? (await httpClient.getBlockNumber());

    const results = await httpClient.multicall({
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
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [POOL_MANAGER],
        },
        {
          address: CURRENCY1,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [POOL_MANAGER],
        },
      ],
    });

    const slot0 = results[0].status === "success" ? results[0].result : null;
    const liquidity =
      results[1].status === "success" ? results[1].result : null;
    const feeGrowth =
      results[2].status === "success" ? results[2].result : null;
    const balance0 = results[3].status === "success" ? results[3].result : null;
    const balance1 = results[4].status === "success" ? results[4].result : null;

    if (
      !slot0 ||
      liquidity == null ||
      !feeGrowth ||
      balance0 == null ||
      balance1 == null
    ) {
      console.error("[pools] incomplete multicall results, skipping update");
      return;
    }

    this.cache = {
      currency0Symbol,
      currency1Symbol,
      currency0Decimals,
      currency1Decimals,
      sqrtPriceX96: slot0[0].toString(),
      tick: slot0[1],
      protocolFee: slot0[2],
      lpFee: slot0[3],
      liquidity: liquidity.toString(),
      feeGrowthGlobal0X128: feeGrowth[0].toString(),
      feeGrowthGlobal1X128: feeGrowth[1].toString(),
      reserve0: balance0.toString(),
      reserve1: balance1.toString(),
      blockNumber: block.toString(),
      updatedAt: Date.now(),
    };

    this.broadcastPoolState();
  }

  private static broadcastPoolState(): void {
    if (!this.cache) return;
    const payload = JSON.stringify({ type: "pool_state", data: this.cache });
    for (const [, client] of this.clients) {
      try {
        client.ws.send(payload);
      } catch {
        this.clients.delete(client.ws);
      }
    }
  }

  private static broadcastSwap(swap: SwapEventData): void {
    const payload = JSON.stringify({ type: "swap", data: swap });
    for (const [, client] of this.clients) {
      try {
        if (
          client.filterAddress &&
          swap.userAddress.toLowerCase() !== client.filterAddress.toLowerCase()
        ) {
          continue;
        }
        client.ws.send(payload);
      } catch {
        this.clients.delete(client.ws);
      }
    }
  }

  static getState(): PoolState | null {
    return this.cache;
  }

  static getRecentSwaps(): SwapEventData[] {
    return this.recentSwaps;
  }

  static addConnection(ws: any): void {
    this.clients.set(ws, { ws, filterAddress: null });
    if (this.cache) {
      ws.send(JSON.stringify({ type: "pool_state", data: this.cache }));
    }
    if (this.recentSwaps.length > 0) {
      ws.send(
        JSON.stringify({ type: "recent_swaps", data: this.recentSwaps })
      );
    }
  }

  static removeConnection(ws: any): void {
    this.clients.delete(ws);
  }

  static setFilterAddress(ws: any, address: string | null): void {
    const client = this.clients.get(ws);
    if (client) {
      client.filterAddress = address;
    }
  }
}
