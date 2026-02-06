#!/usr/bin/env node

/**
 * Agent-Pay HTTP MCP Server
 *
 * Exposes the MCP server over HTTP using StreamableHTTPServerTransport (stateless mode).
 * Each request creates a fresh McpServer + transport — no session state.
 * Designed to sit behind a Cloudflare Tunnel for public access.
 *
 * Usage:
 *   npm run serve          # production (compiled)
 *   npm run dev:http       # development (tsx)
 *
 * Then expose via Cloudflare Tunnel:
 *   cloudflared tunnel --url http://localhost:3001
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./register-tools.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "agent-pay", version: "3.0.0", tools: 16 });
});

// ERC-8004 agent registration file (domain verification)
app.get("/.well-known/agent-registration.json", (_req, res) => {
  const agentIdPath = join(homedir(), ".agent-pay", "agent-id.json");
  if (!existsSync(agentIdPath)) {
    res.status(404).json({ error: "Agent not registered yet. Run: npx @agent-pay/mcp register --endpoint <url>" });
    return;
  }
  try {
    const registration = JSON.parse(readFileSync(agentIdPath, "utf-8"));
    // Serve the agent metadata that was registered on-chain
    const metadata = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Agent-Pay Compute Orchestrator",
      description: "Trustless compute provisioning on Akash Network via MCP",
      image: "",
      endpoints: [{ type: "MCP", uri: registration.endpoint }],
      trustedModels: ["reputation"],
      agentId: registration.fullId,
      ipfsURI: registration.ipfsURI,
    };
    res.json(metadata);
  } catch {
    res.status(500).json({ error: "Failed to read agent registration" });
  }
});

// MCP endpoint — stateless: new server + transport per request
app.post("/mcp", async (req, res) => {
  try {
    const server = new McpServer({ name: "agent-pay", version: "3.0.0" });
    registerAllTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("[agent-pay:http] Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE not needed in stateless mode
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless mode — use POST)" },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless mode)" },
    id: null,
  });
});

const PORT = parseInt(process.env.PORT || "3001");
app.listen(PORT, () => {
  console.error(`[agent-pay:http] MCP server listening on http://localhost:${PORT}/mcp`);
  console.error(`[agent-pay:http] Health check: http://localhost:${PORT}/health`);
  console.error(`[agent-pay:http] Stateless mode — no session tracking`);
  console.error(`[agent-pay:http] Expose via: cloudflared tunnel --url http://localhost:${PORT}`);
});
