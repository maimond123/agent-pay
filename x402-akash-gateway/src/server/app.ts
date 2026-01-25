import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import computeRoutes from './routes/compute.js';
import { logger } from './logger.js';
import { getStats } from '../db/store.js';

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

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
