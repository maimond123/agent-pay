/**
 * Wallet Module
 *
 * Exports all wallet-related functionality for Cosmos/Akash and EVM wallets.
 */

export {
  createAkashWallet,
  restoreAkashWallet,
  getWalletAddress,
  isValidAkashAddress,
  isValidMnemonic,
  type WalletCreationResult,
} from "./cosmos-wallet.js";

export {
  saveWallet,
  loadWallet,
  getOrUnlockWallet,
  lockWallet,
  listStoredWallets,
  walletExists,
  getDefaultWalletAddress,
  getStoredEvmAddress,
  promptPassword,
  type StoredWallet,
} from "./wallet-storage.js";

export {
  deriveEvmAccount,
  getEvmBalance,
  createEvmWalletClient,
  createEvmPublicClient,
  type HDAccount,
} from "./evm-wallet.js";

export {
  compressedPubkeyFromHex,
  evmPubkeyToAkashAddress,
  verifyEvmPubkey,
} from "./key-utils.js";

export {
  loadBudget,
  saveBudget,
  canSpend,
  recordSpend,
  getBudgetSummary,
  type BudgetConfig,
  type BudgetState,
  type SpendRecord,
} from "./budget.js";
