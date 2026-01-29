#!/usr/bin/env node

import { SignClient } from "@walletconnect/sign-client";
import QRCode from "qrcode-terminal";
import { encodeFunctionData, parseUnits, formatUnits } from "viem";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Configuration
const WALLETCONNECT_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID || "7195fdf3f03fb2c3e50485e0821196d7";
const GATEWAY_URL = process.env.AGENT_PAY_GATEWAY_URL || "https://gateway.agentpay.dev";
const NETWORK = process.env.AGENT_PAY_NETWORK || "base";

// USDC addresses
const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
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
  walletAddress: string;
  token: string;
  gatewayUrl: string;
  network: string;
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
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
        description: "Pay for compute with USDC",
        url: "https://agentpay.dev",
        icons: ["https://agentpay.dev/icon.png"],
      },
    });
  } catch (error) {
    console.error("Failed to initialize WalletConnect:", error);
    process.exit(1);
  }
}

async function connectWallet(signClient: InstanceType<typeof SignClient>): Promise<{ session: any; walletAddress: `0x${string}` }> {
  const chainId = CHAIN_IDS[NETWORK] || CHAIN_IDS["base"];

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

  console.log("Scan this QR code with your mobile wallet:\n");
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
// SETUP COMMAND
// ============================================================================

async function setup() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Agent-Pay Setup                            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  console.log("Initializing WalletConnect...\n");
  const signClient = await initWalletConnect();

  const { session, walletAddress } = await connectWallet(signClient);

  console.log(`✓ Connected: ${walletAddress}`);
  console.log(`  Network: ${NETWORK}\n`);

  // Register with gateway
  console.log("Registering with gateway...\n");

  let token: string;
  try {
    const response = await fetch(`${GATEWAY_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress }),
    });

    if (!response.ok) {
      throw new Error(`Registration failed: ${response.statusText}`);
    }

    const result = await response.json() as { token: string };
    token = result.token;
  } catch (error) {
    console.error("Failed to register with gateway:", error);
    process.exit(1);
  }

  console.log("✓ Registered with gateway\n");

  // Save config
  const config: Config = {
    walletAddress,
    token,
    gatewayUrl: GATEWAY_URL,
    network: NETWORK,
  };
  saveConfig(config);

  // Update Claude settings
  const claudeConfigDir = join(homedir(), ".claude");
  const settingsPath = join(claudeConfigDir, "settings.local.json");

  if (!existsSync(claudeConfigDir)) {
    mkdirSync(claudeConfigDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  const mcpServers = (settings.mcpServers as Record<string, unknown>) || {};
  mcpServers["agent-pay"] = {
    command: "npx",
    args: ["@agent-pay/mcp"],
    env: {
      AGENT_PAY_TOKEN: token,
      AGENT_PAY_GATEWAY_URL: GATEWAY_URL,
      AGENT_PAY_NETWORK: NETWORK,
    },
  };
  settings.mcpServers = mcpServers;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`✓ Configuration saved\n`);

  // Disconnect WalletConnect
  await signClient.disconnect({
    topic: session.topic,
    reason: { code: 6000, message: "Setup complete" },
  });

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Setup Complete!                            ║
╚═══════════════════════════════════════════════════════════════╝

Your wallet: ${walletAddress}
Network:     ${NETWORK}
Gateway:     ${GATEWAY_URL}

You can now use agent-pay in Claude Code:

  "provision a GPU server for ML training"
  "get me a compute quote for 2 CPUs and 4GB RAM"

When you provision compute, you'll be asked to approve the exact
amount needed. No pre-approval required!
`);

  process.exit(0);
}

// ============================================================================
// APPROVE COMMAND
// ============================================================================

async function approve(amountArg?: string) {
  const config = loadConfig();
  if (!config) {
    console.error("Not set up yet. Run: npx @agent-pay/mcp setup");
    process.exit(1);
  }

  // Parse amount
  const amount = parseFloat(amountArg || "100");
  if (isNaN(amount) || amount <= 0) {
    console.error("Invalid amount. Usage: npx @agent-pay/mcp approve <amount>");
    console.error("Example: npx @agent-pay/mcp approve 50");
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Approve USDC Spending                        ║
╚═══════════════════════════════════════════════════════════════╝
`);

  console.log(`Amount: $${amount.toFixed(2)} USDC`);
  console.log(`Wallet: ${config.walletAddress}\n`);

  console.log("This approval allows Agent-Pay to charge your wallet");
  console.log("for compute deployments, up to the amount you specify.");
  console.log("You can revoke this anytime via your wallet or revoke.cash\n");

  // Get gateway address
  let gatewayAddress: `0x${string}`;
  try {
    const response = await fetch(`${config.gatewayUrl}/`);
    const info = await response.json() as { payment?: { gatewayAddress?: string } };
    gatewayAddress = (info.payment?.gatewayAddress || "") as `0x${string}`;
    if (!gatewayAddress || gatewayAddress === "0x0000000000000000000000000000000000000000") {
      throw new Error("Gateway address not configured");
    }
  } catch (error) {
    console.error("Failed to fetch gateway info:", error);
    process.exit(1);
  }

  console.log("Initializing WalletConnect...\n");
  const signClient = await initWalletConnect();

  const { session, walletAddress } = await connectWallet(signClient);

  if (walletAddress.toLowerCase() !== config.walletAddress.toLowerCase()) {
    console.error(`\nWallet mismatch!`);
    console.error(`  Expected: ${config.walletAddress}`);
    console.error(`  Got: ${walletAddress}`);
    console.error(`\nPlease connect the same wallet you used during setup.`);
    process.exit(1);
  }

  console.log(`✓ Connected: ${walletAddress}\n`);

  // Request approval
  console.log("Requesting approval...\n");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Check your wallet app to approve the transaction.         │");
  console.log("│                                                             │");
  console.log(`│  Amount: $${amount.toFixed(2)} USDC`);
  console.log("│  This is your spending limit, not an immediate charge.     │");
  console.log("└─────────────────────────────────────────────────────────────┘\n");

  const chainId = CHAIN_IDS[config.network] || CHAIN_IDS["base"];
  const usdcAddress = USDC_ADDRESSES[config.network] || USDC_ADDRESSES["base"];
  const approvalAmount = parseUnits(amount.toString(), 6);

  const approveData = encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: "approve",
    args: [gatewayAddress, approvalAmount],
  });

  try {
    const txHash = await signClient.request({
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

    console.log(`✓ Approval submitted!`);
    console.log(`  Transaction: ${txHash}\n`);
    console.log("Waiting for confirmation...\n");

    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   Approval Complete!                          ║
╚═══════════════════════════════════════════════════════════════╝

You've approved up to $${amount.toFixed(2)} USDC for compute spending.

Go back to Claude Code and try provisioning compute again!
`);
  } catch (error) {
    console.error("\nApproval was rejected or failed.");
    process.exit(1);
  }

  await signClient.disconnect({
    topic: session.topic,
    reason: { code: 6000, message: "Approval complete" },
  });

  process.exit(0);
}

