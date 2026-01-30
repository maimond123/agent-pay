import { nanoid } from 'nanoid';
import type { StoredQuote, DeploymentInfo, ComputeQuote } from '../types/index.js';
import { logger } from '../server/logger.js';
import type { Hex } from 'viem';

// Re-export types for convenience
export type { StoredQuote, DeploymentInfo, ComputeQuote };

// ============================================================================
// IN-MEMORY STORE (Replace with real database in production)
// ============================================================================

const quotes = new Map<string, StoredQuote>();
const deployments = new Map<string, DeploymentInfo>();
const specsHashToQuote = new Map<Hex, StoredQuote>(); // Index by specsHash
const escrowIdToDeployment = new Map<Hex, string>(); // escrowId -> deploymentId

// Cleanup expired quotes every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, quote] of quotes.entries()) {
    if (quote.validUntil < now && !quote.used) {
      quotes.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned expired quotes');
  }
}, 5 * 60 * 1000);

// ============================================================================
// QUOTE OPERATIONS
// ============================================================================

export function generateQuoteId(): string {
  return `quote_${nanoid(16)}`;
}

export function saveQuote(quote: ComputeQuote): StoredQuote {
  const storedQuote: StoredQuote = {
    ...quote,
    used: false,
  };
  quotes.set(quote.quoteId, storedQuote);

  // Also index by specsHash if present
  if (storedQuote.specsHash) {
    specsHashToQuote.set(storedQuote.specsHash as Hex, storedQuote);
  }

  logger.debug({ quoteId: quote.quoteId }, 'Quote saved');
  return storedQuote;
}

export function getQuote(quoteId: string): StoredQuote | undefined {
  return quotes.get(quoteId);
}

export function markQuoteUsed(quoteId: string): boolean {
  const quote = quotes.get(quoteId);
  if (!quote) return false;

  quote.used = true;
  quotes.set(quoteId, quote);
  logger.debug({ quoteId }, 'Quote marked as used');
  return true;
}

export function isQuoteValid(quoteId: string): { valid: boolean; reason?: string } {
  const quote = quotes.get(quoteId);

  if (!quote) {
    return { valid: false, reason: 'Quote not found' };
  }

  if (quote.used) {
    return { valid: false, reason: 'Quote already used' };
  }

  if (quote.validUntil < Date.now()) {
    return { valid: false, reason: 'Quote expired' };
  }

  return { valid: true };
}

// ============================================================================
// DEPLOYMENT OPERATIONS
// ============================================================================

export function generateDeploymentId(): string {
  return `deploy_${nanoid(16)}`;
}

