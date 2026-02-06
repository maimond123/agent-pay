/**
 * ERC-8004 Agent Metadata
 *
 * Constructs the agent registration JSON per the ERC-8004 specification.
 * This metadata is uploaded to IPFS and referenced on-chain via the IdentityRegistry.
 */

export interface AgentEndpoint {
  type: string; // "MCP", "A2A", "ENS", etc.
  uri: string;
}

export interface AgentMetadata {
  type: string;
  name: string;
  description: string;
  image: string;
  endpoints: AgentEndpoint[];
  trustedModels: string[];
}

/**
 * Build the agent metadata JSON for ERC-8004 registration.
 */
export function buildAgentMetadata(mcpEndpoint: string): AgentMetadata {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Agent-Pay Compute Orchestrator",
    description:
      "Trustless compute provisioning on Akash Network via MCP. " +
      "Constructs unsigned transactions for deployment, leasing, and bridging. " +
      "Agents sign with their own secp256k1 keys — no custody.",
    image: "",
    endpoints: [
      {
        type: "MCP",
        uri: mcpEndpoint,
      },
    ],
    trustedModels: ["reputation"],
  };
}
