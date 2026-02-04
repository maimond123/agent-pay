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
  getOrUnlockWallet,
  promptPassword,
} from "./wallet/index.js";
import {
  deployToAkash,
  closeDeployment,
  getWalletBalance,
  getDeploymentStatus,
  queryDeployments,
} from "./akash/index.js";
import { createBridgeRoute, getBridgeStatus, waitForBridgeCompletion } from "./bridge/index.js";
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

// ERC20 approve function ABI
const APPROVE_ABI = [
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
] as const;

// Config file path
const CONFIG_DIR = join(homedir(), ".agent-pay");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface Config {
  walletAddress?: string;
  akashAddress?: string;
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
  const { address, mnemonic, pubkey } = await createAkashWallet();

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

  // Save encrypted wallet
  const walletPath = saveWallet(address, mnemonic, password);

  // Update config
  const config = loadConfig();
  config.akashAddress = address;
  saveConfig(config);

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Wallet Created Successfully!                 ║
╚═══════════════════════════════════════════════════════════════╝

  Address: ${address}
  Saved:   ${walletPath}

Next steps:

  1. Fund your wallet by bridging USDC from Base:
     npx @agent-pay/mcp bridge --amount 10

  2. Then provision compute:
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
    console.log(`  ${wallet.address}${isDefault}`);
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

  console.log(`Address: ${address}`);
  console.log(`Network: ${network}\n`);

  try {
    const balance = await getWalletBalance(address, network);

    console.log("Balances:");
    console.log(`  USDC:  ${balance.usdcFormatted} axlUSDC`);
    console.log(`  AKT:   ${balance.uaktFormatted} AKT`);
    console.log("");

    const usdcBalance = parseFloat(balance.usdcFormatted);
    const aktBalance = parseFloat(balance.uaktFormatted);

    if (usdcBalance < 1.0) {
      console.log("Your USDC balance is low. Bridge more funds:");
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
  const wallet = await getOrUnlockWallet(address);

  try {
    const result = await deployToAkash(wallet, {
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
  const wallet = await getOrUnlockWallet(address);

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
// BRIDGE COMMAND
// ============================================================================

async function bridge() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                Bridge USDC to Akash                           ║
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
  const isTestnet = args.includes("--testnet");

  // Get Akash address
  const akashAddress = getDefaultWalletAddress();
  if (!akashAddress) {
    console.error("No Akash wallet found. Create one first:");
    console.error("  npx @agent-pay/mcp wallet create");
    process.exit(1);
  }

  console.log(`Bridge Details:`);
  console.log(`  Amount: ${amount} USDC`);
  console.log(`  From: ${evmNetwork === "base" ? "Base Mainnet" : "Base Sepolia"}`);
  console.log(`  To: Akash (${akashAddress})`);
  console.log(`  Include gas swap: Yes (small AKT for tx fees)`);
  console.log("");

  // Initialize WalletConnect for EVM signing
  console.log("Connect your EVM wallet to sign the bridge transaction:\n");
  const signClient = await initWalletConnect();
  const { session, walletAddress } = await connectEvmWallet(signClient, evmNetwork);

  console.log(`\nConnected: ${walletAddress}\n`);

  try {
    // Create bridge route
    console.log("Creating bridge route...\n");
    const route = await createBridgeRoute({
      fromAddress: walletAddress,
      toAddress: akashAddress,
      amountUSDC: amount,
      network: isTestnet ? "testnet" : "mainnet",
      includeGasSwap: true,
    });

    console.log(`Route created:`);
    console.log(`  Estimated received: ${route.estimatedReceived} USDC`);
    console.log(`  Bridge fee: ${route.fees.bridgeFee} USDC`);
    console.log(`  Gas fee: ${route.fees.gasFee} USDC`);
    console.log(`  Estimated time: ${route.estimatedTime}s`);
    console.log("");

    // Check if approval is needed
    if (route.approvalNeeded && route.approvalAddress) {
      console.log("Step 1/2: Approving USDC spending...\n");

      const approveData = encodeFunctionData({
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [route.approvalAddress as `0x${string}`, parseUnits(amount, 6)],
      });

      const chainId = CHAIN_IDS[evmNetwork] || CHAIN_IDS["base"];
      const usdcAddress = USDC_ADDRESSES[evmNetwork] || USDC_ADDRESSES["base"];

      try {
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
        console.log("Waiting for confirmation...\n");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (error) {
        console.error("Approval rejected.");
        process.exit(1);
      }
    }

    // Execute bridge transaction
    console.log(`${route.approvalNeeded ? "Step 2/2" : "Step 1/1"}: Executing bridge...\n`);
    console.log("Check your wallet to confirm the bridge transaction.\n");

    const chainId = CHAIN_IDS[evmNetwork] || CHAIN_IDS["base"];

    try {
      const bridgeTxHash = (await signClient.request({
        topic: session.topic,
        chainId,
        request: {
          method: "eth_sendTransaction",
          params: [
            {
              from: walletAddress,
              to: route.transactionRequest.to,
              data: route.transactionRequest.data,
              value: route.transactionRequest.value,
            },
          ],
        },
      })) as string;

      console.log(`Bridge transaction submitted: ${bridgeTxHash}\n`);

      // Disconnect wallet
      await signClient.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: "Bridge initiated" },
      });

      // Wait for bridge completion
      console.log("Waiting for bridge completion...\n");
      const status = await waitForBridgeCompletion(
        bridgeTxHash,
        route.routeId,
        isTestnet ? "testnet" : "mainnet"
      );

      if (status.status === "success") {
        console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Bridge Complete!                             ║
╚═══════════════════════════════════════════════════════════════╝

  Amount: ${amount} USDC
  Received: ~${route.estimatedReceived} axlUSDC
  To: ${akashAddress}
  TX: ${bridgeTxHash}

Your Akash wallet is now funded! You can deploy compute:
  npx @agent-pay/mcp deploy --cpu 2 --memory 4Gi --image ubuntu:22.04
`);
      } else if (status.status === "failed") {
        console.error(`\nBridge failed: ${status.error}`);
        console.error("Funds should be returned to your source wallet.");
        process.exit(1);
      } else {
        console.log(`
Bridge is still processing (may take 2-5 minutes).
Transaction: ${bridgeTxHash}

Check your Akash wallet balance:
  npx @agent-pay/mcp wallet balance
`);
      }
    } catch (error) {
      console.error("Bridge transaction rejected.");
      process.exit(1);
    }
  } catch (error) {
    console.error("Bridge failed:", error);
    process.exit(1);
  }
}

// ============================================================================
// HELP COMMAND
// ============================================================================

function showHelp() {
  console.log(`
Agent-Pay CLI - Trustless Compute Provisioning

Commands:
  wallet create              Create a new Akash wallet
  wallet list                List all stored wallets
  wallet balance [address]   Check wallet balance

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

  bridge                     Bridge USDC from Base to Akash
    --amount <usdc>          Amount to bridge (default: 10)
    --evm-network <network>  EVM network: base or base-sepolia
    --testnet                Use Akash testnet

Examples:
  npx @agent-pay/mcp wallet create
  npx @agent-pay/mcp wallet balance
  npx @agent-pay/mcp bridge --amount 10
  npx @agent-pay/mcp deploy --cpu 2 --memory 4Gi --image ubuntu:22.04 --port 22
  npx @agent-pay/mcp status 12345678
  npx @agent-pay/mcp close 12345678
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
  } else {
    console.error(`Unknown wallet command: ${subcommand}`);
    console.error("Available: wallet create, wallet list, wallet balance");
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
} else if (command === "--help" || command === "-h" || !command) {
  showHelp();
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "npx @agent-pay/mcp --help" for usage.');
  process.exit(1);
}
