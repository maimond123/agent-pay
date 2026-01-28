import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { createChildLogger } from '../server/logger.js';

const logger = createChildLogger('payment');

// ============================================================================
// USDC CONTRACT ADDRESSES
// ============================================================================

const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

const CHAINS: Record<string, typeof baseSepolia | typeof base> = {
  'base-sepolia': baseSepolia,
  'base': base,
};

// ERC20 ABI (for balance, allowance, and transferFrom)
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'transferFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// ============================================================================
// PAYMENT HANDLER
// ============================================================================

export class PaymentHandler {
  private readonly network: string;
  private readonly chain: typeof baseSepolia | typeof base;
  private readonly usdcAddress: `0x${string}`;
  private readonly receiverAddress: `0x${string}`;
  private readonly privateKey: `0x${string}` | null;

  constructor() {
    // Support both old (X402_NETWORK) and new (NETWORK) env vars
    this.network = process.env.NETWORK || process.env.X402_NETWORK || 'base-sepolia';
    this.chain = CHAINS[this.network] || baseSepolia;
    this.usdcAddress = USDC_ADDRESSES[this.network] || USDC_ADDRESSES['base-sepolia'];
    this.receiverAddress = (process.env.PAYMENT_RECEIVER_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`;
    this.privateKey = process.env.PAYMENT_RECEIVER_PRIVATE_KEY as `0x${string}` | null;
  }

  /**
   * Get payment configuration
   */
  getPaymentConfig(amountUsdc: string): {
    network: string;
    token: string;
    recipient: string;
    amount: string;
    chainId: number;
  } {
    return {
      network: this.network,
      token: this.usdcAddress,
      recipient: this.receiverAddress,
      amount: amountUsdc, // Already in 6 decimal format
      chainId: this.chain.id,
    };
  }

  /**
   * Get USDC allowance that a wallet has approved for the gateway
   */
  async getAllowance(ownerAddress: `0x${string}`): Promise<string> {
    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(),
    });

    const allowance = await publicClient.readContract({
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [ownerAddress, this.receiverAddress],
    });

    return allowance.toString();
  }

  /**
   * Pull USDC from a user's wallet using transferFrom
   * Requires the user to have approved the gateway address
   */
  async pullPayment(
    fromAddress: `0x${string}`,
    amount: string
  ): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
  }> {
    if (!this.privateKey) {
      return {
        success: false,
        error: 'Gateway private key not configured - cannot execute transferFrom',
      };
    }

    try {
      const publicClient = createPublicClient({
        chain: this.chain,
        transport: http(),
      });

      // Check allowance first
      const allowance = await this.getAllowance(fromAddress);
      const amountBigInt = BigInt(amount);

      if (BigInt(allowance) < amountBigInt) {
        return {
          success: false,
          error: `Insufficient allowance: have ${allowance}, need ${amount}`,
        };
      }

      // Check user's balance
      const balance = await this.getBalance(fromAddress);
      if (BigInt(balance.balance) < amountBigInt) {
        return {
          success: false,
          error: `Insufficient balance: have ${balance.balance}, need ${amount}`,
        };
      }

      // Create wallet client for gateway
      const account = privateKeyToAccount(this.privateKey);
      const walletClient = createWalletClient({
        account,
        chain: this.chain,
        transport: http(),
      });

      logger.info(
        { from: fromAddress, to: this.receiverAddress, amount },
        'Executing transferFrom'
      );

      // Execute transferFrom
      const txHash = await walletClient.writeContract({
        address: this.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'transferFrom',
        args: [fromAddress, this.receiverAddress, amountBigInt],
      });

      logger.info({ txHash, amount }, 'TransferFrom submitted');

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      if (receipt.status !== 'success') {
        return {
          success: false,
          txHash,
          error: 'Transaction failed on-chain',
        };
      }

      logger.info({ txHash, amount }, 'Payment pulled successfully');

      return {
        success: true,
        txHash,
      };
    } catch (error) {
      logger.error({ error, fromAddress, amount }, 'Failed to pull payment');
      return {
        success: false,
        error: `TransferFrom failed: ${error}`,
      };
    }
  }

  /**
   * Verify a payment was received (for manual payment verification)
   */
  async verifyPayment(
    txHash: `0x${string}`,
    expectedAmount: string,
    senderAddress?: string
  ): Promise<{
    verified: boolean;
    reason?: string;
    actualAmount?: string;
    sender?: string;
  }> {
    try {
      const publicClient = createPublicClient({
        chain: this.chain,
        transport: http(),
      });

      // Get transaction receipt
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

      if (!receipt) {
        return { verified: false, reason: 'Transaction not found' };
      }

      if (receipt.status !== 'success') {
        return { verified: false, reason: 'Transaction failed' };
      }

      // Parse transfer events
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const transferLogs = receipt.logs.filter(
        log =>
          log.address.toLowerCase() === this.usdcAddress.toLowerCase() &&
          log.topics[0] === transferTopic
      );

      if (transferLogs.length === 0) {
        return { verified: false, reason: 'No USDC transfer found in transaction' };
      }

      // Check if any transfer is to our receiver address
      for (const log of transferLogs) {
        const to = `0x${log.topics[2]?.slice(-40)}`.toLowerCase();
        if (to === this.receiverAddress.toLowerCase()) {
          const amount = BigInt(log.data);
          const sender = `0x${log.topics[1]?.slice(-40)}`;

          if (senderAddress && sender.toLowerCase() !== senderAddress.toLowerCase()) {
            continue; // Wrong sender
          }

          const expectedBigInt = BigInt(expectedAmount);
          if (amount >= expectedBigInt) {
            return {
              verified: true,
              actualAmount: amount.toString(),
              sender,
            };
          } else {
            return {
              verified: false,
              reason: `Insufficient amount: expected ${expectedAmount}, got ${amount.toString()}`,
              actualAmount: amount.toString(),
              sender,
            };
          }
        }
      }

      return { verified: false, reason: 'No transfer to receiver address found' };
    } catch (error) {
      logger.error({ error, txHash }, 'Payment verification failed');
      return { verified: false, reason: `Verification error: ${error}` };
    }
  }

  /**
   * Get USDC balance for an address
   */
  async getBalance(address: `0x${string}`): Promise<{
    balance: string;
    formatted: string;
  }> {
    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(),
    });

    const balance = await publicClient.readContract({
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    });

    return {
      balance: balance.toString(),
      formatted: formatUnits(balance, 6),
    };
  }

  /**
   * Get the receiver (gateway) address
   */
  getReceiverAddress(): `0x${string}` {
    return this.receiverAddress;
  }

  /**
   * Get the network
   */
  getNetwork(): string {
    return this.network;
  }

  /**
   * Format USDC amount for display
   */
  formatUsdc(amount: string): string {
    return `${formatUnits(BigInt(amount), 6)} USDC`;
  }

  /**
   * Parse USDC amount from string (e.g., "5.50" -> "5500000")
   */
  parseUsdc(amount: string): string {
    return parseUnits(amount, 6).toString();
  }
}

// Singleton instance
let paymentHandler: PaymentHandler | null = null;

export function getPaymentHandler(): PaymentHandler {
  if (!paymentHandler) {
    paymentHandler = new PaymentHandler();
  }
  return paymentHandler;
}
