#!/usr/bin/env node

/**
 * Agent-Pay CLI (Trustless Flow)
 *
 * CLI for trustless compute provisioning on Akash Network.
 * All signing operations happen here, in the user's CLI process.
 * The agent NEVER has access to keys or mnemonics.
 */

import { SignClient } from "@walletconnect/sign-client";
import QRCode from "qrcode-terminal";
import { encodeFunctionData, parseUnits, createPublicClient, http, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Import trustless modules
import {
  createAkashWallet,
  saveWallet,
  listStoredWallets,
  getDefaultWalletAddress,
  getStoredEvmAddress,
  getOrUnlockWallet,
  promptPassword,
  getEvmBalance,
  createEvmWalletClient,
  createEvmPublicClient,
  loadBudget,
  saveBudget,
  getBudgetSummary,
  type BudgetConfig,
} from "./wallet/index.js";
import {
  deployToAkash,
  closeDeployment,
  getWalletBalance,
  getDeploymentStatus,
  queryDeployments,
} from "./akash/index.js";
import { createSkipBridge, getSkipTransactions, createSkipRoute, trackSkipTransaction, waitForSkipBridgeCompletion, signAndBroadcastCosmosTx, SKIP_CHAINS } from "./bridge/index.js";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import {
  buildAgentMetadata,
  uploadToIPFS,
  registerAgent,
  getAgentId,
  getAgentURI,
  IDENTITY_REGISTRY_ADDRESS,
} from "./erc8004/index.js";

// Debug logging — set SKIP_DEBUG=1 to enable verbose logging
const CLI_DEBUG = process.env.SKIP_DEBUG === "1";
function cliDebug(label: string, ...args: any[]) {
  if (!CLI_DEBUG) return;
  const timestamp = new Date().toISOString();
  console.log(`\n[CLI DEBUG ${timestamp}] ${label}`);
  for (const arg of args) {
    if (typeof arg === "string") {
      console.log(`  ${arg}`);
    } else {
      console.log(`  ${JSON.stringify(arg, null, 2)}`);
    }
  }
}
import type { ComputeSpecs } from "./types.js";

// Configuration
const WALLETCONNECT_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID || "7195fdf3f03fb2c3e50485e0821196d7";

// USDC addresses
const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

// Chain configs
const CHAINS: Record<string, typeof base | typeof baseSepolia> = {
  "base-sepolia": baseSepolia,
  "base": base,
};

// Chain IDs for WalletConnect
const CHAIN_IDS: Record<string, string> = {
  "base-sepolia": "eip155:84532",
  "base": "eip155:8453",
};

// ERC20 ABI for approve, allowance, and balanceOf
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;


// Config file path
const CONFIG_DIR = join(homedir(), ".agent-pay");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface Config {
  walletAddress?: string;
  akashAddress?: string;
  evmAddress?: string;
  network?: string;
  evmNetwork?: string;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: Config) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function initWalletConnect(): Promise<InstanceType<typeof SignClient>> {
  try {
    return await SignClient.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: "Agent-Pay",
        description: "Trustless compute provisioning",
        url: "https://agentpay.dev",
        icons: ["https://agentpay.dev/icon.png"],
      },
    });
  } catch (error) {
    console.error("Failed to initialize WalletConnect:", error);
    process.exit(1);
  }
}

async function connectEvmWallet(signClient: InstanceType<typeof SignClient>, evmNetwork: string = "base"): Promise<{ session: any; walletAddress: `0x${string}` }> {
  const chainId = CHAIN_IDS[evmNetwork] || CHAIN_IDS["base"];

  const { uri, approval } = await signClient.connect({
    requiredNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction", "personal_sign"],
        chains: [chainId],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  });

  if (!uri) {
    console.error("Failed to generate WalletConnect URI");
    process.exit(1);
  }

  console.log("\nScan this QR code with your mobile wallet:\n");
  console.log("(MetaMask, Coinbase Wallet, Rainbow, Trust Wallet, etc.)\n");

  QRCode.generate(uri, { small: true }, (qr) => {
    console.log(qr);
  });

  console.log("\nWaiting for wallet connection...\n");

  let session;
  try {
    session = await approval();
  } catch {
    console.error("\nWallet connection was rejected or timed out.");
    process.exit(1);
  }

  const accounts = session.namespaces.eip155?.accounts || [];
  if (accounts.length === 0) {
    console.error("No accounts found in wallet session");
    process.exit(1);
  }

  const walletAddress = accounts[0].split(":")[2] as `0x${string}`;
  return { session, walletAddress };
}

// ============================================================================
// WALLET CREATE COMMAND
// ============================================================================

async function walletCreate() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                Create New Akash Wallet                        ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Check if wallet already exists
  const existingWallets = listStoredWallets();
  if (existingWallets.length > 0) {
    console.log("You already have an Akash wallet:");
    console.log(`  Address: ${existingWallets[0].address}`);
    console.log("");
    console.log("To create an additional wallet, use: wallet create --force");
    console.log("To check your balance, use: wallet balance");

    if (!process.argv.includes("--force")) {
      process.exit(0);
    }
    console.log("\n--force flag detected, creating new wallet...\n");
  }

  // Generate new wallet
  console.log("Generating new wallet...\n");
  const { address, evmAddress, mnemonic, pubkey } = await createAkashWallet();

  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  IMPORTANT: Write down your recovery phrase!                  ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Recovery Phrase (24 words):");
  console.log("");
  console.log(`  ${mnemonic}`);
  console.log("");
  console.log("Store this phrase securely. Anyone with these words can");
  console.log("access your funds. You will NOT see this again.");
  console.log("");

  // Get password for encryption
  const password = await promptPassword("Create a password to encrypt your wallet: ");
  const confirmPassword = await promptPassword("Confirm password: ");

  if (password !== confirmPassword) {
    console.error("\nPasswords do not match. Please try again.");
    process.exit(1);
  }

  // Save encrypted wallet (with EVM address)
  const walletPath = saveWallet(address, mnemonic, password, "akash-mainnet", evmAddress);

  // Update config
  const config = loadConfig();
  config.akashAddress = address;
  config.evmAddress = evmAddress;
  saveConfig(config);

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Wallet Created Successfully!                 ║
╚═══════════════════════════════════════════════════════════════╝

  Akash Address: ${address}
  Base Address:  ${evmAddress}
  Saved:         ${walletPath}

  Same mnemonic, two keypairs:
    Cosmos (m/44'/118'/0'/0/0) → ${address}
    EVM    (m/44'/60'/0'/0/0)  → ${evmAddress}

Next steps:

  1. Send USDC to your Base address for ERC-8004 payments:
     ${evmAddress}

  2. Or bridge USDC from Base to Akash for compute:
     npx @agent-pay/mcp bridge --amount 10

  3. Then provision compute:
     npx @agent-pay/mcp deploy --cpu 2 --memory 4Gi --image ubuntu:22.04
`);
}

// ============================================================================
// WALLET LIST COMMAND
// ============================================================================

async function walletList() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Stored Wallets                             ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const wallets = listStoredWallets();

  if (wallets.length === 0) {
    console.log("No wallets found. Create one with:");
    console.log("  npx @agent-pay/mcp wallet create");
    process.exit(0);
  }

  const defaultAddress = getDefaultWalletAddress();

  for (const wallet of wallets) {
    const isDefault = wallet.address === defaultAddress ? " (default)" : "";
    console.log(`  Akash: ${wallet.address}${isDefault}`);
    if (wallet.evmAddress) {
      console.log(`  Base:  ${wallet.evmAddress}`);
    }
    console.log(`    Created: ${wallet.createdAt}`);
    console.log(`    Network: ${wallet.network}`);
    console.log("");
  }
}

// ============================================================================
// WALLET BALANCE COMMAND
// ============================================================================

async function walletBalance(addressArg?: string) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Wallet Balance                             ║
╚═══════════════════════════════════════════════════════════════╝
`);

  let address = addressArg;
  if (!address) {
    address = getDefaultWalletAddress() || undefined;
    if (!address) {
      console.error("No wallet found. Create one with: npx @agent-pay/mcp wallet create");
      process.exit(1);
    }
  }

  const isTestnet = process.argv.includes("--testnet");
  const network = isTestnet ? "testnet" : "mainnet";

  console.log(`Akash Address: ${address}`);

  // Look up the EVM address
  const evmAddr = getStoredEvmAddress(address);
  if (evmAddr) {
    console.log(`Base Address:  ${evmAddr}`);
  }
  console.log(`Network: ${network}\n`);

  try {
    // Query Akash balances
    const balance = await getWalletBalance(address, network);

    console.log("Akash Balances:");
    console.log(`  USDC:  ${balance.usdcFormatted} axlUSDC`);
    console.log(`  AKT:   ${balance.uaktFormatted} AKT`);
    console.log("");

    // Query Base (EVM) balances if we have an EVM address
    if (evmAddr) {
      try {
        const evmBalance = await getEvmBalance(evmAddr as `0x${string}`);
        console.log("Base Balances:");
        console.log(`  USDC:  ${evmBalance.usdcFormatted} USDC`);
        console.log(`  ETH:   ${evmBalance.ethFormatted} ETH`);
        console.log("");
      } catch (evmErr) {
        console.log("Base Balances: (failed to fetch)");
        console.log("");
      }
    }

    const usdcBalance = parseFloat(balance.usdcFormatted);
    const aktBalance = parseFloat(balance.uaktFormatted);

    if (usdcBalance < 1.0) {
      console.log("Your Akash USDC balance is low. Bridge more funds:");
      console.log("  npx @agent-pay/mcp bridge --amount 10");
    }

    if (aktBalance < 0.1) {
      console.log("Your AKT balance is low (needed for gas). The bridge command");
      console.log("includes a small AKT swap for gas automatically.");
    }

    // Show active deployments
    try {
      const deployments = await queryDeployments(address, network);
      const activeDeployments = deployments.filter((d) => d.state === 1);

      if (activeDeployments.length > 0) {
        console.log(`\nActive Deployments: ${activeDeployments.length}`);
        for (const d of activeDeployments) {
          console.log(`  DSEQ: ${d.deploymentId.dseq}`);
        }
      }
    } catch {
      // Deployments query may fail
    }
  } catch (error) {
    console.error("Failed to fetch balance:", error);
    process.exit(1);
  }
}

