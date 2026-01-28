#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GatewayClient } from "./gateway-client.js";
import { registerProvisionCompute } from "./tools/provision-compute.js";
import { registerGetComputeQuote } from "./tools/get-compute-quote.js";
import { registerCheckDeployment } from "./tools/check-deployment.js";
import { registerListDeployments } from "./tools/list-deployments.js";
import { registerStopDeployment } from "./tools/stop-deployment.js";

// Configuration from environment
const GATEWAY_URL = process.env.AGENT_PAY_GATEWAY_URL ?? "http://localhost:3000";
const TOKEN = process.env.AGENT_PAY_TOKEN;
const NETWORK = process.env.AGENT_PAY_NETWORK ?? "base-sepolia";

// Check for token
if (!TOKEN) {
  console.error(`
╔═══════════════════════════════════════════════════════════════╗
║                  Agent-Pay Not Configured                     ║
╚═══════════════════════════════════════════════════════════════╝

No authentication token found. Run setup to connect your wallet:

  npx @anthropic/agent-pay setup

This will:
  1. Connect your mobile wallet via QR code
  2. Approve USDC spending for compute
  3. Automatically configure agent-pay

After setup, you can use commands like:
  "provision a GPU server"
  "get a compute quote for 2 CPUs"
`);
  process.exit(1);
}

const server = new McpServer({
  name: "agent-pay",
  version: "2.0.0",
});

// Create gateway client with token auth
const gateway = new GatewayClient(GATEWAY_URL, TOKEN);

console.error(`[agent-pay] Connected to gateway: ${GATEWAY_URL}`);
console.error(`[agent-pay] Network: ${NETWORK}`);
console.error(`[agent-pay] Authentication: Token-based`);

// Register all tools (no wallet needed - gateway handles payments)
registerProvisionCompute(server, gateway, null);
registerGetComputeQuote(server, gateway, null);
registerCheckDeployment(server, gateway);
registerListDeployments(server, gateway);
registerStopDeployment(server, gateway);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
