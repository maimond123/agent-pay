export { buildAgentMetadata, type AgentMetadata, type AgentEndpoint } from "./agent-metadata.js";
export { uploadToIPFS } from "./ipfs.js";
export {
  registerAgent,
  getAgentId,
  getAgentURI,
  IDENTITY_REGISTRY_ADDRESS,
} from "./identity-registry.js";
export {
  submitFeedback,
  getReputation,
  REPUTATION_REGISTRY_ADDRESS,
  type FeedbackParams,
} from "./reputation-registry.js";
