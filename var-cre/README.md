# Verifiable Agent Runtime (VAR) - AI-Powered Autonomous Compute

## Hackathon Submission: Chainlink Convergence Hackathon

### Category: AI + Web3 Integration

---

## Overview

VAR (Verifiable Agent Runtime) is a CRE-powered framework that enables AI agents to autonomously provision decentralized compute infrastructure with cryptographic verification.

**The Problem**: AI agents need to acquire compute resources (VPS, containers, GPU) but lack:
- Native payment capabilities (can't use credit cards)
- Verifiable execution (how to prove actions were legitimate?)
- Decision-making frameworks (how to choose providers?)

**Our Solution**: A CRE workflow that:
1. Uses AI/LLM to analyze tasks and determine optimal compute specs
2. Fetches quotes from multiple decentralized providers (Akash-style)
3. Uses AI to select the best provider based on price/capabilities
4. Executes payment via x402 stablecoin protocol (USDC on Base)
5. Provisions compute on decentralized infrastructure
6. Records verifiable attestation on-chain

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AI-POWERED AUTONOMOUS COMPUTE WORKFLOW                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────┐                                                          │
│   │  AI Agent    │  "I need to run an ML training job"                      │
│   │  (Task)      │                                                          │
│   └──────┬───────┘                                                          │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                    CHAINLINK CRE WORKFLOW                             │  │
│   │                 (Verifiable Multi-Node Consensus)                     │  │
│   ├──────────────────────────────────────────────────────────────────────┤  │
│   │                                                                       │  │
│   │  [1] AI ANALYSIS ──────────────────────────────────────────────────  │  │
│   │      • LLM analyzes task description                                 │  │
│   │      • Recommends: CPU, RAM, Storage, Docker image, Duration         │  │
│   │      • Consensus: All CRE nodes agree on recommendations             │  │
│   │                                                                       │  │
│   │  [2] FETCH QUOTES ─────────────────────────────────────────────────  │  │
│   │      • Query Akash, Flux, Golem providers                            │  │
│   │      • Get competitive pricing from decentralized markets            │  │
│   │      • Consensus: All nodes see same quotes                          │  │
│   │                                                                       │  │
│   │  [3] AI SELECTION ─────────────────────────────────────────────────  │  │
│   │      • LLM evaluates quotes vs. task requirements                    │  │
│   │      • Selects optimal provider (price/capability balance)           │  │
│   │      • Consensus: All nodes agree on selection                       │  │
│   │                                                                       │  │
│   │  [4] X402 PAYMENT ─────────────────────────────────────────────────  │  │
│   │      • Execute USDC payment on Base network                          │  │
│   │      • Stablecoin settlement (no volatile tokens)                    │  │
│   │      • Consensus: Payment verified by all nodes                      │  │
│   │                                                                       │  │
│   │  [5] PROVISION ────────────────────────────────────────────────────  │  │
│   │      • Deploy container on selected provider                         │  │
│   │      • Receive host, ports, credentials                              │  │
│   │      • Consensus: Deployment confirmed by all nodes                  │  │
│   │                                                                       │  │
│   │  [6] ATTESTATION ──────────────────────────────────────────────────  │  │
│   │      • Record verifiable proof on-chain (Base Sepolia)               │  │
│   │      • Includes: agent, task, provider, cost, payment tx             │  │
│   │      • Immutable audit trail for agent actions                       │  │
│   │                                                                       │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────┐                                                          │
│   │  Result:     │  Deployed compute + On-chain proof                       │
│   │  Verifiable  │  Agent can now use the provisioned resources             │
│   └──────────────┘                                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Hackathon Requirements Met

| Requirement | How We Meet It |
|-------------|----------------|
| **CRE Workflow** | Go-based workflow using `cre-sdk-go` |
| **Blockchain Integration** | Base/Ethereum for x402 payments + attestations |
| **External API** | LLM API + Compute provider APIs |
| **AI/LLM Integration** | Task analysis + provider selection via LLM |
| **Successful Simulation** | Demonstrated via CRE CLI |
| **AI-assisted Workflow** | LLM makes compute & provider decisions |
| **Autonomous Agent** | No human intervention in the loop |

---

## Demo Simulation Output

```
╔══════════════════════════════════════════════════════════════════╗
║     AI-POWERED AUTONOMOUS COMPUTE PROVISIONING WORKFLOW          ║
╚══════════════════════════════════════════════════════════════════╝

Agent: var-ai-agent-001
Task: "Run a Python machine learning training job on MNIST..."
Budget: 5.00 USDC

[1/6] AI ANALYSIS - Determining optimal compute requirements
      AI Recommendation: 4 CPU, 16GB RAM, 50GB Storage
      Image: pytorch/pytorch:latest
      Duration: 4 hours
      Confidence: high

[2/6] FETCHING QUOTES - Querying decentralized compute markets
      akash-provider-1: $4.08 (GPU, high-memory)
      akash-provider-2: $3.47 (CPU, standard)
      flux-provider-1:  $3.67 (CPU, GPU, storage)

[3/6] AI SELECTION - Choosing optimal provider
      Selected: akash-provider-2 at $3.47 USDC
      Reason: "Most cost-effective option with suitable capabilities"

[4/6] EXECUTING PAYMENT - x402 stablecoin settlement
      Payment: $3.47 USDC on Base network
      TxHash: 0x31373639...

[5/6] PROVISIONING - Deploying on decentralized compute
      Deployment: deploy_1769318470564_gbwou0
      Host: deploy_1769318470564_gbwou0.eu-west.akash.network

[6/6] ATTESTATION - Recording verifiable proof on-chain
      Attestation ID: att_fd3b33e1e97b9c72
      Chain: base-sepolia

╔══════════════════════════════════════════════════════════════════╗
║                    WORKFLOW COMPLETE                             ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## Project Structure

```
var-cre/
├── agent-ai-compute/           # Main hackathon workflow
│   ├── main.go                 # WASM entry point
│   ├── workflow.go             # 6-step AI compute workflow
│   ├── config.staging.json     # Configuration
│   └── workflow.yaml           # CRE settings
│
├── agent-provision/            # Original provision workflow
│   └── ...
│
├── contracts/
│   └── evm/
│       └── src/
│           └── AttestationRegistry.sol  # On-chain attestation
│
├── mock-backend/               # Simulation services
│   └── server.ts               # LLM + Compute + Payment APIs
│
└── README.md
```

---

## Running the Demo

### Prerequisites
- CRE CLI installed (`~/bin/cre`)
- Bun runtime for mock backend
- Go 1.21+

### Steps

1. **Start Mock Backend**
```bash
cd var-cre/mock-backend
bun run server.ts
```

2. **Run CRE Simulation**
```bash
cd var-cre
cre workflow simulate agent-ai-compute -T staging-settings --non-interactive --trigger-index 0
```

---

## Key Innovations

### 1. AI-in-the-Loop Decision Making
The workflow uses LLM calls at two critical points:
- **Task Analysis**: Determining compute requirements from natural language
- **Provider Selection**: Choosing optimal provider from multiple quotes

### 2. x402 Stablecoin Payments
Integration with the emerging x402 protocol enables:
- Machine-to-machine payments without accounts
- Stablecoin settlement (USDC) for predictable costs
- Instant, verifiable transactions

### 3. Decentralized Compute Markets
Queries multiple providers (Akash, Flux, Golem-style) for:
- Competitive pricing
- Geographic distribution
- Capability matching

### 4. Verifiable Attestations
Every agent action is recorded on-chain:
- Task description
- AI reasoning
- Provider selection
- Payment proof
- Deployment details

---

## Future Roadmap

1. **Production Akash Integration**: Real SDK integration with Akash Network
2. **Real x402 Payments**: Production USDC payments on Base mainnet
3. **Multiple LLM Providers**: Support for OpenAI, Anthropic, local models
4. **GPU Workloads**: Specialized handling for ML training jobs
5. **Agent SDK**: TypeScript/Python SDK for easy integration

---

## Team

Built for Chainlink Convergence Hackathon 2026

---

## License

MIT
