#!/usr/bin/env node

/**
 * Agent-Pay MCP Server (Trustless Flow)
 *
 * MCP server for trustless compute provisioning on Akash Network.
 * The agent orchestrates but NEVER holds keys or signs transactions.
 * All signing happens in the user's CLI process.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProvisionCompute } from "./tools/provision-compute.js";
import { registerCheckWallet } from "./tools/check-wallet.js";
import { registerCheckDeployment } from "./tools/check-deployment.js";
import { registerListDeployments } from "./tools/list-deployments.js";
import { registerStopDeployment } from "./tools/stop-deployment.js";
import { listStoredWallets, getDefaultWalletAddress } from "./wallet/index.js";

const server = new McpServer({
  name: "agent-pay",
  version: "3.0.0",
});

// Check for existing wallets
const storedWallets = listStoredWallets();
const defaultAddress = getDefaultWalletAddress();

if (storedWallets.length === 0) {
  console.error(`
╔═══════════════════════════════════════════════════════════════╗
║              Agent-Pay - Trustless Compute                    ║
╚═══════════════════════════════════════════════════════════════╝

No Akash wallet found. To get started:

  npx @agent-pay/mcp wallet create

This will:
  1. Generate a new Akash wallet with a 24-word recovery phrase
  2. Show you the recovery phrase (save it securely!)
  3. Encrypt and store it locally at ~/.agent-pay/wallets/

After creating your wallet, fund it by bridging USDC from Base:

  npx @agent-pay/mcp bridge --amount 10

Then you can provision compute:

  "Deploy a 2 CPU server for 24 hours"

`);
} else {
  console.error(`[agent-pay] Trustless mode - wallet found: ${defaultAddress}`);
  console.error(`[agent-pay] All transactions signed locally on your machine`);
}

// Register tools for trustless flow
// Read operations - direct chain queries (no signing needed)
registerCheckWallet(server);
registerCheckDeployment(server);
registerListDeployments(server);

// Write operations - return CLI commands for user to execute
registerProvisionCompute(server);
registerStopDeployment(server);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