// ============================================================================
// DEPLOY COMMAND
// ============================================================================

async function deploy() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Deploy to Akash Network                      ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Parse arguments
  const args = process.argv.slice(3);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const cpu = parseInt(getArg("cpu") || "1");
  const memory = getArg("memory") || "1Gi";
  const storage = getArg("storage") || "5Gi";
  const image = getArg("image") || "ubuntu:22.04";
  const hours = parseInt(getArg("hours") || "1");
  const isTestnet = args.includes("--testnet");
  const network = isTestnet ? "testnet" : "mainnet";

  // Parse ports
  const ports: Array<{ port: number; protocol: "tcp" | "udp"; expose: boolean }> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const portStr = args[i + 1];
      if (portStr) {
        const [portNum, proto] = portStr.split("/");
        ports.push({
          port: parseInt(portNum),
          protocol: (proto as "tcp" | "udp") || "tcp",
          expose: true,
        });
      }
    }
  }

  // Default to SSH port if no ports specified
  if (ports.length === 0) {
    ports.push({ port: 22, protocol: "tcp", expose: true });
  }

  // Parse env vars
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env") {
      const envStr = args[i + 1];
      if (envStr) {
        const [key, ...valueParts] = envStr.split("=");
        env[key] = valueParts.join("=");
      }
    }
  }

  // Parse GPU
  const gpuCount = parseInt(getArg("gpu-count") || "0");
  const gpuModel = getArg("gpu-model");
  const gpu = gpuCount > 0 ? { count: gpuCount, model: gpuModel } : undefined;

  const specs: ComputeSpecs = {
    cpu,
    memory,
    storage,
    image,
    hours,
    gpu,
    ports,
  };

  console.log("Deployment Specs:");
  console.log(`  CPU: ${cpu} cores`);
  console.log(`  Memory: ${memory}`);
  console.log(`  Storage: ${storage}`);
  console.log(`  Image: ${image}`);
  console.log(`  Duration: ${hours} hours`);
  console.log(`  Ports: ${ports.map((p) => `${p.port}/${p.protocol}`).join(", ")}`);
  if (gpu) {
    console.log(`  GPU: ${gpu.count}x ${gpu.model || "any"}`);
  }
  console.log(`  Network: ${network}`);
  console.log("");

  // Get wallet
  const address = getDefaultWalletAddress();
  if (!address) {
    console.error("No wallet found. Create one with: npx @agent-pay/mcp wallet create");
    process.exit(1);
  }

  console.log(`Wallet: ${address}\n`);

  // Unlock wallet
  const { wallet, aminoWallet } = await getOrUnlockWallet(address);

  try {
    const result = await deployToAkash(wallet, aminoWallet, {
      specs,
      env: Object.keys(env).length > 0 ? env : undefined,
      network,
    });

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Deployment Successful!                       ║
╚═══════════════════════════════════════════════════════════════╝

  DSEQ: ${result.dseq}
  Provider: ${result.provider}

  Deployment TX: ${result.txHashes.deployment}
  Lease TX: ${result.txHashes.lease}
`);

    if (result.endpoints.length > 0) {
      console.log("  Endpoints:");
      for (const ep of result.endpoints) {
        console.log(`    ${ep.protocol}://${ep.host}:${ep.externalPort}`);
      }
    }

    console.log(`
To check status: npx @agent-pay/mcp status ${result.dseq}
To close:        npx @agent-pay/mcp close ${result.dseq}
`);
  } catch (error) {
    console.error("\nDeployment failed:", error);
    process.exit(1);
  }
}

// ============================================================================
// CLOSE COMMAND
// ============================================================================

