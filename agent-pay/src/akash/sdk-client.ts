/**
 * Akash SDK Client
 *
 * Wrapper around CosmJS for interacting with the Akash network.
 * Handles queries and transaction broadcasting with user wallet signing.
 */

import { StargateClient, SigningStargateClient, GasPrice, defaultRegistryTypes } from "@cosmjs/stargate";
import { DirectSecp256k1HdWallet, Registry } from "@cosmjs/proto-signing";
import { getAkashTypeRegistry } from "@akashnetwork/akashjs/build/stargate/index.js";

// Network configuration
export const AKASH_RPC_ENDPOINTS = {
  mainnet: [
    "https://rpc.akashnet.net:443",
    "https://akash-rpc.polkachu.com:443",
    "https://rpc-akash.cosmos-spaces.cloud:443",
  ],
  testnet: [
    "https://rpc.sandbox-01.aksh.pw:443",
  ],
};

export const AKASH_REST_ENDPOINTS = {
  mainnet: [
    "https://api.akashnet.net:443",
    "https://akash-api.polkachu.com:443",
  ],
  testnet: [
    "https://api.sandbox-01.aksh.pw:443",
  ],
};

// USDC IBC denom on Akash
export const USDC_DENOM = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
export const AKT_DENOM = "uakt";

export interface AkashBalance {
  uakt: string;
  usdc: string;
  uaktFormatted: string;
  usdcFormatted: string;
}

export interface BidInfo {
  bidId: {
    owner: string;
    dseq: string;
    gseq: number;
    oseq: number;
    provider: string;
  };
  state: number;
  price: {
    denom: string;
    amount: string;
  };
  createdAt: string;
}

export interface LeaseInfo {
  leaseId: {
    owner: string;
    dseq: string;
    gseq: number;
    oseq: number;
    provider: string;
  };
  state: number;
  price: {
    denom: string;
    amount: string;
  };
  createdAt: string;
  closedOn: string;
}

export interface DeploymentInfo {
  deploymentId: {
    owner: string;
    dseq: string;
  };
  state: number;
  version: Uint8Array;
  createdAt: string;
}

let queryClient: StargateClient | null = null;
let queryClientNetwork: string | null = null;

/**
 * Normalize state from string or number to numeric enum value.
 * v1beta5 REST API returns string states ("open", "active", "closed")
 * while older versions return numeric (1, 2, 3).
 */
function normalizeState(state: string | number): number {
  if (typeof state === "number") return state;
  const stateMap: Record<string, number> = {
    "invalid": 0,
    "open": 1,
    "active": 1,
    "insufficient_funds": 2,
    "closed": 2,
  };
  return stateMap[state.toLowerCase()] ?? 0;
}

/**
 * Get or create a query client
 */
async function getQueryClient(network: "mainnet" | "testnet" = "mainnet"): Promise<StargateClient> {
  if (queryClient && queryClientNetwork === network) {
    return queryClient;
  }

  const endpoints = AKASH_RPC_ENDPOINTS[network];
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      queryClient = await StargateClient.connect(endpoint);
      queryClientNetwork = network;
      return queryClient;
    } catch (error) {
      lastError = error as Error;
      console.warn(`Failed to connect to ${endpoint}, trying next...`);
    }
  }

  throw lastError || new Error("Failed to connect to any Akash RPC endpoint");
}

/**
 * Create a signing client with user's wallet
 */
