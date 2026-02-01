import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Hex,
} from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { ESCROW_ABI, EscrowStatus, escrowStatusToString } from './abi.js';
import { createChildLogger } from '../server/logger.js';

const logger = createChildLogger('escrow-client');

// Chain configuration
const CHAINS = {
  'base': base,
  'base-sepolia': baseSepolia,
} as const;

export interface EscrowInfo {
  escrowId: Hex;
  user: string;
  depositAmount: bigint;
  quotedAmount: bigint;
  specsHash: Hex;
  status: EscrowStatus;
  statusString: string;
  akashDseq: string;
  akashProvider: string;
  actualCost: bigint;
  createdAt: bigint;
}

export class EscrowClient {
  private readonly network: string;
  private readonly chain: typeof base | typeof baseSepolia;
  private readonly escrowAddress: Hex;
  private readonly privateKey: Hex | null;
  private readonly mnemonic: string | null;

  constructor() {
    this.network = process.env.NETWORK || 'base-sepolia';
    this.chain = CHAINS[this.network as keyof typeof CHAINS] || baseSepolia;
    this.escrowAddress = (process.env.ESCROW_CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000') as Hex;
    this.privateKey = (process.env.ESCROW_PRIVATE_KEY || null) as Hex | null;
    this.mnemonic = process.env.ESCROW_MNEMONIC || null;

    if (this.escrowAddress === '0x0000000000000000000000000000000000000000') {
      logger.warn('ESCROW_CONTRACT_ADDRESS not set - escrow features disabled');
    }

    if (!this.privateKey && !this.mnemonic) {
      logger.warn('No ESCROW_PRIVATE_KEY or ESCROW_MNEMONIC set - cannot submit proofs');
    }
  }

  /**
   * Get the account for signing transactions
   */
  private getAccount() {
    if (this.mnemonic) {
      return mnemonicToAccount(this.mnemonic);
    }
    if (this.privateKey) {
      return privateKeyToAccount(this.privateKey);
    }
    return null;
  }

  /**
   * Compute specsHash matching the Solidity formula
   */
  computeSpecsHash(
    cpu: number,
    memoryMb: number,
    storageMb: number,
    image: string,
    durationHours: number
  ): Hex {
    // keccak256(abi.encodePacked(cpu, memoryMb, storageMb, image, durationHours))
    const encoded = encodeAbiParameters(
      parseAbiParameters('uint256, uint256, uint256, string, uint256'),
      [BigInt(cpu), BigInt(memoryMb), BigInt(storageMb), image, BigInt(durationHours)]
    );
    return keccak256(encoded);
  }

  /**
   * Get escrow contract address
   */
  getEscrowAddress(): Hex {
    return this.escrowAddress;
  }

  /**
   * Check if escrow is enabled
   */
  isEnabled(): boolean {
    return this.escrowAddress !== '0x0000000000000000000000000000000000000000';
  }

  /**
   * Get escrow details from contract
   */
  async getEscrow(escrowId: Hex): Promise<EscrowInfo | null> {
    if (!this.isEnabled()) {
      logger.warn('Escrow not enabled, cannot get escrow');
      return null;
    }

    try {
      const client = createPublicClient({
        chain: this.chain,
        transport: http(),
      });

      const result = await client.readContract({
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: 'escrows',
        args: [escrowId],
      }) as [string, bigint, bigint, Hex, bigint, number, string, string, bigint];

      const [user, depositAmount, quotedAmount, specsHash, createdAt, status, akashDseq, akashProvider, actualCost] = result;

      return {
        escrowId,
        user,
        depositAmount,
        quotedAmount,
        specsHash,
        status: status as EscrowStatus,
        statusString: escrowStatusToString(status),
        akashDseq,
        akashProvider,
        actualCost,
        createdAt,
      };
    } catch (error) {
      logger.error({ error, escrowId }, 'Failed to get escrow');
      return null;
    }
  }

  /**
   * Submit proof of successful deployment
   * Called after Akash deployment succeeds
   */
  async submitProof(
    escrowId: Hex,
    akashDseq: string,
    akashProvider: string,
    actualCostUsdc: string // in USDC units (6 decimals)
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (!this.isEnabled()) {
      return { success: false, error: 'Escrow not enabled' };
    }

    const account = this.getAccount();
    if (!account) {
      return { success: false, error: 'Gateway credentials not configured (need ESCROW_PRIVATE_KEY or ESCROW_MNEMONIC)' };
    }

    try {

      const publicClient = createPublicClient({
        chain: this.chain,
        transport: http(),
      });

      const walletClient = createWalletClient({
        account,
        chain: this.chain,
        transport: http(),
      });

      logger.info({ escrowId, akashDseq, akashProvider, actualCostUsdc }, 'Submitting proof to escrow');

      const txHash = await walletClient.writeContract({
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: 'submitProof',
        args: [escrowId, akashDseq, akashProvider, BigInt(actualCostUsdc)],
      });

      logger.info({ txHash, escrowId }, 'Proof submitted, waiting for confirmation');

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      if (receipt.status !== 'success') {
        return { success: false, txHash, error: 'Transaction failed on-chain' };
      }

      logger.info({ txHash, escrowId }, 'Proof confirmed - funds released');

      return { success: true, txHash };
    } catch (error) {
      logger.error({ error, escrowId }, 'Failed to submit proof');
      return { success: false, error: String(error) };
    }
  }

  /**
   * Report deployment failure
   * Called if Akash deployment fails
   */
  async reportFailure(
    escrowId: Hex,
    reason: string
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (!this.isEnabled()) {
      return { success: false, error: 'Escrow not enabled' };
    }

    const account = this.getAccount();
    if (!account) {
      return { success: false, error: 'Gateway credentials not configured (need ESCROW_PRIVATE_KEY or ESCROW_MNEMONIC)' };
    }

    try {

      const publicClient = createPublicClient({
        chain: this.chain,
        transport: http(),
      });

      const walletClient = createWalletClient({
        account,
        chain: this.chain,
        transport: http(),
      });

      logger.info({ escrowId, reason }, 'Reporting failure to escrow');

      const txHash = await walletClient.writeContract({
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: 'reportFailure',
        args: [escrowId, reason],
      });

      logger.info({ txHash, escrowId }, 'Failure reported, waiting for confirmation');

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      if (receipt.status !== 'success') {
        return { success: false, txHash, error: 'Transaction failed on-chain' };
      }

      logger.info({ txHash, escrowId }, 'Failure confirmed - user refunded');

      return { success: true, txHash };
    } catch (error) {
      logger.error({ error, escrowId }, 'Failed to report failure');
      return { success: false, error: String(error) };
    }
  }
}

// Singleton instance
let escrowClient: EscrowClient | null = null;

export function getEscrowClient(): EscrowClient {
  if (!escrowClient) {
    escrowClient = new EscrowClient();
  }
  return escrowClient;
}
