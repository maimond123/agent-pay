import type { Hex } from 'viem';
import { getAkashClient } from '../akash/client.js';
import { getEscrowClient } from './client.js';
import { parseToMb } from '../pricing/calculator.js';
import {
  updateDeploymentStatus,
  setDeploymentEndpoints,
  setEscrowProofTx,
  type StoredQuote,
} from '../db/store.js';
import { createChildLogger } from '../server/logger.js';

const logger = createChildLogger('escrow-deploy');

/**
 * Deploy to Akash from an escrow deposit
 * On success: calls submitProof() to release funds
 * On failure: calls reportFailure() to refund user
 */
export async function deployToAkashFromEscrow(
  deploymentId: string,
  escrowId: Hex,
  quote: StoredQuote
): Promise<void> {
  const akash = getAkashClient();
  const escrowClient = getEscrowClient();

  logger.info({ deploymentId, escrowId }, 'Starting Akash deployment from escrow');

  // Update status to deploying
  updateDeploymentStatus(deploymentId, 'deploying');

  try {
    // Create deployment on Akash
    const { dseq, txHash } = await akash.createDeployment({
      cpu: quote.specs.cpu,
      memoryMb: parseToMb(quote.specs.memory),
      storageMb: parseToMb(quote.specs.storage),
      image: quote.specs.image,
      ports: [{ port: 80, protocol: 'tcp', expose: true }],
      gpu: quote.specs.gpu,
    });

    logger.info({ deploymentId, dseq, txHash }, 'Akash deployment created');

    // Update with dseq
    updateDeploymentStatus(deploymentId, 'deploying', { dseq });

    // Wait for bids
    await new Promise(resolve => setTimeout(resolve, 2000));

    const bids = await akash.getBids(dseq);
    if (bids.length === 0) {
      throw new Error('No bids received from providers');
    }

    // Select cheapest bid
    const selectedBid = bids.sort((a, b) =>
      parseInt(a.price) - parseInt(b.price)
    )[0];

    logger.info({ deploymentId, provider: selectedBid.provider }, 'Provider selected');

    // Create lease
    const { leaseId } = await akash.createLease(dseq, 1, 1, selectedBid.provider);
    updateDeploymentStatus(deploymentId, 'deploying', {
      provider: selectedBid.provider,
      leaseId,
      gseq: 1,
      oseq: 1,
    });

    // Send manifest
    await akash.sendManifest(dseq, selectedBid.provider, {
      cpu: quote.specs.cpu,
      memoryMb: parseToMb(quote.specs.memory),
      storageMb: parseToMb(quote.specs.storage),
      image: quote.specs.image,
      ports: [{ port: 80, protocol: 'tcp', expose: true }],
      gpu: quote.specs.gpu,
    });

    // Wait for deployment to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Get lease status with endpoints
    const status = await akash.getLeaseStatus(dseq, 1, 1, selectedBid.provider);

    if (status.state === 'active' && status.services.length > 0) {
      const service = status.services[0];
      const endpoints = service.ips.map(ip => ({
        host: ip.ip || service.uris[0],
        port: ip.externalPort,
        protocol: ip.protocol.toLowerCase(),
      }));

      setDeploymentEndpoints(deploymentId, endpoints);
      updateDeploymentStatus(deploymentId, 'running');

      logger.info({ deploymentId, endpoints }, 'Deployment running');

      // SUCCESS: Submit proof to escrow contract
      // This releases funds to gateway and refunds excess to user
      const actualCostUsdc = quote.pricing.totalUsdc; // Use quoted cost as actual cost
      const proofResult = await escrowClient.submitProof(
        escrowId,
        dseq,
        selectedBid.provider,
        actualCostUsdc
      );

      if (proofResult.success) {
        setEscrowProofTx(deploymentId, proofResult.txHash!);
        logger.info({ deploymentId, escrowId, proofTx: proofResult.txHash }, 'Proof submitted - funds released');
      } else {
        logger.error({ deploymentId, escrowId, error: proofResult.error }, 'Failed to submit proof');
        // Deployment succeeded but proof submission failed
        // This is a problem - funds are stuck in escrow
        // Could implement retry logic here
      }
    } else {
      throw new Error(`Unexpected lease state: ${status.state}`);
    }
  } catch (error) {
    logger.error({ error, deploymentId }, 'Deployment failed');
    updateDeploymentStatus(deploymentId, 'failed');

    // FAILURE: Report failure to escrow contract
    // This refunds the full deposit to the user
    const failureReason = error instanceof Error ? error.message : String(error);
    const failureResult = await escrowClient.reportFailure(escrowId, failureReason);

    if (failureResult.success) {
      setEscrowProofTx(deploymentId, failureResult.txHash!);
      logger.info({ deploymentId, escrowId, refundTx: failureResult.txHash }, 'Failure reported - user refunded');
    } else {
      logger.error({ deploymentId, escrowId, error: failureResult.error }, 'Failed to report failure');
    }

    throw error;
  }
}
