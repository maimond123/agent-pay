#!/usr/bin/env bash
#
# Toggle between dev (Base Sepolia testnet) and prod (Base mainnet).
#
# Usage:
#   ./mode.sh dev    — testnet, mock Akash, Sepolia USDC
#   ./mode.sh prod   — mainnet, real Akash, real USDC
#   ./mode.sh        — show current mode
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
GATEWAY="$ROOT/x402-akash-gateway"
MCP_CONFIG="$ROOT/.claude/settings.local.json"

show_current() {
  if [ ! -f "$GATEWAY/.env" ]; then
    echo "No .env found — run './mode.sh dev' or './mode.sh prod' first."
    exit 1
  fi
  network=$(grep '^X402_NETWORK=' "$GATEWAY/.env" | cut -d= -f2)
  node_env=$(grep '^NODE_ENV=' "$GATEWAY/.env" | cut -d= -f2)
  mcp_network=$(grep AGENT_PAY_NETWORK "$MCP_CONFIG" 2>/dev/null | sed 's/.*: *"\(.*\)".*/\1/')
  echo "Gateway:   $node_env (X402_NETWORK=$network)"
  echo "agent-pay: AGENT_PAY_NETWORK=$mcp_network"
}

set_mode() {
  local mode="$1"

  if [ "$mode" = "dev" ]; then
    cp "$GATEWAY/.env.development" "$GATEWAY/.env"
    # Update MCP config to base-sepolia
    sed -i '' 's/"AGENT_PAY_NETWORK": "base"/"AGENT_PAY_NETWORK": "base-sepolia"/' "$MCP_CONFIG"
    echo "Switched to DEVELOPMENT (Base Sepolia testnet)"
  elif [ "$mode" = "prod" ]; then
    cp "$GATEWAY/.env.production" "$GATEWAY/.env"
    # Update MCP config to base mainnet
    sed -i '' 's/"AGENT_PAY_NETWORK": "base-sepolia"/"AGENT_PAY_NETWORK": "base"/' "$MCP_CONFIG"
    echo "Switched to PRODUCTION (Base mainnet)"
  else
    echo "Usage: ./mode.sh [dev|prod]"
    exit 1
  fi

  echo ""
  show_current
  echo ""
  echo "Restart the gateway and Claude Code to pick up changes."
}

if [ $# -eq 0 ]; then
  show_current
else
  set_mode "$1"
fi
