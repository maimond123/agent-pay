import { createPublicClient, http, type Hex, parseAbiItem } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { ESCROW_ABI } from './abi.js';
import { getEscrowClient } from './client.js';
import { createChildLogger } from '../server/logger.js';
import { getQuoteBySpecsHash, createDeploymentFromEscrow, updateDeploymentStatus, setPaymentTxHash, getDeploymentByEscrowId as getByEscrowId } from '../db/store.js';
import { deployToAkashFromEscrow } from './deploy-handler.js';

const logger = createChildLogger('escrow-listener');

const CHAINS = {
  'base': base,
  'base-sepolia': baseSepolia,
} as const;

const DEPOSITED_EVENT = parseAbiItem(
  'event Deposited(bytes32 indexed escrowId, address indexed user, uint256 amount, bytes32 specsHash)'
);

// Store client reference for manual polling
let storedClient: any = null;
let storedEscrowAddress: Hex | null = null;

/**
 * Start listening for Deposited events on the escrow contract
 */
export function startEscrowListener(): void {
  const escrowClient = getEscrowClient();

  if (!escrowClient.isEnabled()) {
    logger.warn('Escrow not enabled - listener not started');
    return;
  }

  const network = process.env.NETWORK || 'base-sepolia';
  const chain = CHAINS[network as keyof typeof CHAINS] || baseSepolia;
  const escrowAddress = escrowClient.getEscrowAddress();

  logger.info({ network, escrowAddress }, 'Starting escrow event listener');

  const client = createPublicClient({
    chain,
    transport: http(),
  });

  // Store for manual polling
  storedClient = client;
  storedEscrowAddress = escrowAddress;

  // Track last processed block to avoid duplicates
  let lastProcessedBlock = 0n;

  // Poll for events every 5 seconds (public RPCs don't support watchEvent filters)
  const pollInterval = setInterval(async () => {
    try {
      const currentBlock = await client.getBlockNumber();
      const fromBlock = lastProcessedBlock > 0n ? lastProcessedBlock + 1n : (currentBlock > 50n ? currentBlock - 50n : 0n);

      if (fromBlock > currentBlock) return;

      const logs = await client.getLogs({
        address: escrowAddress,
        event: DEPOSITED_EVENT,
        fromBlock,
        toBlock: currentBlock,
      });

      if (logs.length > 0) {
        logger.info({ count: logs.length, fromBlock, toBlock: currentBlock }, 'Found new deposit events');
        for (const log of logs) {
          await handleDepositedEvent(log);
        }
      }

      lastProcessedBlock = currentBlock;
    } catch (error) {
      logger.error({ error }, 'Error polling for Deposited events');
    }
  }, 5000);

  // Also poll for recent events on startup (in case we missed any)
  pollRecentDeposits(client, escrowAddress);

  logger.info('Escrow event listener started (polling mode)');

  // Cleanup on shutdown
  process.on('SIGTERM', () => {
    logger.info('Stopping escrow listener');
    clearInterval(pollInterval);
  });
}

/**
 * Poll for recent Deposited events (last 100 blocks)
 */
async function pollRecentDeposits(client: any, escrowAddress: Hex): Promise<void> {
  try {
    const currentBlock = await client.getBlockNumber();
    const fromBlock = currentBlock > 100n ? currentBlock - 100n : 0n;

    logger.info({ fromBlock, toBlock: currentBlock }, 'Polling for recent deposits');

    const logs = await client.getLogs({
      address: escrowAddress,
      event: DEPOSITED_EVENT,
      fromBlock,
      toBlock: currentBlock,
    });

    logger.info({ count: logs.length }, 'Found recent deposit events');

    for (const log of logs) {
      await handleDepositedEvent(log);
    }
  } catch (error) {
    logger.error({ error }, 'Failed to poll recent deposits');
  }
}

/**
 * Handle a Deposited event
 */
async function handleDepositedEvent(log: any): Promise<void> {
  const { escrowId, user, amount, specsHash } = log.args;
  const txHash = log.transactionHash;

  logger.info({ escrowId, user, amount: amount.toString(), specsHash, txHash }, 'Processing Deposited event');

  try {
    // Look up the quote by specsHash
    const quote = getQuoteBySpecsHash(specsHash as Hex);

    if (!quote) {
      logger.warn({ specsHash }, 'No quote found for specsHash - cannot deploy');
      // Report failure since we don't know what to deploy
      const escrowClient = getEscrowClient();
      await escrowClient.reportFailure(escrowId as Hex, 'Quote not found for specsHash');
      return;
    }

    // Check if we already processed this escrow
    const existingDeployment = getDeploymentByEscrowId(escrowId as Hex);
    if (existingDeployment) {
      logger.info({ escrowId, deploymentId: existingDeployment.deploymentId }, 'Deposit already processed');
      return;
    }

    // Create deployment record
    const deployment = createDeploymentFromEscrow(escrowId as Hex, user as string, quote);
    setPaymentTxHash(deployment.deploymentId, txHash);

    logger.info({ deploymentId: deployment.deploymentId, escrowId }, 'Created deployment from escrow deposit');

    // Start async deployment to Akash
    deployToAkashFromEscrow(deployment.deploymentId, escrowId as Hex, quote).catch(error => {
      logger.error({ error, deploymentId: deployment.deploymentId }, 'Akash deployment failed');
      updateDeploymentStatus(deployment.deploymentId, 'failed');
    });

  } catch (error) {
    logger.error({ error, escrowId }, 'Failed to handle Deposited event');
  }
}

/**
 * Check if deployment already exists for this escrow
 */
function getDeploymentByEscrowId(escrowId: Hex): any {
  return getByEscrowId(escrowId);
}

/**
 * Manually trigger polling for recent deposits
 */
export async function manualPollDeposits(): Promise<{ success: boolean; count?: number; events?: any[]; error?: string }> {
  if (!storedClient || !storedEscrowAddress) {
    return { success: false, error: 'Escrow listener not initialized' };
  }

  try {
    const currentBlock = await storedClient.getBlockNumber();
    const fromBlock = currentBlock > 500n ? currentBlock - 500n : 0n;

    logger.info({ fromBlock, toBlock: currentBlock }, 'Manual polling for deposits');

    const logs = await storedClient.getLogs({
      address: storedEscrowAddress,
      event: DEPOSITED_EVENT,
      fromBlock,
      toBlock: currentBlock,
    });

    logger.info({ count: logs.length }, 'Manual poll found deposit events');

    const eventDetails = logs.map((log: any) => ({
      escrowId: log.args.escrowId,
      user: log.args.user,
      amount: log.args.amount?.toString(),
      specsHash: log.args.specsHash,
      txHash: log.transactionHash,
    }));

    for (const log of logs) {
      await handleDepositedEvent(log);
    }

    return { success: true, count: logs.length, events: eventDetails };
  } catch (error: any) {
    logger.error({ error }, 'Manual poll failed');
    return { success: false, error: error.message };
  }
}
