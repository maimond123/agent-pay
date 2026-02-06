/**
 * EVM Wallet Utilities
 *
 * Derives an EVM (Base) account from the same BIP39 mnemonic used for Akash.
 * Uses viem for all EVM operations: account derivation, balance queries, signing.
 *
 * Derivation paths:
 *   Cosmos: m/44'/118'/0'/0/0 (CosmJS default)
 *   EVM:    m/44'/60'/0'/0/0  (viem default via mnemonicToAccount)
 */

import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";

// Base Mainnet USDC contract
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// Minimal ERC20 ABI for balance queries
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Derive an EVM account from a BIP39 mnemonic.
 * Uses the standard Ethereum derivation path m/44'/60'/0'/0/0.
 */
export function deriveEvmAccount(mnemonic: string): {
  evmAddress: `0x${string}`;
  evmAccount: HDAccount;
} {
  const evmAccount = mnemonicToAccount(mnemonic);
  return {
    evmAddress: evmAccount.address,
    evmAccount,
  };
}

/**
 * Query Base chain balances for an EVM address.
 * Returns USDC balance and ETH balance (for gas).
 */
export async function getEvmBalance(address: `0x${string}`): Promise<{
  usdcRaw: bigint;
  usdcFormatted: string;
  ethRaw: bigint;
  ethFormatted: string;
}> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const [usdcRaw, ethRaw] = await Promise.all([
    publicClient.readContract({
      address: BASE_USDC_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
    publicClient.getBalance({ address }),
  ]);

  return {
    usdcRaw,
    usdcFormatted: (Number(usdcRaw) / 1e6).toFixed(6),
    ethRaw,
    ethFormatted: formatEther(ethRaw),
  };
}

/**
 * Create a viem WalletClient on Base for autonomous EVM signing.
 * Used for direct bridge transactions (no WalletConnect/QR code needed).
 */
export function createEvmWalletClient(account: HDAccount): WalletClient {
  return createWalletClient({
    account,
    chain: base,
    transport: http(),
  });
}

/**
 * Create a viem PublicClient on Base for read-only queries.
 */
export function createEvmPublicClient(): PublicClient {
  return createPublicClient({
    chain: base,
    transport: http(),
  }) as PublicClient;
}

export type { HDAccount } from "viem/accounts";
