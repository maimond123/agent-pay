/**
 * Wallet Storage
 *
 * Handles encrypted storage and retrieval of wallet mnemonics.
 * Mnemonics are encrypted with a user-provided password and stored locally.
 * The agent NEVER has access to the raw mnemonic - only the CLI process does.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as readline from "readline";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { deriveEvmAccount, type HDAccount } from "./evm-wallet.js";

// Storage directory
const WALLET_DIR = join(homedir(), ".agent-pay", "wallets");

// Session management for unlocked wallets
const SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

interface WalletSession {
  wallet: DirectSecp256k1HdWallet;
  aminoWallet: Secp256k1HdWallet;  // For JWT signing
  evmAccount: HDAccount;
  evmAddress: `0x${string}`;
  address: string;
  unlockedAt: number;
  expiresAt: number;
}

let activeSession: WalletSession | null = null;

/**
 * Stored wallet structure (encrypted on disk)
 */
export interface StoredWallet {
  address: string;
  evmAddress?: string;           // Base (EVM) address — optional for backward compat
  encryptedMnemonic: string;
  salt: string;
  iv: string;
  authTag: string;
  createdAt: string;
  network: string;
}

/**
 * Encrypt a mnemonic with a password
 */
function encryptMnemonic(mnemonic: string, password: string): {
  encrypted: string;
  salt: string;
  iv: string;
  authTag: string;
} {
  const salt = randomBytes(32);
  const key = scryptSync(password, salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(mnemonic, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString("base64"),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypt a mnemonic with a password
 */
function decryptMnemonic(
  encrypted: string,
  salt: string,
  iv: string,
  authTag: string,
  password: string
): string {
  const key = scryptSync(password, Buffer.from(salt, "base64"), 32);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Prompt for password from stdin (hidden input)
 */
export async function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Attempt to hide input (may not work in all terminals)
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      const stdin = process.stdin as any;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      let password = "";
      const onData = (char: string) => {
        switch (char) {
          case "\n":
          case "\r":
          case "\u0004": // Ctrl-D
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            console.log(); // New line after password
            resolve(password);
            break;
          case "\u0003": // Ctrl-C
            stdin.setRawMode(false);
            process.exit();
            break;
          case "\u007F": // Backspace
          case "\b": // Backspace (alternative)
            if (password.length > 0) {
              password = password.slice(0, -1);
              process.stdout.clearLine(0);
              process.stdout.cursorTo(0);
              process.stdout.write(prompt + "*".repeat(password.length));
            }
            break;
          default:
            // Only add printable characters
            if (char.charCodeAt(0) >= 32) {
              password += char;
              process.stdout.write("*");
            }
        }
      };
      stdin.on("data", onData);
    } else {
      // Fallback for non-TTY
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * Save an encrypted wallet to disk
 */
export function saveWallet(
  address: string,
  mnemonic: string,
  password: string,
  network: string = "akash-mainnet",
  evmAddress?: string
): string {
  // Ensure directory exists
  if (!existsSync(WALLET_DIR)) {
    mkdirSync(WALLET_DIR, { recursive: true });
  }

  // Encrypt mnemonic
  const { encrypted, salt, iv, authTag } = encryptMnemonic(mnemonic, password);

  // Create stored wallet object
  const storedWallet: StoredWallet = {
    address,
    ...(evmAddress ? { evmAddress } : {}),
    encryptedMnemonic: encrypted,
    salt,
    iv,
    authTag,
    createdAt: new Date().toISOString(),
    network,
  };

  // Save to file
  const filePath = join(WALLET_DIR, `${address}.json`);
  writeFileSync(filePath, JSON.stringify(storedWallet, null, 2));

  return filePath;
}

/**
 * Load and decrypt a wallet from disk
 * Returns both Direct (for transactions) and Amino (for JWT signing) wallets
 */
export async function loadWallet(
  address: string,
  password: string
): Promise<{
  wallet: DirectSecp256k1HdWallet;
  aminoWallet: Secp256k1HdWallet;
  evmAccount: HDAccount;
  evmAddress: `0x${string}`;
}> {
  const filePath = join(WALLET_DIR, `${address}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`Wallet not found: ${address}`);
  }

  const stored: StoredWallet = JSON.parse(readFileSync(filePath, "utf8"));

  // Decrypt mnemonic
  let mnemonic: string;
  try {
    mnemonic = decryptMnemonic(
      stored.encryptedMnemonic,
      stored.salt,
      stored.iv,
      stored.authTag,
      password
    );
  } catch (e) {
    throw new Error("Incorrect password");
  }

  // Create both wallet types from mnemonic
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });
  const aminoWallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });

  // Derive EVM account from the same mnemonic
  const { evmAccount, evmAddress } = deriveEvmAccount(mnemonic);

  // Lazily populate evmAddress on old wallet files
  if (!stored.evmAddress) {
    migrateWalletAddEvmAddress(address, evmAddress);
  }

  // Mnemonic goes out of scope here - garbage collected
  return { wallet, aminoWallet, evmAccount, evmAddress };
}

/**
 * Get or unlock a wallet with session support
 * If wallet was recently unlocked, reuse the session
 * Returns both Direct (for transactions) and Amino (for JWT signing) wallets
 */
export async function getOrUnlockWallet(
  address: string
): Promise<{
  wallet: DirectSecp256k1HdWallet;
  aminoWallet: Secp256k1HdWallet;
  evmAccount: HDAccount;
  evmAddress: `0x${string}`;
}> {
  // Check for valid session
  if (
    activeSession &&
    activeSession.address === address &&
    Date.now() < activeSession.expiresAt
  ) {
    const remaining = Math.round(
      (activeSession.expiresAt - Date.now()) / 60000
    );
    console.log(`Using unlocked wallet (${remaining} min remaining)`);
    return {
      wallet: activeSession.wallet,
      aminoWallet: activeSession.aminoWallet,
      evmAccount: activeSession.evmAccount,
      evmAddress: activeSession.evmAddress,
    };
  }

  // Need to unlock
  console.log("🔐 Wallet locked. Enter password to unlock.");
  const password = await promptPassword("Password: ");

  const { wallet, aminoWallet, evmAccount, evmAddress } = await loadWallet(address, password);

  // Create session
  activeSession = {
    wallet,
    aminoWallet,
    evmAccount,
    evmAddress,
    address,
    unlockedAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION_MS,
  };

  console.log("✓ Wallet unlocked for 4 hours");
  return { wallet, aminoWallet, evmAccount, evmAddress };
}

/**
 * Lock the wallet (clear session)
 */
export function lockWallet(): void {
  if (activeSession) {
    activeSession = null;
    console.log("🔒 Wallet locked");
  }
}

/**
 * List all stored wallets
 */
export function listStoredWallets(): StoredWallet[] {
  if (!existsSync(WALLET_DIR)) {
    return [];
  }

  const files = readdirSync(WALLET_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const content = readFileSync(join(WALLET_DIR, f), "utf8");
    return JSON.parse(content) as StoredWallet;
  });
}

/**
 * Check if a wallet exists locally
 */
export function walletExists(address: string): boolean {
  const filePath = join(WALLET_DIR, `${address}.json`);
  return existsSync(filePath);
}

/**
 * Get the first available wallet address (for convenience)
 */
export function getDefaultWalletAddress(): string | null {
  const wallets = listStoredWallets();
  return wallets.length > 0 ? wallets[0].address : null;
}

/**
 * Read evmAddress from a stored wallet JSON without decryption.
 * Returns undefined if the wallet file doesn't exist or has no evmAddress.
 */
export function getStoredEvmAddress(akashAddress: string): string | undefined {
  const filePath = join(WALLET_DIR, `${akashAddress}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    const stored: StoredWallet = JSON.parse(readFileSync(filePath, "utf8"));
    return stored.evmAddress;
  } catch {
    return undefined;
  }
}

/**
 * Lazily populate evmAddress on old wallet files (no decryption needed —
 * called from loadWallet after the mnemonic has already been decrypted).
 */
function migrateWalletAddEvmAddress(akashAddress: string, evmAddress: string): void {
  const filePath = join(WALLET_DIR, `${akashAddress}.json`);
  if (!existsSync(filePath)) return;
  try {
    const stored: StoredWallet = JSON.parse(readFileSync(filePath, "utf8"));
    stored.evmAddress = evmAddress;
    writeFileSync(filePath, JSON.stringify(stored, null, 2));
  } catch {
    // Non-fatal — evmAddress will be populated on next unlock
  }
}

// Auto-lock on process exit
process.on("exit", lockWallet);
process.on("SIGINT", () => {
  lockWallet();
  process.exit();
});
process.on("SIGTERM", () => {
  lockWallet();
  process.exit();
});