export function createDeployment(
  quoteId: string,
  quote: StoredQuote
): DeploymentInfo {
  const deploymentId = generateDeploymentId();
  const now = Date.now();

  const deployment: DeploymentInfo = {
    deploymentId,
    status: 'pending',
    quoteId,
    akash: {},
    specs: quote.specs,
    expiresAt: now + (quote.specs.hours * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  };

  deployments.set(deploymentId, deployment);
  logger.info({ deploymentId, quoteId }, 'Deployment created');
  return deployment;
}

export function getDeployment(deploymentId: string): DeploymentInfo | undefined {
  return deployments.get(deploymentId);
}

export function updateDeployment(
  deploymentId: string,
  updates: Partial<DeploymentInfo>
): DeploymentInfo | undefined {
  const deployment = deployments.get(deploymentId);
  if (!deployment) return undefined;

  const updated: DeploymentInfo = {
    ...deployment,
    ...updates,
    updatedAt: Date.now(),
  };

  deployments.set(deploymentId, updated);
  logger.debug({ deploymentId, updates }, 'Deployment updated');
  return updated;
}

export function updateDeploymentStatus(
  deploymentId: string,
  status: DeploymentInfo['status'],
  akashInfo?: Partial<DeploymentInfo['akash']>
): DeploymentInfo | undefined {
  const deployment = deployments.get(deploymentId);
  if (!deployment) return undefined;

  deployment.status = status;
  deployment.updatedAt = Date.now();

  if (akashInfo) {
    deployment.akash = { ...deployment.akash, ...akashInfo };
  }

  deployments.set(deploymentId, deployment);
  logger.info({ deploymentId, status }, 'Deployment status updated');
  return deployment;
}

export function setDeploymentEndpoints(
  deploymentId: string,
  endpoints: DeploymentInfo['endpoints']
): DeploymentInfo | undefined {
  const deployment = deployments.get(deploymentId);
  if (!deployment) return undefined;

  deployment.endpoints = endpoints;
  deployment.updatedAt = Date.now();
  deployments.set(deploymentId, deployment);

  logger.info({ deploymentId, endpoints }, 'Deployment endpoints set');
  return deployment;
}

export function setPaymentTxHash(
  deploymentId: string,
  txHash: string
): DeploymentInfo | undefined {
  const deployment = deployments.get(deploymentId);
  if (!deployment) return undefined;

  deployment.paymentTxHash = txHash;
  deployment.updatedAt = Date.now();
  deployments.set(deploymentId, deployment);

  logger.debug({ deploymentId, txHash }, 'Payment tx hash set');
  return deployment;
}

// ============================================================================
// LIST OPERATIONS
// ============================================================================

export function listDeployments(
  filter?: { status?: DeploymentInfo['status'] }
): DeploymentInfo[] {
  const results: DeploymentInfo[] = [];

  for (const deployment of deployments.values()) {
    if (filter?.status && deployment.status !== filter.status) {
      continue;
    }
    results.push(deployment);
  }

  return results.sort((a, b) => b.createdAt - a.createdAt);
}

export function listQuotes(includeUsed = false): StoredQuote[] {
  const results: StoredQuote[] = [];
  const now = Date.now();

  for (const quote of quotes.values()) {
    if (!includeUsed && quote.used) continue;
    if (quote.validUntil < now) continue;
    results.push(quote);
  }

  return results.sort((a, b) => b.createdAt - a.createdAt);
}

// ============================================================================
// ESCROW-RELATED OPERATIONS
// ============================================================================

/**
 * Get a quote by its specsHash
 */
export function getQuoteBySpecsHash(specsHash: Hex): StoredQuote | undefined {
  return specsHashToQuote.get(specsHash);
}

/**
 * Create a deployment record from an escrow deposit
 */
export function createDeploymentFromEscrow(
  escrowId: Hex,
  userAddress: string,
  quote: StoredQuote
): DeploymentInfo {
  const deploymentId = generateDeploymentId();
  const now = Date.now();

  const deployment: DeploymentInfo = {
    deploymentId,
    status: 'pending',
    quoteId: quote.quoteId,
    escrowId,
    userAddress,
    akash: {},
    specs: quote.specs,
    expiresAt: now + (quote.specs.hours * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  };

  deployments.set(deploymentId, deployment);
  escrowIdToDeployment.set(escrowId, deploymentId);

  logger.info({ deploymentId, escrowId, quoteId: quote.quoteId }, 'Deployment created from escrow');
  return deployment;
}

/**
 * Get deployment by escrow ID
 */
export function getDeploymentByEscrowId(escrowId: Hex): DeploymentInfo | undefined {
  const deploymentId = escrowIdToDeployment.get(escrowId);
  if (!deploymentId) return undefined;
  return deployments.get(deploymentId);
}

/**
 * Set escrow proof/failure transaction hash
 */
export function setEscrowProofTx(
  deploymentId: string,
  txHash: string
): DeploymentInfo | undefined {
  const deployment = deployments.get(deploymentId);
  if (!deployment) return undefined;

  deployment.escrowProofTx = txHash;
  deployment.updatedAt = Date.now();
  deployments.set(deploymentId, deployment);

  logger.debug({ deploymentId, txHash }, 'Escrow proof tx set');
  return deployment;
}

// ============================================================================
// STATS
// ============================================================================

export function getStats(): {
  totalQuotes: number;
  activeQuotes: number;
  totalDeployments: number;
  runningDeployments: number;
} {
  const now = Date.now();
  let activeQuotes = 0;
  let runningDeployments = 0;

  for (const quote of quotes.values()) {
    if (!quote.used && quote.validUntil >= now) {
      activeQuotes++;
    }
  }

  for (const deployment of deployments.values()) {
    if (deployment.status === 'running') {
      runningDeployments++;
    }
  }

  return {
    totalQuotes: quotes.size,
    activeQuotes,
    totalDeployments: deployments.size,
    runningDeployments,
  };
}
