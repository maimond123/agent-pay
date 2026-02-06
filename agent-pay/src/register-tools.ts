/**
 * Shared tool registration — used by both stdio (index.ts) and HTTP (http-server.ts) entry points.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Existing tools (CLI/human flow)
import { registerProvisionCompute } from "./tools/provision-compute.js";
import { registerCheckWallet } from "./tools/check-wallet.js";
import { registerCheckDeployment } from "./tools/check-deployment.js";
import { registerListDeployments } from "./tools/list-deployments.js";
import { registerStopDeployment } from "./tools/stop-deployment.js";

// Agent-to-agent trustless tools
import { registerDeriveAddress } from "./tools/derive-address.js";
import { registerBroadcastTx } from "./tools/broadcast-tx.js";
import { registerPrepareCertificateTx } from "./tools/prepare-certificate-tx.js";
import { registerPrepareDeployTx } from "./tools/prepare-deploy-tx.js";
import { registerQueryBids } from "./tools/query-bids.js";
import { registerPrepareLeaseTx } from "./tools/prepare-lease-tx.js";
import { registerPrepareCloseTx } from "./tools/prepare-close-tx.js";
import { registerPrepareBridgeTx } from "./tools/prepare-bridge-tx.js";
import { registerTrackBridge } from "./tools/track-bridge.js";
import { registerPrepareJwtSign } from "./tools/prepare-jwt-sign.js";
import { registerSendManifest } from "./tools/send-manifest.js";

export function registerAllTools(server: McpServer): void {
  // Read operations — direct chain queries (no signing needed)
  registerCheckWallet(server);
  registerCheckDeployment(server);
  registerListDeployments(server);

  // Write operations — return CLI commands for user to execute
  registerProvisionCompute(server);
  registerStopDeployment(server);

  // Agent-to-agent trustless tools (ERC-8004 flow)
  // Key derivation
  registerDeriveAddress(server);

  // Bridge (Base → Akash)
  registerPrepareBridgeTx(server);
  registerTrackBridge(server);

  // TX construction + broadcast
  registerBroadcastTx(server);
  registerPrepareCertificateTx(server);
  registerPrepareDeployTx(server);
  registerQueryBids(server);
  registerPrepareLeaseTx(server);
  registerPrepareCloseTx(server);

  // Provider authentication + manifest
  registerPrepareJwtSign(server);
  registerSendManifest(server);
}
