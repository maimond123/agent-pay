/**
 * Squid Router Client
 *
 * Handles cross-chain bridging from EVM chains (Base) to Cosmos chains (Akash).
 * Uses Squid Router SDK for optimal routing via Axelar/Osmosis.
 */

import { Squid } from "@0xsquid/sdk";
import type { RouteResponse, ChainData, TokenData } from "@0xsquid/sdk";

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
  // axlUSDC IBC denom on Akash
  AKASH_AXLUSDC:
    "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
  // Native AKT
  AKASH_AKT: "uakt",
} as const;

export interface BridgeParams {
  fromAddress: string; // User's EVM address
  toAddress: string; // User's Akash address
  amountUSDC: string; // Amount in USDC (human readable, e.g., "10.50")
  network?: "mainnet" | "testnet";
  includeGasSwap?: boolean; // Also swap a small amount to AKT for gas
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

/**
 * Initialize the Squid SDK
 */
async function getSquid(network: "mainnet" | "testnet" = "mainnet"): Promise<Squid> {
  if (squidInstance) {
    return squidInstance;
  }

  const baseUrl =
    network === "mainnet"
      ? "https://v2.api.squidrouter.com"
      : "https://testnet.v2.api.squidrouter.com";

  squidInstance = new Squid({
    baseUrl,
    integratorId: process.env.SQUID_INTEGRATOR_ID || "agent-pay-default",
  });

  await squidInstance.init();
  return squidInstance;
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
 * Create a bridge route from Base to Akash
 */
export async function createBridgeRoute(
  params: BridgeParams
): Promise<BridgeRoute> {
  const squid = await getSquid(params.network || "mainnet");

  const isMainnet = params.network !== "testnet";
  const fromChain = isMainnet ? CHAINS.BASE_MAINNET : CHAINS.BASE_SEPOLIA;
  const fromToken = isMainnet ? TOKENS.BASE_USDC : TOKENS.BASE_SEPOLIA_USDC;

  // Build route params
  const routeParams: any = {
    fromChain,
    fromToken,
    fromAmount: toMicroUSDC(params.amountUSDC),
    toChain: CHAINS.AKASH_MAINNET,
    toToken: TOKENS.AKASH_AXLUSDC,
    toAddress: params.toAddress,
    fromAddress: params.fromAddress,
    slippage: 1.0, // 1% slippage tolerance
    quoteOnly: false,
  };

  // Optionally include a small swap to AKT for gas
  if (params.includeGasSwap) {
    routeParams.postHooks = [
      {
        chainType: "cosmos",
        calls: [
          {
            callType: "swap",
            target: "osmosis",
            inputToken: TOKENS.AKASH_AXLUSDC,
            outputToken: TOKENS.AKASH_AKT,
            amount: "100000", // ~$0.10 worth for gas
          },
        ],
      },
    ];
  }

  const { route } = await squid.getRoute(routeParams);

  // Generate a unique route ID
  const routeId = `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    routeId,
    route,
    transactionRequest: {
      to: route.transactionRequest?.target || "",
      data: route.transactionRequest?.data || "",
      value: route.transactionRequest?.value || "0",
      gasLimit: route.transactionRequest?.gasLimit?.toString(),
    },
    approvalNeeded: !!route.estimate.approvalAddress,
    approvalAddress: route.estimate.approvalAddress,
    estimatedTime: route.estimate.estimatedRouteDuration || 180,
    estimatedReceived: fromMicroUSDC(route.estimate.toAmount),
    fees: {
      bridgeFee: fromMicroUSDC(route.estimate.feeCosts?.[0]?.amount || "0"),
      gasFee: fromMicroUSDC(route.estimate.gasCosts?.[0]?.amount || "0"),
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
    const status = await squid.getStatus({
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
