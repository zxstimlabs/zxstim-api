import {
  createWalletClient,
  createPublicClient,
  erc20Abi,
  http,
  parseUnits,
  verifyMessage,
  getAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import {
  CLAIMABLE_TOKENS,
  NONCE_VALIDITY_WINDOW_MS,
} from "../../config/claim";

const ARBITRUM_SEPOLIA_RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const HOT_MANAGER_WALLET_PRIVATE_KEY = process.env.HOT_MANAGER_WALLET_PRIVATE_KEY;

if (!ARBITRUM_SEPOLIA_RPC_URL) {
  throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
}
if (!HOT_MANAGER_WALLET_PRIVATE_KEY) {
  throw new Error("HOT_MANAGER_WALLET_PRIVATE_KEY is not set");
}

const managerAccount = privateKeyToAccount(
  HOT_MANAGER_WALLET_PRIVATE_KEY as `0x${string}`
);

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
});

const walletClient = createWalletClient({
  account: managerAccount,
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
});

export interface ClaimParams {
  requester: Address;
  tokens: Address[];
  nonce: number;
  signature: `0x${string}`;
}

export interface ClaimResult {
  token: Address;
  amount: string;
  transactionHash: string;
}

export abstract class ClaimService {
  static buildMessage(requester: Address, tokens: Address[], nonce: number): string {
    return [
      "zxstim-api claim mock-tokens",
      `requester: ${getAddress(requester)}`,
      `tokens: ${tokens.map((t) => getAddress(t)).join(",")}`,
      `nonce: ${nonce}`,
    ].join("\n");
  }

  static async claim({
    requester,
    tokens,
    nonce,
    signature,
  }: ClaimParams): Promise<ClaimResult[]> {
    if (tokens.length === 0) {
      throw new Error("tokens array is empty");
    }

    const drift = Math.abs(Date.now() - nonce);
    if (Number.isNaN(nonce) || drift > NONCE_VALIDITY_WINDOW_MS) {
      throw new Error("nonce expired or invalid");
    }

    const normalizedRequester = getAddress(requester);
    const normalizedTokens = tokens.map((t) => getAddress(t));

    for (const token of normalizedTokens) {
      if (!CLAIMABLE_TOKENS[token]) {
        throw new Error(`token ${token} is not claimable`);
      }
    }

    const message = ClaimService.buildMessage(
      normalizedRequester,
      normalizedTokens,
      nonce
    );

    const valid = await verifyMessage({
      address: normalizedRequester,
      message,
      signature,
    });

    if (!valid) {
      throw new Error("invalid signature");
    }

    const results: ClaimResult[] = [];
    for (const token of normalizedTokens) {
      const { amount, decimals } = CLAIMABLE_TOKENS[token];
      const value = parseUnits(amount, decimals);

      const estimatedGas = await publicClient.estimateContractGas({
        account: managerAccount,
        address: token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [normalizedRequester, value],
      });
      // Add a 50% buffer plus a flat floor to stay safe against estimate drift.
      const gas = estimatedGas + estimatedGas / 2n + 50_000n;

      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [normalizedRequester, value],
        gas,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        throw new Error(`claim transfer for ${token} reverted`);
      }

      results.push({ token, amount, transactionHash: hash });
    }

    return results;
  }
}
