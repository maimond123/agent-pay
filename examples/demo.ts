/**
 * Demo: Verifiable Agent Runtime
 *
 * This example demonstrates an AI agent autonomously:
 * 1. Provisioning a VPS with crypto payment
 * 2. Setting up Claude Code
 * 3. Recording verifiable attestations on-chain
 *
 * All actions are executed through CRE with BFT consensus.
 */

import { createAgent, type ProvisionRequest } from '../src/sdk/index.js';

async function main() {
  console.log('='.repeat(60));
  console.log('VERIFIABLE AGENT RUNTIME - Demo');
  console.log('='.repeat(60));
  console.log();

  // Initialize the agent
  const agent = createAgent({
    agentId: 'demo-agent-001',
    network: 'testnet',
    // In production, wallet credentials would be securely managed
    // walletAddress: '0x...',
    // privateKey: '0x...',
  });

  console.log('[1] Agent initialized');
  console.log('    Agent ID: demo-agent-001');
  console.log('    Network: Base Sepolia (testnet)');
  console.log();

  // Step 1: Provision a VPS
  console.log('[2] Requesting VPS provisioning...');
  console.log('    Specs: 2GB RAM, 1 vCPU, Ubuntu 24.04');
  console.log('    Max Budget: 10 USDC');
  console.log();

  const provisionRequest: ProvisionRequest = {
    serviceType: 'vps',
    specs: {
      ram: '2GB',
      cpu: 1,
      storage: '50GB',
      os: 'ubuntu-24.04',
      region: 'us-east',
    },
    maxBudget: BigInt(10 * 1e6), // 10 USDC (6 decimals)
    duration: 30 * 24 * 60 * 60, // 30 days in seconds
  };

  const provisionResult = await agent.provision(provisionRequest);

  console.log('[3] Provisioning result:');
  console.log('    Success:', provisionResult.success);
  console.log('    Attestation ID:', provisionResult.attestation.attestationId);
  console.log('    Attestation TX:', provisionResult.attestation.txHash);
  console.log('    Proof Type:', provisionResult.attestation.proof.type);
  console.log();

  // Step 2: Create a custom attestation
  console.log('[4] Creating custom attestation...');
  const customAttestation = await agent.attest('vps_setup_complete', {
    vpsId: provisionResult.data?.credentials,
    setupSteps: ['nodejs_installed', 'claude_code_installed', 'tmux_configured'],
    timestamp: Date.now(),
  });

  console.log('    Attestation recorded:');
  console.log('    TX Hash:', customAttestation.txHash);
  console.log('    Block:', customAttestation.blockNumber.toString());
  console.log();

  // Step 3: Verify the attestation
  console.log('[5] Verifying attestation...');
  const verification = await agent.verify(customAttestation.attestationId);
  console.log('    Valid:', verification.valid);
  console.log();

  // Step 4: Execute a payment
  console.log('[6] Executing test payment...');
  const paymentResult = await agent.pay({
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f5bE21' as `0x${string}`,
    amount: BigInt(1 * 1e6), // 1 USDC
    token: 'USDC',
    memo: 'Test payment from demo agent',
  });

  console.log('    Payment result:');
  console.log('    Success:', paymentResult.success);
  console.log('    Attestation:', paymentResult.attestation.attestationId);
  console.log();

  // Summary
  console.log('='.repeat(60));
  console.log('DEMO COMPLETE');
  console.log('='.repeat(60));
  console.log();
  console.log('What happened:');
  console.log('1. Agent requested VPS provisioning through CRE');
  console.log('2. CRE workflow executed with multi-node consensus');
  console.log('3. Payment was made via x402-compatible flow');
  console.log('4. All actions recorded as on-chain attestations');
  console.log('5. Anyone can verify these actions occurred');
  console.log();
  console.log('Attestations can be verified on-chain at:');
  console.log(`https://sepolia.basescan.org/address/ATTESTATION_REGISTRY`);
  console.log();
  console.log('In production:');
  console.log('- CRE DON provides BFT consensus (not simulation)');
  console.log('- Real USDC payments on Base mainnet');
  console.log('- ZK proofs for privacy-sensitive operations');
  console.log('- TEE attestations for secure computation');
}

// Run the demo
main().catch(console.error);