async function close(dseqArg?: string) {
  if (!dseqArg) {
    console.error("Usage: npx @agent-pay/mcp close <dseq>");
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Close Akash Deployment                       ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const isTestnet = process.argv.includes("--testnet");
  const network = isTestnet ? "testnet" : "mainnet";

  const address = getDefaultWalletAddress();
  if (!address) {
    console.error("No wallet found. Create one with: npx @agent-pay/mcp wallet create");
    process.exit(1);
  }

  console.log(`DSEQ: ${dseqArg}`);
  console.log(`Wallet: ${address}`);
  console.log(`Network: ${network}\n`);

  // Unlock wallet
  const { wallet } = await getOrUnlockWallet(address);

  try {
    const result = await closeDeployment(wallet, dseqArg, network);

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Deployment Closed                            ║
╚═══════════════════════════════════════════════════════════════╝

  DSEQ: ${dseqArg}
  TX: ${result.txHash}

  Unused funds will be refunded to your wallet.
`);
  } catch (error) {
    console.error("\nFailed to close deployment:", error);
    process.exit(1);
  }
}

// ============================================================================
// STATUS COMMAND
// ============================================================================

async function statusCmd(dseqArg?: string) {
  const isTestnet = process.argv.includes("--testnet");
  const network = isTestnet ? "testnet" : "mainnet";

  const address = getDefaultWalletAddress();
  if (!address) {
    console.error("No wallet found. Create one with: npx @agent-pay/mcp wallet create");
    process.exit(1);
  }

  if (dseqArg) {
    // Show specific deployment status
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Deployment Status                            ║
╚═══════════════════════════════════════════════════════════════╝
`);

    try {
      const status = await getDeploymentStatus(address, dseqArg, network);

      if (!status.deployment) {
        console.log(`No deployment found with DSEQ ${dseqArg}`);
        process.exit(1);
      }

      const stateMap: Record<number, string> = {
        0: "Invalid",
        1: "Active",
        2: "Closed",
      };

      console.log(`DSEQ: ${dseqArg}`);
      console.log(`Owner: ${address}`);
      console.log(`State: ${stateMap[status.deployment.state] || "Unknown"}`);
      console.log(`Status: ${status.status}`);
      console.log(`Created: ${status.deployment.createdAt}`);

      if (status.leases.length > 0) {
        console.log("\nLeases:");
        for (const lease of status.leases) {
          const leaseStateMap: Record<number, string> = {
            0: "Invalid",
            1: "Active",
            2: "Insufficient Funds",
            3: "Closed",
          };
          console.log(`  GSEQ ${lease.leaseId.gseq}: ${leaseStateMap[lease.state] || "Unknown"}`);
          console.log(`    Provider: ${lease.leaseId.provider}`);
        }
      }

      if (status.endpoints.length > 0) {
        console.log("\nEndpoints:");
        for (const ep of status.endpoints) {
          console.log(`  ${ep.uri}`);
        }
      }
    } catch (error) {
      console.error("Failed to fetch status:", error);
      process.exit(1);
    }
  } else {
    // Show all deployments
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    All Deployments                            ║
╚═══════════════════════════════════════════════════════════════╝
`);

    try {
      const deployments = await queryDeployments(address, network);

      if (deployments.length === 0) {
        console.log("No deployments found.");
        process.exit(0);
      }

      const stateMap: Record<number, string> = {
        0: "Invalid",
        1: "Active",
        2: "Closed",
      };

      for (const d of deployments) {
        console.log(`DSEQ: ${d.deploymentId.dseq}`);
        console.log(`  State: ${stateMap[d.state] || "Unknown"}`);
        console.log(`  Created: ${d.createdAt}`);
        console.log("");
      }
    } catch (error) {
      console.error("Failed to fetch deployments:", error);
      process.exit(1);
    }
  }
}

// ============================================================================
// BRIDGE HELPERS
// ============================================================================

const COSMOS_PREFIXES: Record<string, string> = {
  "akashnet-2": "akash",
  "noble-1": "noble",
  "osmosis-1": "osmo",
  "cosmoshub-4": "cosmos",
};

/**
 * Print the user's derived addresses on intermediate Cosmos chains.
 * Useful when a bridge fails or times out so the user can check where funds landed.
 */
function printIntermediateAddresses(akashAddress: string, chainPath: string[]) {
  console.log("\nCheck your balances on intermediate chains:");
  for (const chainId of chainPath) {
    const prefix = COSMOS_PREFIXES[chainId];
    if (!prefix) continue; // skip EVM chains
    try {
      const { data } = fromBech32(akashAddress);
      const addr = toBech32(prefix, data);
      const label = chainId.split("-")[0].charAt(0).toUpperCase() + chainId.split("-")[0].slice(1);
      console.log(`  ${label.padEnd(10)} ${addr}`);
    } catch {
      // skip if conversion fails
    }
  }
}

// ============================================================================
// BRIDGE COMMAND (Skip Go API - Low Fees)
// ============================================================================

async function bridge() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           Bridge USDC to Akash (via Skip Go)                  ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Parse arguments
  const args = process.argv.slice(3);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const amount = getArg("amount") || "10";
  const evmNetwork = getArg("evm-network") || "base";
  const destinationType = (getArg("receive") || "akt") as "akt" | "usdc";
  const isDirect = args.includes("--direct");

  // Get Akash address
  const akashAddress = getDefaultWalletAddress();
  if (!akashAddress) {
    console.error("No Akash wallet found. Create one first:");
    console.error("  npx @agent-pay/mcp wallet create");
    process.exit(1);
  }

  console.log(`Bridge Details:`);
  console.log(`  Amount: ${amount} USDC`);
  console.log(`  From: Base Mainnet`);
  console.log(`  To: Akash (${akashAddress})`);
  console.log(`  Receive: ${destinationType.toUpperCase()}`);
  console.log(`  Bridge: Skip Go (Noble CCTP + IBC)`);
  console.log(`  Mode: ${isDirect ? "Direct (agent wallet signs)" : "WalletConnect (external wallet signs)"}`);
  console.log(`  Estimated fee: ~$0.02`);
  console.log("");

  // ── Direct mode: sign EVM tx with the agent's own wallet ──
  if (isDirect) {
    await bridgeDirect(akashAddress, amount, evmNetwork, destinationType);
    return;
  }

  // Initialize WalletConnect for EVM signing
  console.log("Connect your EVM wallet to sign the bridge transaction:\n");
  const signClient = await initWalletConnect();
  const { session, walletAddress } = await connectEvmWallet(signClient, evmNetwork);

  console.log(`\nConnected: ${walletAddress}\n`);
  cliDebug("WalletConnect session established", {
    topic: session.topic,
    accounts: session.namespaces.eip155?.accounts,
    walletAddress,
    evmNetwork,
    chainId: CHAIN_IDS[evmNetwork] || CHAIN_IDS["base"],
  });

  try {
    // Create bridge route using Skip Go API
    console.log("Creating bridge route via Skip Go...\n");
    const bridgeResult = await createSkipBridge({
      fromAddress: walletAddress,
      toAddress: akashAddress,
      amountUSDC: amount,
      destinationType,
      slippagePercent: "3",
    });

    const { route, transactions } = bridgeResult;

    cliDebug("Bridge result received", {
      routeId: route.routeId,
      chainPath: route.chainPath,
      amountIn: route.amountIn,
      amountOut: route.amountOut,
      estimatedAmountOut: route.estimatedAmountOut,
      txsRequired: route.txsRequired,
      transactionCount: transactions.length,
      transactionTypes: transactions.map(tx => ({
        type: tx.txType,
        chainId: tx.chainId,
        hasEvmTx: !!tx.evmTx,
        hasCosmTx: !!tx.cosmosTx,
      })),
      fees: route.fees,
    });

    // Format the output amount
    const outputAmount = (parseInt(route.estimatedAmountOut) / 1_000_000).toFixed(6);
    const outputToken = destinationType === "akt" ? "AKT" : "USDC";

    console.log(`Route created:`);
    console.log(`  Estimated received: ${outputAmount} ${outputToken}`);
    console.log(`  Total fees: $${route.fees.totalUsd}`);
    console.log(`  Estimated time: ~${Math.round(route.estimatedDurationSeconds / 60)} minutes`);
    console.log(`  Route: ${route.chainPath.join(" → ")}`);
    console.log(`  Transactions required: ${route.txsRequired}`);
    console.log("");

    // Get the first EVM transaction (the one on Base)
    const evmTx = transactions.find(tx => tx.txType === "evm" && tx.evmTx);
    if (!evmTx?.evmTx) {
      cliDebug("No EVM transaction found in route", {
        transactions: transactions.map(tx => ({ type: tx.txType, chainId: tx.chainId })),
      });
      throw new Error("No EVM transaction found in route");
    }

    const chainId = CHAIN_IDS[evmNetwork] || CHAIN_IDS["base"];
    const usdcAddress = USDC_ADDRESSES[evmNetwork] || USDC_ADDRESSES["base"];
    const chain = CHAINS[evmNetwork] || CHAINS["base"];
    const amountInMicro = parseUnits(amount, 6);

    // Check current USDC balance and allowance for the Skip contract
    const skipContractAddress = evmTx.evmTx.to as `0x${string}`;
    cliDebug("EVM transaction details", {
      to: evmTx.evmTx.to,
      value: evmTx.evmTx.value,
      dataLength: evmTx.evmTx.data?.length,
      dataPreview: evmTx.evmTx.data?.slice(0, 74) + "...",
      gasLimit: evmTx.evmTx.gasLimit,
      chainId: evmTx.evmTx.chainId,
      skipContractAddress,
      usdcAddress,
      amountInMicro: amountInMicro.toString(),
    });
    console.log("Checking USDC balance and allowance...\n");
    const publicClient = createPublicClient({
      chain,
      transport: http(),
    });

    // Check balance first
    const currentBalance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });

    const balanceFormatted = Number(currentBalance) / 1e6;
    console.log(`  USDC Balance: ${balanceFormatted.toFixed(6)} USDC`);
    cliDebug("On-chain USDC balance", {
      raw: currentBalance.toString(),
      formatted: balanceFormatted.toFixed(6),
      requiredRaw: amountInMicro.toString(),
      sufficient: currentBalance >= amountInMicro,
    });

    if (currentBalance < amountInMicro) {
      console.error(`\nInsufficient USDC balance!`);
      console.error(`  You have: ${balanceFormatted.toFixed(6)} USDC`);
      console.error(`  Required: ${amount} USDC`);
      console.error(`\nPlease add more USDC to your wallet: ${walletAddress}`);
      process.exit(1);
    }

    // Check allowance
    const currentAllowance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [walletAddress, skipContractAddress],
    });

    const allowanceFormatted = Number(currentAllowance) / 1e6;
    console.log(`  USDC Allowance: ${allowanceFormatted.toFixed(6)} USDC (for Skip contract)`);
    console.log("");
    cliDebug("On-chain USDC allowance", {
      raw: currentAllowance.toString(),
      formatted: allowanceFormatted.toFixed(6),
      spender: skipContractAddress,
      requiredRaw: amountInMicro.toString(),
      needsApproval: currentAllowance < amountInMicro,
    });

    const needsApproval = currentAllowance < amountInMicro;

    if (needsApproval) {
      console.log(`Allowance is less than bridge amount. Need to approve first.`);
      console.log("\nStep 1/2: Approving USDC spending...\n");
      console.log("Check your wallet to approve the USDC spending.");
      console.log("(If your wallet takes too long, you may need to manually accept)\n");

      // Approve max uint256 so user doesn't need to approve again
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [skipContractAddress, maxApproval],
      });

      try {
        cliDebug("Sending approval tx via WalletConnect", {
          from: walletAddress,
          to: usdcAddress,
          spender: skipContractAddress,
          chainId,
          topic: session.topic,
        });

        const approveTxHash = await signClient.request({
          topic: session.topic,
          chainId,
          request: {
            method: "eth_sendTransaction",
            params: [
              {
                from: walletAddress,
                to: usdcAddress,
                data: approveData,
              },
            ],
          },
        });

        console.log(`Approval submitted: ${approveTxHash}`);
        cliDebug("Approval tx hash received", { approveTxHash });
        console.log("Waiting for confirmation (15 seconds)...\n");
        await new Promise((resolve) => setTimeout(resolve, 15000));
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        if (errorMsg.includes("timeout") || errorMsg.includes("TIMEOUT")) {
          console.error("\nWalletConnect request timed out.");
          console.error("This usually means:");
          console.error("  1. The transaction wasn't approved in time on your wallet");
          console.error("  2. Your wallet app may have disconnected");
          console.error("\nTry again and approve the transaction promptly in your wallet.");
        } else if (errorMsg.includes("rejected") || errorMsg.includes("denied")) {
          console.error("\nApproval was rejected in your wallet.");
        } else {
          console.error("\nApproval failed:", errorMsg);
        }
        process.exit(1);
      }
    } else {
      console.log(`Allowance OK: ${Number(currentAllowance) / 1e6} USDC\n`);
    }

    // Execute bridge transaction
    console.log(`${needsApproval ? "Step 2/2" : "Step 1/1"}: Executing bridge...\n`);
    console.log("Check your wallet to confirm the bridge transaction.\n");

    try {
      const bridgeTxParams = {
        from: walletAddress,
        to: evmTx.evmTx.to,
        data: evmTx.evmTx.data,
        value: evmTx.evmTx.value || "0x0",
      };

      cliDebug("Sending bridge tx via WalletConnect", {
        chainId,
        topic: session.topic,
        params: {
          from: bridgeTxParams.from,
          to: bridgeTxParams.to,
          value: bridgeTxParams.value,
          dataLength: bridgeTxParams.data?.length,
          dataPreview: bridgeTxParams.data?.slice(0, 74) + "...",
        },
      });

      const bridgeTxHash = (await signClient.request({
        topic: session.topic,
        chainId,
        request: {
          method: "eth_sendTransaction",
          params: [bridgeTxParams],
        },
      })) as string;

      console.log(`Bridge transaction submitted: ${bridgeTxHash}\n`);
      cliDebug("Bridge tx hash received from wallet", { bridgeTxHash });

      // Register with Skip's Smart Relay for tracking
      console.log("Registering transaction with Skip relay...\n");
      try {
        const trackResult = await trackSkipTransaction(bridgeTxHash, SKIP_CHAINS.BASE_MAINNET);
        console.log(`Explorer: ${trackResult.explorerLink}\n`);
      } catch (trackError: any) {
        console.warn(`Warning: Could not register with Skip relay: ${trackError.message}`);
        console.warn("Will still attempt to poll for status...\n");
      }

      // Disconnect wallet
      cliDebug("Disconnecting WalletConnect session", { topic: session.topic });
      await signClient.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: "Bridge initiated" },
      });
      cliDebug("WalletConnect disconnected");

      // Wait for bridge completion with per-hop progress
      console.log("Waiting for bridge completion...\n");
      cliDebug("Starting bridge completion polling", {
        txHash: bridgeTxHash,
        chainId: SKIP_CHAINS.BASE_MAINNET,
        chainPath: route.chainPath,
      });

      const status = await waitForSkipBridgeCompletion(
        bridgeTxHash,
        SKIP_CHAINS.BASE_MAINNET,
        {
          timeoutMs: 1800000, // 30 min timeout
          pollIntervalMs: 15000, // Poll every 15 seconds
          chainPath: route.chainPath,
        }
      );

      console.log(""); // newline after progress block
      cliDebug("Phase 1 bridge polling finished", {
        finalStatus: status.status,
        transferDetails: status.transferDetails,
        assetRelease: status.assetRelease,
      });

      // ================================================================
      // Phase 2: If there are Cosmos txs (Noble IBC transfer), sign
      // and broadcast them to forward funds Noble -> Osmosis -> Akash
      // ================================================================
      const cosmosTxs = transactions.filter(
        (tx) => tx.txType === "cosmos" && tx.cosmosTx
      );

      cliDebug("Phase 2 check — cosmos transactions", {
        count: cosmosTxs.length,
        chains: cosmosTxs.map((tx) => tx.chainId),
        phase1Status: status.status,
      });

      if (status.status === "success" && cosmosTxs.length > 0) {
        // Phase 1 (CCTP: Base -> Noble) completed. Now execute Phase 2 (IBC: Noble -> Osmosis -> Akash)
        console.log("Phase 1 complete (CCTP: Base -> Noble).\n");
        console.log("Starting Phase 2: IBC transfer (Noble -> Osmosis -> Akash)...\n");

        // Unlock wallet to derive Noble signing key
        console.log("Unlocking wallet for Noble IBC signing...\n");
        const { wallet: akashWallet } = await getOrUnlockWallet(akashAddress);

        // Re-derive the wallet with Noble bech32 prefix (same key, different prefix)
        cliDebug("Deriving Noble wallet from Akash wallet mnemonic");
        const nobleWallet = await DirectSecp256k1HdWallet.fromMnemonic(
          (akashWallet as any).mnemonic,
          { prefix: "noble" }
        );
        const [nobleAccount] = await nobleWallet.getAccounts();
        console.log(`Noble address: ${nobleAccount.address}\n`);
        cliDebug("Noble wallet derived", { nobleAddress: nobleAccount.address });

        // Sign and broadcast each cosmos tx (typically just one Noble IBC transfer)
        for (let i = 0; i < cosmosTxs.length; i++) {
          const cosmosTx = cosmosTxs[i];
          console.log(
            `Signing cosmos tx ${i + 1}/${cosmosTxs.length} on ${cosmosTx.chainId}...\n`
          );
          cliDebug(`Phase 2 — Signing cosmos tx ${i + 1}/${cosmosTxs.length}`, {
            chainId: cosmosTx.chainId,
            msgCount: cosmosTx.cosmosTx?.msgs?.length || 0,
            rawMsgs: JSON.stringify(cosmosTx.cosmosTx?.msgs || []).slice(0, 500),
          });

          try {
            const cosmosResult = await signAndBroadcastCosmosTx(
              nobleWallet,
              cosmosTx.cosmosTx!
            );

            console.log(`\nNoble tx broadcast: ${cosmosResult.txHash}\n`);
            cliDebug("Phase 2 — Cosmos tx broadcast success", cosmosResult);

            // Register Noble tx with Skip relay for tracking
            console.log("Registering Noble tx with Skip relay...\n");
            try {
              const nobleTrack = await trackSkipTransaction(
                cosmosResult.txHash,
                cosmosResult.chainId,
                { initialDelayMs: 3000, maxRetries: 5 }
              );
              console.log(`Explorer: ${nobleTrack.explorerLink}\n`);
              cliDebug("Phase 2 — Noble tx tracked", nobleTrack);
            } catch (trackErr: any) {
              console.warn(
                `Warning: Could not register Noble tx with Skip relay: ${trackErr.message}`
              );
              console.warn("Will still attempt to poll for status...\n");
              cliDebug("Phase 2 — Noble tx track failed (non-fatal)", {
                error: trackErr.message,
              });
            }

            // Wait for IBC hops to complete (Noble -> Osmosis -> Akash)
            console.log("Waiting for IBC transfer to complete...\n");
            cliDebug("Phase 2 — Starting IBC completion polling", {
              txHash: cosmosResult.txHash,
              chainId: cosmosResult.chainId,
            });

            const ibcStatus = await waitForSkipBridgeCompletion(
              cosmosResult.txHash,
              cosmosResult.chainId,
              {
                timeoutMs: 600000, // 10 min for IBC (much faster than CCTP)
                pollIntervalMs: 10000, // Poll every 10 seconds
                chainPath: route.chainPath.filter(
                  (c) => c !== SKIP_CHAINS.BASE_MAINNET
                ), // Noble -> Osmosis -> Akash
              }
            );

            console.log(""); // newline after progress block
            cliDebug("Phase 2 — IBC polling finished", {
              finalStatus: ibcStatus.status,
              transferDetails: ibcStatus.transferDetails,
              assetRelease: ibcStatus.assetRelease,
            });

            if (ibcStatus.status === "success") {
              console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Bridge Complete!                             ║
╚═══════════════════════════════════════════════════════════════╝

  Sent: ${amount} USDC
  Received: ~${outputAmount} ${outputToken}
  To: ${akashAddress}

  Phase 1 TX (CCTP):  ${bridgeTxHash}
  Phase 2 TX (IBC):   ${cosmosResult.txHash}
  Fees: ~$${route.fees.totalUsd}

Your Akash wallet is now funded! You can deploy compute:
  npx @agent-pay/mcp deploy --cpu 2 --memory 4Gi --image ubuntu:22.04
`);
            } else if (ibcStatus.status === "failed") {
              console.error(`\nIBC transfer (Phase 2) failed.`);
              console.error(`CCTP TX: ${bridgeTxHash}`);
              console.error(`Noble TX: ${cosmosResult.txHash}`);
              console.error(`\nYour funds may be on an intermediate chain.`);
              printIntermediateAddresses(akashAddress, route.chainPath);
              process.exit(1);
            } else if (ibcStatus.status === "abandoned") {
              console.error(`\nIBC transfer tracking abandoned by Skip relay.`);
              console.error(`Noble TX: ${cosmosResult.txHash}`);
              console.error("Your funds may be on an intermediate chain.");
              printIntermediateAddresses(akashAddress, route.chainPath);
              process.exit(1);
            } else {
              // timeout
              console.log(`
IBC transfer still processing. Noble TX: ${cosmosResult.txHash}

Track your transfer:
  https://ibc.fun/tx/${cosmosResult.txHash}
`);
              printIntermediateAddresses(akashAddress, route.chainPath);
              console.log(`
Check your Akash wallet balance:
  npx @agent-pay/mcp wallet balance
`);
            }
          } catch (cosmosErr: any) {
            console.error(`\nFailed to sign/broadcast Noble IBC tx: ${cosmosErr.message}`);
            cliDebug("Phase 2 — Cosmos tx failed", {
              error: cosmosErr.message,
              stack: cosmosErr.stack?.split("\n").slice(0, 5).join("\n"),
            });
            console.error(`\nYour USDC arrived on Noble but was not forwarded via IBC.`);
            console.error(`You can manually transfer from Noble using your wallet.`);
            printIntermediateAddresses(akashAddress, route.chainPath);
            process.exit(1);
          }
        }
      } else if (status.status === "success") {
        // No cosmos txs — single-phase bridge completed successfully
        console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Bridge Complete!                             ║
╚═══════════════════════════════════════════════════════════════╝

  Sent: ${amount} USDC
  Received: ~${outputAmount} ${outputToken}
  To: ${akashAddress}
  TX: ${bridgeTxHash}
  Fees: ~$${route.fees.totalUsd}

Your Akash wallet is now funded! You can deploy compute:
  npx @agent-pay/mcp deploy --cpu 2 --memory 4Gi --image ubuntu:22.04
`);
      } else if (status.status === "failed") {
        console.error(`\nBridge failed. Check transaction status at:`);
        console.error(`  https://www.mintscan.io/`);
        printIntermediateAddresses(akashAddress, route.chainPath);
        console.error("\nFunds should be on one of the above chains.");
        process.exit(1);
      } else if (status.status === "abandoned") {
        console.error(`\nBridge tracking was abandoned by Skip relay.`);
        console.error("Your funds may be on an intermediate chain.");
        printIntermediateAddresses(akashAddress, route.chainPath);
        process.exit(1);
      } else {
        console.log(`
Bridge is still processing (may take up to 20 minutes).
Transaction: ${bridgeTxHash}

Track your transfer:
  https://ibc.fun/tx/${bridgeTxHash}
`);
        printIntermediateAddresses(akashAddress, route.chainPath);
        console.log(`
Check your Akash wallet balance:
  npx @agent-pay/mcp wallet balance
`);
      }
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes("timeout") || errorMsg.includes("TIMEOUT")) {
        console.error("\nWalletConnect request timed out.");
        console.error("This usually means:");
        console.error("  1. The transaction wasn't approved in time on your wallet");
        console.error("  2. Your wallet app may have disconnected");
        console.error("\nTry again and approve the transaction promptly in your wallet.");
      } else if (errorMsg.includes("rejected") || errorMsg.includes("denied")) {
        console.error("\nBridge transaction was rejected in your wallet.");
      } else {
        console.error("\nBridge transaction failed:", errorMsg);
      }
      process.exit(1);
    }
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    if (errorMsg.includes("relay") || errorMsg.includes("FAILED_TIMEOUT")) {
      console.error("\nSkip Go relay timed out. This can happen if:");
      console.error("  1. The Skip API is experiencing high traffic");
      console.error("  2. There's a network congestion issue");
      console.error("\nPlease try again in a few minutes.");
    } else {
      console.error("\nBridge failed:", errorMsg);
    }
    process.exit(1);
  }
}

