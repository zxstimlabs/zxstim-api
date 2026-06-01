import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
  type SignedAuthorization,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

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

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
});

const walletClient = createWalletClient({
  account: sponsorAccount,
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA_RPC_URL),
});

export abstract class DelegateService {
  static async delegate(
    authorization: SignedAuthorization,
    authority: Address
  ): Promise<{ transactionHash: string }> {
    const estimatedGas = await publicClient.estimateGas({
      account: sponsorAccount.address,
      to: authority,
      value: 0n,
      // Include the authorization so the estimate covers the EIP-7702
      // intrinsic gas (~25k per authorization); otherwise the estimate is
      // too low and the tx reverts with "intrinsic gas too low".
      authorizationList: [authorization],
    });
    // Add a 50% buffer plus a flat floor to stay safe against estimate drift.
    const gas = estimatedGas + estimatedGas / 2n + 50_000n;

    const hash = await walletClient.sendTransaction({
      authorizationList: [authorization],
      to: authority,
      data: "0x",
      value: 0n,
      gas,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "reverted") {
      throw new Error("delegation transaction reverted");
    }

    return { transactionHash: hash };
  }
}
