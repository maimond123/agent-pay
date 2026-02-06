/**
 * ERC-8004 Identity Registry Client
 *
 * Interacts with the IdentityRegistry contract on Base mainnet.
 * Handles agent registration (minting an ERC-721 NFT) and agent lookups.
 */

import {
  encodeFunctionData,
  decodeEventLog,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";
import type { HDAccount } from "viem/accounts";

export const IDENTITY_REGISTRY_ADDRESS =
  "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;

const IDENTITY_REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "tokenOfOwnerByIndex",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "Transfer",
    type: "event",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

/**
 * Register an agent on the ERC-8004 IdentityRegistry.
 * Calls register(agentURI) and parses the Transfer event to get the minted agentId.
 */
export async function registerAgent(
  walletClient: WalletClient,
  publicClient: PublicClient,
  evmAccount: HDAccount,
  agentURI: string
): Promise<{ txHash: `0x${string}`; agentId: bigint }> {
  console.error(
    `[agent-pay:identity-registry] Registering agent with URI: ${agentURI}`
  );

  const data = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [agentURI],
  });

  const txHash = await walletClient.sendTransaction({
    account: evmAccount,
    chain: base,
    to: IDENTITY_REGISTRY_ADDRESS,
    data,
  });

  console.error(
    `[agent-pay:identity-registry] TX submitted: ${txHash}, waiting for confirmation...`
  );

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status === "reverted") {
    throw new Error(`Registration TX reverted: ${txHash}`);
  }

  // Parse Transfer event to get the minted token ID (agentId)
  let agentId: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: IDENTITY_REGISTRY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "Transfer") {
        agentId = decoded.args.tokenId;
        break;
      }
    } catch {
      // Not a Transfer event from this contract
    }
  }

  if (agentId === undefined) {
    throw new Error(
      `Could not parse agentId from registration TX ${txHash}. ` +
        "Check the transaction on Basescan."
    );
  }

  console.error(
    `[agent-pay:identity-registry] Registered! Agent ID: ${agentId}, TX: ${txHash}`
  );

  return { txHash, agentId };
}

/**
 * Check if an address already has a registered agent.
 * Returns the first agentId owned by the address, or null if none.
 */
export async function getAgentId(
  publicClient: PublicClient,
  ownerAddress: `0x${string}`
): Promise<bigint | null> {
  try {
    const balance = await publicClient.readContract({
      address: IDENTITY_REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "balanceOf",
      args: [ownerAddress],
    });

    if (balance === 0n) {
      return null;
    }

    const agentId = await publicClient.readContract({
      address: IDENTITY_REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "tokenOfOwnerByIndex",
      args: [ownerAddress, 0n],
    });

    return agentId;
  } catch {
    return null;
  }
}

/**
 * Get the metadata URI for a registered agent.
 */
export async function getAgentURI(
  publicClient: PublicClient,
  agentId: bigint
): Promise<string> {
  return publicClient.readContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "tokenURI",
    args: [agentId],
  });
}
