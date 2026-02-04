/**
 * Bridge Module
 *
 * Exports cross-chain bridging functionality.
 */

export {
  createBridgeRoute,
  getBridgeStatus,
  waitForBridgeCompletion,
  getSupportedChains,
  getSupportedTokens,
  CHAINS,
  TOKENS,
  type BridgeParams,
  type BridgeRoute,
  type BridgeStatus,
} from "./squid-client.js";
