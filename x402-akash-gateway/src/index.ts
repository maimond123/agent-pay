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
║  Compute Endpoints:                                                          ║
║  • POST /compute/quote        - Get pricing for compute specs                ║
║  • POST /compute/quotes       - Get multi-provider quotes (CRE compatible)   ║
║  • POST /compute/provision    - Deploy compute (requires payment)            ║
║  • GET  /compute/:id/status   - Get deployment status                        ║
║                                                                              ║
║  LLM Endpoints (for CRE workflow):                                           ║
║  • POST /llm/analyze          - Analyze task, recommend compute specs        ║
║  • POST /llm/select-provider  - Select best provider from quotes             ║
║                                                                              ║
║  Payment Endpoints (x402):                                                   ║
║  • POST /x402/pay             - Process USDC payment                         ║
║  • POST /x402/verify          - Verify payment transaction                   ║
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
