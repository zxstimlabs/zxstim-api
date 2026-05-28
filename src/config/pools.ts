import { parseAbi, parseAbiItem, type Address } from "viem";

export const POOL_ID =
  "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257" as `0x${string}`;

export const POOL_DEPLOY_BLOCK = 271232501n;

export const CURRENCY0 = "0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a" as Address;
export const CURRENCY1 = "0x46DEA9Be3165024CC358Fa24798458e62BFC1d57" as Address;
export const POOL_MANAGER = "0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317" as Address;
export const STATE_VIEW = "0x9d467fa9062b6e9b1a46e26007ad82db116c67cb" as Address;

export const BACKFILL_CHUNK_SIZE = 5000n;

export const swapEventAbi = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128)",
]);

export const tokenMetaAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/**
 * Convert Uniswap V4 sqrtPriceX96 to a float price (token1 per token0),
 * adjusted for token decimals. Loses precision for very large values but
 * is sufficient for charting.
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): number {
  const sqrt = Number(sqrtPriceX96) / Number(2n ** 96n);
  const raw = sqrt * sqrt;
  const adjustment = 10 ** (decimals0 - decimals1);
  return raw * adjustment;
}
