#!/bin/bash

# Akash Gateway Startup Script
# This script starts the gateway with all required environment variables

# Kill any existing process on port 3000
lsof -t -i :3000 | xargs -r kill -9 2>/dev/null

# Escrow Contract Configuration (Base Mainnet)
export ESCROW_CONTRACT_ADDRESS="0x07b1e3666B0E19E3F2B5bDf961CF0479F3A6dDBA"
export ESCROW_GATEWAY_ADDRESS="0xf1AA30f0cF88a54CB8A60c977A4482c2CDda22d6"
export ESCROW_PRIVATE_KEY="0x67e898d348b57e487e5a97b5045241210d3ff3319f80ae4ec002744af146916f"

# Network Configuration
export NETWORK="base"
export NODE_ENV="production"

# Start the gateway
echo "Starting Akash Gateway..."
echo "  Escrow Contract: $ESCROW_CONTRACT_ADDRESS"
echo "  Gateway Address: $ESCROW_GATEWAY_ADDRESS"
echo "  Network: $NETWORK"
echo ""

npm start
