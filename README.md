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
HOT_MANAGER_WALLET_PRIVATE_KEY=0x<YOUR_PRIVATE_KEY>
HOT_MANAGER_WALLET_ADDRESS=0x<YOUR_ADDRESS>
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

## Delegate (EIP-7702 Gas Sponsorship)

The `/delegate` module lets a user delegate their EOA to a contract via [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) without paying gas. The user signs an authorization off-chain, POSTs it to the API, and the server's hot manager wallet sponsors the on-chain transaction.

### Endpoint

**POST** `/delegate/arbitrum-sepolia`

### Request Body

```json
{
  "authorization": {
    "address": "0x<contract to delegate to>",
    "chainId": 421614,
    "nonce": 0,
    "r": "0x...",
    "s": "0x...",
    "yParity": 0
  },
  "authority": "0x<user EOA address>"
}
```

| Field | Description |
|---|---|
| `authorization.address` | Contract address the EOA is delegating to |
| `authorization.chainId` | Chain ID (421614 for Arbitrum Sepolia) |
| `authorization.nonce` | Current nonce of the user's EOA |
| `authorization.r`, `s`, `yParity` | Signature components from `signAuthorization` |
| `authority` | The user's EOA address that signed the authorization |

### Response

**Success (200):**

```json
{
  "transactionHash": "0x..."
}
```

**Error (400):**

```json
{
  "error": "delegation transaction reverted"
}
```

### Frontend Integration (viem)

```ts
import { walletClient } from "./config"; // user's wallet client

const CONTRACT_ADDRESS = "0x<contract to delegate to>";

// 1. Sign the authorization (gasless — no tx sent)
const authorization = await walletClient.signAuthorization({
  contractAddress: CONTRACT_ADDRESS,
});

// 2. POST to the API — hot wallet sponsors the gas
const response = await fetch("http://localhost:8001/delegate/arbitrum-sepolia", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    authorization,
    authority: walletClient.account.address,
  }),
});

const result = await response.json();
console.log(result.transactionHash);
```

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

## Sponsored Trade (Gas Sponsorship)

The `/sponsor/trade` endpoint lets a user execute a batched swap without paying gas. The user signs the batch of calls off-chain, POSTs them to the API, and the server's hot manager wallet submits the transaction on-chain.

This requires the user's EOA to have already been delegated to the `BatchCallAndSponsor` contract via the `/delegate/arbitrum-sepolia` endpoint.

### Endpoint

**POST** `/sponsor/trade`

### Request Body

```json
{
  "authority": "0x<user EOA address>",
  "calls": [
    { "to": "0x<token>", "value": "0", "data": "0x<approve calldata>" },
    { "to": "0x<permit2>", "value": "0", "data": "0x<permit2 approve calldata>" },
    { "to": "0x<router>", "value": "0", "data": "0x<swap calldata>" }
  ],
  "signature": "0x<ECDSA signature>"
}
```

| Field | Description |
|---|---|
| `authority` | The user's EOA address (delegated to `BatchCallAndSponsor`) |
| `calls` | Array of calls to batch-execute: ERC-20 approve, Permit2 approve, Universal Router swap |
| `calls[].to` | Target contract address |
| `calls[].value` | ETH value as a string (use `"0"` for token swaps) |
| `calls[].data` | ABI-encoded calldata for the target function |
| `signature` | ECDSA signature over the current nonce and calls (see signing section below) |

### Response

**Success (200):**

```json
{
  "transactionHash": "0x..."
}
```

**Error (400):**

```json
{
  "error": "sponsored trade transaction reverted"
}
```

### Signing the Batch

The `BatchCallAndSponsor` contract verifies the signature against a digest of:

```
keccak256(abi.encodePacked(nonce, calls[0].to, calls[0].value, calls[0].data, calls[1].to, ...))
```

Wrapped with EIP-191 (`\x19Ethereum Signed Message\n32` prefix).

The nonce is read from the contract and auto-increments after each execution, providing replay protection.

### Frontend Integration (viem)

