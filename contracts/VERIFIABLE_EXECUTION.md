# Verifiable Execution Architecture

## Overview

Agent-Pay implements **verifiable execution** for AI agent compute provisioning:

1. **Transparent Pricing** - Specs hash committed on-chain before payment
2. **Escrow Protection** - Funds held until deployment proven
3. **Proof of Deployment** - Akash dseq recorded on-chain
4. **Instant Settlement** - Immediate release on success, immediate refund on failure
5. **Timeout Protection** - 1-hour auto-refund if gateway goes silent
6. **Permanent Registry** - All deployments auditable forever

## Trust Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    WHAT'S VERIFIABLE                            │
└─────────────────────────────────────────────────────────────────┘

✅ Payment amount          - On-chain USDC transfer
✅ Specs commitment        - Hash stored in escrow
✅ Deployment exists       - Akash dseq verifiable on Cosmos
✅ Actual cost             - Recorded when proof submitted
✅ Instant refund          - Immediate on failure or timeout
✅ Deployment history      - Permanent on-chain registry

⚠️ Specs match deployment  - Requires checking Akash chain
⚠️ Deployment still runs   - Requires querying Akash
⚠️ Gateway cost reporting  - Gateway self-reports actual cost
```

## Flow Diagram

```
    User                    Escrow Contract               Gateway                 Akash
      │                           │                          │                      │
      │ 1. Request quote          │                          │                      │
      │──────────────────────────────────────────────────────►                      │
      │                           │                          │                      │
      │ ◄─────────────────────────────────────────────────────                      │
      │    Quote: $5.00, specsHash: 0xabc...                 │                      │
      │                           │                          │                      │
      │ 2. approve() USDC         │                          │                      │
      │──────────────────────────►│ (USDC contract)          │                      │
      │                           │                          │                      │
      │ 3. deposit($5, 0xabc...)  │                          │                      │
      │──────────────────────────►│                          │                      │
      │    escrowId: 0x123...     │                          │                      │
      │ ◄─────────────────────────│                          │                      │
      │                           │                          │                      │
      │                           │ 4. Deposited event       │                      │
      │                           │─────────────────────────►│                      │
      │                           │                          │                      │
      │                           │                          │ 5. Deploy            │
      │                           │                          │─────────────────────►│
      │                           │                          │                      │
      │                           │                          │ ◄─────────────────────
      │                           │                          │    dseq: 12345       │
      │                           │                          │                      │
      │                     ┌─────┴─────┐                    │                      │
      │                     │ SUCCESS?  │                    │                      │
      │                     └─────┬─────┘                    │                      │
      │                    YES    │    NO                    │                      │
      │              ┌────────────┴───────────┐              │                      │
      │              │                        │              │                      │
      │              ▼                        ▼              │                      │
      │     submitProof()            reportFailure()         │                      │
      │     INSTANT RELEASE          INSTANT REFUND          │                      │
      │              │                        │              │                      │
      │ ◄────────────┘                        └─────────────►│                      │
      │  $5 to gateway                     Full refund       │                      │
      │                                                      │                      │
      │                     ┌─────────────┐                  │                      │
      │                     │ 1HR TIMEOUT │                  │                      │
      │                     │ (no response)                  │                      │
      │                     └─────────────┘                  │                      │
      │                           │                          │                      │
      │ claimRefund()             │                          │                      │
      │──────────────────────────►│                          │                      │
      │ ◄─────────────────────────│                          │                      │
      │    Full refund            │                          │                      │
```

## Smart Contract Functions

### User Functions

| Function | Purpose |
|----------|---------|
| `deposit(specsHash, quotedAmount, depositAmount)` | Lock USDC in escrow with specs commitment |
| `claimRefund(escrowId)` | Get refund if gateway goes silent (after 1hr timeout) |

### Gateway Functions

| Function | Purpose |
|----------|---------|
| `submitProof(escrowId, dseq, provider, actualCost)` | Submit proof → **INSTANT** release to gateway |
| `reportFailure(escrowId, reason)` | Report failure → **INSTANT** refund to user |

### View Functions

| Function | Purpose |
|----------|---------|
| `getEscrow(escrowId)` | Get escrow details and status |
| `getDeployment(id)` | Get deployment from permanent registry |
| `getUserEscrows(user)` | List all escrows for a user |
| `getUserDeployments(user)` | List all deployments for a user |
| `computeSpecsHash(...)` | Helper to compute specs hash off-chain |

## Verification Steps for Users

### 1. Verify Escrow Status
```javascript
const escrow = await contract.getEscrow(escrowId);
console.log('Status:', escrow.status); // Should be 'ProofSubmitted'
console.log('Akash dseq:', escrow.akashDseq);
console.log('Actual cost:', escrow.actualCost);
```

### 2. Verify on Akash Chain
```bash
# Query Akash for deployment
akash query deployment get \
  --owner <gateway_akash_address> \
  --dseq <dseq_from_escrow> \
  --node https://rpc.akashnet.net:443
```

### 3. Verify Specs Match
```javascript
// Recompute specs hash
const expectedHash = contract.computeSpecsHash(cpu, memory, storage, image, hours);
const escrow = await contract.getEscrow(escrowId);
assert(escrow.specsHash === expectedHash, 'Specs mismatch!');
```

## Security Properties

| Property | How It's Achieved |
|----------|-------------------|
| **No fund loss** | Escrow holds funds; instant refund on failure, 1hr timeout if silent |
| **No overcharging** | Actual cost recorded; excess refunded instantly |
| **No waiting** | Instant release on success, instant refund on failure |
| **Deployment proof** | Akash dseq on-chain, verifiable on Cosmos |
| **Auditability** | All deployments in permanent registry |
| **Censorship resistance** | User can claim refund without gateway cooperation after 1hr |

## Deployment Addresses

| Network | Contract | Address |
|---------|----------|---------|
| Base Mainnet | AgentPayEscrow | TBD |
| Base Mainnet | PaymentReceiver (legacy) | 0xf1aa30f0cf88a54cb8a60c977a4482c2cdda22d6 |

## Gas Costs (Estimated)

| Operation | Gas | ~Cost at 0.1 gwei |
|-----------|-----|-------------------|
| deposit() | ~150,000 | ~$0.05 |
| submitProof() (includes release) | ~200,000 | ~$0.07 |
| reportFailure() | ~100,000 | ~$0.03 |
| claimRefund() | ~80,000 | ~$0.03 |
