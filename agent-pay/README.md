# agent-pay

MCP server that lets AI agents provision and pay for cloud compute on [Akash Network](https://akash.network) using USDC.

## Install

```bash
npm install -g agent-pay
```

Or from source:

```bash
git clone https://github.com/maimond123/verifiable-agents.git
cd verifiable-agents/agent-pay
npm install && npm run build
```

## Configure

Add to your Claude Code project settings (`.claude/settings.local.json`):

```json
{
  "mcpServers": {
    "agent-pay": {
      "command": "npx",
      "args": ["agent-pay"],
      "env": {
        "AGENT_PAY_GATEWAY_URL": "https://your-gateway-url.com",
        "AGENT_PAY_GATEWAY_API_KEY": "your-api-key",
        "AGENT_PAY_WALLET_KEY": "your-hex-private-key",
        "AGENT_PAY_NETWORK": "base-sepolia"
      }
    }
  }
}
```

Or for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-pay": {
      "command": "npx",
      "args": ["agent-pay"],
      "env": {
        "AGENT_PAY_GATEWAY_URL": "https://your-gateway-url.com",
        "AGENT_PAY_GATEWAY_API_KEY": "your-api-key",
        "AGENT_PAY_WALLET_KEY": "your-hex-private-key",
        "AGENT_PAY_NETWORK": "base-sepolia"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENT_PAY_GATEWAY_URL` | Yes | `http://localhost:3000` | URL of the x402-akash-gateway |
| `AGENT_PAY_GATEWAY_API_KEY` | Yes | — | API key for gateway authentication |
| `AGENT_PAY_WALLET_KEY` | No | — | Hex private key for USDC payments. Omit for simulated mode. |
| `AGENT_PAY_NETWORK` | No | `base` | `base-sepolia` (testnet) or `base` (mainnet) |

## Wallet Setup

The wallet specified by `AGENT_PAY_WALLET_KEY` needs:

- **USDC** on the chosen network (to pay for compute)
- **ETH** on the chosen network (to pay gas for the ERC-20 transfer)

USDC contract addresses:
- Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Base Mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Tools

| Tool | Description |
|---|---|
| `provision_compute` | Analyze task, get quotes, pay with USDC, deploy on Akash |
| `get_compute_quote` | Get pricing from multiple providers (shows wallet balance) |
| `check_deployment` | Check status of a deployment |
| `list_deployments` | List all deployments |
| `stop_deployment` | Stop a running deployment |

## License

MIT
