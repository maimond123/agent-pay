import { Router, Request, Response, NextFunction } from 'express';
import { createChildLogger } from '../logger.js';
import { getPaymentHandler } from '../../wallet/payment.js';

const logger = createChildLogger('payment-routes');
const router = Router();

// In-memory payment storage for simulation
const payments = new Map<string, any>();

// ============================================================================
// X402 PAYMENT ENDPOINTS
// ============================================================================

// POST /x402/pay - Process payment (simulation/mock)
router.post('/pay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { quoteId, amount, recipient, memo, currency, network } = req.body;

    logger.info({ quoteId, amount, recipient, network }, 'Payment request received');

    // Generate simulated transaction hash
    const timestamp = Date.now();
    const txHash = `0x${Buffer.from(timestamp.toString()).toString('hex').padStart(64, '0')}`;

    const payment = {
      txHash,
      amount: amount || '0',
      recipient: recipient || process.env.PAYMENT_RECEIVER_ADDRESS,
      memo: memo || '',
      currency: currency || 'USDC',
      network: network || process.env.X402_NETWORK || 'base-sepolia',
      timestamp,
      status: 'confirmed',
      blockNumber: Math.floor(timestamp / 1000),
    };

    payments.set(txHash, payment);

    logger.info({ txHash, amount: payment.amount, network: payment.network }, 'Payment confirmed (simulated)');

    return res.json(payment);
  } catch (error) {
    next(error);
  }
});

// POST /x402/verify - Verify a payment transaction
router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { txHash, expectedAmount } = req.body;

    logger.info({ txHash, expectedAmount }, 'Payment verification request');

    // Check in-memory first (for simulated payments)
    if (payments.has(txHash)) {
      const payment = payments.get(txHash);
      return res.json({
        verified: true,
        payment,
      });
    }

    // Try to verify on-chain
    const paymentHandler = getPaymentHandler();
    const verification = await paymentHandler.verifyPayment(
      txHash as `0x${string}`,
      expectedAmount || '0'
    );

    return res.json({
      verified: verification.verified,
      reason: verification.reason,
      actualAmount: verification.actualAmount,
      sender: verification.sender,
    });
  } catch (error) {
    next(error);
  }
});

// GET /x402/balance/:address - Get USDC balance for an address
router.get('/balance/:address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params;

    const paymentHandler = getPaymentHandler();
    const balance = await paymentHandler.getBalance(address as `0x${string}`);

    return res.json(balance);
  } catch (error) {
    next(error);
  }
});

// GET /x402/payments - List all simulated payments (debug)
router.get('/payments', async (req: Request, res: Response) => {
  return res.json(Array.from(payments.values()));
});

export default router;