// ============================================================================
// BRIDGE RESUME COMMAND (Phase 2 only — recover funds stuck on Noble)
// ============================================================================

async function bridgeResume() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║       Bridge Resume — Phase 2 (Noble IBC Transfer)           ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const args = process.argv.slice(3);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const amount = getArg("amount") || "0.28";
  const destinationType = (getArg("receive") || "akt") as "akt" | "usdc";
  // A dummy EVM address — we only need the route for cosmos tx data
  const evmAddress = getArg("evm-address") || "0x0000000000000000000000000000000000000001";

  // Get Akash address
  const akashAddress = getDefaultWalletAddress();
  if (!akashAddress) {
    console.error("No Akash wallet found. Create one first:");
    console.error("  npx @agent-pay/mcp wallet create");
    process.exit(1);
  }

  console.log(`Akash address: ${akashAddress}`);
  console.log(`Amount on Noble: ${amount} USDC`);
  console.log(`Destination: ${destinationType.toUpperCase()} on Akash`);
  console.log("");

  // Step 1: Re-fetch the route from Skip to get the cosmos tx messages
  console.log("Fetching route from Skip to get IBC transfer data...\n");
  const bridgeResult = await createSkipBridge({
    fromAddress: evmAddress,
    toAddress: akashAddress,
    amountUSDC: amount,
    destinationType,
    slippagePercent: "3",
  });

  const { route, transactions } = bridgeResult;
  const cosmosTxs = transactions.filter(
    (tx) => tx.txType === "cosmos" && tx.cosmosTx
  );

  cliDebug("bridge-resume — route fetched", {
    chainPath: route.chainPath,
    totalTxs: transactions.length,
    cosmosTxs: cosmosTxs.length,
    cosmosTxChains: cosmosTxs.map((tx) => tx.chainId),
  });

  if (cosmosTxs.length === 0) {
    console.error("No cosmos transactions found in the route.");
    console.error("This route may not require a Phase 2 Noble IBC transfer.");
    process.exit(1);
  }

  console.log(`Route: ${route.chainPath.join(" → ")}`);
  console.log(`Found ${cosmosTxs.length} cosmos tx(s) to sign.\n`);

  // Step 2: Unlock wallet and derive Noble key
  console.log("Unlocking wallet...\n");
  const { wallet: akashWallet } = await getOrUnlockWallet(akashAddress);

  cliDebug("bridge-resume — deriving Noble wallet");
  const nobleWallet = await DirectSecp256k1HdWallet.fromMnemonic(
    (akashWallet as any).mnemonic,
    { prefix: "noble" }
  );
  const [nobleAccount] = await nobleWallet.getAccounts();
  console.log(`Noble address: ${nobleAccount.address}\n`);

  // Step 3: Sign and broadcast each cosmos tx
  for (let i = 0; i < cosmosTxs.length; i++) {
    const cosmosTx = cosmosTxs[i];
    console.log(
      `Signing cosmos tx ${i + 1}/${cosmosTxs.length} on ${cosmosTx.chainId}...\n`
    );
    cliDebug(`bridge-resume — signing tx ${i + 1}`, {
      chainId: cosmosTx.chainId,
      msgCount: cosmosTx.cosmosTx?.msgs?.length || 0,
    });

    try {
      const cosmosResult = await signAndBroadcastCosmosTx(
        nobleWallet,
        cosmosTx.cosmosTx!
      );

      console.log(`\nNoble tx broadcast: ${cosmosResult.txHash}\n`);

      // Track with Skip relay
      console.log("Registering with Skip relay...\n");
      try {
        const trackResult = await trackSkipTransaction(
          cosmosResult.txHash,
          cosmosResult.chainId,
          { initialDelayMs: 3000, maxRetries: 5 }
        );
        console.log(`Explorer: ${trackResult.explorerLink}\n`);
      } catch (trackErr: any) {
        console.warn(`Warning: Could not track with Skip: ${trackErr.message}\n`);
      }

      // Wait for IBC completion
      console.log("Waiting for IBC transfer to complete...\n");
      const ibcStatus = await waitForSkipBridgeCompletion(
        cosmosResult.txHash,
        cosmosResult.chainId,
        {
          timeoutMs: 600000,
          pollIntervalMs: 10000,
          chainPath: route.chainPath.filter(
            (c) => c !== SKIP_CHAINS.BASE_MAINNET
          ),
        }
      );

      console.log("");

      if (ibcStatus.status === "success") {
        console.log(`
╔═══════════════════════════════════════════════════════════════╗
║               Phase 2 Bridge Complete!                       ║
╚═══════════════════════════════════════════════════════════════╝

  Noble TX: ${cosmosResult.txHash}
  To: ${akashAddress}

Your Akash wallet should now have the funds.
  npx @agent-pay/mcp wallet balance
`);
      } else {
        console.log(`IBC status: ${ibcStatus.status}`);
        console.log(`Noble TX: ${cosmosResult.txHash}`);
        printIntermediateAddresses(akashAddress, route.chainPath);
      }
    } catch (err: any) {
      console.error(`\nFailed: ${err.message}`);
      cliDebug("bridge-resume — error", {
        error: err.message,
        stack: err.stack?.split("\n").slice(0, 5).join("\n"),
      });
      printIntermediateAddresses(akashAddress, route.chainPath);
      process.exit(1);
    }
  }
}

