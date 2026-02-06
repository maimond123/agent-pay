/**
 * Akash Deployer
 *
 * Orchestrates the deployment flow on Akash network.
 * All transactions are signed by the user's wallet in the CLI process.
 *
 * Flow:
 * 1. Create deployment transaction
 * 2. Wait for provider bids
 * 3. Select best bid and create lease
 * 4. Send manifest to provider
 */

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { DeliverTxResponse, assertIsDeliverTxSuccess } from "@cosmjs/stargate";
import { SDL } from "@akashnetwork/chain-sdk";
import type { ComputeSpecs } from "../types.js";
import {
  createSigningClient,
  getCurrentBlockHeight,
  queryBids,
  selectBestBid,
  queryProvider,
  type BidInfo,
} from "./sdk-client.js";
import { calculateDeposit } from "./sdl-generator.js";
import { getOrCreateCertificate, generateProviderJwt, jwtFetch } from "./certificate.js";

// Deployment state enum (matches Akash chain)
export enum DeploymentState {
  INVALID = 0,
  ACTIVE = 1,
  CLOSED = 2,
}

// Lease state enum (matches Akash chain)
export enum LeaseState {
  INVALID = 0,
  ACTIVE = 1,
  INSUFFICIENT_FUNDS = 2,
  CLOSED = 3,
}

export interface DeploymentResult {
  dseq: string;
  gseq: number;
  oseq: number;
  owner: string;
  provider: string;
  providerHost: string;
  lease: {
    dseq: string;
    gseq: number;
    oseq: number;
    provider: string;
  };
  endpoints: DeploymentEndpoint[];
  txHashes: {
    deployment: string;
    lease: string;
  };
}

export interface DeploymentEndpoint {
  host: string;
  port: number;
  externalPort: number;
  protocol: string;
}

