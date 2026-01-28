#!/usr/bin/env node

import { SignClient } from "@walletconnect/sign-client";
import QRCode from "qrcode-terminal";
import { encodeFunctionData, parseUnits } from "viem";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Configuration
const WALLETCONNECT_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID || "your-project-id";
const GATEWAY_URL = process.env.AGENT_PAY_GATEWAY_URL || "https://gateway.agentpay.dev";
const NETWORK = process.env.AGENT_PAY_NETWORK || "base-sepolia";

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

async function setup() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Agent-Pay Setup                            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Step 1: Initialize WalletConnect
  console.log("Initializing WalletConnect...\n");

  let signClient: InstanceType<typeof SignClient>;
  try {
    signClient = await SignClient.init({
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
    console.error("\nMake sure you have a valid WALLETCONNECT_PROJECT_ID.");
    console.error("Get one free at: https://cloud.walletconnect.com");
    process.exit(1);
  }

  // Step 2: Create pairing
  const chainId = CHAIN_IDS[NETWORK] || CHAIN_IDS["base-sepolia"];

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

  // Step 3: Display QR code
  console.log("Scan this QR code with your mobile wallet:\n");
  console.log("(MetaMask, Coinbase Wallet, Rainbow, Trust Wallet, etc.)\n");

  QRCode.generate(uri, { small: true }, (qr) => {
    console.log(qr);
  });

  console.log("\nWaiting for wallet connection...\n");

  // Step 4: Wait for approval
  let session;
  try {
    session = await approval();
  } catch (error) {
    console.error("\nWallet connection was rejected or timed out.");
    process.exit(1);
  }

  // Get wallet address
  const accounts = session.namespaces.eip155?.accounts || [];
  if (accounts.length === 0) {
    console.error("No accounts found in wallet session");
    process.exit(1);
  }

  // Format: "eip155:84532:0x1234..."
  const walletAddress = accounts[0].split(":")[2] as `0x${string}`;

  console.log(`✓ Connected: ${walletAddress}`);
  console.log(`  Network: ${NETWORK}\n`);

  // Step 5: Get gateway info
  console.log("Fetching gateway configuration...\n");

  let gatewayAddress: `0x${string}`;
  try {
    const response = await fetch(`${GATEWAY_URL}/`);
    const info = await response.json() as { payment?: { gatewayAddress?: string } };
    gatewayAddress = (info.payment?.gatewayAddress || "0x0000000000000000000000000000000000000000") as `0x${string}`;
  } catch {
    console.error("Failed to fetch gateway info. Using default address.");
    gatewayAddress = "0x0000000000000000000000000000000000000000" as `0x${string}`;
  }

  // Step 6: Request approval transaction
  console.log("Requesting USDC spending approval...\n");
  console.log("Check your wallet app to approve the transaction.\n");

  const usdcAddress = USDC_ADDRESSES[NETWORK] || USDC_ADDRESSES["base-sepolia"];
  const approvalAmount = parseUnits("1000", 6); // 1000 USDC

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

    console.log(`✓ Approval transaction submitted: ${txHash}`);
    console.log("  Waiting for confirmation...\n");

    // Wait a bit for the transaction to confirm
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (error) {
    console.error("\nApproval transaction was rejected.");
    console.error("You can still register, but you'll need to approve spending later.\n");
  }

  // Step 7: Register with gateway
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

  // Step 8: Save configuration
  const claudeConfigDir = join(homedir(), ".claude");
  const settingsPath = join(claudeConfigDir, "settings.local.json");

  // Ensure directory exists
  if (!existsSync(claudeConfigDir)) {
    mkdirSync(claudeConfigDir, { recursive: true });
  }

  // Read existing settings or create new
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  // Update MCP server config
  const mcpServers = (settings.mcpServers as Record<string, unknown>) || {};
  mcpServers["agent-pay"] = {
    command: "npx",
    args: ["@anthropic/agent-pay"],
    env: {
      AGENT_PAY_TOKEN: token,
      AGENT_PAY_GATEWAY_URL: GATEWAY_URL,
      AGENT_PAY_NETWORK: NETWORK,
    },
  };
  settings.mcpServers = mcpServers;

  // Write settings
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  console.log(`✓ Configuration saved to ${settingsPath}\n`);

  // Step 9: Try to register MCP with Claude Code CLI
  try {
    execSync("which claude", { stdio: "ignore" });
    console.log("Registering MCP with Claude Code...\n");
    // MCP is already configured via settings file, no need for claude mcp add
    console.log("✓ MCP registered\n");
  } catch {
    // Claude CLI not found, that's ok - settings file will work
  }

  // Done!
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

Your USDC will be charged automatically when you provision compute.
To add more allowance, visit your wallet and approve the gateway address.

Gateway address: ${gatewayAddress}
`);

  // Disconnect WalletConnect session
  await signClient.disconnect({
    topic: session.topic,
    reason: { code: 6000, message: "Setup complete" },
  });

  process.exit(0);
}

// CLI entry point
const command = process.argv[2];

if (command === "setup") {
  setup().catch((error) => {
    console.error("Setup failed:", error);
    process.exit(1);
  });
} else if (command === "--help" || command === "-h" || !command) {
  console.log(`
Agent-Pay CLI

Commands:
  setup    Connect your wallet and configure agent-pay

Usage:
  npx @anthropic/agent-pay setup

Environment variables:
  AGENT_PAY_GATEWAY_URL    Gateway URL (default: https://gateway.agentpay.dev)
  AGENT_PAY_NETWORK        Network: "base" or "base-sepolia" (default: base-sepolia)
  WALLETCONNECT_PROJECT_ID WalletConnect project ID (get one at cloud.walletconnect.com)
`);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "npx @anthropic/agent-pay --help" for usage.');
  process.exit(1);
}
