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

// ERC20 ABI (minimal for balance checking and approval verification)
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
] as const;

// ============================================================================
// PAYMENT HANDLER
// ============================================================================

export class PaymentHandler {
  private readonly network: string;
  private readonly chain: typeof baseSepolia | typeof base;
  private readonly usdcAddress: `0x${string}`;
  private readonly receiverAddress: `0x${string}`;

  constructor() {
    this.network = process.env.X402_NETWORK || 'base-sepolia';
    this.chain = CHAINS[this.network] || baseSepolia;
    this.usdcAddress = USDC_ADDRESSES[this.network] || USDC_ADDRESSES['base-sepolia'];
    this.receiverAddress = (process.env.PAYMENT_RECEIVER_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`;
  }

  /**
   * Get payment configuration for x402
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
   * Verify a payment was received
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
