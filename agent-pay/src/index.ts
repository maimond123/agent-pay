#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GatewayClient } from "./gateway-client.js";
import { createWallet } from "./wallet.js";
import { registerProvisionCompute } from "./tools/provision-compute.js";
import { registerGetComputeQuote } from "./tools/get-compute-quote.js";
import { registerCheckDeployment } from "./tools/check-deployment.js";
import { registerListDeployments } from "./tools/list-deployments.js";
import { registerStopDeployment } from "./tools/stop-deployment.js";

const GATEWAY_URL =
  process.env.AGENT_PAY_GATEWAY_URL ?? "http://localhost:3000";
const GATEWAY_API_KEY = process.env.AGENT_PAY_GATEWAY_API_KEY;

const server = new McpServer({
  name: "agent-pay",
  version: "0.1.0",
});

const gateway = new GatewayClient(GATEWAY_URL, GATEWAY_API_KEY);
const wallet = createWallet();

if (wallet) {
  console.error(
    `[agent-pay] Wallet configured: ${wallet.address} on ${wallet.network}`,
  );
} else {
  console.error(
    "[agent-pay] No wallet key configured — using simulated payments",
  );
}

// Register all tools
registerProvisionCompute(server, gateway, wallet);
registerGetComputeQuote(server, gateway, wallet);
registerCheckDeployment(server, gateway);
registerListDeployments(server, gateway);
registerStopDeployment(server, gateway);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
