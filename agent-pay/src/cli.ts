#!/usr/bin/env node

import { SignClient } from "@walletconnect/sign-client";
import QRCode from "qrcode-terminal";
import { encodeFunctionData, parseUnits, formatUnits, createPublicClient, http, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
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

// Escrow contract deposit ABI
const ESCROW_DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "specsHash", type: "bytes32" },
      { name: "quotedAmount", type: "uint256" },
      { name: "depositAmount", type: "uint256" },
    ],
    outputs: [{ name: "escrowId", type: "bytes32" }],
  },
] as const;

// Escrow contract read ABI
const ESCROW_READ_ABI = [
  {
    name: "escrows",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "user", type: "address" },
      { name: "depositAmount", type: "uint256" },
      { name: "quotedAmount", type: "uint256" },
      { name: "specsHash", type: "bytes32" },
      { name: "createdAt", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "akashDseq", type: "string" },
      { name: "akashProvider", type: "string" },
      { name: "actualCost", type: "uint256" },
    ],
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
// DEPOSIT COMMAND
// ============================================================================

async function deposit(quoteIdArg?: string) {
  const config = loadConfig();
  if (!config) {
    console.error("Not set up yet. Run: npx @agent-pay/mcp setup");
    process.exit(1);
  }

  if (!quoteIdArg) {
    console.error("Usage: npx @agent-pay/mcp deposit <quoteId>");
    console.error("\nGet a quote first by asking Claude for compute.");
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Deposit into Escrow                        ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Fetch quote details from gateway
  console.log("Fetching quote details...\n");

  let quote: any;
  try {
    const response = await fetch(`${config.gatewayUrl}/compute/quote/${quoteIdArg}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });

    if (!response.ok) {
      // Quote endpoint might not exist, try to get from quotes list
      console.error("Quote not found. Please request a new quote via Claude.");
      process.exit(1);
    }

    quote = await response.json();
  } catch (error) {
    console.error("Failed to fetch quote. Please request a new quote via Claude.");
    process.exit(1);
  }

  if (!quote.escrow) {
    console.error("This quote does not support escrow deposits.");
    console.error("The gateway may not have escrow enabled.");
    process.exit(1);
  }

  const escrowContract = quote.escrow.contract as `0x${string}`;
  const specsHash = quote.specsHash as `0x${string}`;
  const quotedAmount = BigInt(quote.escrow.quotedAmount);
  const depositAmount = BigInt(quote.escrow.suggestedDeposit);
  const depositUsd = (Number(depositAmount) / 1_000_000).toFixed(2);
  const quotedUsd = (Number(quotedAmount) / 1_000_000).toFixed(2);

  console.log("Quote Details:");
  console.log(`  Specs: ${quote.specs.cpu} CPU, ${quote.specs.memory} RAM, ${quote.specs.storage} storage`);
  console.log(`  Image: ${quote.specs.image}`);
  console.log(`  Duration: ${quote.specs.hours} hours`);
  console.log(`  Cost: $${quotedUsd} USDC\n`);

  console.log(`Deposit Amount: $${depositUsd} USDC (includes buffer)\n`);

  console.log("Your Protections:");
  console.log("  ✓ Funds held in escrow (not sent to gateway yet)");
  console.log("  ✓ Full refund if deployment fails");
  console.log("  ✓ Excess refunded after deployment");
  console.log("  ✓ All transactions recorded on-chain\n");

  // Initialize WalletConnect
  console.log("Initializing WalletConnect...\n");
  const signClient = await initWalletConnect();

  console.log("Scan QR code to connect and approve deposit:\n");
  const { session, walletAddress } = await connectWallet(signClient);

  if (walletAddress.toLowerCase() !== config.walletAddress.toLowerCase()) {
    console.error(`\nWallet mismatch!`);
    console.error(`  Expected: ${config.walletAddress}`);
    console.error(`  Got: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✓ Connected: ${walletAddress}\n`);

  const chainId = CHAIN_IDS[config.network] || CHAIN_IDS["base"];
  const usdcAddress = USDC_ADDRESSES[config.network] || USDC_ADDRESSES["base"];

  // Step 1: Approve USDC spending for escrow contract
  console.log("Step 1/2: Approving USDC spending for escrow...\n");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Check your wallet to approve USDC spending.                │");
  console.log(`│  Amount: $${depositUsd} USDC                                 `);
  console.log("│  Spender: AgentPayEscrow (verified contract)                │");
  console.log("└─────────────────────────────────────────────────────────────┘\n");

  const approveData = encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: "approve",
    args: [escrowContract, depositAmount],
  });

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

    console.log(`✓ Approval submitted: ${approveTxHash}`);
    console.log("Waiting for confirmation...\n");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (error) {
    console.error("\nApproval was rejected.");
    process.exit(1);
  }

  // Step 2: Deposit into escrow
  console.log("Step 2/2: Depositing into escrow...\n");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Check your wallet to confirm the deposit.                  │");
  console.log(`│  Amount: $${depositUsd} USDC into escrow                     `);
  console.log("└─────────────────────────────────────────────────────────────┘\n");

  const depositData = encodeFunctionData({
    abi: ESCROW_DEPOSIT_ABI,
    functionName: "deposit",
    args: [specsHash, quotedAmount, depositAmount],
  });

  try {
    const depositTxHash = await signClient.request({
      topic: session.topic,
      chainId,
      request: {
        method: "eth_sendTransaction",
        params: [
          {
            from: walletAddress,
            to: escrowContract,
            data: depositData,
          },
        ],
      },
    });

    console.log(`✓ Deposit submitted!`);
    console.log(`  Transaction: ${depositTxHash}\n`);
    console.log("Waiting for confirmation...\n");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Deposit Complete!                          ║
╚═══════════════════════════════════════════════════════════════╝

  Amount: $${depositUsd} USDC
  Tx: ${depositTxHash}

`);

    // Disconnect wallet - no longer needed
    await signClient.disconnect({
      topic: session.topic,
      reason: { code: 6000, message: "Deposit complete" },
    });

    // Now track deployment status
    console.log("Tracking deployment status...\n");

    const pollTimeout = 120000; // 2 minutes
    const pollInterval = 2000; // 2 seconds for more responsive updates
    const startTime = Date.now();

    // Track what we've already printed to avoid duplicates
    let printedDeposit = false;
    let printedDeploymentId = false;
    let printedDseq = false;
    let printedWaitingBids = false;
    let printedProvider = false;
    let printedLease = false;
    let printedManifest = false;
    let lastDseq = "";
    let lastProvider = "";
    let lastLeaseId = "";

    while (Date.now() - startTime < pollTimeout) {
      try {
        const response = await fetch(`${config.gatewayUrl}/compute/by-quote/${quoteIdArg}`, {
          headers: { Authorization: `Bearer ${config.token}` },
        });

        if (!response.ok) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          continue;
        }

        const result = await response.json() as {
          status: string;
          deployment?: {
            deploymentId: string;
            status: string;
            akash?: {
              dseq?: string;
              provider?: string;
              leaseId?: string;
            };
            endpoints?: Array<{ host: string; port: number; protocol: string }>;
            expiresAt: number;
            escrowProofTx?: string;
          };
        };

        if (result.status === "awaiting_deposit") {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          process.stdout.write(`\r  Waiting for deposit confirmation... (${elapsed}s)`);
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          continue;
        }

        if (result.status === "deployment_found" && result.deployment) {
          const deployment = result.deployment;
          const akash = deployment.akash || {};

          // Print deposit detected
          if (!printedDeposit) {
            console.log("\n");
            console.log("  ✓ Deposit confirmed on-chain");
            printedDeposit = true;
          }

          // Print deployment ID
          if (!printedDeploymentId && deployment.deploymentId) {
            console.log(`  ✓ Deployment created: ${deployment.deploymentId}`);
            printedDeploymentId = true;
          }

          // Print dseq when it appears
          if (!printedDseq && akash.dseq && akash.dseq !== lastDseq) {
            console.log(`  ✓ Akash deployment broadcasted (dseq: ${akash.dseq})`);
            printedDseq = true;
            lastDseq = akash.dseq;
          }

          // Print waiting for bids
          if (printedDseq && !printedProvider && !printedWaitingBids) {
            console.log(`  ⏳ Waiting for provider bids...`);
            printedWaitingBids = true;
          }

          // Print provider selected
          if (!printedProvider && akash.provider && akash.provider !== lastProvider) {
            console.log(`  ✓ Provider selected: ${akash.provider}`);
            printedProvider = true;
            lastProvider = akash.provider;
          }

          // Print lease created
          if (!printedLease && akash.leaseId && akash.leaseId !== lastLeaseId) {
            console.log(`  ✓ Lease created with provider`);
            printedLease = true;
            lastLeaseId = akash.leaseId;
          }

          // Print manifest sent (infer from having lease but not yet running)
          if (printedLease && !printedManifest && deployment.status === "deploying") {
            console.log(`  ⏳ Sending manifest & starting container...`);
            printedManifest = true;
          }

          // Check for terminal states
          if (deployment.status === "running") {
            console.log("  ✓ Container is RUNNING!");

            if (deployment.escrowProofTx) {
              console.log(`  ✓ Escrow proof submitted - funds released`);
            }

            const endpointLines = deployment.endpoints && deployment.endpoints.length > 0
              ? deployment.endpoints.map(ep => `    ${ep.protocol}://${ep.host}:${ep.port}`).join("\n")
              : "    (endpoints still provisioning - check status again)";

            console.log(`

╔═══════════════════════════════════════════════════════════════╗
║                  Deployment Complete!                         ║
╚═══════════════════════════════════════════════════════════════╝

  Deployment ID: ${deployment.deploymentId}
  Akash dseq:    ${akash.dseq || "N/A"}
  Provider:      ${akash.provider || "N/A"}

  Endpoints:
${endpointLines}

  Expires: ${new Date(deployment.expiresAt).toISOString()}
${deployment.escrowProofTx ? `\n  Escrow tx: ${deployment.escrowProofTx}` : ""}
`);
            process.exit(0);
          }

          if (deployment.status === "failed") {
            console.log("  ✗ Deployment FAILED");

            console.log(`

╔═══════════════════════════════════════════════════════════════╗
║                  Deployment Failed                            ║
╚═══════════════════════════════════════════════════════════════╝

  Deployment ID: ${deployment.deploymentId}
${deployment.escrowProofTx ? `  Refund tx: ${deployment.escrowProofTx}` : ""}

  Your deposit has been automatically refunded via escrow.
  You can try again with different specs.
`);
            process.exit(1);
          }
        }
      } catch {
        // Polling error - continue
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout
    console.log(`

Timed out waiting for deployment status.
The deployment may still be in progress.

Check status in Claude Code by saying "check my deployment"
or run: npx @agent-pay/mcp escrow-status <escrowId>
`);

  } catch (error) {
    console.error("\nDeposit was rejected.");
    process.exit(1);
  }

  process.exit(0);
}

// ============================================================================
// ESCROW STATUS COMMAND
// ============================================================================

async function escrowStatus(escrowIdArg?: string) {
  const config = loadConfig();
  if (!config) {
    console.error("Not set up yet. Run: npx @agent-pay/mcp setup");
    process.exit(1);
  }

  if (!escrowIdArg) {
    console.error("Usage: npx @agent-pay/mcp escrow-status <escrowId>");
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Escrow Status                              ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Get escrow contract address from gateway
  let escrowContract: `0x${string}`;
  try {
    const response = await fetch(`${config.gatewayUrl}/`);
    const info = await response.json() as any;
    escrowContract = info.escrow?.contract;
    if (!escrowContract) {
      console.error("Escrow contract not configured on gateway.");
      process.exit(1);
    }
  } catch (error) {
    console.error("Failed to fetch gateway info.");
    process.exit(1);
  }

  // Read escrow status from chain
  const chain = CHAINS[config.network] || CHAINS["base"];
  const client = createPublicClient({
    chain,
    transport: http(),
  });

  try {
    const result = await client.readContract({
      address: escrowContract,
      abi: ESCROW_READ_ABI,
      functionName: "escrows",
      args: [escrowIdArg as Hex],
    }) as [string, bigint, bigint, Hex, bigint, number, string, string, bigint];

    const [user, depositAmount, quotedAmount, specsHash, createdAt, status, akashDseq, akashProvider, actualCost] = result;

    const statusNames = ["None", "Deposited", "Released", "Refunded"];
    const statusName = statusNames[status] || "Unknown";

    const depositUsd = (Number(depositAmount) / 1_000_000).toFixed(2);
    const quotedUsd = (Number(quotedAmount) / 1_000_000).toFixed(2);
    const actualUsd = (Number(actualCost) / 1_000_000).toFixed(2);

    console.log(`Escrow ID: ${escrowIdArg}`);
    console.log(`Status: ${statusName}`);
    console.log(`User: ${user}`);
    console.log(`Deposit: $${depositUsd} USDC`);
    console.log(`Quoted: $${quotedUsd} USDC`);

    if (status === 2) { // Released
      console.log(`Actual Cost: $${actualUsd} USDC`);
      const refund = Number(depositAmount - actualCost) / 1_000_000;
      console.log(`Refund: $${refund.toFixed(2)} USDC`);
    }

    if (akashDseq) {
      console.log(`\nAkash Deployment:`);
      console.log(`  DSEQ: ${akashDseq}`);
      console.log(`  Provider: ${akashProvider}`);
    }

    console.log(`\nCreated: ${new Date(Number(createdAt) * 1000).toISOString()}`);

  } catch (error) {
    console.error("Failed to read escrow status:", error);
    process.exit(1);
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
} else if (command === "deposit") {
  deposit(arg).catch((error) => {
    console.error("Deposit failed:", error);
    process.exit(1);
  });
} else if (command === "escrow-status") {
  escrowStatus(arg).catch((error) => {
    console.error("Escrow status check failed:", error);
    process.exit(1);
  });
} else if (command === "--help" || command === "-h" || !command) {
  console.log(`
Agent-Pay CLI

Commands:
  setup                      Connect your wallet and configure agent-pay
  approve <amount>           Approve USDC spending (e.g., approve 50 for $50)
  status                     Check your wallet balance and spending limit
  deposit <quoteId>          Deposit into escrow for a quote
  escrow-status <escrowId>   Check escrow status on-chain

Usage:
  npx @agent-pay/mcp setup
  npx @agent-pay/mcp approve 100
  npx @agent-pay/mcp status
  npx @agent-pay/mcp deposit quote_abc123
  npx @agent-pay/mcp escrow-status 0x...

Environment variables:
  AGENT_PAY_GATEWAY_URL    Gateway URL (default: https://gateway.agentpay.dev)
  AGENT_PAY_NETWORK        Network: "base" or "base-sepolia" (default: base)
`);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "npx @agent-pay/mcp --help" for usage.');
  process.exit(1);
}
