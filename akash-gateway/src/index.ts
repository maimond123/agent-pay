import 'dotenv/config';
import { createApp } from './server/app.js';
import { initializeAkashClient } from './akash/client.js';
import { logger } from './server/logger.js';

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
  const port = parseInt(process.env.PORT || '3000');

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                          AKASH GATEWAY                                       ║
║             Pay for Decentralized Compute with USDC                          ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  This gateway enables AI agents to provision compute on Akash Network        ║
║  using USDC payments with token-based authentication.                        ║
║                                                                              ║
║  Auth Endpoints:                                                             ║
║  • POST /auth/register       - Register wallet, get auth token               ║
║  • POST /auth/verify         - Verify token, get wallet address              ║
║                                                                              ║
║  Compute Endpoints:                                                          ║
║  • POST /compute/quote       - Get pricing for compute specs                 ║
║  • POST /compute/quotes      - Get multi-provider quotes                     ║
║  • POST /compute/provision   - Deploy compute (requires auth token)          ║
║  • GET  /compute/:id/status  - Get deployment status                         ║
║                                                                              ║
║  LLM Endpoints:                                                              ║
║  • POST /llm/analyze         - Analyze task, recommend compute specs         ║
║  • POST /llm/select-provider - Select best provider from quotes              ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  // Initialize Akash client
  logger.info('Initializing Akash client...');
  try {
    await initializeAkashClient();
    logger.info('Akash client initialized');
  } catch (error) {
    logger.warn('Akash client initialization failed - running in mock mode');
  }

  // Create and start server
  const app = createApp();

  const server = app.listen(port, () => {
    logger.info({ port }, `Akash Gateway running on http://localhost:${port}`);
    console.log(`
┌──────────────────────────────────────────────────────────────────────────────┐
│  Server running on http://localhost:${port}                                     │
│                                                                              │
│  Network: ${(process.env.NETWORK || 'base-sepolia').padEnd(66)}│
│  Mode: ${(process.env.AKASH_MNEMONIC ? 'Production (Akash connected)' : 'Mock (no wallet configured)').padEnd(69)}│
└──────────────────────────────────────────────────────────────────────────────┘
`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.fatal(
        { port, error },
        `Port ${port} is already in use. Please stop the process using this port or set a different PORT environment variable.`
      );
      console.error(`\n❌ Error: Port ${port} is already in use.\n`);
      console.error(`   To fix this, either:`);
      console.error(`   1. Stop the process using port ${port}`);
      console.error(`   2. Set a different PORT: PORT=3001 npm start\n`);
    } else {
      logger.fatal({ error }, 'Server error');
    }
    process.exit(1);
  });
}

// Run
main().catch(error => {
  logger.fatal({ error }, 'Fatal error starting server');
  process.exit(1);
});
