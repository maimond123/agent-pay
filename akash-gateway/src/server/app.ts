import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import computeRoutes from './routes/compute.js';
import llmRoutes from './routes/llm.js';
import authRoutes from './routes/auth.js';
import { logger } from './logger.js';
import { getStats } from '../db/store.js';
import { verifyToken } from '../db/tokens.js';

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

// Extend Express Request to include wallet info
declare global {
  namespace Express {
    interface Request {
      walletAddress?: string;
    }
  }
}

export function createApp() {
  const app = express();

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
  // TOKEN AUTH MIDDLEWARE (for protected routes)
  // ──────────────────────────────────────────────────────────────────────────

  const tokenAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Include Authorization: Bearer <token> header',
        setup: 'Run `npx @agent-pay/mcp setup` to get your token',
      });
    }

    const token = authHeader.slice(7);
    const result = verifyToken(token);

    if (!result.valid) {
      return res.status(401).json({
        error: 'Invalid token',
        message: result.error,
        setup: 'Run `npx @agent-pay/mcp setup` to get a new token',
      });
    }

    // Attach wallet address to request for use in route handlers
    req.walletAddress = result.walletAddress;
    next();
  };

  // ──────────────────────────────────────────────────────────────────────────
  // ROUTES
  // ──────────────────────────────────────────────────────────────────────────

  // Health check (public)
  app.get('/health', (req: Request, res: Response) => {
    const stats = getStats();
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      version: '2.0.0',
      stats,
    });
  });

  // API info (public)
  app.get('/', (req: Request, res: Response) => {
    res.json({
      name: 'Akash Gateway',
      version: '2.0.0',
      description: 'Pay for decentralized compute with USDC',
      endpoints: {
        // Public
        'GET /health': 'Health check',
        'POST /auth/register': 'Register wallet, get auth token',
        'POST /auth/verify': 'Verify token',
        'GET /auth/info': 'Get authenticated wallet info',
        // Protected (require auth token)
        'POST /compute/quote': 'Get pricing for compute specs',
        'POST /compute/quotes': 'Get multi-provider quotes',
        'POST /compute/provision': 'Deploy compute (auto-charges wallet)',
        'GET /compute/:id/status': 'Get deployment status',
        'GET /compute': 'List all deployments',
        'POST /llm/analyze': 'Analyze task, recommend compute specs',
        'POST /llm/select-provider': 'Select best provider from quotes',
      },
      authentication: {
        type: 'Bearer token',
        setup: 'Run `npx @agent-pay/mcp setup` to connect wallet and get token',
      },
      payment: {
        method: 'USDC via ERC-20 approve + transferFrom',
        network: process.env.NETWORK || 'base-sepolia',
        token: 'USDC',
        gatewayAddress: process.env.PAYMENT_RECEIVER_ADDRESS || '0x0000000000000000000000000000000000000000',
      },
    });
  });

  // Auth routes (public)
  app.use('/auth', authRoutes);

  // Compute routes (protected)
  app.use('/compute', tokenAuthMiddleware, computeRoutes);

  // LLM routes (protected)
  app.use('/llm', tokenAuthMiddleware, llmRoutes);

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