// ============================================================================
// BRIDGE DIRECT — signs EVM tx with agent's own wallet (no WalletConnect)
// ============================================================================

async function bridgeDirect(
  akashAddress: string,
  amount: string,
  evmNetwork: string,
  destinationType: "akt" | "usdc"
) {
  // Unlock wallet to get the EVM account
  console.log("Unlocking agent wallet for direct EVM signing...\n");
  const { evmAccount, evmAddress } = await getOrUnlockWallet(akashAddress);
  const walletAddress = evmAddress;

  console.log(`Agent EVM address: ${walletAddress}\n`);

  try {
    // Create bridge route
    console.log("Creating bridge route via Skip Go...\n");
    const bridgeResult = await createSkipBridge({
      fromAddress: walletAddress,
      toAddress: akashAddress,
      amountUSDC: amount,
      destinationType,
      slippagePercent: "3",
    });

    const { route, transactions } = bridgeResult;

    const outputAmount = (parseInt(route.estimatedAmountOut) / 1_000_000).toFixed(6);
    const outputToken = destinationType === "akt" ? "AKT" : "USDC";

    console.log(`Route created:`);
    console.log(`  Estimated received: ${outputAmount} ${outputToken}`);
    console.log(`  Total fees: $${route.fees.totalUsd}`);
    console.log(`  Estimated time: ~${Math.round(route.estimatedDurationSeconds / 60)} minutes`);
    console.log(`  Route: ${route.chainPath.join(" → ")}`);
    console.log("");

    // Get the EVM transaction
    const evmTx = transactions.find(tx => tx.txType === "evm" && tx.evmTx);
    if (!evmTx?.evmTx) throw new Error("No EVM transaction found in route");

    const usdcAddress = USDC_ADDRESSES[evmNetwork] || USDC_ADDRESSES["base"];
    const chain = CHAINS[evmNetwork] || CHAINS["base"];
    const amountInMicro = parseUnits(amount, 6);
    const skipContractAddress = evmTx.evmTx.to as `0x${string}`;

    // Create viem clients
    const evmWalletClient = createEvmWalletClient(evmAccount);
    const publicClient = createPublicClient({ chain, transport: http() });

    // Check balance
    const currentBalance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });

    const balanceFormatted = Number(currentBalance) / 1e6;
    console.log(`  USDC Balance: ${balanceFormatted.toFixed(6)} USDC`);

    if (currentBalance < amountInMicro) {
      console.error(`\nInsufficient USDC balance!`);
      console.error(`  You have: ${balanceFormatted.toFixed(6)} USDC`);
      console.error(`  Required: ${amount} USDC`);
      console.error(`\nSend USDC to your agent wallet: ${walletAddress}`);
      process.exit(1);
    }

    // Check allowance
    const currentAllowance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [walletAddress, skipContractAddress],
    });

    if (currentAllowance < amountInMicro) {
      console.log("\nApproving USDC spending...\n");
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [skipContractAddress, maxApproval],
      });

      const approveTxHash = await evmWalletClient.sendTransaction({
        account: evmAccount,
        chain: base,
        to: usdcAddress,
        data: approveData,
      });
      console.log(`Approval submitted: ${approveTxHash}`);
      console.log("Waiting for confirmation...\n");
      await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
      console.log("Approval confirmed.\n");
    } else {
      console.log(`Allowance OK: ${Number(currentAllowance) / 1e6} USDC\n`);
    }

    // Execute bridge transaction
    console.log("Executing bridge transaction...\n");
    const bridgeTxHash = await evmWalletClient.sendTransaction({
      account: evmAccount,
      chain: base,
      to: evmTx.evmTx.to as `0x${string}`,
      data: evmTx.evmTx.data as `0x${string}`,
      value: evmTx.evmTx.value ? BigInt(evmTx.evmTx.value) : 0n,
    });

    console.log(`Bridge transaction submitted: ${bridgeTxHash}\n`);

    // Register with Skip relay
    console.log("Registering with Skip relay...\n");
    try {
      const trackResult = await trackSkipTransaction(bridgeTxHash, SKIP_CHAINS.BASE_MAINNET);
      console.log(`Explorer: ${trackResult.explorerLink}\n`);
    } catch (trackError: any) {
      console.warn(`Warning: Could not register with Skip relay: ${trackError.message}\n`);
    }

    // Wait for Phase 1 completion
    console.log("Waiting for bridge completion...\n");
    const status = await waitForSkipBridgeCompletion(
      bridgeTxHash,
      SKIP_CHAINS.BASE_MAINNET,
      { timeoutMs: 1800000, pollIntervalMs: 15000, chainPath: route.chainPath }
    );
    console.log("");

    // Phase 2: Cosmos IBC txs
    const cosmosTxs = transactions.filter(tx => tx.txType === "cosmos" && tx.cosmosTx);

    if (status.status === "success" && cosmosTxs.length > 0) {
      console.log("Phase 1 complete (CCTP: Base -> Noble).\n");
      console.log("Starting Phase 2: IBC transfer...\n");

      const { wallet: akashWallet } = await getOrUnlockWallet(akashAddress);
      const nobleWallet = await DirectSecp256k1HdWallet.fromMnemonic(
        (akashWallet as any).mnemonic,
        { prefix: "noble" }
      );
      const [nobleAccount] = await nobleWallet.getAccounts();
      console.log(`Noble address: ${nobleAccount.address}\n`);

      for (let i = 0; i < cosmosTxs.length; i++) {
        const cosmosTx = cosmosTxs[i];
        console.log(`Signing cosmos tx ${i + 1}/${cosmosTxs.length} on ${cosmosTx.chainId}...\n`);

        const cosmosResult = await signAndBroadcastCosmosTx(nobleWallet, cosmosTx.cosmosTx!);
        console.log(`\nNoble tx broadcast: ${cosmosResult.txHash}\n`);

        try {
          const nobleTrack = await trackSkipTransaction(cosmosResult.txHash, cosmosResult.chainId, { initialDelayMs: 3000, maxRetries: 5 });
          console.log(`Explorer: ${nobleTrack.explorerLink}\n`);
        } catch {}

        console.log("Waiting for IBC transfer...\n");
        const ibcStatus = await waitForSkipBridgeCompletion(
          cosmosResult.txHash,
          cosmosResult.chainId,
          {
            timeoutMs: 600000,
            pollIntervalMs: 10000,
            chainPath: route.chainPath.filter(c => c !== SKIP_CHAINS.BASE_MAINNET),
          }
        );
        console.log("");

        if (ibcStatus.status === "success") {
          console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Bridge Complete! (Direct)                    ║
╚═══════════════════════════════════════════════════════════════╝

  Sent: ${amount} USDC (signed by agent wallet)
  Received: ~${outputAmount} ${outputToken}
  To: ${akashAddress}
  Phase 1 TX: ${bridgeTxHash}
  Phase 2 TX: ${cosmosResult.txHash}
`);
        } else {
          console.error(`\nIBC transfer ${ibcStatus.status}. Noble TX: ${cosmosResult.txHash}`);
          printIntermediateAddresses(akashAddress, route.chainPath);
          process.exit(1);
        }
      }
    } else if (status.status === "success") {
      console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Bridge Complete! (Direct)                    ║
╚═══════════════════════════════════════════════════════════════╝

  Sent: ${amount} USDC (signed by agent wallet)
  Received: ~${outputAmount} ${outputToken}
  To: ${akashAddress}
  TX: ${bridgeTxHash}
`);
    } else {
      console.error(`\nBridge ${status.status}. TX: ${bridgeTxHash}`);
      printIntermediateAddresses(akashAddress, route.chainPath);
      process.exit(1);
    }
  } catch (error: any) {
    console.error("\nDirect bridge failed:", error.message || String(error));
    process.exit(1);
  }
}

