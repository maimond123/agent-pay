#!/bin/bash

# Agent-Pay PaymentReceiver Deployment Script

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Agent-Pay PaymentReceiver Deployment                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check for required env vars
if [ -z "$PRIVATE_KEY" ]; then
    echo -e "${RED}Error: PRIVATE_KEY environment variable is required${NC}"
    echo "Export your deployer wallet's private key:"
    echo "  export PRIVATE_KEY=0x..."
    exit 1
fi

if [ -z "$OWNER_ADDRESS" ]; then
    echo -e "${RED}Error: OWNER_ADDRESS environment variable is required${NC}"
    echo "Export the address that will own the contract (can withdraw funds):"
    echo "  export OWNER_ADDRESS=0x..."
    exit 1
fi

if [ -z "$BASESCAN_API_KEY" ]; then
    echo -e "${YELLOW}Warning: BASESCAN_API_KEY not set. Contract won't be verified.${NC}"
    echo "Get an API key at: https://basescan.org/apis"
    echo ""
fi

# Default to Base mainnet
NETWORK=${1:-base}

echo -e "Network: ${YELLOW}$NETWORK${NC}"
echo -e "Owner:   ${YELLOW}$OWNER_ADDRESS${NC}"
echo ""

# Set RPC URL based on network
if [ "$NETWORK" == "base" ]; then
    RPC_URL="https://mainnet.base.org"
    CHAIN_ID=8453
elif [ "$NETWORK" == "base-sepolia" ]; then
    RPC_URL="https://sepolia.base.org"
    CHAIN_ID=84532
else
    echo -e "${RED}Unknown network: $NETWORK${NC}"
    echo "Supported networks: base, base-sepolia"
    exit 1
fi

echo "Deploying..."
echo ""

# Deploy with verification
if [ -n "$BASESCAN_API_KEY" ]; then
    forge script script/Deploy.s.sol:DeployScript \
        --rpc-url $RPC_URL \
        --broadcast \
        --verify \
        -vvv
else
    forge script script/Deploy.s.sol:DeployScript \
        --rpc-url $RPC_URL \
        --broadcast \
        -vvv
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Deployment Complete!                       ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "1. Copy the contract address from above"
echo "2. Update your gateway .env:"
echo "   PAYMENT_RECEIVER_ADDRESS=<contract_address>"
echo ""
echo "3. If not verified automatically, verify manually:"
echo "   forge verify-contract <ADDRESS> PaymentReceiver --chain $NETWORK"
echo ""
