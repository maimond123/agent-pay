/**
 * Squid Router Client
 *
 * Handles cross-chain bridging from EVM chains (Base) to Cosmos chains (Akash).
 * Uses Squid Router SDK for optimal routing via Axelar/Osmosis.
 */

import { Squid } from "@0xsquid/sdk";

// Type definitions for Squid SDK responses
type RouteResponse = any;
type ChainData = any;
type TokenData = any;

// Chain identifiers
export const CHAINS = {
  BASE_MAINNET: "8453",
  BASE_SEPOLIA: "84532",
  AKASH_MAINNET: "akashnet-2",
} as const;

// Token addresses
export const TOKENS = {
  // USDC on Base Mainnet
  BASE_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // USDC on Base Sepolia (test)
  BASE_SEPOLIA_USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // Native AKT on Akash (Squid-supported destination token)
  AKASH_AKT: "uakt",
  // USDC on Osmosis (for two-step bridging via Osmosis)
  OSMOSIS_USDC: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
} as const;

export interface BridgeParams {
  fromAddress: string; // User's EVM address
  toAddress: string; // User's Cosmos address (Akash or Osmosis)
  amountUSDC: string; // Amount in USDC (human readable, e.g., "10.50")
  network?: "mainnet" | "testnet";
  destinationType?: "akt" | "osmosis-usdc"; // What to receive: AKT on Akash or USDC on Osmosis
}

export interface BridgeRoute {
  routeId: string;
  route: RouteResponse["route"];
  transactionRequest: {
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
  };
  approvalNeeded: boolean;
  approvalAddress?: string;
  estimatedTime: number; // seconds
  estimatedReceived: string;
  fees: {
    bridgeFee: string;
    gasFee: string;
  };
}

export interface BridgeStatus {
  status: "pending" | "in_progress" | "success" | "failed" | "partial_success";
  currentStep?: string;
  txHash?: string;
  error?: string;
}

let squidInstance: Squid | null = null;

// Squid integrator ID for agent-pay
const SQUID_INTEGRATOR_ID = process.env.SQUID_INTEGRATOR_ID || "agent-pay-653e5808-059f-4d7f-951e-1adea8f7b34a";

/**
 * Check if Squid integrator ID is configured
 */
export function hasSquidIntegratorId(): boolean {
  return !!SQUID_INTEGRATOR_ID;
}

/**
 * Get the Squid app URL for manual bridging
 */
export function getSquidAppUrl(params: {
  fromAddress?: string;
  toAddress: string;
  amount: string;
  network: "mainnet" | "testnet";
}): string {
  const baseUrl = "https://app.squidrouter.com";

  // Build query params for pre-filling the form
  const queryParams = new URLSearchParams({
    chains: "8453,akashnet-2", // Base to Akash
    tokens: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
  });

  return `${baseUrl}?${queryParams.toString()}`;
}

/**
 * Initialize the Squid SDK
 */