export interface DeploymentOptions {
  specs: ComputeSpecs;
  env?: Record<string, string>;
  command?: string[];
  network?: "mainnet" | "testnet";
  bidWaitSeconds?: number;
  maxBidPrice?: string;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate SDL YAML string from compute specs
 * This format is understood by the chain-sdk SDL parser
 */
export function generateSDLYaml(
  specs: ComputeSpecs,
  env?: Record<string, string>,
  command?: string[]
): string {
  const serviceName = "main";

  // Build expose section
  const exposeEntries: string[] = [];
  const ports = specs.ports || [{ port: 80, expose: true }];

  for (const p of ports) {
    if (p.expose !== false) {
      const proto = (p as any).protocol || "tcp";
      exposeEntries.push(`      - port: ${p.port}
        as: ${p.port}
        to:
          - global: true
        proto: ${proto}`);
    }
  }

  // Build env section
  let envSection = "";
  if (env && Object.keys(env).length > 0) {
    const envLines = Object.entries(env).map(([k, v]) => `      - ${k}=${v}`).join("\n");
    envSection = `
    env:
${envLines}`;
  }

  // Build command section
  let commandSection = "";
  if (command && command.length > 0) {
    const cmdLines = command.map(c => `      - "${c}"`).join("\n");
    commandSection = `
    command:
${cmdLines}`;
  }

  // Build GPU section
  let gpuSection = "";
  if (specs.gpu && specs.gpu.count > 0) {
    gpuSection = `
        gpu:
          units: ${specs.gpu.count}
          attributes:
            vendor:
              nvidia:
                - model: ${specs.gpu.model || "*"}`;
  }

  return `version: "2.0"
services:
  ${serviceName}:
    image: ${specs.image}${envSection}${commandSection}
    expose:
${exposeEntries.join("\n")}
profiles:
  compute:
    ${serviceName}:
      resources:
        cpu:
          units: ${specs.cpu}
        memory:
          size: ${specs.memory}
        storage:
          - size: ${specs.storage}${gpuSection}
  placement:
    dcloud:
      pricing:
        ${serviceName}:
          denom: uakt
          amount: 10000
deployment:
  ${serviceName}:
    dcloud:
      profile: ${serviceName}
      count: 1
`;
}

/**
 * Deploy to Akash network
 *
 * @param wallet - User's wallet (signs all transactions)
 * @param aminoWallet - Amino wallet (for JWT signing)
 * @param options - Deployment options
 * @returns Deployment result with endpoints
 */
export async function deployToAkash(
  wallet: DirectSecp256k1HdWallet,
  aminoWallet: Secp256k1HdWallet,
  options: DeploymentOptions
): Promise<DeploymentResult> {
  const {
    specs,
    env,
    command,
    network = "mainnet",
    bidWaitSeconds = 60,
    maxBidPrice,
  } = options;

  const [account] = await wallet.getAccounts();
  const owner = account.address;

  console.log(`\nDeploying to Akash (${network})...`);
  console.log(`  Owner: ${owner}`);
  console.log(`  Image: ${specs.image}`);
  console.log(`  CPU: ${specs.cpu}, Memory: ${specs.memory}, Storage: ${specs.storage}`);

  // 1. Create signing client and ensure certificate exists
  console.log("\n[1/6] Connecting to Akash network...");
  const signingClient = await createSigningClient(wallet, network);

  console.log("[2/6] Ensuring mTLS certificate...");
  const cert = await getOrCreateCertificate(wallet, network);

  // 2. Generate SDL using chain-sdk for proper manifest/version computation
  console.log("[3/6] Generating deployment manifest...");
  const sdlYaml = generateSDLYaml(specs, env, command);
  const sdl = SDL.fromString(sdlYaml, "beta3");
  const deposit = calculateDeposit(specs, specs.hours);
  const version = await sdl.manifestVersion();

  console.log(`  Deposit: ${(parseInt(deposit.amount) / 1_000_000).toFixed(6)} AKT (escrowed, refunded on close)`);

  // 3. Get current block height for DSEQ
  const blockHeight = await getCurrentBlockHeight(network);
  const dseq = blockHeight.toString();

  console.log(`  DSEQ: ${dseq}`);

  // 4. Create deployment transaction
  console.log("[4/6] Creating deployment (signing transaction)...");

  // Use chain-sdk groups - these include correct endpoints and resource encoding
  // that match the manifest, ensuring cross-validation passes
  const sdlGroups = sdl.groups();

  const createDeploymentMsg = {
    typeUrl: "/akash.deployment.v1beta4.MsgCreateDeployment",
    value: {
      id: {
        owner,
        dseq: BigInt(dseq),
      },
      groups: sdlGroups,
      hash: version,
      deposit: {
        amount: {
          denom: deposit.denom,
          amount: deposit.amount,
        },
        sources: [1], // Source.balance — fund deposit from account balance
      },
    },
  };

  let deployTxResult: DeliverTxResponse;
  try {
    deployTxResult = await signingClient.signAndBroadcast(
      owner,
      [createDeploymentMsg],
      "auto",
      "Akash deployment via agent-pay"
    );
    assertIsDeliverTxSuccess(deployTxResult);
    console.log(`  Tx hash: ${deployTxResult.transactionHash}`);
  } catch (error: any) {
    throw new Error(`Failed to create deployment: ${error.message}`);
  }

  // 5. Wait for bids
  console.log(`[5/6] Waiting for provider bids (${bidWaitSeconds}s)...`);

  let selectedBid: BidInfo | null = null;
  const bidStartTime = Date.now();
  const bidTimeout = bidWaitSeconds * 1000;

  while (Date.now() - bidStartTime < bidTimeout) {
    await sleep(5000); // Poll every 5 seconds

    const bids = await queryBids(owner, dseq, network);
    const openBids = bids.filter(b => b.state === 1); // OPEN state

    if (openBids.length > 0) {
      // Filter by max price if specified
      let eligibleBids = openBids;
      if (maxBidPrice) {
        const maxPrice = parseInt(maxBidPrice);
        eligibleBids = openBids.filter(b => parseInt(b.price.amount) <= maxPrice);
      }

      selectedBid = selectBestBid(eligibleBids);
      if (selectedBid) {
        console.log(`  Found ${openBids.length} bids, selected: ${selectedBid.bidId.provider}`);
        console.log(`  Price: ${(parseInt(selectedBid.price.amount) / 1_000_000).toFixed(6)} USDC/block`);
        break;
      }
    }

    const elapsed = Math.round((Date.now() - bidStartTime) / 1000);
    process.stdout.write(`\r  Waiting for bids... ${elapsed}s / ${bidWaitSeconds}s`);
  }

  process.stdout.write("\n");

  if (!selectedBid) {
    throw new Error("No bids received within timeout. Try increasing bid wait time or adjusting specs.");
  }

  // 6. Create lease
  console.log("[6/6] Creating lease (signing transaction)...");

  const createLeaseMsg = {
    typeUrl: "/akash.market.v1beta5.MsgCreateLease",
    value: {
      bidId: {
        owner: selectedBid.bidId.owner,
        dseq: BigInt(selectedBid.bidId.dseq),
        gseq: selectedBid.bidId.gseq,
        oseq: selectedBid.bidId.oseq,
        provider: selectedBid.bidId.provider,
        bseq: 0,
      },
    },
  };

  let leaseTxResult: DeliverTxResponse;
  try {
    leaseTxResult = await signingClient.signAndBroadcast(
      owner,
      [createLeaseMsg],
      "auto",
      "Akash lease creation via agent-pay"
    );
    assertIsDeliverTxSuccess(leaseTxResult);
    console.log(`  Tx hash: ${leaseTxResult.transactionHash}`);
  } catch (error: any) {
    throw new Error(`Failed to create lease: ${error.message}`);
  }

  // 7. Get provider host and send manifest
  console.log("\n[Manifest] Sending deployment manifest to provider...");

  const providerInfo = await queryProvider(selectedBid.bidId.provider, network);
  const providerHost = providerInfo?.provider?.host_uri || "";

  // Generate JWT token for provider authentication
  const jwtToken = await generateProviderJwt(aminoWallet);

  if (!providerHost) {
    throw new Error("Provider host not found. Cannot send manifest.");
  }

  // Retry manifest send with delays - provider may need time to sync cert from chain
  const maxRetries = 5;
  const retryDelayMs = 3000;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sendManifest(
        providerHost,
        owner,
        dseq,
        selectedBid.bidId.gseq,
        selectedBid.bidId.oseq,
        sdl,
        cert,
        jwtToken
      );
      console.log("  Manifest sent successfully");
      lastError = null;
      break;
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries) {
        console.log(`  Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
        console.log(`  Retrying in ${retryDelayMs/1000}s...`);
        await sleep(retryDelayMs);
      }
    }
  }

  if (lastError) {
    // Close the deployment to refund the deposit since manifest failed
    console.error(`\n  Failed to send manifest after ${maxRetries} attempts: ${lastError.message}`);
    console.error("  Closing deployment to refund deposit...");
    try {
      await closeDeployment(wallet, dseq, network);
    } catch (closeError: any) {
      console.error(`  Warning: Could not close deployment: ${closeError.message}`);
    }
    throw new Error(`Manifest rejected by provider: ${lastError.message}`);
  }

  // 8. Get deployment endpoints
  const endpoints = await getDeploymentEndpoints(
    providerHost,
    owner,
    dseq,
    selectedBid.bidId.gseq,
    selectedBid.bidId.oseq,
    cert,
    jwtToken
  );

  const result: DeploymentResult = {
    dseq,
    gseq: selectedBid.bidId.gseq,
    oseq: selectedBid.bidId.oseq,
    owner,
    provider: selectedBid.bidId.provider,
    providerHost,
    lease: {
      dseq,
      gseq: selectedBid.bidId.gseq,
      oseq: selectedBid.bidId.oseq,
      provider: selectedBid.bidId.provider,
    },
    endpoints,
    txHashes: {
      deployment: deployTxResult.transactionHash,
      lease: leaseTxResult.transactionHash,
    },
  };

  console.log("\nDeployment successful!");
  console.log(`  DSEQ: ${result.dseq}`);
  console.log(`  Provider: ${result.provider}`);
  if (result.endpoints.length > 0) {
    console.log("  Endpoints:");
    for (const ep of result.endpoints) {
      console.log(`    ${ep.protocol}://${ep.host}:${ep.externalPort}`);
    }
  }