// ============================================================================
// WALLET BUDGET COMMAND
// ============================================================================

async function walletBudget() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Budget Configuration                       ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const args = process.argv.slice(3);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const budget = loadBudget();

  // Check if user wants to set a config value
  const maxTx = getArg("max-tx");
  const maxDaily = getArg("max-daily");
  const maxTotal = getArg("max-total");
  const approvalAbove = getArg("approval-above");

  let changed = false;
  if (maxTx) { budget.config.maxTransactionUsd = parseFloat(maxTx); changed = true; }
  if (maxDaily) { budget.config.maxDailyUsd = parseFloat(maxDaily); changed = true; }
  if (maxTotal) { budget.config.maxTotalUsd = parseFloat(maxTotal); changed = true; }
  if (approvalAbove) { budget.config.requireApprovalAboveUsd = parseFloat(approvalAbove); changed = true; }

  if (changed) {
    saveBudget(budget);
    console.log("Budget updated!\n");
  }

  const summary = getBudgetSummary(budget);

  console.log("Limits:");
  console.log(`  Per-transaction:  $${summary.config.maxTransactionUsd.toFixed(2)}`);
  console.log(`  Daily:            $${summary.config.maxDailyUsd.toFixed(2)}`);
  console.log(`  Lifetime:         $${summary.config.maxTotalUsd.toFixed(2)}`);
  console.log(`  Approval above:   $${summary.config.requireApprovalAboveUsd.toFixed(2)}`);
  console.log("");
  console.log("Usage:");
  console.log(`  Spent today:      $${summary.dailySpent.toFixed(2)} / $${summary.config.maxDailyUsd.toFixed(2)}`);
  console.log(`  Daily remaining:  $${summary.dailyRemaining.toFixed(2)}`);
  console.log(`  Spent total:      $${summary.totalSpent.toFixed(2)} / $${summary.config.maxTotalUsd.toFixed(2)}`);
  console.log(`  Total remaining:  $${summary.totalRemaining.toFixed(2)}`);
  console.log("");

  if (!changed) {
    console.log("To update limits:");
    console.log("  npx @agent-pay/mcp wallet budget --max-tx 100 --max-daily 200");
  }
}

