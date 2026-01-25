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
║                        x402 AKASH GATEWAY                                    ║
║             Pay for Decentralized Compute with USDC                          ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  This gateway enables AI agents to provision compute on Akash Network        ║
║  using USDC payments via the x402 protocol.                                  ║
║                                                                              ║
║  API Endpoints:                                                              ║
║  • POST /compute/quote        - Get pricing for compute specs                ║
║  • POST /compute/provision    - Deploy compute (requires x402 payment)       ║
║  • GET  /compute/:id/status   - Get deployment status                        ║
║  • GET  /compute              - List all deployments                         ║
║  • GET  /compute/stats        - Gateway statistics                           ║
║                                                                              ║
║  Payment Flow:                                                               ║
║  1. Request a quote with desired specs                                       ║
║  2. Send USDC to the recipient address                                       ║
║  3. Call provision with quote ID and payment tx hash                         ║
║  4. Poll status endpoint until deployment is running                         ║
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

  app.listen(port, () => {
    logger.info({ port }, `x402 Akash Gateway running on http://localhost:${port}`);
    console.log(`
┌──────────────────────────────────────────────────────────────────────────────┐
│  Server running on http://localhost:${port}                                     │
│                                                                              │
│  Network: ${(process.env.X402_NETWORK || 'base-sepolia').padEnd(66)}│
│  Mode: ${(process.env.AKASH_MNEMONIC ? 'Production (Akash connected)' : 'Mock (no wallet configured)').padEnd(69)}│
└──────────────────────────────────────────────────────────────────────────────┘
`);
  });
}

// Run
main().catch(error => {
  logger.fatal({ error }, 'Fatal error starting server');
  process.exit(1);
});
