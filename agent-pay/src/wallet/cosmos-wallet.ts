/**
 * Cosmos/Akash Wallet Creation
 *
 * Creates and manages Akash-compatible wallets using CosmJS.
 * Wallets are created locally - the agent never sees the mnemonic.
 */

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { Bip39, Random } from "@cosmjs/crypto";

export interface WalletCreationResult {
  address: string;
  mnemonic: string;
  pubkey: string;
}

/**
 * Generate a new Akash wallet with a 24-word mnemonic
 */
export async function createAkashWallet(): Promise<WalletCreationResult> {
  // Generate wallet with 24-word mnemonic
  const wallet = await DirectSecp256k1HdWallet.generate(24, {
    prefix: "akash",
  });

  const [account] = await wallet.getAccounts();

  return {
    address: account.address,
    mnemonic: wallet.mnemonic,
    pubkey: Buffer.from(account.pubkey).toString("base64"),
  };
}

/**
 * Restore a wallet from an existing mnemonic
 */
export async function restoreAkashWallet(
  mnemonic: string
): Promise<DirectSecp256k1HdWallet> {
  return await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });
}

/**
 * Get the address from a wallet
 */
export async function getWalletAddress(
  wallet: DirectSecp256k1HdWallet
): Promise<string> {
  const [account] = await wallet.getAccounts();
  return account.address;
}

/**
 * Validate that a string is a valid Akash address
 */
export function isValidAkashAddress(address: string): boolean {
  return (
    typeof address === "string" &&
    address.startsWith("akash1") &&
    address.length === 44
  );
}

/**
 * Validate that a mnemonic is valid (12, 15, 18, 21, or 24 words)
 */
export function isValidMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length);
}