  return result;
}

/**
 * Close a deployment
 */
export async function closeDeployment(
  wallet: DirectSecp256k1HdWallet,
  dseq: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<{ txHash: string }> {
  const [account] = await wallet.getAccounts();
  const owner = account.address;

  console.log(`\nClosing deployment ${dseq}...`);

  const signingClient = await createSigningClient(wallet, network);

  const closeMsg = {
    typeUrl: "/akash.deployment.v1beta4.MsgCloseDeployment",
    value: {
      id: {
        owner,
        dseq: BigInt(dseq),
      },
    },
  };

  const txResult = await signingClient.signAndBroadcast(
    owner,
    [closeMsg],
    "auto",
    "Close Akash deployment via agent-pay"
  );

  assertIsDeliverTxSuccess(txResult);

  console.log(`  Tx hash: ${txResult.transactionHash}`);
  console.log("  Deployment closed. Unused funds will be refunded.");

  return { txHash: txResult.transactionHash };
}

/**
 * Send manifest to provider with mTLS + JWT authentication
 *
 * Uses the chain-sdk's manifestSorted() method which produces the exact format
 * that matches the version hash stored on-chain:
 * - String values for ResourceValue.val fields
 * - "size" key for memory/storage (not "quantity")
 * - Canonically sorted keys
 */
async function sendManifest(
  providerHost: string,
  owner: string,
  dseq: string,
  gseq: number,
  oseq: number,
  sdl: SDL,
  cert: { cert: string; privateKey: string },
  jwtToken: string
): Promise<void> {
  // Get manifest from chain-sdk using manifestSorted() - this produces the exact format
  // that was used to compute the version hash (string values, "size" key, sorted)
  const manifest = sdl.manifestSorted();

  const url = `${providerHost}/deployment/${dseq}/manifest`;

  // Use the pre-sorted JSON string directly to preserve key ordering
  const manifestJson = sdl.manifestSortedJSON();

  const response = await jwtFetch(url, jwtToken, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: manifestJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Provider rejected manifest: ${response.status} - ${errorText}`);
  }
}

/**
 * Get deployment endpoints from provider (with JWT auth)
 */
async function getDeploymentEndpoints(
  providerHost: string,
  owner: string,
  dseq: string,
  gseq: number,
  oseq: number,
  cert: { cert: string; privateKey: string },
  jwtToken: string
): Promise<DeploymentEndpoint[]> {
  if (!providerHost) {
    return [];
  }

  try {
    const url = `${providerHost}/lease/${dseq}/${gseq}/${oseq}/status`;
    const response = await jwtFetch(url, jwtToken);

    if (!response.ok) {
      return [];
    }

    const status = await response.json();
    const endpoints: DeploymentEndpoint[] = [];

    // Parse forwarded ports from status
    if (status.forwarded_ports) {
      for (const service of Object.values<any>(status.forwarded_ports)) {
        for (const port of service) {
          endpoints.push({
            host: port.host || providerHost.replace(/^https?:\/\//, ""),
            port: port.port,
            externalPort: port.externalPort,
            protocol: port.proto || "tcp",
          });
        }
      }
    }

    return endpoints;
  } catch {
    return [];
  }
}

