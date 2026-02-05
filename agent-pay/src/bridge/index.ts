/**
 * Bridge Module
 *
 * Exports cross-chain bridging functionality.
 * Primary: Skip Go API (cheap: ~$0.02 fees)
 * Fallback: Squid Router (expensive: ~$50 fees)
 */

// Skip Go API - Primary bridge (cheap fees)
export {
  createSkipRoute,
  createSkipBridge,
  getSkipTransactions,
  getSkipTransactionStatus,
  trackSkipTransaction,
  waitForSkipBridgeCompletion,
  signAndBroadcastCosmosTx,
  CHAINS as SKIP_CHAINS,
  TOKENS as SKIP_TOKENS,
  type SkipBridgeParams,
  type SkipRoute,
  type SkipTransaction,
  type SkipBridgeResult,
  type SkipTransactionStatusResult,
  type SkipTransferDetail,
  type WaitForBridgeResult,
} from "./skip-client.js";

// Squid Router - Fallback (expensive but more routes)
export {
  createBridgeRoute,
  getBridgeStatus,
  waitForBridgeCompletion,
  getSupportedChains,
  getSupportedTokens,
  hasSquidIntegratorId,
  getSquidAppUrl,
  CHAINS,
  TOKENS,
  type BridgeParams,
  type BridgeRoute,
  type BridgeStatus,
} from "./squid-client.js";
