export interface PoolStateData {
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
  price: number;
  transactionHash: string;
  blockNumber: string;
  blockTimestamp: number;
  timestamp: number;
}
