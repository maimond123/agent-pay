import { createPublicClient, http, type Hex, parseAbiItem } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { ESCROW_ABI } from './abi.js';
import { getEscrowClient } from './client.js';
import { createChildLogger } from '../server/logger.js';
import { getQuoteBySpecsHash, createDeploymentFromEscrow, updateDeploymentStatus, setPaymentTxHash } from '../db/store.js';
import { deployToAkashFromEscrow } from './deploy-handler.js';

const logger = createChildLogger('escrow-listener');

const CHAINS = {
  'base': base,
  'base-sepolia': baseSepolia,
} as const;

const DEPOSITED_EVENT = parseAbiItem(
  'event Deposited(bytes32 indexed escrowId, address indexed user, uint256 amount, bytes32 specsHash)'
);

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

  // Watch for Deposited events
  const unwatch = client.watchEvent({
    address: escrowAddress,
    event: DEPOSITED_EVENT,
    onLogs: async (logs) => {
      for (const log of logs) {
        await handleDepositedEvent(log);
      }
    },
    onError: (error) => {
      logger.error({ error }, 'Error watching Deposited events');
    },
  });

  // Also poll for recent events on startup (in case we missed any)
  pollRecentDeposits(client, escrowAddress);

  logger.info('Escrow event listener started');

  // Return unwatch function for cleanup
  process.on('SIGTERM', () => {
    logger.info('Stopping escrow listener');
    unwatch();
  });
}

/**
 * Poll for recent Deposited events (last 100 blocks)
 */
async function pollRecentDeposits(client: ReturnType<typeof createPublicClient>, escrowAddress: Hex): Promise<void> {
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
  // This will be implemented in store.ts
  const { getDeploymentByEscrowId: getByEscrow } = require('../db/store.js');
  return getByEscrow?.(escrowId);
}
