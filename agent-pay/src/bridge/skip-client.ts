/**
 * Skip Go API Client
 *
 * Handles cross-chain bridging from EVM chains (Base) to Cosmos chains (Akash).
 * Uses Skip Go API with Noble CCTP + IBC for minimal fees (~$0.02 vs $50+ with other bridges).
 *
 * Route: Base USDC -> CCTP -> Noble USDC -> IBC -> Osmosis -> Akash
 */

import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { SigningStargateClient, GasPrice } from "@cosmjs/stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";

// Chain identifiers
export const CHAINS = {
  BASE_MAINNET: "8453",
  NOBLE: "noble-1",
  OSMOSIS: "osmosis-1",
  AKASH_MAINNET: "akashnet-2",
} as const;

// Token addresses/denoms
export const TOKENS = {
  // USDC on Base Mainnet
  BASE_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // Native USDC on Noble
  NOBLE_USDC: "uusdc",
  // USDC on Akash (IBC from Noble via Cosmos Hub)
  AKASH_USDC: "ibc/140A34459BD0720DDF3B13E7B7C8B3667744CD49ED79E018578EF87E8CB203C5",
  // Native AKT
  AKASH_AKT: "uakt",
} as const;

export interface SkipBridgeParams {
  fromAddress: string; // User's EVM address (Base)
  toAddress: string; // User's Akash address
  amountUSDC: string; // Amount in USDC (human readable, e.g., "10.50")
  destinationType?: "usdc" | "akt"; // What to receive on Akash
  slippagePercent?: string; // Slippage tolerance (default: "3")
}

export interface SkipRoute {
  routeId: string;
  amountIn: string;
  amountOut: string;
  estimatedAmountOut: string;
  usdIn: string;
  usdOut: string;
  estimatedDurationSeconds: number;
  txsRequired: number;
  chainPath: string[];
  operations: any[];
  fees: {
    totalUsd: string;
    details: Array<{
      type: string;
      amount: string;
      usdAmount: string;
    }>;
  };
  requiredChainAddresses: string[];
}

export interface SkipTransaction {
  chainId: string;
  txType: "evm" | "cosmos";
  evmTx?: {
    to: string;
    data: string;
    value: string;
    chainId: string;
    gasLimit?: string;
  };
  cosmosTx?: {
    msgs: any[];
    chainId: string;
  };
}

export interface SkipBridgeResult {
  route: SkipRoute;
  transactions: SkipTransaction[];
}

const SKIP_API_BASE = "https://api.skip.build";

// Debug logging — set SKIP_DEBUG=1 to enable verbose API logging
const DEBUG = process.env.SKIP_DEBUG === "1";

function debugLog(label: string, ...args: any[]) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  console.log(`\n[SKIP DEBUG ${timestamp}] ${label}`);
  for (const arg of args) {
    if (typeof arg === "string") {
      console.log(`  ${arg}`);
    } else {
      console.log(`  ${JSON.stringify(arg, null, 2)}`);
    }
  }
}

async function logResponse(label: string, response: Response): Promise<string> {
  const bodyText = await response.text();
  debugLog(
    `${label} — Response`,
    `Status: ${response.status} ${response.statusText}`,
    `Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`,
    `Body: ${bodyText.length > 2000 ? bodyText.slice(0, 2000) + "... (truncated)" : bodyText}`
  );
  return bodyText;
}

// Noble RPC endpoints for signing IBC transfers (phase 2 of bridge)
const NOBLE_RPC_ENDPOINTS = [
  "https://noble-rpc.polkachu.com:443",
  "https://rpc-noble.cosmos-spaces.cloud:443",
  "https://noble-rpc.owlstake.com:443",
];

// Map chain IDs to their bech32 address prefixes
const CHAIN_PREFIXES: Record<string, string> = {
  "akashnet-2": "akash",
  "noble-1": "noble",
  "osmosis-1": "osmo",
  "cosmoshub-4": "cosmos",
};

/**
 * Convert a Cosmos address from one chain prefix to another
 * Properly handles bech32 encoding/decoding with correct checksums
 */
function convertCosmosAddress(address: string, targetChainId: string): string {
  const targetPrefix = CHAIN_PREFIXES[targetChainId];
  if (!targetPrefix) {
    // Unknown chain, return original address
    return address;
  }

  try {
    // Decode the address to get the raw bytes
    const { data } = fromBech32(address);
    // Re-encode with the new prefix (this creates a valid checksum)
    return toBech32(targetPrefix, data);
  } catch (error) {
    // If decoding fails, return original address
    console.warn(`Failed to convert address ${address} to ${targetChainId}:`, error);
    return address;
  }
}

