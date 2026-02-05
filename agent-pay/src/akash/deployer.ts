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
import { sha256 } from "@cosmjs/crypto";
import type { ComputeSpecs } from "../types.js";
import {
  createSigningClient,
  getCurrentBlockHeight,
  queryBids,
  selectBestBid,
  queryProvider,
  AKT_DENOM,
  type BidInfo,
} from "./sdk-client.js";
import { generateSDL, calculateDeposit, sdlToYaml } from "./sdl-generator.js";
import { getOrCreateCertificate, generateProviderJwt, mtlsFetch } from "./certificate.js";

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
 * Calculate SDL version hash
 */
function calculateVersion(sdl: any): Uint8Array {
  const sdlJson = JSON.stringify(sdl);
  return sha256(new TextEncoder().encode(sdlJson));
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

  // 2. Generate SDL and calculate deposit
  console.log("[3/6] Generating deployment manifest...");
  const sdl = generateSDL(specs, env, command);
  const deposit = calculateDeposit(specs, specs.hours);
  const version = calculateVersion(sdl);

  console.log(`  Deposit: ${(parseInt(deposit.amount) / 1_000_000).toFixed(6)} AKT (escrowed, refunded on close)`);

  // 3. Get current block height for DSEQ
  const blockHeight = await getCurrentBlockHeight(network);
  const dseq = blockHeight.toString();

  console.log(`  DSEQ: ${dseq}`);

  // 4. Create deployment transaction
  console.log("[4/6] Creating deployment (signing transaction)...");

  // Helper to encode a number string as Uint8Array (Akash v1beta4 resource encoding)
  const encodeResourceVal = (val: string): Uint8Array =>
    new TextEncoder().encode(val);

  // Build the deployment message (v1beta4 format)
  const createDeploymentMsg = {
    typeUrl: "/akash.deployment.v1beta4.MsgCreateDeployment",
    value: {
      id: {
        owner,
        dseq: BigInt(dseq),
      },
      groups: [
        {
          name: "dcloud",
          requirements: {
            signedBy: {
              allOf: [],
              anyOf: ["akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63"],
            },
            attributes: [],
          },
          resources: [
            {
              resource: {
                id: 1,
                cpu: { units: { val: encodeResourceVal(`${specs.cpu * 1000}`) }, attributes: [] },
                memory: { quantity: { val: encodeResourceVal(parseBytes(specs.memory).toString()) }, attributes: [] },
                gpu: { units: { val: encodeResourceVal(specs.gpu ? `${specs.gpu.count}` : "0") }, attributes: specs.gpu?.model ? [{ key: "vendor/nvidia/model", value: specs.gpu.model }] : [] },
                storage: [{ name: "default", quantity: { val: encodeResourceVal(parseBytes(specs.storage).toString()) }, attributes: [] }],
                endpoints: [],
              },
              count: 1,
              price: {
                denom: AKT_DENOM,
                amount: calculateHourlyPrice(specs).toString(),
              },
            },
          ],
        },
      ],
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
 */
async function sendManifest(
  providerHost: string,
  owner: string,
  dseq: string,
  gseq: number,
  oseq: number,
  sdl: any,
  cert: { cert: string; privateKey: string },
  jwtToken: string
): Promise<void> {
  // The provider expects the manifest in a specific format
  const manifest = sdlToManifest(sdl);

  const url = `${providerHost}/deployment/${dseq}/manifest`;

  const response = await mtlsFetch(url, cert as any, jwtToken, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(manifest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Provider rejected manifest: ${response.status} - ${errorText}`);
  }
}

/**
 * Convert SDL to manifest format for provider
 * Manifest structure: array of groups, each containing services
 *
 * ResourceValue.val is a plain string number (parsed by Go as *big.Int)
 */
function sdlToManifest(sdl: any): any {
  // Build services array for the group
  const services: any[] = [];

  for (const [serviceName, service] of Object.entries<any>(sdl.services)) {
    const resources = sdl.profiles.compute[serviceName]?.resources || {};

    // Get CPU value in millicores, strip 'm' suffix if present
    const cpuMillicores = resources.cpu?.units?.replace(/m$/, "") || "1000";

    // Get memory value in bytes
    const memoryBytes = resources.memory?.size
      ? parseStorageSize(resources.memory.size)
      : "536870912";

    services.push({
      name: serviceName,
      image: service.image,
      command: service.command || null,
      args: service.args || null,
      env: service.env?.map((e: string) => {
        const [key, ...valueParts] = e.split("=");
        return { name: key, value: valueParts.join("=") };
      }) || null,
      resources: {
        id: 1,
        cpu: {
          units: { val: cpuMillicores },
          attributes: [],
        },
        memory: {
          quantity: { val: memoryBytes },
          attributes: [],
        },
        storage: (resources.storage || [{ size: "1Gi" }]).map((s: any) => ({
          name: "default",
          quantity: { val: parseStorageSize(s.size) },
          attributes: [],
        })),
        gpu: {
          units: { val: resources.gpu?.units || "0" },
          attributes: resources.gpu?.model
            ? [{ key: "vendor/nvidia/model", value: resources.gpu.model }]
            : [],
        },
        endpoints: [],
      },
      count: 1,
      expose: service.expose?.map((e: any) => ({
        port: e.port,
        externalPort: e.as || e.port,
        proto: (e.proto || "TCP").toUpperCase(),
        service: serviceName,
        global: e.to?.some((t: any) => t.global) || false,
        hosts: null,
      })) || [],
    });
  }

  // Return manifest as array of groups (we use one group named "dcloud")
  return [
    {
      name: "dcloud",
      services,
    },
  ];
}

/**
 * Get deployment endpoints from provider (with mTLS + JWT)
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
    const response = await mtlsFetch(url, cert as any, jwtToken);

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

/**
 * Parse storage size string to bytes string (for manifest)
 */
function parseStorageSize(size: string): string {
  return parseBytes(size).toString();
}

/**
 * Parse bytes from size string
 */
function parseBytes(size: string): number {
  const units: Record<string, number> = {
    "b": 1,
    "kb": 1024,
    "mb": 1024 * 1024,
    "gb": 1024 * 1024 * 1024,
    "tb": 1024 * 1024 * 1024 * 1024,
    "ki": 1024,
    "mi": 1024 * 1024,
    "gi": 1024 * 1024 * 1024,
    "ti": 1024 * 1024 * 1024 * 1024,
  };

  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|Ki|Mi|Gi|Ti)?$/i);
  if (!match) {
    throw new Error(`Invalid size format: ${size}`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || "B").toLowerCase();
  const multiplier = units[unit] || 1;

  return Math.floor(value * multiplier);
}

/**
 * Calculate hourly price for specs (in micro USDC)
 */
function calculateHourlyPrice(specs: ComputeSpecs): number {
  const memoryBytes = parseBytes(specs.memory);
  const storageBytes = parseBytes(specs.storage);

  const cpuCost = specs.cpu * 50000; // $0.05 per CPU
  const memoryCostPerGi = 10000; // $0.01 per Gi
  const storageCostPerGi = 5000; // $0.005 per Gi
  const gpuCost = specs.gpu ? specs.gpu.count * 500000 : 0; // $0.50 per GPU

  const memoryGi = memoryBytes / (1024 * 1024 * 1024);
  const storageGi = storageBytes / (1024 * 1024 * 1024);

  return Math.ceil(
    cpuCost +
    memoryCostPerGi * memoryGi +
    storageCostPerGi * storageGi +
    gpuCost
  );
}
