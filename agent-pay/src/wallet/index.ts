/**
 * Wallet Module
 *
 * Exports all wallet-related functionality for Cosmos/Akash wallets.
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
  promptPassword,
  type StoredWallet,
} from "./wallet-storage.js";
