#!/usr/bin/env node

/**
 * Agent-Pay MCP Server (Trustless Flow)
 *
 * MCP server for trustless compute provisioning on Akash Network.
 * The agent orchestrates but NEVER holds keys or signs transactions.
 * All signing happens in the user's CLI process or by external ERC-8004 agents.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./register-tools.js";
import { listStoredWallets, getDefaultWalletAddress, getStoredEvmAddress } from "./wallet/index.js";

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
  const evmAddr = defaultAddress ? getStoredEvmAddress(defaultAddress) : undefined;
  console.error(`[agent-pay] Trustless mode - wallet found: ${defaultAddress}`);
  if (evmAddr) {
    console.error(`[agent-pay] Base (EVM) address: ${evmAddr}`);
  }
  console.error(`[agent-pay] All transactions signed locally on your machine`);
}

// Register all 16 tools (shared with HTTP entry point)
registerAllTools(server);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
