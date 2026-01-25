# x402 Akash Gateway

Pay for decentralized compute on Akash Network using USDC via the x402 protocol.

## Overview

This gateway enables AI agents to autonomously provision compute resources on Akash Network using stablecoin payments. It bridges the gap between:
- **x402 Protocol**: HTTP 402 payment standard for machine-to-machine payments
- **Akash Network**: Decentralized compute marketplace
- **USDC**: Stablecoin payments on Base network

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Run in development mode (mock)
npm run dev

# Build for production
npm run build
npm start
```

## API Endpoints

### `POST /compute/quote`
Get pricing for compute specifications.

**Request:**
```json
{
  "cpu": 2,
  "memory": "4GB",
  "storage": "20GB",
  "image": "nginx:latest",
  "hours": 4,
  "gpu": {
    "count": 1,
    "model": "nvidia-a100"
  }
}
```

**Response:**
```json
{
  "quoteId": "quote_abc123",
  "specs": { ... },
  "pricing": {
    "akashCostUakt": "1000000",
    "akashCostUsd": "$3.50",
    "markupUsd": "$0.52",
    "totalUsd": "$4.02",
    "totalUsdc": "4020000"
  },
  "paymentDetails": {
    "network": "base-sepolia",
    "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "recipient": "0x...",
    "amount": "4020000"
  },
  "validUntil": 1234567890
}
```

### `POST /compute/provision`
Deploy compute after payment.

**Headers:**
- `X-Payment-TxHash`: Transaction hash of USDC payment

**Request:**
```json
{
  "quoteId": "quote_abc123",
  "env": {
    "API_KEY": "secret"
  },
  "command": ["nginx", "-g", "daemon off;"],
  "ports": [
    { "port": 80, "protocol": "tcp", "expose": true }
  ]
}
```

**Response:**
```json
{
  "deploymentId": "deploy_xyz789",
  "status": "deploying",
  "message": "Deployment initiated. Poll status endpoint for updates."
}
```

### `GET /compute/:deploymentId/status`
Get deployment status and endpoints.

**Response:**
```json
{
  "deploymentId": "deploy_xyz789",
  "status": "running",
  "endpoints": [
    { "host": "abc123.akash.network", "port": 80, "protocol": "tcp" }
  ],
  "specs": { ... },
  "expiresAt": 1234567890
}
```

### `GET /compute`
List all deployments.

### `GET /compute/stats`
Get gateway statistics.

## Payment Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Agent     │────▶│   Gateway   │────▶│    Base     │────▶│   Akash     │
│             │     │             │     │  (USDC)     │     │   Network   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       │  1. Request Quote │                   │                   │
       │──────────────────▶│                   │                   │
       │                   │                   │                   │
       │  2. Quote + Price │                   │                   │
       │◀──────────────────│                   │                   │
       │                   │                   │                   │
       │  3. Send USDC     │                   │                   │
       │───────────────────┼──────────────────▶│                   │
       │                   │                   │                   │
       │  4. Provision     │                   │                   │
       │  (with tx hash)   │                   │                   │
       │──────────────────▶│                   │                   │
       │                   │  5. Verify Payment│                   │
       │                   │──────────────────▶│                   │
       │                   │                   │                   │
       │                   │  6. Deploy        │                   │
       │                   │───────────────────┼──────────────────▶│
       │                   │                   │                   │
       │  7. Endpoints     │                   │                   │
       │◀──────────────────│                   │                   │
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `AKASH_MNEMONIC` | Akash wallet mnemonic | (mock mode) |
| `AKASH_RPC_ENDPOINT` | Akash RPC URL | https://rpc.akashnet.net:443 |
| `X402_NETWORK` | Payment network | base-sepolia |
| `PAYMENT_RECEIVER_ADDRESS` | USDC recipient | - |
| `MARKUP_PERCENTAGE` | Gateway fee % | 15 |

## Production Setup

1. **Configure Akash Wallet**: Set `AKASH_MNEMONIC` with funded wallet
2. **Configure Payment Wallet**: Set `PAYMENT_RECEIVER_ADDRESS`
3. **Switch Network**: Set `X402_NETWORK=base` for mainnet
4. **Deploy**: Run with `npm start`

## Architecture

```
src/
├── index.ts              # Entry point
├── server/
│   ├── app.ts           # Express setup
│   ├── logger.ts        # Pino logger
│   └── routes/
│       └── compute.ts   # API routes
├── akash/
│   ├── client.ts        # Akash SDK wrapper
│   └── sdl.ts           # SDL generator
├── pricing/
│   └── calculator.ts    # Cost calculation
├── wallet/
│   └── payment.ts       # USDC payment verification
├── db/
│   └── store.ts         # Quote/deployment storage
└── types/
    └── index.ts         # TypeScript types
```

## License

MIT
