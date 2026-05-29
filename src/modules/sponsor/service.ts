import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { BATCH_CALL_AND_SPONSOR_ABI } from "../../lib/abis";

const ARBITRUM_SEPOLIA_RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const HOT_MANAGER_WALLET_PRIVATE_KEY = process.env.HOT_MANAGER_WALLET_PRIVATE_KEY;

if (!ARBITRUM_SEPOLIA_RPC_URL) {
  throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
}
if (!HOT_MANAGER_WALLET_PRIVATE_KEY) {
  throw new Error("HOT_MANAGER_WALLET_PRIVATE_KEY is not set");
}

const sponsorAccount = privateKeyToAccount(
  HOT_MANAGER_WALLET_PRIVATE_KEY as `0x${string}`
);

export const HOT_MANAGER_WALLET_ADDRESS = sponsorAccount.address;

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
});

const walletClient = createWalletClient({
  account: sponsorAccount,
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
});

export interface Call {
  to: Address;
  value: bigint;
  data: `0x${string}`;
}

export abstract class SponsorService {
  static async trade(
    authority: Address,
    calls: Call[],
    signature: `0x${string}`
  ): Promise<{ transactionHash: string }> {
    const estimatedGas = await publicClient.estimateContractGas({
      account: sponsorAccount.address,
      address: authority,
      abi: BATCH_CALL_AND_SPONSOR_ABI,
      functionName: "execute",
      args: [calls, signature],
    });
    const gas = estimatedGas + estimatedGas / 5n;

    const hash = await walletClient.writeContract({
      address: authority,
      abi: BATCH_CALL_AND_SPONSOR_ABI,
      functionName: "execute",
      args: [calls, signature],
      gas,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "reverted") {
      throw new Error("sponsored trade transaction reverted");
    }

    return { transactionHash: hash };
  }
}