export async function createSigningClient(
  wallet: DirectSecp256k1HdWallet,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<SigningStargateClient> {
  const endpoints = AKASH_RPC_ENDPOINTS[network];
  let lastError: Error | null = null;

  // Create registry with both default CosmJS types and Akash-specific types
  const registry = new Registry([
    ...defaultRegistryTypes,
    ...getAkashTypeRegistry(),
  ]);

  for (const endpoint of endpoints) {
    try {
      const client = await SigningStargateClient.connectWithSigner(
        endpoint,
        wallet,
        {
          registry,
          gasPrice: GasPrice.fromString("0.025uakt"),
        }
      );
      return client;
    } catch (error) {
      lastError = error as Error;
      console.warn(`Failed to connect to ${endpoint}, trying next...`);
    }
  }

  throw lastError || new Error("Failed to connect to any Akash RPC endpoint");
}

/**
 * Get current block height
 */
export async function getCurrentBlockHeight(
  network: "mainnet" | "testnet" = "mainnet"
): Promise<number> {
  const client = await getQueryClient(network);
  return await client.getHeight();
}

/**
 * Get wallet balance
 */
export async function getWalletBalance(
  address: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<AkashBalance> {
  const client = await getQueryClient(network);

  const aktBalance = await client.getBalance(address, AKT_DENOM);
  const usdcBalance = await client.getBalance(address, USDC_DENOM);

  return {
    uakt: aktBalance.amount,
    usdc: usdcBalance.amount,
    uaktFormatted: (parseInt(aktBalance.amount) / 1_000_000).toFixed(6),
    usdcFormatted: (parseInt(usdcBalance.amount) / 1_000_000).toFixed(6),
  };
}

/**
 * Query deployments for an address
 */
export async function queryDeployments(
  owner: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<DeploymentInfo[]> {
  const restEndpoints = AKASH_REST_ENDPOINTS[network];
  let lastError: Error | null = null;

  for (const endpoint of restEndpoints) {
    try {
      const url = `${endpoint}/akash/deployment/v1beta4/deployments/list?filters.owner=${owner}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return (data.deployments || []).map((d: any) => ({
        deploymentId: {
          owner: (d.deployment.id || d.deployment.deployment_id).owner,
          dseq: (d.deployment.id || d.deployment.deployment_id).dseq,
        },
        state: normalizeState(d.deployment.state),
        version: d.deployment.hash || d.deployment.version,
        createdAt: d.deployment.created_at,
      }));
    } catch (error) {
      lastError = error as Error;
      console.warn(`Failed to query ${endpoint}, trying next...`);
    }
  }

  throw lastError || new Error("Failed to query deployments from any endpoint");
}

/**
 * Query bids for a deployment
 */
export async function queryBids(
  owner: string,
  dseq: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<BidInfo[]> {
  const restEndpoints = AKASH_REST_ENDPOINTS[network];
  let lastError: Error | null = null;

  for (const endpoint of restEndpoints) {
    try {
      const url = `${endpoint}/akash/market/v1beta5/bids/list?filters.owner=${owner}&filters.dseq=${dseq}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return (data.bids || []).map((b: any) => {
        const bidId = b.bid.id || b.bid.bid_id;
        return {
          bidId: {
            owner: bidId.owner,
            dseq: bidId.dseq,
            gseq: parseInt(bidId.gseq),
            oseq: parseInt(bidId.oseq),
            provider: bidId.provider,
          },
          state: normalizeState(b.bid.state),
          price: {
            denom: b.bid.price.denom,
            amount: b.bid.price.amount,
          },
          createdAt: b.bid.created_at,
        };
      });
    } catch (error) {
      lastError = error as Error;
      console.warn(`Failed to query bids from ${endpoint}, trying next...`);
    }
  }

  throw lastError || new Error("Failed to query bids from any endpoint");
}

/**
 * Query leases for a deployment
 */
export async function queryLeases(
  owner: string,
  dseq: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<LeaseInfo[]> {
  const restEndpoints = AKASH_REST_ENDPOINTS[network];
  let lastError: Error | null = null;

  for (const endpoint of restEndpoints) {
    try {
      const url = `${endpoint}/akash/market/v1beta5/leases/list?filters.owner=${owner}&filters.dseq=${dseq}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return (data.leases || []).map((l: any) => {
        const leaseId = l.lease.id || l.lease.lease_id;
        return {
          leaseId: {
            owner: leaseId.owner,
            dseq: leaseId.dseq,
            gseq: parseInt(leaseId.gseq),
            oseq: parseInt(leaseId.oseq),
            provider: leaseId.provider,
          },
          state: normalizeState(l.lease.state),
          price: {
            denom: l.lease.price.denom,
            amount: l.lease.price.amount,
          },
          createdAt: l.lease.created_at,
          closedOn: l.lease.closed_on,
        };
      });
    } catch (error) {
      lastError = error as Error;
      console.warn(`Failed to query leases from ${endpoint}, trying next...`);
    }
  }

  throw lastError || new Error("Failed to query leases from any endpoint");
}

/**
 * Query provider info
 */
export async function queryProvider(
  providerAddress: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<any> {
  const restEndpoints = AKASH_REST_ENDPOINTS[network];
  let lastError: Error | null = null;

  for (const endpoint of restEndpoints) {
    try {
      const url = `${endpoint}/akash/provider/v1beta4/providers/${providerAddress}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError || new Error("Failed to query provider info");
}

/**
 * Get deployment status summary
 */
export async function getDeploymentStatus(
  owner: string,
  dseq: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<{
  deployment: DeploymentInfo | null;
  leases: LeaseInfo[];
  status: "unknown" | "open" | "active" | "closed";
  endpoints: { provider: string; uri: string }[];
}> {
  try {
    // Get deployments for owner
    const deployments = await queryDeployments(owner, network);
    const deployment = deployments.find(d => d.deploymentId.dseq === dseq) || null;

    if (!deployment) {
      return {
        deployment: null,
        leases: [],
        status: "unknown",
        endpoints: [],
      };
    }

    // Get leases
    const leases = await queryLeases(owner, dseq, network);
    const activeLeases = leases.filter(l => l.state === 1); // ACTIVE state

    // Determine status
    let status: "unknown" | "open" | "active" | "closed" = "unknown";
    if (deployment.state === 1) { // OPEN
      status = activeLeases.length > 0 ? "active" : "open";
    } else if (deployment.state === 2) { // CLOSED
      status = "closed";
    }

    // Get endpoints from provider for active leases
    const endpoints: { provider: string; uri: string }[] = [];
    for (const lease of activeLeases) {
      try {
        const providerInfo = await queryProvider(lease.leaseId.provider, network);
        if (providerInfo?.provider?.host_uri) {
          endpoints.push({
            provider: lease.leaseId.provider,
            uri: providerInfo.provider.host_uri,
          });
        }
      } catch {
        // Provider info not available
      }
    }

    return {
      deployment,
      leases,
      status,
      endpoints,
    };
  } catch (error) {
    console.error("Error getting deployment status:", error);
    return {
      deployment: null,
      leases: [],
      status: "unknown",
      endpoints: [],
    };
  }
}

/**
 * Select best bid from available bids
 */
export function selectBestBid(bids: BidInfo[]): BidInfo | null {
  // Filter open bids (state 1 = OPEN)
  const openBids = bids.filter(b => b.state === 1);

  if (openBids.length === 0) {
    return null;
  }

  // Sort by price (lowest first)
  openBids.sort((a, b) => {
    const priceA = parseInt(a.price.amount);
    const priceB = parseInt(b.price.amount);
    return priceA - priceB;
  });

  return openBids[0];
}
