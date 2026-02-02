import { Router, Request, Response, NextFunction } from 'express';
import {
  ComputeQuoteRequestSchema,
  ComputeProvisionRequestSchema,
  type ComputeQuote,
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
  getDeploymentByQuoteId,
  updateDeploymentStatus,
  setDeploymentEndpoints,
  setPaymentTxHash,
  listDeployments,
  getStats,
} from '../../db/store.js';
import { getAkashClient } from '../../akash/client.js';
import { getPaymentHandler } from '../../wallet/payment.js';
import { getEscrowClient } from '../../escrow/client.js';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('compute-routes');
const router = Router();

// ============================================================================
// QUOTE ENDPOINT - Get pricing for compute specs
// ============================================================================

router.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate request - support both 'memory' and 'ram' field names
    const body = {
      ...req.body,
      memory: req.body.memory || req.body.ram,
    };
    delete body.ram;

    const parsed = ComputeQuoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.errors,
      });
    }

    const specs = parsed.data;
    logger.info({ specs, wallet: req.walletAddress }, 'Quote requested');

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

    // Compute specsHash for escrow matching
    const escrowClient = getEscrowClient();
    const specsHash = escrowClient.computeSpecsHash(
      specs.cpu,
      memoryMb,
      storageMb,
      specs.image,
      specs.hours
    );

    // Calculate suggested deposit (quoted + 20% buffer, rounded up)
    const quotedAmount = pricing.totalUsdc;
    const suggestedDeposit = Math.ceil(parseInt(quotedAmount) * 1.2).toString();

    // Create quote
    const quote: ComputeQuote = {
      quoteId: generateQuoteId(),
      specsHash,
      specs: {
        cpu: specs.cpu,
        memory: specs.memory,
        storage: specs.storage,
        image: specs.image,
        hours: specs.hours,
        gpu: specs.gpu,
        ports: specs.ports,
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
      escrow: escrowClient.isEnabled() ? {
        contract: escrowClient.getEscrowAddress(),
        quotedAmount,
        suggestedDeposit,
      } : undefined,
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
// MULTI-PROVIDER QUOTES ENDPOINT
// ============================================================================

router.post('/quotes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Support both 'memory' and 'ram' field names
    const body = {
      ...req.body,
      memory: req.body.memory || req.body.ram,
    };
    delete body.ram;

    const parsed = ComputeQuoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.errors,
      });
    }

    const specs = parsed.data;
    logger.info({ specs, wallet: req.walletAddress }, 'Multi-provider quotes requested');

    const memoryMb = parseToMb(specs.memory);
    const storageMb = parseToMb(specs.storage);
    const paymentHandler = getPaymentHandler();
    const escrowClient = getEscrowClient();

    // Compute specsHash for escrow matching
    const specsHash = escrowClient.computeSpecsHash(
      specs.cpu,
      memoryMb,
      storageMb,
      specs.image,
      specs.hours
    );

    // Simulate multiple providers with different pricing
    const providers = [
      { id: 'akash-provider-1', name: 'Akash US-East', region: 'us-east', capabilities: 'gpu,high-memory', multiplier: 1.0 },
      { id: 'akash-provider-2', name: 'Akash EU-West', region: 'eu-west', capabilities: 'cpu,standard', multiplier: 0.85 },
      { id: 'flux-provider-1', name: 'Flux Global', region: 'global', capabilities: 'cpu,gpu,storage', multiplier: 0.90 },
    ];

    const quotes = providers.map(provider => {
      const pricing = calculatePrice({
        cpu: specs.cpu,
        memoryMb,
        storageMb,
        hours: specs.hours,
        gpu: specs.gpu,
      });

      // Apply provider-specific multiplier
      const adjustedTotal = Math.ceil(parseFloat(pricing.totalUsdc) * provider.multiplier);
      const priceUsd = (adjustedTotal / 1_000_000).toFixed(2);
      const suggestedDeposit = Math.ceil(adjustedTotal * 1.2).toString();

      const quote: ComputeQuote = {
        quoteId: generateQuoteId(),
        specsHash,
        specs: {
          cpu: specs.cpu,
          memory: specs.memory,
          storage: specs.storage,
          image: specs.image,
          hours: specs.hours,
          gpu: specs.gpu,
          ports: specs.ports,
        },
        pricing: {
          akashCostUakt: pricing.akashCostUakt.toString(),
          akashCostUsd: formatUsd(pricing.akashCostUsd * provider.multiplier),
          markupUsd: formatUsd(pricing.markupUsd * provider.multiplier),
          totalUsd: `$${priceUsd}`,
          totalUsdc: adjustedTotal.toString(),
        },
        paymentDetails: paymentHandler.getPaymentConfig(adjustedTotal.toString()),
        escrow: escrowClient.isEnabled() ? {
          contract: escrowClient.getEscrowAddress(),
          quotedAmount: adjustedTotal.toString(),
          suggestedDeposit,
        } : undefined,
        validUntil: Date.now() + 5 * 60 * 1000,
        createdAt: Date.now(),
      };

      saveQuote(quote);

      return {
        quoteId: quote.quoteId,
        specsHash: quote.specsHash,
        provider: provider.id,
        providerName: provider.name,
        region: provider.region,
        priceUsdc: priceUsd,
        currency: 'USDC',
        validUntil: quote.validUntil,
        capabilities: provider.capabilities,
        specs: quote.specs,
        escrow: quote.escrow,
      };
    });

    // Get user's wallet info for response
    let walletInfo = null;
    if (req.walletAddress) {
      try {
        const balance = await paymentHandler.getBalance(req.walletAddress as `0x${string}`);
        const allowance = await paymentHandler.getAllowance(req.walletAddress as `0x${string}`);
        walletInfo = {
          address: req.walletAddress,
          balance: balance.formatted,
          allowance: (parseInt(allowance) / 1_000_000).toFixed(2),
        };
      } catch (error) {
        logger.warn({ error }, 'Failed to fetch wallet info');
      }
    }

    logger.info({ count: quotes.length }, 'Multi-provider quotes created');

    return res.json({ quotes, wallet: walletInfo });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// PROVISION ENDPOINT - Deploy compute (auto-charges via transferFrom)
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
    const walletAddress = req.walletAddress;

    if (!walletAddress) {
      return res.status(401).json({
        error: 'Wallet address not found',
        message: 'Authentication token does not contain a valid wallet address',
      });
    }

    logger.info({ quoteId, wallet: walletAddress }, 'Provision requested');

    // Validate quote
    const quoteValidation = isQuoteValid(quoteId);
    if (!quoteValidation.valid) {
      return res.status(400).json({
        error: 'Invalid quote',
        reason: quoteValidation.reason,
      });
    }

    const quote = getQuote(quoteId)!;
    const paymentHandler = getPaymentHandler();

    // Pull payment from user's wallet via transferFrom
    const isDevelopment = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
    let paymentTxHash: string | undefined;

    if (!isDevelopment) {
      // Production: Actually charge the user
      const paymentResult = await paymentHandler.pullPayment(
        walletAddress as `0x${string}`,
        quote.pricing.totalUsdc
      );

      if (!paymentResult.success) {
        // Check if it's an allowance issue
        const allowance = await paymentHandler.getAllowance(walletAddress as `0x${string}`);
        const allowanceUsd = (parseInt(allowance) / 1_000_000).toFixed(2);
        const requiredUsd = (parseInt(quote.pricing.totalUsdc) / 1_000_000).toFixed(2);

        // Calculate suggested approval amount (round up to nearest $10)
        const suggestedApproval = Math.ceil(parseFloat(requiredUsd) / 10) * 10;

        return res.status(402).json({
          error: 'Payment failed',
          reason: paymentResult.error,
          details: {
            required: `$${requiredUsd} USDC`,
            allowance: `$${allowanceUsd} USDC`,
            wallet: walletAddress,
            gatewayAddress: paymentHandler.getReceiverAddress(),
          },
          action: parseInt(allowance) < parseInt(quote.pricing.totalUsdc)
            ? `Run: npx @agent-pay/mcp approve ${suggestedApproval}`
            : 'Ensure you have sufficient USDC balance in your wallet',
          hint: parseInt(allowance) < parseInt(quote.pricing.totalUsdc)
            ? 'This will open your wallet to approve the spending limit. No funds are charged until you provision compute.'
            : undefined,
        });
      }

      paymentTxHash = paymentResult.txHash;
      logger.info({ txHash: paymentTxHash, amount: quote.pricing.totalUsdc, wallet: walletAddress }, 'Payment pulled successfully');
    } else {
      // Development: Simulate payment
      paymentTxHash = `0x${Buffer.from(Date.now().toString()).toString('hex').padStart(64, '0')}`;
      logger.info({ txHash: paymentTxHash }, 'Simulated payment (development mode)');
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

    // Generate mock host for immediate response (real endpoints come from status polling)
    const mockHost = `${deployment.deploymentId}.akash.network`;

    const response = {
      deploymentId: deployment.deploymentId,
      provider: req.body.provider || 'akash-provider-1',
      providerName: 'Akash Network',
      host: mockHost,
      ports: {
        http: 80,
        https: 443,
        ssh: 22,
      },
      status: 'deploying',
      expiresAt: deployment.expiresAt,
      credentials: {
        sshHost: mockHost,
        sshPort: 22,
        sshUser: 'root',
        accessToken: `token_${deployment.deploymentId.slice(-16)}`,
      },
      payment: {
        txHash: paymentTxHash,
        amount: quote.pricing.totalUsd,
        wallet: walletAddress,
      },
      message: 'Deployment initiated. Poll status endpoint for updates.',
    };

    return res.status(202).json(response);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// GET QUOTE BY ID - For CLI deposit command
// ============================================================================

router.get('/quote/:quoteId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { quoteId } = req.params;

    const quote = getQuote(quoteId);
    if (!quote) {
      return res.status(404).json({
        error: 'Quote not found',
        message: 'The quote may have expired or been used. Please request a new quote.',
      });
    }

    const validation = isQuoteValid(quoteId);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Quote invalid',
        reason: validation.reason,
      });
    }

    return res.json(quote);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// GET DEPLOYMENT BY QUOTE ID - For tracking escrow deposits