/**
 * Convert human-readable USDC amount to micro units (6 decimals)
 */
function toMicroUSDC(amount: string): string {
  const num = parseFloat(amount);
  return Math.floor(num * 1_000_000).toString();
}

/**
 * Get the destination token denom based on type
 */
function getDestToken(destinationType: "usdc" | "akt"): string {
  return destinationType === "usdc" ? TOKENS.AKASH_USDC : TOKENS.AKASH_AKT;
}

/**
 * Create a bridge route from Base to Akash using Skip Go API
 */
export async function createSkipRoute(
  params: SkipBridgeParams
): Promise<SkipRoute> {
  const destToken = getDestToken(params.destinationType || "akt");

  const requestBody = {
    source_asset_denom: TOKENS.BASE_USDC,
    source_asset_chain_id: CHAINS.BASE_MAINNET,
    dest_asset_denom: destToken,
    dest_asset_chain_id: CHAINS.AKASH_MAINNET,
    amount_in: toMicroUSDC(params.amountUSDC),
    allow_unsafe: true,
    allow_multi_tx: true, // Required for EVM -> Cosmos routes
    smart_relay: true, // Use Skip's relay service
  };

  debugLog("createSkipRoute — Request", `POST ${SKIP_API_BASE}/v2/fungible/route`, requestBody);

  const response = await fetch(`${SKIP_API_BASE}/v2/fungible/route`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const rawBody = await logResponse("createSkipRoute", response);

  if (!response.ok) {
    let error: any = {};
    try { error = JSON.parse(rawBody); } catch {}
    throw new Error(`Skip API error: ${error.message || response.statusText}`);
  }

  const data = JSON.parse(rawBody);

  // Parse fees
  const fees = data.estimated_fees || [];
  const totalFeeUsd = fees.reduce(
    (sum: number, f: any) => sum + parseFloat(f.usd_amount || "0"),
    0
  );

  return {
    routeId: `skip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    amountIn: data.amount_in,
    amountOut: data.amount_out,
    estimatedAmountOut: data.estimated_amount_out,
    usdIn: data.usd_amount_in,
    usdOut: data.usd_amount_out,
    estimatedDurationSeconds: data.estimated_route_duration_seconds,
    txsRequired: data.txs_required,
    chainPath: data.chain_ids || [],
    operations: data.operations || [],
    fees: {
      totalUsd: totalFeeUsd.toFixed(4),
      details: fees.map((f: any) => ({
        type: f.fee_type,
        amount: f.amount,
        usdAmount: f.usd_amount,
      })),
    },
    requiredChainAddresses: data.required_chain_addresses || [],
  };
}

/**
 * Get transaction messages for executing the bridge
 */
export async function getSkipTransactions(
  params: SkipBridgeParams,
  route: SkipRoute
): Promise<SkipBridgeResult> {
  const destToken = getDestToken(params.destinationType || "akt");

  // Build address map for all chains in the route
  const chainIdsToAddresses: Record<string, string> = {};

  for (const chainId of route.chainPath) {
    if (chainId === CHAINS.BASE_MAINNET) {
      // EVM chains use the EVM address
      chainIdsToAddresses[chainId] = params.fromAddress;
    } else {
      // Cosmos chains: convert the Akash address to the appropriate prefix
      chainIdsToAddresses[chainId] = convertCosmosAddress(params.toAddress, chainId);
    }
  }

  const requestBody = {
    source_asset_denom: TOKENS.BASE_USDC,
    source_asset_chain_id: CHAINS.BASE_MAINNET,
    dest_asset_denom: destToken,
    dest_asset_chain_id: CHAINS.AKASH_MAINNET,
    amount_in: route.amountIn,
    amount_out: route.amountOut,
    chain_ids_to_addresses: chainIdsToAddresses,
    slippage_tolerance_percent: params.slippagePercent || "3",
    operations: route.operations,
  };

  debugLog("getSkipTransactions — Request", `POST ${SKIP_API_BASE}/v2/fungible/msgs`, requestBody);

  const response = await fetch(`${SKIP_API_BASE}/v2/fungible/msgs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const rawBody = await logResponse("getSkipTransactions", response);

  if (!response.ok) {
    let error: any = {};
    try { error = JSON.parse(rawBody); } catch {}
    throw new Error(`Skip API error: ${error.message || response.statusText}`);
  }

  const data = JSON.parse(rawBody);

  // Parse transactions
  const transactions: SkipTransaction[] = (data.txs || []).map((tx: any) => {
    if (tx.evm_tx) {
      return {
        chainId: tx.evm_tx.chain_id,
        txType: "evm" as const,
        evmTx: {
          to: tx.evm_tx.to,
          data: tx.evm_tx.data,
          value: tx.evm_tx.value || "0",
          chainId: tx.evm_tx.chain_id,
          gasLimit: tx.evm_tx.gas_limit,
        },
      };
    } else if (tx.cosmos_tx) {
      return {
        chainId: tx.cosmos_tx.chain_id,
        txType: "cosmos" as const,
        cosmosTx: {
          msgs: tx.cosmos_tx.msgs,
          chainId: tx.cosmos_tx.chain_id,
        },
      };
    }
    return null;
  }).filter(Boolean);

  return {
    route,
    transactions,
  };
}

/**
 * Get route and transactions in one call using msgs_direct
 */
export async function createSkipBridge(
  params: SkipBridgeParams
): Promise<SkipBridgeResult> {
  const destToken = getDestToken(params.destinationType || "akt");

  // First get the route to know which chains we need addresses for
  const route = await createSkipRoute(params);

  // Build address map
  const chainIdsToAddresses: Record<string, string> = {};

  for (const chainId of route.chainPath) {
    if (chainId === CHAINS.BASE_MAINNET) {
      // EVM chains use the EVM address
      chainIdsToAddresses[chainId] = params.fromAddress;
    } else {
      // Cosmos chains: convert the Akash address to the appropriate prefix
      chainIdsToAddresses[chainId] = convertCosmosAddress(params.toAddress, chainId);
    }
  }

  const requestBody = {
    source_asset_denom: TOKENS.BASE_USDC,
    source_asset_chain_id: CHAINS.BASE_MAINNET,
    dest_asset_denom: destToken,
    dest_asset_chain_id: CHAINS.AKASH_MAINNET,
    amount_in: toMicroUSDC(params.amountUSDC),
    chain_ids_to_addresses: chainIdsToAddresses,
    slippage_tolerance_percent: params.slippagePercent || "3",
    allow_unsafe: true,
    allow_multi_tx: true,
    smart_relay: true,
  };

  debugLog("createSkipBridge — Request", `POST ${SKIP_API_BASE}/v2/fungible/msgs_direct`, requestBody);

  const response = await fetch(`${SKIP_API_BASE}/v2/fungible/msgs_direct`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const rawBody = await logResponse("createSkipBridge", response);

  if (!response.ok) {
    let error: any = {};
    try { error = JSON.parse(rawBody); } catch {}
    throw new Error(`Skip API error: ${error.message || response.statusText}`);
  }

  const data = JSON.parse(rawBody);

  // Parse route info
  const fees = data.route?.estimated_fees || [];
  const totalFeeUsd = fees.reduce(
    (sum: number, f: any) => sum + parseFloat(f.usd_amount || "0"),
    0
  );

  const routeInfo: SkipRoute = {
    routeId: `skip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    amountIn: data.route?.amount_in || toMicroUSDC(params.amountUSDC),
    amountOut: data.route?.amount_out || "0",
    estimatedAmountOut: data.route?.estimated_amount_out || "0",
    usdIn: data.route?.usd_amount_in || params.amountUSDC,
    usdOut: data.route?.usd_amount_out || "0",
    estimatedDurationSeconds: data.route?.estimated_route_duration_seconds || 1200,
    txsRequired: data.route?.txs_required || data.txs?.length || 1,
    chainPath: data.route?.chain_ids || [],
    operations: data.route?.operations || [],
    fees: {
      totalUsd: totalFeeUsd.toFixed(4),
      details: fees.map((f: any) => ({
        type: f.fee_type,
        amount: f.amount,
        usdAmount: f.usd_amount,
      })),
    },
    requiredChainAddresses: data.route?.required_chain_addresses || [],
  };

  // Parse transactions
  const transactions: SkipTransaction[] = (data.txs || []).map((tx: any) => {
    if (tx.evm_tx) {
      return {
        chainId: tx.evm_tx.chain_id,
        txType: "evm" as const,
        evmTx: {
          to: tx.evm_tx.to,
          data: tx.evm_tx.data,
          value: tx.evm_tx.value || "0",
          chainId: tx.evm_tx.chain_id,
          gasLimit: tx.evm_tx.gas_limit,
        },
      };
    } else if (tx.cosmos_tx) {
      return {
        chainId: tx.cosmos_tx.chain_id,
        txType: "cosmos" as const,
        cosmosTx: {
          msgs: tx.cosmos_tx.msgs,
          chainId: tx.cosmos_tx.chain_id,
        },
      };
    }
    return null;
  }).filter(Boolean);

  return {
    route: routeInfo,
    transactions,
  };
}

/**
 * Register a transaction with Skip's Smart Relay for tracking.
 * This MUST be called after broadcasting the EVM tx, otherwise
 * Skip's relay infrastructure won't know about the tx and will
 * never relay the IBC packets on subsequent hops.
 */
export async function trackSkipTransaction(
  txHash: string,
  chainId: string,
  options?: {
    maxRetries?: number;
    initialDelayMs?: number;
  }
): Promise<{ txHash: string; explorerLink: string }> {
  const maxRetries = options?.maxRetries ?? 5;
  const initialDelayMs = options?.initialDelayMs ?? 5000;

  const requestBody = {
    tx_hash: txHash,
    chain_id: chainId,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Wait before each attempt so the tx has time to be indexed on-chain
    const delayMs = attempt === 1 ? initialDelayMs : 5000;
    debugLog(
      `trackSkipTransaction — Attempt ${attempt}/${maxRetries}`,
      `Waiting ${delayMs}ms for tx indexing...`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    debugLog("trackSkipTransaction — Request", `POST ${SKIP_API_BASE}/v2/tx/track`, requestBody);

    const response = await fetch(`${SKIP_API_BASE}/v2/tx/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const rawBody = await logResponse("trackSkipTransaction", response);

    if (response.ok) {
      const data = JSON.parse(rawBody);
      debugLog("trackSkipTransaction — Parsed response", data);
      return {
        txHash,
        explorerLink: data.explorer_link || `https://ibc.fun/tx/${txHash}`,
      };
    }

    // Parse the error
    let error: any = {};
    try { error = JSON.parse(rawBody); } catch {}
    const errorMsg = error.message || error.code || response.statusText;

    // If 404 "not found", the tx isn't indexed yet — retry
    if (response.status === 404 && attempt < maxRetries) {
      debugLog(
        `trackSkipTransaction — tx not found yet (attempt ${attempt}/${maxRetries}), will retry...`
      );
      process.stdout.write(
        `  Waiting for tx to be indexed on-chain (attempt ${attempt}/${maxRetries})...\n`
      );
      continue;
    }

    throw new Error(
      `Failed to register tx with Skip relay: ${errorMsg} (HTTP ${response.status})`
    );
  }

  // Should not be reached, but just in case
  throw new Error("Failed to register tx with Skip relay: max retries exceeded");
}

export interface SkipTransferDetail {
  hopIndex: number;
  fromChain: string;
  toChain: string;
  state: string;
}

export interface SkipTransactionStatusResult {
  status: "pending" | "success" | "failed" | "abandoned";
  state: string;
  transferDetails: SkipTransferDetail[];
  assetRelease?: {
    chainId: string;
    denom: string;
  };
}

/**
 * Track the status of a Skip bridge transaction
 */
export async function getSkipTransactionStatus(
  txHash: string,
  chainId: string
): Promise<SkipTransactionStatusResult> {
  const url = `${SKIP_API_BASE}/v2/tx/status?tx_hash=${txHash}&chain_id=${chainId}`;
  debugLog("getSkipTransactionStatus — Request", `GET ${url}`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const rawBody = await logResponse("getSkipTransactionStatus", response);

  if (!response.ok) {
    debugLog("getSkipTransactionStatus — Non-OK response, treating as pending", `HTTP ${response.status}`);
    return {
      status: "pending",
      state: "STATE_PENDING",
      transferDetails: [],
    };
  }

  const data = JSON.parse(rawBody);

  // Parse per-hop transfer details from the top-level transfer_sequence.
  // Each entry is an object with exactly one key: "cctp_transfer", "ibc_transfer",
  // "axelar_transfer", etc. The value contains src_chain_id, dst_chain_id, and state.
  const transferSequence: any[] = data.transfer_sequence || [];

  debugLog("getSkipTransactionStatus — Parsed", {
    state: data.state,
    transfer_sequence_count: transferSequence.length,
    transfer_sequence: transferSequence.map((entry: any) => {
      const hop = entry.cctp_transfer || entry.ibc_transfer || entry.axelar_transfer || entry.hyperlane_transfer || {};
      return {
        type: entry.cctp_transfer ? "cctp" : entry.ibc_transfer ? "ibc" : "other",
        src_chain_id: hop.src_chain_id || hop.from_chain_id,
        dst_chain_id: hop.dst_chain_id || hop.to_chain_id,
        state: hop.state,
      };
    }),
    transfer_asset_release: data.transfer_asset_release,
  });

  const transferDetails: SkipTransferDetail[] = transferSequence.map(
    (entry: any, i: number) => {
      // Extract the inner transfer object — could be cctp_transfer, ibc_transfer, etc.
      const hop =
        entry.cctp_transfer ||
        entry.ibc_transfer ||
        entry.axelar_transfer ||
        entry.hyperlane_transfer ||
        {};
      return {
        hopIndex: i,
        fromChain: hop.src_chain_id || hop.from_chain_id || "",
        toChain: hop.dst_chain_id || hop.to_chain_id || "",
        state: normalizeHopState(hop.state || ""),
      };
    }
  );

  // Parse asset release info (where funds are if stuck)
  let assetRelease: SkipTransactionStatusResult["assetRelease"];
  if (data.transfer_asset_release) {
    assetRelease = {
      chainId: data.transfer_asset_release.chain_id || "",
      denom: data.transfer_asset_release.denom || "",
    };
  }

  // Map Skip's top-level state to our status
  const rawState: string = data.state || "STATE_PENDING";
  let status: SkipTransactionStatusResult["status"] = "pending";

  if (rawState === "STATE_COMPLETED_SUCCESS") {
    status = "success";
  } else if (rawState === "STATE_COMPLETED_ERROR") {
    status = "failed";
  } else if (rawState === "STATE_ABANDONED") {
    status = "abandoned";
  }

  debugLog("getSkipTransactionStatus — Result", { status, state: rawState, transferDetails, assetRelease });

  return { status, state: rawState, transferDetails, assetRelease };
}

// Friendly chain name mapping
const CHAIN_DISPLAY_NAMES: Record<string, string> = {
  "8453": "Base",
  "noble-1": "Noble",
  "osmosis-1": "Osmosis",
  "akashnet-2": "Akash",
  "cosmoshub-4": "Cosmos Hub",
};

// Bridge type between chains
const HOP_TYPES: Record<string, string> = {
  "8453->noble-1": "CCTP",
  "noble-1->osmosis-1": "IBC",
  "osmosis-1->akashnet-2": "IBC",
};

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec.toString().padStart(2, "0")}s` : `${sec}s`;
}

/**
 * Normalize per-protocol hop states into a consistent set.
 * Skip uses different state enums per bridge type:
 *   CCTP: CCTP_TRANSFER_SENT, CCTP_TRANSFER_PENDING_CONFIRMATION, CCTP_TRANSFER_COMPLETE
 *   IBC:  IBC_TRANSFER_PENDING, IBC_TRANSFER_COMPLETE, IBC_TRANSFER_FAILED
 *   Axelar: AXELAR_TRANSFER_PENDING_CONFIRMATION, AXELAR_TRANSFER_COMPLETE, etc.
 * We normalize them all to: TRANSFER_PENDING | TRANSFER_SUCCESS | TRANSFER_FAILURE
 */
function normalizeHopState(state: string): string {
  if (!state) return "TRANSFER_UNKNOWN";

  const s = state.toUpperCase();

  // Success states
  if (s.includes("COMPLETE") || s.includes("SUCCESS") || s.includes("RECEIVED")) {
    return "TRANSFER_SUCCESS";
  }
  // Failure states
  if (s.includes("FAIL") || s.includes("ERROR")) {
    return "TRANSFER_FAILURE";
  }
  // In-progress states (sent, pending, confirming, etc.)
  if (s.includes("PENDING") || s.includes("SENT") || s.includes("CONFIRM")) {
    return "TRANSFER_PENDING";
  }
  // Fallback — treat as pending if it has any value
  return "TRANSFER_PENDING";
}

function getHopIcon(state: string): string {
  if (state === "TRANSFER_SUCCESS") return "\u2713"; // ✓
  if (state === "TRANSFER_FAILURE" || state === "TRANSFER_UNKNOWN")
    return "\u2717"; // ✗
  if (state === "TRANSFER_PENDING" || state === "TRANSFER_RECEIVED")
    return "\u27F3"; // ⟳
  return "\u00B7"; // · (waiting / not started)
}

export interface WaitForBridgeResult {
  status: "success" | "failed" | "abandoned" | "timeout";
  transferDetails: SkipTransferDetail[];
  assetRelease?: SkipTransactionStatusResult["assetRelease"];
}

/**
 * Poll for bridge completion with per-hop progress display
 */
export async function waitForSkipBridgeCompletion(
  txHash: string,
  chainId: string,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    chainPath?: string[];
  }
): Promise<WaitForBridgeResult> {
  const timeoutMs = options?.timeoutMs ?? 1800000; // 30 minutes default
  const pollIntervalMs = options?.pollIntervalMs ?? 10000; // 10 seconds
  const chainPath = options?.chainPath ?? [];

  debugLog("waitForSkipBridgeCompletion — Start", {
    txHash,
    chainId,
    timeoutMs,
    pollIntervalMs,
    chainPath,
  });

  const startTime = Date.now();
  let previousLineCount = 0;
  let pollCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    debugLog(`waitForSkipBridgeCompletion — Poll #${pollCount}`, `Elapsed: ${formatElapsed(Date.now() - startTime)}`);
    const result = await getSkipTransactionStatus(txHash, chainId);

    if (result.status === "success") {
      // Draw final state
      drawProgress(result.transferDetails, chainPath, startTime);
      return {
        status: "success",
        transferDetails: result.transferDetails,
        assetRelease: result.assetRelease,
      };
    } else if (result.status === "failed") {
      drawProgress(result.transferDetails, chainPath, startTime);
      return {
        status: "failed",
        transferDetails: result.transferDetails,
        assetRelease: result.assetRelease,
      };
    } else if (result.status === "abandoned") {
      drawProgress(result.transferDetails, chainPath, startTime);
      return {
        status: "abandoned",
        transferDetails: result.transferDetails,
        assetRelease: result.assetRelease,
      };
    }

    // Draw progress
    previousLineCount = drawProgress(
      result.transferDetails,
      chainPath,
      startTime,
      previousLineCount
    );

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { status: "timeout", transferDetails: [] };
}

/**
 * Draw per-hop progress block. Returns the number of lines written
 * so the next call can clear them.
 */
function drawProgress(
  transferDetails: SkipTransferDetail[],
  chainPath: string[],
  startTime: number,
  previousLines: number = 0
): number {
  // Move cursor up to overwrite previous output
  if (previousLines > 0) {
    process.stdout.write(`\x1b[${previousLines}A\x1b[0J`);
  }

  const lines: string[] = [];
  lines.push("Bridge Progress:");

  if (transferDetails.length > 0) {
    for (const hop of transferDetails) {
      const icon = getHopIcon(hop.state);
      const fromName =
        CHAIN_DISPLAY_NAMES[hop.fromChain] || hop.fromChain;
      const toName =
        CHAIN_DISPLAY_NAMES[hop.toChain] || hop.toChain;
      const hopKey = `${hop.fromChain}->${hop.toChain}`;
      const bridgeType = HOP_TYPES[hopKey] || "";
      const bridgeLabel = bridgeType ? ` (${bridgeType})` : "";

      let stateLabel = "waiting";
      if (hop.state === "TRANSFER_SUCCESS") stateLabel = "complete";
      else if (
        hop.state === "TRANSFER_PENDING" ||
        hop.state === "TRANSFER_RECEIVED"
      )
        stateLabel = "in progress...";
      else if (hop.state === "TRANSFER_FAILURE") stateLabel = "failed";

      const hopLine = `${fromName} \u2192 ${toName}${bridgeLabel}`;
      lines.push(
        `  ${icon} ${hopLine.padEnd(34)} ${stateLabel}`
      );
    }
  } else if (chainPath.length >= 2) {
    // No transfer details yet — show the expected hops as waiting
    for (let i = 0; i < chainPath.length - 1; i++) {
      const fromName =
        CHAIN_DISPLAY_NAMES[chainPath[i]] || chainPath[i];
      const toName =
        CHAIN_DISPLAY_NAMES[chainPath[i + 1]] || chainPath[i + 1];
      const hopKey = `${chainPath[i]}->${chainPath[i + 1]}`;
      const bridgeType = HOP_TYPES[hopKey] || "";
      const bridgeLabel = bridgeType ? ` (${bridgeType})` : "";

      const hopLine = `${fromName} \u2192 ${toName}${bridgeLabel}`;
      lines.push(
        `  \u00B7 ${hopLine.padEnd(34)} waiting`
      );
    }
  } else {
    lines.push("  Waiting for transfer details...");
  }

  const elapsed = formatElapsed(Date.now() - startTime);
  lines.push("");
  lines.push(`  Elapsed: ${elapsed}`);
  lines.push("");

  const output = lines.join("\n");
  process.stdout.write(output);

  return lines.length;
}

// ============================================================================
// PHASE 2: Noble IBC Transfer Signing
// ============================================================================

/**
 * Parse Skip API cosmos messages into CosmJS EncodeObject format.
 * Skip wraps messages in a `multi_chain_msg` envelope where the `msg`
 * field is a JSON string of the actual protobuf message.
 */
function parseSkipCosmosMsgs(rawMsgs: any[]): Array<{ typeUrl: string; value: any }> {
  const result: Array<{ typeUrl: string; value: any }> = [];

  for (const rawMsg of rawMsgs) {
    // Skip uses `multi_chain_msg` wrapper for PFM (multi-hop IBC) messages
    const wrapper = rawMsg.multi_chain_msg || rawMsg;
    const msgTypeUrl = wrapper.msg_type_url;

    // Parse the msg JSON string (Skip returns it as a JSON-encoded string)
    let msgBody: any;
    if (typeof wrapper.msg === "string") {
      try {
        msgBody = JSON.parse(wrapper.msg);
      } catch (e) {
        debugLog("parseSkipCosmosMsgs — Failed to parse msg JSON", {
          msg: wrapper.msg?.slice(0, 200),
          error: (e as Error).message,
        });
        continue;
      }
    } else {
      msgBody = wrapper.msg;
    }

    // Get type URL from wrapper or from @type field in the msg body
    const typeUrl = msgTypeUrl || msgBody?.["@type"];
    if (!typeUrl) {
      debugLog("parseSkipCosmosMsgs — Skipping msg with no type URL", rawMsg);
      continue;
    }

    if (typeUrl === "/ibc.applications.transfer.v1.MsgTransfer") {
      // Adjust timeout: Skip's original timeout was set relative to route creation time.
      // Since the CCTP phase takes 15-20 min, the original timeout may have expired.
      // Set timeout to 30 min from now if the original has expired.
      const nowNs = BigInt(Date.now()) * BigInt(1_000_000);
      const thirtyMinFromNowNs = BigInt(Date.now() + 30 * 60 * 1000) * BigInt(1_000_000);
      const originalTimeoutNs = BigInt(msgBody.timeout_timestamp || "0");
      const useTimeout = originalTimeoutNs > nowNs ? originalTimeoutNs : thirtyMinFromNowNs;

      debugLog("parseSkipCosmosMsgs — MsgTransfer", {
        sourcePort: msgBody.source_port,
        sourceChannel: msgBody.source_channel,
        token: msgBody.token,
        sender: msgBody.sender,
        receiver: msgBody.receiver,
        originalTimeoutNs: originalTimeoutNs.toString(),
        nowNs: nowNs.toString(),
        timeoutExpired: originalTimeoutNs <= nowNs,
        finalTimeoutNs: useTimeout.toString(),
        memo: msgBody.memo
          ? msgBody.memo.slice(0, 200) + (msgBody.memo.length > 200 ? "..." : "")
          : "(none)",
      });

      result.push({
        typeUrl,
        value: {
          sourcePort: msgBody.source_port || "transfer",
          sourceChannel: msgBody.source_channel,
          token: msgBody.token,
          sender: msgBody.sender,
          receiver: msgBody.receiver,
          timeoutHeight: msgBody.timeout_height
            ? {
                revisionNumber: BigInt(msgBody.timeout_height.revision_number || "0"),
                revisionHeight: BigInt(msgBody.timeout_height.revision_height || "0"),
              }
            : { revisionNumber: BigInt(0), revisionHeight: BigInt(0) },
          timeoutTimestamp: useTimeout,
          memo: msgBody.memo || "",
        },
      });
    } else {
      debugLog("parseSkipCosmosMsgs — Unknown type URL, passing raw", { typeUrl });
      // For unknown types, pass through as-is (likely won't encode correctly,
      // but at least we'll get a meaningful error)
      result.push({ typeUrl, value: msgBody });
    }
  }

  return result;
}

/**
 * Sign and broadcast a Cosmos transaction (typically the Noble IBC transfer
 * that forwards USDC from Noble -> Osmosis -> Akash via PFM).
 *
 * This is phase 2 of the two-phase bridge:
 *   Phase 1: EVM tx on Base (CCTP burn) -> tracked via Skip relay
 *   Phase 2: Cosmos tx on Noble (IBC transfer with PFM) -> this function
 *
 * @param wallet - Noble-prefixed DirectSecp256k1HdWallet (same key as Akash wallet)
 * @param cosmosTx - The cosmos tx from Skip's msgs_direct response
 * @returns The tx hash and chain ID
 */
export async function signAndBroadcastCosmosTx(
  wallet: DirectSecp256k1HdWallet,
  cosmosTx: NonNullable<SkipTransaction["cosmosTx"]>,
): Promise<{ txHash: string; chainId: string }> {
  const chainId = cosmosTx.chainId;

  debugLog("signAndBroadcastCosmosTx — Start", {
    chainId,
    rawMsgCount: cosmosTx.msgs?.length || 0,
    rawMsgTypes: (cosmosTx.msgs || []).map((m: any) => {
      const wrapper = m.multi_chain_msg || m;
      return wrapper.msg_type_url || "(unknown)";
    }),
  });

  // Parse messages from Skip format to CosmJS EncodeObject format
  const messages = parseSkipCosmosMsgs(cosmosTx.msgs || []);
  if (messages.length === 0) {
    throw new Error(
      `No valid messages found in cosmos tx for chain ${chainId}. ` +
      `Raw msgs: ${JSON.stringify(cosmosTx.msgs).slice(0, 500)}`
    );
  }

  debugLog("signAndBroadcastCosmosTx — Parsed messages", {
    count: messages.length,
    typeUrls: messages.map((m) => m.typeUrl),
  });

  // Get signer address
  const [account] = await wallet.getAccounts();
  const signerAddress = account.address;
  debugLog("signAndBroadcastCosmosTx — Signer", {
    address: signerAddress,
    prefix: signerAddress.split("1")[0],
  });

  // Determine RPC endpoints and gas price based on chain
  let rpcEndpoints: string[];
  let gasPrice: GasPrice;

  if (chainId === "noble-1") {
    rpcEndpoints = NOBLE_RPC_ENDPOINTS;
    gasPrice = GasPrice.fromString("0.2uusdc");
  } else {
    throw new Error(
      `Unsupported cosmos chain for signing: ${chainId}. ` +
      `Only noble-1 is currently supported for phase 2 signing.`
    );
  }

  // Try each RPC endpoint until one succeeds
  let lastError: Error | null = null;

  for (const rpc of rpcEndpoints) {
    try {
      debugLog("signAndBroadcastCosmosTx — Connecting to RPC", {
        rpc,
        chainId,
        gasPrice: gasPrice.toString(),
      });

      const client = await SigningStargateClient.connectWithSigner(rpc, wallet, {
        gasPrice,
      });

      debugLog("signAndBroadcastCosmosTx — Connected, signing tx", {
        rpc,
        signerAddress,
        msgCount: messages.length,
        typeUrls: messages.map((m) => m.typeUrl),
      });

      // Sign and broadcast with auto gas estimation (1.5x multiplier for safety)
      const result = await client.signAndBroadcast(
        signerAddress,
        messages,
        "auto",
        `agent-pay bridge phase 2: IBC forward via PFM`,
      );

      debugLog("signAndBroadcastCosmosTx — Broadcast result", {
        txHash: result.transactionHash,
        code: result.code,
        gasUsed: result.gasUsed?.toString(),
        gasWanted: result.gasWanted?.toString(),
        rawLog: result.rawLog?.slice(0, 500),
      });

      if (result.code !== 0) {
        throw new Error(
          `Noble tx failed with code ${result.code}: ${result.rawLog || "(no log)"}`
        );
      }

      console.log(`Noble IBC tx broadcast: ${result.transactionHash}`);
      console.log(`  Gas used: ${result.gasUsed}/${result.gasWanted}`);

      client.disconnect();

      return { txHash: result.transactionHash, chainId };
    } catch (err: any) {
      lastError = err;
      debugLog("signAndBroadcastCosmosTx — RPC endpoint failed", {
        rpc,
        error: err.message,
        stack: err.stack?.split("\n").slice(0, 3).join("\n"),
      });
      console.warn(`  Noble RPC ${rpc} failed: ${err.message}`);
    }
  }

  throw new Error(
    `All Noble RPC endpoints failed. Last error: ${lastError?.message || "unknown"}`
  );
}
