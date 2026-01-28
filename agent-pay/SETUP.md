# agent-pay — External Tester Setup

Connect your Claude Code to a live agent-pay gateway and provision real compute on Akash Network.

## Prerequisites

- [Claude Code](https://claude.com/claude-code) installed
- Node.js >= 18

## 1. Install the MCP server

```bash
npm install -g @maimond123/agent-pay
```

## 2. Register with Claude Code

```bash
claude mcp add agent-pay --transport stdio --scope user \
  -e AGENT_PAY_GATEWAY_URL=GATEWAY_URL_HERE \
  -e AGENT_PAY_NETWORK=base-sepolia \
  -e AGENT_PAY_GATEWAY_API_KEY=API_KEY_HERE \
  -- npx @maimond123/agent-pay
```

Replace `GATEWAY_URL_HERE` and `API_KEY_HERE` with the values provided to you.

## 3. Verify connection

```bash
claude mcp list
```

You should see `agent-pay` with status `Connected`.

## 4. Use it

Open a new Claude Code session from any directory and try:

- **"Get me a compute quote for 1 CPU, 1GB RAM, 1GB storage, running ubuntu:22.04 for 1 hour"**
- **"Deploy the cheapest option"**
- **"List my deployments"**
- **"Stop deployment deploy_xxxxx"** (always stop when done to reclaim deposit)

## Available Tools

| Tool | What it does |
|---|---|
| `get_compute_quote` | Get pricing from multiple Akash providers |
| `provision_compute` | Pay and deploy a container on Akash |
| `check_deployment` | Check status of a deployment |
| `list_deployments` | List all deployments |
| `stop_deployment` | Stop a deployment (frees resources) |

## Optional: Real USDC Payments

By default, payments are simulated. To use real USDC on Base Sepolia testnet:

1. Get a Base Sepolia wallet (any Ethereum wallet)
2. Fund it with test ETH from a [Base Sepolia faucet](https://www.alchemy.com/faucets/base-sepolia)
3. Get test USDC from the [Circle faucet](https://faucet.circle.com/) (select Base Sepolia)
4. Re-register with your wallet key:

```bash
claude mcp remove agent-pay
claude mcp add agent-pay --transport stdio --scope user \
  -e AGENT_PAY_GATEWAY_URL=GATEWAY_URL_HERE \
  -e AGENT_PAY_NETWORK=base-sepolia \
  -e AGENT_PAY_GATEWAY_API_KEY=API_KEY_HERE \
  -e AGENT_PAY_WALLET_KEY=your-private-key-hex \
  -- npx @maimond123/agent-pay
```
