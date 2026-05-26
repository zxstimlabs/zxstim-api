# zxstim-api

Elysia API running on Bun.

## Development

```bash
bun install
bun run dev
```

Server runs at http://localhost:8001

## Environment Variables

Create a `.env.local` file:

```
ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/<YOUR_KEY>
ARBITRUM_SEPOLIA_WSS_URL=wss://arb-sepolia.g.alchemy.com/v2/<YOUR_KEY>
```

## Pools WebSocket Integration

The `/pools` module streams live Uniswap V4 pool state and swap events to frontend clients over a single WebSocket connection.

### Endpoints

- **REST** `GET /pools/:poolId` — returns latest pool state + recent swaps
- **WebSocket** `WS /pools/:poolId/ws` — streams pool state updates and swap events in real time

### Pool ID

```
0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257
```

### WebSocket Message Types

All messages are JSON with a `type` field:

#### `pool_state` — sent on every new block

```json
{
  "type": "pool_state",
  "data": {
    "currency0Symbol": "ETH",
    "currency1Symbol": "VND",
    "currency0Decimals": 18,
    "currency1Decimals": 18,
    "sqrtPriceX96": "588100859679867612338768403599633",
    "tick": 178255,
    "protocolFee": 0,
    "lpFee": 500,
    "liquidity": "74228532250072169377684025",
    "feeGrowthGlobal0X128": "346111096686892598082152625",
    "feeGrowthGlobal1X128": "23019849040645226698443971215162792",
    "reserve0": "9999968821516356479511",
    "reserve1": "550989227082318594375578085831",
    "blockNumber": "271312626",
    "updatedAt": 1779814558367
  }
}
```

#### `swap` — sent when a swap occurs in the pool

```json
{
  "type": "swap",
  "data": {
    "poolId": "0x363251ac...",
    "sender": "0x...",
    "userAddress": "0x...",
    "amount0": "-1000000000000000000",
    "amount1": "55000000000000000000000",
    "sqrtPriceX96": "588100859679867612338768403599633",
    "liquidity": "74228532250072169377684025",
    "tick": 178255,
    "fee": 500,
    "transactionHash": "0x...",
    "blockNumber": "271312626",
    "timestamp": 1779814558367
  }
}
```

- `sender` is the contract that called the PoolManager (usually the Universal Router)
- `userAddress` is the wallet that initiated the transaction (`tx.from`)
- `amount0`/`amount1` are signed — negative means tokens going in, positive means tokens coming out

#### `recent_swaps` — sent once on connect

```json
{
  "type": "recent_swaps",
  "data": [{ ... }, { ... }]
}
```

Contains the last 50 swap events cached in memory. Same shape as `swap` data.

### Filtering Swaps by Address

To only receive swap events for a specific wallet, send a message after connecting:

```json
{ "filterAddress": "0xb4A520D855C21A449d1031727911BDE602FfA7DC" }
```

Pool state updates are always sent regardless of filter. To clear the filter:

```json
{ "filterAddress": null }
```

### REST Response Shape

`GET /pools/:poolId` returns:

```json
{
  "pool": { ... },
  "recentSwaps": [{ ... }, { ... }]
}
```

### React Hook Example

```tsx
import { useState, useEffect, useRef, useCallback } from "react";

interface PoolState {
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

interface SwapEvent {
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

function usePoolStream(poolId: string, filterAddress?: string) {
  const [pool, setPool] = useState<PoolState | null>(null);
  const [swaps, setSwaps] = useState<SwapEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(
      `ws://localhost:8001/pools/${poolId}/ws`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      if (filterAddress) {
        ws.send(JSON.stringify({ filterAddress }));
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "pool_state":
          setPool(msg.data);
          break;
        case "swap":
          setSwaps((prev) => [...prev, msg.data]);
          break;
        case "recent_swaps":
          setSwaps(msg.data);
          break;
      }
    };

    return () => ws.close();
  }, [poolId, filterAddress]);

  return { pool, swaps };
}
```

Usage:

```tsx
const POOL_ID = "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

// All swaps
function GlobalSwapFeed() {
  const { pool, swaps } = usePoolStream(POOL_ID);
  // ...
}

// Only swaps for a specific wallet
function MySwapFeed({ address }: { address: string }) {
  const { pool, swaps } = usePoolStream(POOL_ID, address);
  // ...
}
```

All bigint values are serialized as strings. Parse them with `BigInt(value)` on the frontend.

### Live Price Chart Integration

Each `pool_state` message contains `sqrtPriceX96`, `tick`, and `blockNumber`. You can accumulate these into a time series and render a live price chart.

#### Price Conversion

Convert `sqrtPriceX96` to a human-readable price:

```ts
function sqrtPriceX96ToPrice(
  sqrtPriceX96: string,
  decimals0: number,
  decimals1: number
): number {
  const sqrtPrice = Number(BigInt(sqrtPriceX96)) / Number(BigInt(2) ** BigInt(96));
  const rawPrice = sqrtPrice * sqrtPrice;
  const decimalAdjustment = 10 ** (decimals0 - decimals1);
  return rawPrice * decimalAdjustment;
}
```

#### Price History Hook

Accumulates price points from the WebSocket stream for charting:

```tsx
import { useState, useEffect, useRef } from "react";

interface PricePoint {
  price: number;
  tick: number;
  blockNumber: string;
  timestamp: number;
}

function usePriceHistory(poolId: string, maxPoints = 500) {
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [pool, setPool] = useState<PoolState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(
      `ws://localhost:8001/pools/${poolId}/ws`
    );
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type !== "pool_state") return;

      const data = msg.data;
      setPool(data);

      const price = sqrtPriceX96ToPrice(
        data.sqrtPriceX96,
        data.currency0Decimals,
        data.currency1Decimals
      );

      setHistory((prev) => {
        // Skip if price hasn't changed (avoids flat duplicates)
        if (prev.length > 0 && prev[prev.length - 1].price === price) {
          return prev;
        }
        const next = [...prev, {
          price,
          tick: data.tick,
          blockNumber: data.blockNumber,
          timestamp: data.updatedAt,
        }];
        // Keep bounded
        if (next.length > maxPoints) next.shift();
        return next;
      });
    };

    return () => ws.close();
  }, [poolId, maxPoints]);

  return { pool, history };
}
```

#### Minimal Chart Component

Using plain SVG (no chart library needed):

```tsx
function PriceChart({ history }: { history: PricePoint[] }) {
  if (history.length < 2) return <p>Collecting data...</p>;

  const width = 600;
  const height = 200;
  const padding = 10;

  const prices = history.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const points = history
    .map((p, i) => {
      const x = padding + (i / (history.length - 1)) * (width - padding * 2);
      const y = height - padding - ((p.price - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className="border rounded">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
```

Usage:

```tsx
const POOL_ID = "0x363251ac1864e05ea6f839785a02ccaef52cd97f9e2b4516a4c47b638efb4257";

function LivePriceView() {
  const { pool, history } = usePriceHistory(POOL_ID);

  return (
    <div>
      <h2>{pool?.currency0Symbol}/{pool?.currency1Symbol}</h2>
      <p>
        Current price: {history.length > 0
          ? history[history.length - 1].price.toLocaleString(undefined, { maximumFractionDigits: 6 })
          : "Loading..."}
      </p>
      <PriceChart history={history} />
      <p>{history.length} data points</p>
    </div>
  );
}
```

Note: the chart only shows data from the moment the page loads. For historical charts, persist price snapshots on the backend (e.g. SQLite) and serve them via the REST endpoint.
