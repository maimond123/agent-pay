import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import computeRoutes from './routes/compute.js';
import llmRoutes from './routes/llm.js';
import paymentRoutes from './routes/payment.js';
import { logger } from './logger.js';
import { getStats, getQuote, isQuoteValid } from '../db/store.js';

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

export function createApp() {
  const app = express();

  // ──────────────────────────────────────────────────────────────────────────
  // X402 PAYMENT MIDDLEWARE SETUP
  // ──────────────────────────────────────────────────────────────────────────

  const paymentReceiverAddress = process.env.PAYMENT_RECEIVER_ADDRESS || '0x0000000000000000000000000000000000000000';
  const x402Network = process.env.X402_NETWORK || 'base-sepolia';
  const chainId = x402Network === 'base' ? 'eip155:8453' : 'eip155:84532'; // Base mainnet or Sepolia

  // Initialize x402 resource server
  let x402Server: x402ResourceServer | null = null;

  try {
    const facilitatorClient = new HTTPFacilitatorClient({
      url: process.env.X402_FACILITATOR_URL || 'https://facilitator.x402.org'
    });
    x402Server = new x402ResourceServer(facilitatorClient)
      .register(chainId, new ExactEvmScheme());
    logger.info({ chainId }, 'x402 resource server initialized');
  } catch (error) {
    logger.warn({ error }, 'x402 middleware initialization failed - running without payment protection');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MIDDLEWARE
  // ──────────────────────────────────────────────────────────────────────────

  // CORS
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-402-Receipt',
      'X-Payment-TxHash',
      'X-Payment-Proof',
    ],
  }));

  // JSON parsing
  app.use(express.json());

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
      }, 'Request completed');
    });
    next();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // X402 PAYMENT MIDDLEWARE (for provision endpoint)
  // ──────────────────────────────────────────────────────────────────────────

  // Dynamic pricing middleware - extracts price from quote
  if (x402Server && process.env.ENABLE_X402_MIDDLEWARE === 'true') {
    logger.info('x402 payment middleware enabled for /compute/provision');

    // Note: x402 middleware with dynamic pricing requires custom implementation
    // For now, we use manual payment verification in the route handler
    // Full x402 middleware would look like:
    // app.use(paymentMiddleware({
    //   'POST /compute/provision': {
    //     accepts: { scheme: 'exact', network: chainId, payTo: paymentReceiverAddress },
    //     getPricing: async (req) => {
    //       const quoteId = req.body?.quoteId;
    //       const quote = getQuote(quoteId);
    //       return quote ? { price: `$${(parseInt(quote.pricing.totalUsdc) / 1_000_000).toFixed(2)}` } : null;
    //     },
    //   },
    // }, x402Server));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ROUTES
  // ──────────────────────────────────────────────────────────────────────────

  // Health check
  app.get('/health', (req: Request, res: Response) => {
    const stats = getStats();
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      version: '1.0.0',
      stats,
    });
  });

  // API info
  app.get('/', (req: Request, res: Response) => {
    res.json({
      name: 'x402 Akash Gateway',
      version: '1.0.0',
      description: 'Pay for decentralized compute with USDC via x402 protocol',
      endpoints: {
        'POST /compute/quote': 'Get pricing for compute specs',
        'POST /compute/provision': 'Deploy compute (requires payment)',
        'GET /compute/:id/status': 'Get deployment status',
        'GET /compute': 'List all deployments',
        'GET /compute/stats': 'Get gateway statistics',
        'GET /health': 'Health check',
      },
      payment: {
        protocol: 'x402',
        network: process.env.X402_NETWORK || 'base-sepolia',
        token: 'USDC',
      },
    });
  });

  // Compute routes
  app.use('/compute', computeRoutes);

  // LLM routes (for CRE workflow compatibility)
  app.use('/llm', llmRoutes);

  // Payment routes (x402)
  app.use('/x402', paymentRoutes);

  // ──────────────────────────────────────────────────────────────────────────
  // ERROR HANDLING
  // ──────────────────────────────────────────────────────────────────────────

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      path: req.path,
      method: req.method,
    });
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error({
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    }, 'Request error');

    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  });

  return app;
}
