/**
 * Skip Go API Client
 *
 * Handles cross-chain bridging from EVM chains (Base) to Cosmos chains (Akash).
 * Uses Skip Go API with Noble CCTP + IBC for minimal fees (~$0.02 vs $50+ with other bridges).
 *
 * Route: Base USDC -> CCTP -> Noble USDC -> IBC -> Osmosis -> Akash
 */

import { fromBech32, toBech32 } from "@cosmjs/encoding";

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

  const response = await fetch(`${SKIP_API_BASE}/v2/fungible/route`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Skip API error: ${error.message || response.statusText}`);
  }

  const data = await response.json();

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

  const response = await fetch(`${SKIP_API_BASE}/v2/fungible/msgs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Skip API error: ${error.message || response.statusText}`);
  }

  const data = await response.json();

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

  const response = await fetch(`${SKIP_API_BASE}/v2/fungible/msgs_direct`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Skip API error: ${error.message || response.statusText}`);
  }

  const data = await response.json();

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
  chainId: string
): Promise<{ txHash: string; explorerLink: string }> {
  const response = await fetch(`${SKIP_API_BASE}/v2/tx/track`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tx_hash: txHash,
      chain_id: chainId,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to register tx with Skip relay: ${(error as any).message || response.statusText}`
    );
  }

  const data = await response.json();

  return {
    txHash,
    explorerLink: data.explorer_link || `https://ibc.fun/tx/${txHash}`,
  };
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
  const response = await fetch(
    `${SKIP_API_BASE}/v2/tx/status?tx_hash=${txHash}&chain_id=${chainId}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    return {
      status: "pending",
      state: "STATE_PENDING",
      transferDetails: [],
    };
  }

  const data = await response.json();

  // Parse per-hop transfer details from transfer_sequence
  const transfers = data.transfers || [];
  const transferDetails: SkipTransferDetail[] = transfers.map(
    (t: any, i: number) => ({
      hopIndex: i,
      fromChain: t.from_chain_id || t.src_chain_id || "",
      toChain: t.to_chain_id || t.dst_chain_id || "",
      state: t.state || "TRANSFER_UNKNOWN",
    })
  );

  // Parse asset release info (where funds are if stuck)
  let assetRelease: SkipTransactionStatusResult["assetRelease"];
  if (data.transfer_asset_release) {
    assetRelease = {
      chainId: data.transfer_asset_release.chain_id || "",
      denom: data.transfer_asset_release.denom || "",
    };
  }

  // Map Skip state enums to our status
  const rawState: string = data.state || "STATE_PENDING";
  let status: SkipTransactionStatusResult["status"] = "pending";

  if (rawState === "STATE_COMPLETED_SUCCESS") {
    status = "success";
  } else if (rawState === "STATE_COMPLETED_ERROR") {
    status = "failed";
  } else if (rawState === "STATE_ABANDONED") {
    status = "abandoned";
  } else {
    // Also check individual transfer states as a fallback
    const allSuccess =
      transfers.length > 0 &&
      transfers.every((t: any) => t.state === "TRANSFER_SUCCESS");
    const anyFailed = transfers.some(
      (t: any) => t.state === "TRANSFER_FAILURE"
    );

    if (allSuccess) {
      status = "success";
    } else if (anyFailed) {
      status = "failed";
    }
  }

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

function getHopIcon(state: string): string {
  if (state === "TRANSFER_SUCCESS") return "\u2713"; // ✓
  if (
    state === "TRANSFER_FAILURE" ||
    state === "TRANSFER_UNKNOWN"
  )
    return "\u2717"; // ✗
  if (
    state === "TRANSFER_PENDING" ||
    state === "TRANSFER_RECEIVED"
  )
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

  const startTime = Date.now();
  let previousLineCount = 0;

  while (Date.now() - startTime < timeoutMs) {
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