```ts
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  encodeFunctionData,
  encodePacked,
  keccak256,
  type Address,
  parseUnits,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { V4Planner, Actions } from "@uniswap/v4-sdk";

// --- Constants ---

const CURRENCY0 = "0x3890f8Fb0F7aa237e03E995CFe7282fdb519F95a" as Address; // mETH
const CURRENCY1 = "0x46DEA9Be3165024CC358Fa24798458e62BFC1d57" as Address; // mVND
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const UNIVERSAL_ROUTER = "0xeFd1D4bD4cf1e86Da286BB4CB1B8BcED9C10BA47" as Address;
const BATCH_CALL_AND_SPONSOR = "0xBC88C078bf2e0ECeF6F235Df065E7600E95F27F5" as Address;

const POOL_KEY = {
  currency0: CURRENCY0,
  currency1: CURRENCY1,
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000" as Address,
};

const BATCH_CALL_AND_SPONSOR_ABI = [
  {
    inputs: [],
    name: "nonce",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const MAX_UINT256 = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
);

const PERMIT2_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  {
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

// --- Build the V4 swap input ---

function buildV4SwapInput(zeroForOne: boolean, amountIn: bigint): `0x${string}` {
  const inputCurrency = zeroForOne ? CURRENCY0 : CURRENCY1;
  const outputCurrency = zeroForOne ? CURRENCY1 : CURRENCY0;

  const planner = new V4Planner();
  planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
    {
      poolKey: POOL_KEY,
      zeroForOne,
      amountIn: amountIn.toString(),
      amountOutMinimum: "0",
      hookData: "0x",
    },
  ]);
  planner.addAction(Actions.SETTLE_ALL, [inputCurrency, MAX_UINT256.toString()]);
  planner.addAction(Actions.TAKE_ALL, [outputCurrency, "0"]);

  return planner.finalize() as `0x${string}`;
}

// --- Sponsored swap flow ---

async function sponsoredSwap(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  zeroForOne: boolean,
  amount: string,
  apiUrl: string
) {
  const account = walletClient.account!;
  const amountIn = parseUnits(amount, 18);
  const inputToken = zeroForOne ? CURRENCY0 : CURRENCY1;
  const v4SwapInput = buildV4SwapInput(zeroForOne, amountIn);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // 1. Build the calls array
  const calls = [
    {
      to: inputToken,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2, amountIn],
      }),
    },
    {
      to: PERMIT2,
      value: 0n,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [
          inputToken,
          UNIVERSAL_ROUTER,
          amountIn,
          Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        ],
      }),
    },
    {
      to: UNIVERSAL_ROUTER,
      value: 0n,
      data: encodeFunctionData({
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: ["0x10" as `0x${string}`, [v4SwapInput], deadline],
      }),
    },
  ];

  // 2. Read the current nonce from the user's delegated EOA
  const currentNonce = await publicClient.readContract({
    address: account.address,
    abi: BATCH_CALL_AND_SPONSOR_ABI,
    functionName: "nonce",
  });

  // 3. Build the digest: keccak256(abi.encodePacked(nonce, calls[0].to, calls[0].value, calls[0].data, ...))
  const packed = encodePacked(
    ["uint256", ...calls.flatMap(() => ["address", "uint256", "bytes"] as const)],
    [currentNonce, ...calls.flatMap((c) => [c.to, c.value, c.data])] as any
  );
  const digest = keccak256(packed);

  // 4. Sign the digest with EIP-191 personal sign
  const signature = await walletClient.signMessage({
    account,
    message: { raw: digest },
  });

  // 5. POST to the sponsor API
  const response = await fetch(`${apiUrl}/sponsor/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authority: account.address,
      calls: calls.map((c) => ({
        to: c.to,
        value: c.value.toString(),
        data: c.data,
      })),
      signature,
    }),
  });

  return response.json();
}
```

Usage:

```ts
// Sell ETH for VND (zeroForOne = true)
const result = await sponsoredSwap(walletClient, publicClient, true, "1.0", "http://localhost:8001");
console.log(result.transactionHash);

// Buy ETH with VND (zeroForOne = false)
const result = await sponsoredSwap(walletClient, publicClient, false, "55000", "http://localhost:8001");
console.log(result.transactionHash);
```

### Flow Summary

1. **One-time setup**: User delegates EOA to `BatchCallAndSponsor` via `POST /delegate/arbitrum-sepolia`
2. **Each trade**: User builds the calls array, reads the nonce from their delegated EOA, signs `keccak256(abi.encodePacked(nonce, ...calls))` with personal sign, then POSTs to `POST /sponsor/trade`
3. **Server**: Hot wallet calls `execute(calls, signature)` on the user's EOA, paying the gas. The contract verifies the signature matches the EOA owner and increments the nonce for replay protection.
