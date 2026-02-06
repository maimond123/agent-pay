/**
 * ERC-8004 Reputation Registry Client
 *
 * Interacts with the ReputationRegistry contract on Base mainnet.
 * Handles submitting feedback after successful deployments and querying reputation.
 */

import {
  encodeFunctionData,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";
import type { HDAccount } from "viem/accounts";

export const REPUTATION_REGISTRY_ADDRESS =
  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

const REPUTATION_REGISTRY_ABI = [
  {
    name: "giveFeedback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "getSummary",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint256" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
] as const;

export interface FeedbackParams {
  agentId: bigint;
  value: bigint; // Signed fixed-point: e.g. 10000n for 100.00 with decimals=2
  valueDecimals: number;
  tag1: string; // Primary category, e.g. "compute"
  tag2: string; // Secondary, e.g. "deployment"
  feedbackURI: string; // URI to detailed feedback JSON (can be empty)
  feedbackHash: `0x${string}`; // keccak256 of feedback content (or zero bytes)
}

/**
 * Submit feedback for an agent on the ReputationRegistry.
 */
export async function submitFeedback(
  walletClient: WalletClient,
  publicClient: PublicClient,
  evmAccount: HDAccount,
  params: FeedbackParams
): Promise<`0x${string}`> {
  console.error(
    `[agent-pay:reputation] Submitting feedback for agent ${params.agentId}: ` +
      `value=${params.value}, tag1=${params.tag1}`
  );

  const data = encodeFunctionData({
    abi: REPUTATION_REGISTRY_ABI,
    functionName: "giveFeedback",
    args: [
      params.agentId,
      params.value,
      params.valueDecimals,
      params.tag1,
      params.tag2,
      params.feedbackURI,
      params.feedbackHash,
    ],
  });

  const txHash = await walletClient.sendTransaction({
    account: evmAccount,
    chain: base,
    to: REPUTATION_REGISTRY_ADDRESS,
    data,
  });

  console.error(`[agent-pay:reputation] Feedback TX: ${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error(`Feedback TX reverted: ${txHash}`);
  }

  console.error(`[agent-pay:reputation] Feedback confirmed: ${txHash}`);
  return txHash;
}

/**
 * Get aggregated reputation for an agent.
 */
export async function getReputation(
  publicClient: PublicClient,
  agentId: bigint,
  tag1 = "",
  tag2 = ""
): Promise<{ count: bigint; summaryValue: bigint; summaryValueDecimals: number }> {
  const [count, summaryValue, summaryValueDecimals] =
    await publicClient.readContract({
      address: REPUTATION_REGISTRY_ADDRESS,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: "getSummary",
      args: [agentId, [], tag1, tag2],
    });

  return { count, summaryValue, summaryValueDecimals };
}