// ============================================================================

router.get('/by-quote/:quoteId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { quoteId } = req.params;

    // First check if quote exists
    const quote = getQuote(quoteId);
    if (!quote) {
      return res.status(404).json({
        error: 'Quote not found',
        status: 'not_found',
      });
    }

    // Check if a deployment was created for this quote (direct match)
    let deployment = getDeploymentByQuoteId(quoteId);

    // If no direct match, check if there's a deployment with the same specsHash
    // This handles the case where multiple quotes have the same specsHash
    // (e.g., multi-provider quotes) and the escrow listener found a different quote
    if (!deployment && quote.specsHash) {
      const allDeployments = listDeployments();
      for (const d of allDeployments) {
        const deploymentQuote = getQuote(d.quoteId);
        if (deploymentQuote?.specsHash === quote.specsHash) {
          deployment = d;
          logger.info({
            requestedQuoteId: quoteId,
            foundQuoteId: d.quoteId,
            specsHash: quote.specsHash,
          }, 'Found deployment via specsHash match');
          break;
        }
      }
    }

    if (!deployment) {
      // Quote exists but no deployment yet - user hasn't deposited
      return res.json({
        status: 'awaiting_deposit',
        quoteId,
        message: 'Waiting for escrow deposit. Once you deposit, deployment will start automatically.',
      });
    }

    // Deployment exists - return full status
    return res.json({
      status: 'deployment_found',
      deployment,
    });
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
// CLOSE ENDPOINT - Stop a running deployment
// ============================================================================

router.post('/:deploymentId/close', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deploymentId } = req.params;

    const deployment = getDeployment(deploymentId);
    if (!deployment) {
      return res.status(404).json({
        error: 'Deployment not found',
      });
    }

    if (deployment.status === 'stopped') {
      return res.json({
        deploymentId,
        status: 'stopped',
        message: 'Deployment is already stopped.',
      });
    }

    if (deployment.status === 'failed') {
      updateDeploymentStatus(deploymentId, 'stopped');
      return res.json({
        deploymentId,
        status: 'stopped',
        message: 'Deployment was in failed state and has been marked as stopped.',
      });
    }

    // If the deployment has an Akash dseq, close the on-chain deployment
    if (deployment.akash?.dseq) {
      try {
        const akash = getAkashClient();
        await akash.closeDeployment(deployment.akash.dseq);
        logger.info({ deploymentId, dseq: deployment.akash.dseq }, 'Akash deployment closed');
      } catch (error) {
        logger.error({ error, deploymentId }, 'Failed to close Akash deployment, marking as stopped anyway');
      }
    }

    updateDeploymentStatus(deploymentId, 'stopped');

    return res.json({
      deploymentId,
      status: 'stopped',
      message: 'Deployment has been stopped and resources released.',
    });
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

  // Determine ports: options > quote.specs > default
  const deployPorts = options.ports || quote.specs.ports || [{ port: 22, protocol: 'tcp' as const, expose: true }];

  try {
    // Create deployment on Akash
    const { dseq, txHash } = await akash.createDeployment({
      cpu: quote.specs.cpu,
      memoryMb: parseToMb(quote.specs.memory),
      storageMb: parseToMb(quote.specs.storage),
      image: quote.specs.image,
      env: options.env,
      command: options.command,
      ports: deployPorts,
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
