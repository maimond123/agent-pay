import { Router, Request, Response, NextFunction } from 'express';
import {
  ComputeQuoteRequestSchema,
  ComputeProvisionRequestSchema,
  type ComputeQuote,
  type ProvisionResponse,
} from '../../types/index.js';
import { calculatePrice, parseToMb, formatUsd } from '../../pricing/calculator.js';
import {
  generateQuoteId,
  saveQuote,
  getQuote,
  isQuoteValid,
  markQuoteUsed,
  createDeployment,
  getDeployment,
  updateDeploymentStatus,
  setDeploymentEndpoints,
  setPaymentTxHash,
  listDeployments,
  getStats,
} from '../../db/store.js';
import { getAkashClient } from '../../akash/client.js';
import { getPaymentHandler } from '../../wallet/payment.js';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('compute-routes');
const router = Router();

// ============================================================================
// QUOTE ENDPOINT - Get pricing for compute specs
// ============================================================================

router.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate request
    const parsed = ComputeQuoteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.errors,
      });
    }

    const specs = parsed.data;
    logger.info({ specs }, 'Quote requested');

    // Calculate pricing
    const memoryMb = parseToMb(specs.memory);
    const storageMb = parseToMb(specs.storage);

    const pricing = calculatePrice({
      cpu: specs.cpu,
      memoryMb,
      storageMb,
      hours: specs.hours,
      gpu: specs.gpu,
    });

    // Get payment configuration
    const paymentHandler = getPaymentHandler();
    const paymentDetails = paymentHandler.getPaymentConfig(pricing.totalUsdc);

    // Create quote
    const quote: ComputeQuote = {
      quoteId: generateQuoteId(),
      specs: {
        cpu: specs.cpu,
        memory: specs.memory,
        storage: specs.storage,
        image: specs.image,
        hours: specs.hours,
        gpu: specs.gpu,
      },
      pricing: {
        akashCostUakt: pricing.akashCostUakt.toString(),
        akashCostUsd: formatUsd(pricing.akashCostUsd),
        markupUsd: formatUsd(pricing.markupUsd),
        totalUsd: formatUsd(pricing.totalUsd),
        totalUsdc: pricing.totalUsdc,
      },
      paymentDetails: {
        network: paymentDetails.network,
        token: paymentDetails.token,
        recipient: paymentDetails.recipient,
        amount: paymentDetails.amount,
      },
      validUntil: Date.now() + 5 * 60 * 1000, // 5 minutes
      createdAt: Date.now(),
    };

    // Save quote
    saveQuote(quote);

    logger.info({
      quoteId: quote.quoteId,
      totalUsd: quote.pricing.totalUsd,
    }, 'Quote created');

    return res.json(quote);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// PROVISION ENDPOINT - Deploy compute (requires x402 payment)
// ============================================================================

router.post('/provision', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate request
    const parsed = ComputeProvisionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.errors,
      });
    }

    const { quoteId, env, command, ports } = parsed.data;

    // Get x402 payment proof from header
    const paymentProof = req.headers['x-402-receipt'] as string | undefined;
    const paymentTxHash = req.headers['x-payment-txhash'] as string | undefined;

    logger.info({ quoteId, hasPaymentProof: !!paymentProof, hasTxHash: !!paymentTxHash }, 'Provision requested');

    // Validate quote
    const quoteValidation = isQuoteValid(quoteId);
    if (!quoteValidation.valid) {
      return res.status(400).json({
        error: 'Invalid quote',
        reason: quoteValidation.reason,
      });
    }

    const quote = getQuote(quoteId)!;

    // Verify payment (if not in mock mode)
    if (paymentTxHash) {
      const paymentHandler = getPaymentHandler();
      const verification = await paymentHandler.verifyPayment(
        paymentTxHash as `0x${string}`,
        quote.pricing.totalUsdc
      );

      if (!verification.verified) {
        return res.status(402).json({
          error: 'Payment verification failed',
          reason: verification.reason,
          required: {
            amount: quote.pricing.totalUsdc,
            token: quote.paymentDetails.token,
            recipient: quote.paymentDetails.recipient,
            network: quote.paymentDetails.network,
          },
        });
      }

      logger.info({ txHash: paymentTxHash, amount: verification.actualAmount }, 'Payment verified');
    } else if (!paymentProof && process.env.NODE_ENV !== 'development') {
      // In production, require payment
      return res.status(402).json({
        error: 'Payment required',
        paymentDetails: quote.paymentDetails,
        message: 'Send USDC payment and include X-Payment-TxHash header',
      });
    }

    // Mark quote as used
    markQuoteUsed(quoteId);

    // Create deployment record
    const deployment = createDeployment(quoteId, quote);

    if (paymentTxHash) {
      setPaymentTxHash(deployment.deploymentId, paymentTxHash);
    }

    // Start async deployment on Akash
    deployToAkash(deployment.deploymentId, quote, { env, command, ports }).catch(error => {
      logger.error({ error, deploymentId: deployment.deploymentId }, 'Akash deployment failed');
      updateDeploymentStatus(deployment.deploymentId, 'failed');
    });

    const response: ProvisionResponse = {
      deploymentId: deployment.deploymentId,
      status: deployment.status,
      message: 'Deployment initiated. Poll status endpoint for updates.',
    };

    return res.status(202).json(response);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STATUS ENDPOINT - Get deployment status
// ============================================================================

router.get('/:deploymentId/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deploymentId } = req.params;

    const deployment = getDeployment(deploymentId);
    if (!deployment) {
      return res.status(404).json({
        error: 'Deployment not found',
      });
    }

    return res.json(deployment);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// LIST ENDPOINT - List all deployments
// ============================================================================

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const deployments = listDeployments(
      status ? { status: status as any } : undefined
    );

    return res.json({
      deployments,
      total: deployments.length,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STATS ENDPOINT
// ============================================================================

router.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = getStats();
    return res.json(stats);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// HELPER: Async Akash deployment
// ============================================================================

async function deployToAkash(
  deploymentId: string,
  quote: ComputeQuote,
  options: {
    env?: Record<string, string>;
    command?: string[];
    ports?: Array<{ port: number; protocol: 'tcp' | 'udp'; expose: boolean }>;
  }
): Promise<void> {
  const akash = getAkashClient();

  // Update status to deploying
  updateDeploymentStatus(deploymentId, 'deploying');

  try {
    // Create deployment on Akash
    const { dseq, txHash } = await akash.createDeployment({
      cpu: quote.specs.cpu,
      memoryMb: parseToMb(quote.specs.memory),
      storageMb: parseToMb(quote.specs.storage),
      image: quote.specs.image,
      env: options.env,
      command: options.command,
      ports: options.ports || [{ port: 80, protocol: 'tcp', expose: true }],
      gpu: quote.specs.gpu,
    });

    logger.info({ deploymentId, dseq, txHash }, 'Akash deployment created');

    // Update with dseq
    updateDeploymentStatus(deploymentId, 'deploying', { dseq });

    // Wait for bids and select provider (simplified)
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
      env: options.env,
      command: options.command,
      ports: options.ports || [{ port: 80, protocol: 'tcp', expose: true }],
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
    } else {
      throw new Error(`Unexpected lease state: ${status.state}`);
    }
  } catch (error) {
    logger.error({ error, deploymentId }, 'Deployment failed');
    updateDeploymentStatus(deploymentId, 'failed');
    throw error;
  }
}

export default router;