async function getSquid(network: "mainnet" | "testnet" = "mainnet"): Promise<Squid> {
  if (!SQUID_INTEGRATOR_ID) {
    throw new Error(
      "Squid integrator ID is not configured.\n\n" +
      "To enable programmatic bridging:\n" +
      "  1. Apply at: https://squidrouter.typeform.com/integrator-id\n" +
      "  2. Wait for approval (usually within 24 hours)\n" +
      "  3. Add your ID to src/bridge/squid-client.ts\n\n" +
      "Alternatively, bridge manually using Squid's web app:\n" +
      "  https://app.squidrouter.com"
    );
  }

  if (squidInstance) {
    return squidInstance;
  }

  const baseUrl =
    network === "mainnet"
      ? "https://v2.api.squidrouter.com"
      : "https://testnet.v2.api.squidrouter.com";

  squidInstance = new Squid({
    baseUrl,
    integratorId: SQUID_INTEGRATOR_ID,
  });

  await squidInstance.init();

  // Add delay after init to avoid rate limiting on subsequent requests
  await sleep(1000);

  return squidInstance;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if it's a rate limit error (429)
      const isRateLimit = error?.response?.status === 429 ||
                          error?.status === 429 ||
                          error?.message?.includes('429') ||
                          error?.message?.includes('Too many requests');

      if (isRateLimit && attempt < maxRetries) {
        // Get retry-after header or use exponential backoff
        const retryAfter = error?.response?.headers?.['retry-after'];
        const delayMs = retryAfter
          ? Math.ceil(parseFloat(retryAfter) * 1000) + 500 // Add 500ms buffer
          : initialDelayMs * Math.pow(2, attempt);

        console.log(`Rate limited, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delayMs);
        continue;
      }

      // For non-rate-limit errors or final attempt, throw
      throw error;
    }
  }

  throw lastError;
}

/**
 * Convert human-readable USDC amount to micro units (6 decimals)
 */
function toMicroUSDC(amount: string): string {
  const num = parseFloat(amount);
  return Math.floor(num * 1_000_000).toString();
}

/**
 * Convert micro USDC to human-readable amount
 */
function fromMicroUSDC(amount: string): string {
  const num = parseInt(amount, 10);
  return (num / 1_000_000).toFixed(6);
}

/**
 * Create a bridge route from Base to Cosmos (Akash or Osmosis)
 *
 * Supported destinations:
 * - "akt": Bridge USDC to AKT on Akash (single step, Squid-supported)
 * - "osmosis-usdc": Bridge USDC to Osmosis (then IBC to Akash manually)
 */
export async function createBridgeRoute(
  params: BridgeParams
): Promise<BridgeRoute> {
  const squid = await getSquid(params.network || "mainnet");

  const isMainnet = params.network !== "testnet";
  const fromChain = isMainnet ? CHAINS.BASE_MAINNET : CHAINS.BASE_SEPOLIA;
  const fromToken = isMainnet ? TOKENS.BASE_USDC : TOKENS.BASE_SEPOLIA_USDC;

  // Determine destination based on destinationType
  const destinationType = params.destinationType || "akt";

  let toChain: string;
  let toToken: string;

  if (destinationType === "osmosis-usdc") {
    // Bridge to USDC on Osmosis (user needs to IBC transfer to Akash afterward)
    toChain = "osmosis-1";
    toToken = TOKENS.OSMOSIS_USDC;
  } else {
    // Default: Bridge to AKT on Akash (single step, fully supported)
    toChain = CHAINS.AKASH_MAINNET;
    toToken = TOKENS.AKASH_AKT;
  }

  // Build route params
  const routeParams: any = {
    fromChain,
    fromToken,
    fromAmount: toMicroUSDC(params.amountUSDC),
    toChain,
    toToken,
    toAddress: params.toAddress,
    fromAddress: params.fromAddress,
    slippage: 1.0, // 1% slippage tolerance
    quoteOnly: false,
  };

  // Request route with retry logic for rate limiting
  const { route } = await withRetry(
    () => squid.getRoute(routeParams),
    3,  // max retries
    1500 // initial delay 1.5s
  );

  // Cast to any to handle SDK type variations
  const routeData = route as any;

  // Generate a unique route ID
  const routeId = `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Parse fees - Squid returns fees in different formats
  // feeCosts and gasCosts are arrays with objects containing amount and amountUsd
  const feeCosts = routeData.estimate?.feeCosts || [];
  const gasCosts = routeData.estimate?.gasCosts || [];

  // Sum up USD values for fees (more reliable than token amounts)
  const totalBridgeFeeUsd = feeCosts.reduce((sum: number, fee: any) => {
    return sum + (parseFloat(fee.amountUsd) || 0);
  }, 0);

  const totalGasFeeUsd = gasCosts.reduce((sum: number, fee: any) => {
    return sum + (parseFloat(fee.amountUsd) || 0);
  }, 0);

  // Parse received amount - this is in micro units (6 decimals) for AKT
  const toAmountRaw = routeData.estimate?.toAmount || "0";
  const toAmountFormatted = (parseInt(toAmountRaw, 10) / 1_000_000).toFixed(6);

  return {
    routeId,
    route,
    transactionRequest: {
      to: routeData.transactionRequest?.target || routeData.transactionRequest?.to || "",
      data: routeData.transactionRequest?.data || "",
      value: routeData.transactionRequest?.value || "0",
      gasLimit: routeData.transactionRequest?.gasLimit?.toString(),
    },
    approvalNeeded: !!routeData.estimate?.approvalAddress,
    approvalAddress: routeData.estimate?.approvalAddress,
    estimatedTime: routeData.estimate?.estimatedRouteDuration || 180,
    estimatedReceived: toAmountFormatted,
    fees: {
      bridgeFee: totalBridgeFeeUsd.toFixed(2),
      gasFee: totalGasFeeUsd.toFixed(2),
    },
  };
}

/**
 * Monitor the status of a bridge transaction
 */
export async function getBridgeStatus(
  txHash: string,
  routeId: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<BridgeStatus> {
  const squid = await getSquid(network);

  try {
    const status = await (squid as any).getStatus({
      transactionId: txHash,
      requestId: routeId,
      fromChainId: network === "mainnet" ? CHAINS.BASE_MAINNET : CHAINS.BASE_SEPOLIA,
      toChainId: CHAINS.AKASH_MAINNET,
    });

    // Map Squid status to our status
    const squidStatus = status.squidTransactionStatus;

    if (squidStatus === "success") {
      return { status: "success", txHash };
    } else if (squidStatus === "ongoing" || squidStatus === "partial_success") {
      return {
        status: "in_progress",
        currentStep: status.routeStatus?.[0]?.status || "Processing",
        txHash,
      };
    } else if (squidStatus === "not_found") {
      return { status: "pending", txHash };
    } else {
      return {
        status: "failed",
        error: status.error || "Unknown error",
        txHash,
      };
    }
  } catch (error: any) {
    return {
      status: "pending",
      error: error.message,
    };
  }
}

/**
 * Wait for bridge completion with polling
 */
export async function waitForBridgeCompletion(
  txHash: string,
  routeId: string,
  network: "mainnet" | "testnet" = "mainnet",
  timeoutMs: number = 300000, // 5 minutes default
  pollIntervalMs: number = 5000 // 5 seconds
): Promise<BridgeStatus> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await getBridgeStatus(txHash, routeId, network);

    if (status.status === "success" || status.status === "failed") {
      return status;
    }

    // Log progress
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(
      `\r  Bridging... ${status.currentStep || "Processing"} (${elapsed}s)`
    );

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    status: "pending",
    error: "Bridge timeout - transaction may still be processing",
  };
}

/**
 * Get supported chains from Squid
 */
export async function getSupportedChains(
  network: "mainnet" | "testnet" = "mainnet"
): Promise<ChainData[]> {
  const squid = await getSquid(network);
  return squid.chains;
}

/**
 * Get supported tokens from Squid
 */
export async function getSupportedTokens(
  network: "mainnet" | "testnet" = "mainnet"
): Promise<TokenData[]> {
  const squid = await getSquid(network);
  return squid.tokens;
}
