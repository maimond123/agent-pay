import { Router, Request, Response, NextFunction } from 'express';
import { createChildLogger } from '../logger.js';
import { generateToken, verifyToken } from '../../db/tokens.js';
import { getPaymentHandler } from '../../wallet/payment.js';

const logger = createChildLogger('auth-routes');
const router = Router();

// ============================================================================
// AUTH ENDPOINTS
// ============================================================================

/**
 * POST /auth/register
 * Register a wallet address and get an auth token
 *
 * Body: { walletAddress: string }
 * Returns: { token: string, walletAddress: string }
 */
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({
        error: 'Missing walletAddress',
        message: 'walletAddress is required in request body',
      });
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        error: 'Invalid wallet address',
        message: 'walletAddress must be a valid Ethereum address (0x...)',
      });
    }

    logger.info({ wallet: walletAddress }, 'Registering wallet');

    // Generate token
    const token = generateToken(walletAddress);

    // Get wallet balance for info
    const paymentHandler = getPaymentHandler();
    let balance = { balance: '0', formatted: '0' };
    try {
      balance = await paymentHandler.getBalance(walletAddress as `0x${string}`);
    } catch (error) {
      logger.warn({ error, wallet: walletAddress }, 'Failed to fetch balance');
    }

    // Check allowance for gateway
    let allowance = '0';
    try {
      allowance = await paymentHandler.getAllowance(walletAddress as `0x${string}`);
    } catch (error) {
      logger.warn({ error, wallet: walletAddress }, 'Failed to fetch allowance');
    }

    return res.json({
      token,
      walletAddress: walletAddress.toLowerCase(),
      balance: {
        usdc: balance.formatted,
        raw: balance.balance,
      },
      allowance: {
        usdc: (parseInt(allowance) / 1_000_000).toFixed(2),
        raw: allowance,
      },
      message: 'Registration successful. Include this token in Authorization header for all requests.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/verify
 * Verify a token and return wallet info
 *
 * Body: { token: string } OR Authorization header
 * Returns: { valid: boolean, walletAddress?: string, error?: string }
 */
router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get token from body or header
    let token = req.body.token;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }

    if (!token) {
      return res.status(400).json({
        error: 'Missing token',
        message: 'Provide token in body or Authorization header',
      });
    }

    const result = verifyToken(token);

    if (!result.valid) {
      return res.status(401).json({
        valid: false,
        error: result.error,
      });
    }

    // Get wallet balance and allowance
    const paymentHandler = getPaymentHandler();
    let balance = { balance: '0', formatted: '0' };
    let allowance = '0';

    try {
      balance = await paymentHandler.getBalance(result.walletAddress as `0x${string}`);
      allowance = await paymentHandler.getAllowance(result.walletAddress as `0x${string}`);
    } catch (error) {
      logger.warn({ error }, 'Failed to fetch wallet info');
    }

    return res.json({
      valid: true,
      walletAddress: result.walletAddress,
      balance: {
        usdc: balance.formatted,
        raw: balance.balance,
      },
      allowance: {
        usdc: (parseInt(allowance) / 1_000_000).toFixed(2),
        raw: allowance,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /auth/info
 * Get info about the current authenticated wallet
 * Requires Authorization header
 */
router.get('/info', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Include Authorization: Bearer <token> header',
      });
    }

    const token = authHeader.slice(7);
    const result = verifyToken(token);

    if (!result.valid) {
      return res.status(401).json({
        error: 'Invalid token',
        message: result.error,
      });
    }

    const paymentHandler = getPaymentHandler();
    const balance = await paymentHandler.getBalance(result.walletAddress as `0x${string}`);
    const allowance = await paymentHandler.getAllowance(result.walletAddress as `0x${string}`);

    return res.json({
      walletAddress: result.walletAddress,
      balance: {
        usdc: balance.formatted,
        raw: balance.balance,
      },
      allowance: {
        usdc: (parseInt(allowance) / 1_000_000).toFixed(2),
        raw: allowance,
        sufficient: parseInt(allowance) > 0,
      },
      network: process.env.NETWORK || 'base-sepolia',
      gatewayAddress: process.env.PAYMENT_RECEIVER_ADDRESS,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
