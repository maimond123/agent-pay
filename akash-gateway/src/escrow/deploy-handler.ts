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

  // Determine ports from quote or use default (SSH)
  const deployPorts = quote.specs.ports || [{ port: 22, protocol: 'tcp' as const, expose: true }];
  logger.info({ deploymentId, ports: deployPorts }, 'Using ports for deployment');

  // Update status to deploying
  updateDeploymentStatus(deploymentId, 'deploying');

  try {
    // Create deployment on Akash
    const { dseq, txHash } = await akash.createDeployment({
      cpu: quote.specs.cpu,
      memoryMb: parseToMb(quote.specs.memory),
      storageMb: parseToMb(quote.specs.storage),
      image: quote.specs.image,
      ports: deployPorts,
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

    // Filter and select cheapest bid with valid provider URI
    const sortedBids = bids.sort((a, b) => parseInt(a.price) - parseInt(b.price));

    let selectedBid = null;
    for (const bid of sortedBids) {
      // Verify provider has a valid public hostname
      const providerUri = await akash.getProviderUri(bid.provider);
      if (!providerUri) {
        logger.warn({ provider: bid.provider }, 'Provider has no host_uri, skipping');
        continue;
      }

      // Skip providers with local/invalid hostnames
      const hostname = new URL(providerUri).hostname;
      if (hostname.endsWith('.local') || hostname === 'localhost' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
        logger.warn({ provider: bid.provider, hostname }, 'Provider has local/invalid hostname, skipping');
        continue;
      }

      selectedBid = bid;
      break;
    }

    if (!selectedBid) {
      throw new Error('No providers with valid public hostnames found');
    }

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
      ports: deployPorts,
      gpu: quote.specs.gpu,
    });

    // Wait for deployment to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Get lease status with endpoints
    const status = await akash.getLeaseStatus(dseq, 1, 1, selectedBid.provider);

    if (status.state === 'active' && status.services.length > 0) {
      const service = status.services[0];

      // Extract endpoints from IPs
      let endpoints = service.ips.map(ip => ({
        host: ip.ip || service.uris[0],
        port: ip.externalPort,
        protocol: ip.protocol.toLowerCase(),
      }));

      // Fallback: if no IPs but URIs exist, use URIs as endpoints
      if (endpoints.length === 0 && service.uris && service.uris.length > 0) {
        endpoints = service.uris.map(uri => ({
          host: uri,
          port: deployPorts[0]?.port || 80,
          protocol: 'tcp',
        }));
        logger.info({ deploymentId, uris: service.uris }, 'Using URIs as endpoints (no IPs available)');
      }

      setDeploymentEndpoints(deploymentId, endpoints);
      updateDeploymentStatus(deploymentId, 'running');

      logger.info({ deploymentId, endpoints }, 'Deployment running');

      // SUCCESS: Submit proof to escrow contract
      // This releases funds to gateway and refunds excess to user
      const actualCostUsdc = quote.pricing.totalUsdc; // Use quoted cost as actual cost
      logger.info({
        deploymentId,
        escrowId,
        dseq,
        provider: selectedBid.provider,
        actualCostUsdc,
        quotePricing: quote.pricing
      }, 'Submitting proof to escrow contract');

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
  } catch (error: any) {
    logger.error({
      error: error?.message || String(error),
      stack: error?.stack,
      deploymentId
    }, 'Deployment failed');
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