// ============================================================================
// REGISTER COMMAND (ERC-8004)
// ============================================================================

const AGENT_ID_PATH = join(homedir(), ".agent-pay", "agent-id.json");

async function register() {
  const args = process.argv.slice(3);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const endpoint = getArg("endpoint");
  if (!endpoint) {
    console.error("Usage: npx @agent-pay/mcp register --endpoint <mcp-url>");
    console.error("");
    console.error("Example:");
    console.error("  npx @agent-pay/mcp register --endpoint https://your-domain.trycloudflare.com/mcp");
    console.error("");
    console.error("Requires:");
    console.error("  - PINATA_JWT env var (free at https://app.pinata.cloud)");
    console.error("  - ETH on Base for gas (~$0.01)");
    process.exit(1);
  }

  // 1. Check wallet
  const akashAddress = getDefaultWalletAddress();
  if (!akashAddress) {
    console.error("No wallet found. Create one first:");
    console.error("  npx @agent-pay/mcp wallet create");
    process.exit(1);
  }

  const { evmAccount, evmAddress } = await getOrUnlockWallet(akashAddress);
  const evmWalletClient = createEvmWalletClient(evmAccount);
  const publicClient = createEvmPublicClient();

  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║              ERC-8004 Agent Registration                      ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  EVM Address:    ${evmAddress}`);
  console.log(`  Akash Address:  ${akashAddress}`);
  console.log(`  MCP Endpoint:   ${endpoint}`);
  console.log("");

  // 2. Check if already registered
  const existingAgentId = await getAgentId(publicClient, evmAddress as `0x${string}`);
  if (existingAgentId !== null) {
    const uri = await getAgentURI(publicClient, existingAgentId);
    const fullId = `eip155:8453:${IDENTITY_REGISTRY_ADDRESS}#${existingAgentId}`;

    console.log("  Already registered!");
    console.log("");
    console.log(`  Agent ID:       ${existingAgentId}`);
    console.log(`  Full ID:        ${fullId}`);
    console.log(`  Metadata URI:   ${uri}`);
    console.log("");
    return;
  }

  // 3. Build metadata
  console.log("  Step 1/3: Building agent metadata...");
  const metadata = buildAgentMetadata(endpoint);

  // 4. Upload to IPFS
  console.log("  Step 2/3: Uploading to IPFS via Pinata...");
  const ipfsURI = await uploadToIPFS(metadata);
  console.log(`  IPFS URI: ${ipfsURI}`);

  // 5. Register on-chain
  console.log("  Step 3/3: Registering on Base mainnet...");
  const { txHash, agentId } = await registerAgent(
    evmWalletClient,
    publicClient,
    evmAccount,
    ipfsURI
  );

  const fullId = `eip155:8453:${IDENTITY_REGISTRY_ADDRESS}#${agentId}`;

  // 6. Store locally
  const registrationData = {
    agentId: agentId.toString(),
    fullId,
    txHash,
    ipfsURI,
    endpoint,
    registeredAt: new Date().toISOString(),
  };
  writeFileSync(AGENT_ID_PATH, JSON.stringify(registrationData, null, 2));

  console.log("");
  console.log("  Registration complete!");
  console.log("");
  console.log(`  Agent ID:       ${agentId}`);
  console.log(`  Full ID:        ${fullId}`);
  console.log(`  TX Hash:        ${txHash}`);
  console.log(`  IPFS URI:       ${ipfsURI}`);
  console.log(`  MCP Endpoint:   ${endpoint}`);
  console.log("");
  console.log(`  View on Basescan: https://basescan.org/tx/${txHash}`);
  console.log("");
}

