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

// Storage directory
const WALLET_DIR = join(homedir(), ".agent-pay", "wallets");

// Session management for unlocked wallets
const SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

interface WalletSession {
  wallet: DirectSecp256k1HdWallet;
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
  network: string = "akash-mainnet"
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
 */
export async function loadWallet(
  address: string,
  password: string
): Promise<DirectSecp256k1HdWallet> {
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

  // Create wallet from mnemonic
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "akash",
  });

  // Mnemonic goes out of scope here - garbage collected
  return wallet;
}

/**
 * Get or unlock a wallet with session support
 * If wallet was recently unlocked, reuse the session
 */
export async function getOrUnlockWallet(
  address: string
): Promise<DirectSecp256k1HdWallet> {
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
    return activeSession.wallet;
  }

  // Need to unlock
  console.log("🔐 Wallet locked. Enter password to unlock.");
  const password = await promptPassword("Password: ");

  const wallet = await loadWallet(address, password);

  // Create session
  activeSession = {
    wallet,
    address,
    unlockedAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION_MS,
  };

  console.log("✓ Wallet unlocked for 15 minutes");
  return wallet;
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
