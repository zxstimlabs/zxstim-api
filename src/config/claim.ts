import { getAddress, type Address } from "viem";
import {
  MOCK_ETH_CONTRACT_ADDRESS,
  MOCK_VND_CONTRACT_ADDRESS,
} from "../lib/constants";

export interface ClaimableToken {
  amount: string;
  decimals: number;
}

export const CLAIMABLE_TOKENS: Record<Address, ClaimableToken> = {
  [getAddress(MOCK_ETH_CONTRACT_ADDRESS)]: { amount: "0.1", decimals: 18 },
  [getAddress(MOCK_VND_CONTRACT_ADDRESS)]: { amount: "5000000", decimals: 18 },
};

export const NONCE_VALIDITY_WINDOW_MS = 5 * 60 * 1000;