// ============================================================================
// HELP COMMAND
// ============================================================================

function showHelp() {
  console.log(`
Agent-Pay CLI - Trustless Compute Provisioning

Commands:
  wallet create              Create a new Akash wallet (+ Base EVM address)
  wallet list                List all stored wallets
  wallet balance [address]   Check wallet balance (Akash + Base)
  wallet budget              View/configure spending limits

  deploy                     Deploy to Akash Network
    --cpu <n>                CPU cores (default: 1)
    --memory <size>          Memory (default: 1Gi)
    --storage <size>         Storage (default: 5Gi)
    --image <image>          Docker image (default: ubuntu:22.04)
    --hours <n>              Duration in hours (default: 1)
    --port <port>[/proto]    Port to expose (can be repeated)
    --env <key=value>        Environment variable (can be repeated)
    --gpu-count <n>          Number of GPUs
    --gpu-model <model>      GPU model
    --testnet                Use testnet

  close <dseq>               Close a deployment
    --testnet                Use testnet

  status [dseq]              Check deployment status
    --testnet                Use testnet

  bridge                     Bridge USDC from Base to Akash (via Skip Go)
    --amount <usdc>          Amount to bridge (default: 10)
    --receive <token>        Token to receive: akt or usdc (default: akt)
    --direct                 Sign with agent wallet (no WalletConnect QR)

  wallet budget              View/configure autonomous spending limits
    --max-tx <usd>           Max per-transaction (default: 50)
    --max-daily <usd>        Max per-day (default: 100)
    --max-total <usd>        Lifetime cap (default: 500)
    --approval-above <usd>   Prompt user above this amount (default: 25)

  register                   Register as an ERC-8004 agent on Base
    --endpoint <url>         Your public MCP endpoint URL (required)
                             Requires PINATA_JWT env var + ETH on Base for gas

Examples:
  npx @agent-pay/mcp wallet create
  npx @agent-pay/mcp wallet balance
  npx @agent-pay/mcp wallet budget
  npx @agent-pay/mcp bridge --amount 10
  npx @agent-pay/mcp bridge --amount 5 --direct
  npx @agent-pay/mcp deploy --cpu 2 --memory 4Gi --image ubuntu:22.04 --port 22
  npx @agent-pay/mcp status 12345678
  npx @agent-pay/mcp close 12345678
  npx @agent-pay/mcp register --endpoint https://your-domain.com/mcp
`);
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

const command = process.argv[2];
const subcommand = process.argv[3];

if (command === "wallet") {
  if (subcommand === "create") {
    walletCreate().catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
  } else if (subcommand === "list") {
    walletList().catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
  } else if (subcommand === "balance") {
    walletBalance(process.argv[4]).catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
  } else if (subcommand === "budget") {
    walletBudget().catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
  } else {
    console.error(`Unknown wallet command: ${subcommand}`);
    console.error("Available: wallet create, wallet list, wallet balance, wallet budget");
    process.exit(1);
  }
} else if (command === "deploy") {
  deploy().catch((error) => {
    console.error("Deploy failed:", error);
    process.exit(1);
  });
} else if (command === "close") {
  close(subcommand).catch((error) => {
    console.error("Close failed:", error);
    process.exit(1);
  });
} else if (command === "status") {
  statusCmd(subcommand).catch((error) => {
    console.error("Status check failed:", error);
    process.exit(1);
  });
} else if (command === "bridge") {
  bridge().catch((error) => {
    console.error("Bridge failed:", error);
    process.exit(1);
  });
} else if (command === "bridge-resume") {
  bridgeResume().catch((error) => {
    console.error("Bridge resume failed:", error);
    process.exit(1);
  });
} else if (command === "register") {
  register().catch((error) => {
    console.error("Registration failed:", error);
    process.exit(1);
  });
} else if (command === "--help" || command === "-h" || !command) {
  showHelp();
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "npx @agent-pay/mcp --help" for usage.');
  process.exit(1);
}