// ============================================================================
// STATUS COMMAND
// ============================================================================

async function status() {
  const config = loadConfig();
  if (!config) {
    console.error("Not set up yet. Run: npx @agent-pay/mcp setup");
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Agent-Pay Status                           ║
╚═══════════════════════════════════════════════════════════════╝
`);

  console.log(`Wallet:  ${config.walletAddress}`);
  console.log(`Network: ${config.network}`);
  console.log(`Gateway: ${config.gatewayUrl}\n`);

  // Get balance and allowance from gateway
  try {
    const response = await fetch(`${config.gatewayUrl}/auth/info`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch info: ${response.statusText}`);
    }

    const info = await response.json() as {
      balance?: { usdc: string };
      allowance?: { usdc: string };
    };

    console.log(`USDC Balance:   $${info.balance?.usdc || "0.00"}`);
    console.log(`Spending Limit: $${info.allowance?.usdc || "0.00"}\n`);

    const allowance = parseFloat(info.allowance?.usdc || "0");
    if (allowance === 0) {
      console.log("No spending limit set. To approve spending, run:");
      console.log("  npx @agent-pay/mcp approve 50\n");
    } else if (allowance < 10) {
      console.log("Low spending limit. To increase, run:");
      console.log("  npx @agent-pay/mcp approve 50\n");
    }
  } catch (error) {
    console.error("Failed to fetch wallet info:", error);
  }
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

const command = process.argv[2];
const arg = process.argv[3];

if (command === "setup") {
  setup().catch((error) => {
    console.error("Setup failed:", error);
    process.exit(1);
  });
} else if (command === "approve") {
  approve(arg).catch((error) => {
    console.error("Approval failed:", error);
    process.exit(1);
  });
} else if (command === "status") {
  status().catch((error) => {
    console.error("Status check failed:", error);
    process.exit(1);
  });
} else if (command === "--help" || command === "-h" || !command) {
  console.log(`
Agent-Pay CLI

Commands:
  setup              Connect your wallet and configure agent-pay
  approve <amount>   Approve USDC spending (e.g., approve 50 for $50)
  status             Check your wallet balance and spending limit

Usage:
  npx @agent-pay/mcp setup
  npx @agent-pay/mcp approve 100
  npx @agent-pay/mcp status

Environment variables:
  AGENT_PAY_GATEWAY_URL    Gateway URL (default: https://gateway.agentpay.dev)
  AGENT_PAY_NETWORK        Network: "base" or "base-sepolia" (default: base)
`);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "npx @agent-pay/mcp --help" for usage.');
  process.exit(1);
}
