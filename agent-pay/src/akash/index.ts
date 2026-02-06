/**
 * Akash Module
 *
 * Exports Akash deployment functionality for trustless compute provisioning.
 */

// Deployer - main deployment orchestration
export {
  deployToAkash,
  closeDeployment,
  generateSDLYaml,
  DeploymentState,
  LeaseState,
  type DeploymentResult,
  type DeploymentEndpoint,
  type DeploymentOptions,
} from "./deployer.js";

// SDK Client - chain queries
export {
  getWalletBalance,
  queryDeployments,
  queryBids,
  queryLeases,
  queryProvider,
  getDeploymentStatus,
  getCurrentBlockHeight,
  createSigningClient,
  selectBestBid,
  AKASH_RPC_ENDPOINTS,
  AKASH_REST_ENDPOINTS,
  USDC_DENOM,
  AKT_DENOM,
  type AkashBalance,
  type BidInfo,
  type LeaseInfo,
  type DeploymentInfo,
} from "./sdk-client.js";

// Certificate - mTLS + JWT authentication with providers
export {
  getOrCreateCertificate,
  generateCertificateKeyPair,
  loadStoredCert,
  saveStoredCert,
  deleteStoredCert,
  generateProviderJwt,
  mtlsFetch,
  type StoredCert,
} from "./certificate.js";

// SDL Generator - manifest creation
export {
  generateSDL,
  calculateDeposit,
  sdlToYaml,
  buildDeploymentGroups,
  type SDLSpec,
} from "./sdl-generator.js";

// Trustless TX construction + broadcast
export {
  queryAccountInfo,
  simulateGas,
  constructUnsignedTx,
  broadcastSignedTx,
  constructDeploymentMsg,
  constructLeaseMsg,
  constructCloseMsg,
  constructCertificateMsg,
  constructAminoJwtSignDoc,
  assembleJwt,
  type UnsignedTxResult,
  type BroadcastResult,
} from "./trustless.js";
