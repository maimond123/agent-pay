/**
 * Trustless Transaction Construction & Broadcast
 *
 * Constructs unsigned Cosmos/Akash transactions for external agents to sign.
 * Agent B (our MCP server) builds the TX, Agent A signs with their secp256k1 key.
 *
 * Flow:
 * 1. Agent B constructs protobuf SignDoc (TxBody + AuthInfo + chainId + accountNumber)
 * 2. Agent A computes sha256(signDocBytes) → secp256k1_sign(hash, privateKey) → 64-byte signature
 * 3. Agent A calls broadcast_cosmos_tx with signature + bodyBytes + authInfoBytes
 * 4. Agent B assembles TxRaw and broadcasts to Akash chain
 */

import { StargateClient, defaultRegistryTypes } from "@cosmjs/stargate";
import {
  Registry,
  makeAuthInfoBytes,
  makeSignDoc,
  makeSignBytes,
  encodePubkey,
  type EncodeObject,
} from "@cosmjs/proto-signing";
import { getAkashTypeRegistry } from "@akashnetwork/akashjs/build/stargate/index.js";
import { fromHex, toHex } from "@cosmjs/encoding";
import { AKASH_RPC_ENDPOINTS } from "./sdk-client.js";

// Import cosmjs-types via createRequire for Node16 module compat
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { TxBody, TxRaw } = require("cosmjs-types/cosmos/tx/v1beta1/tx") as {
  TxBody: {
    encode: (value: any) => { finish: () => Uint8Array };
    fromPartial: (value: any) => any;
  };
  TxRaw: {
    encode: (value: any) => { finish: () => Uint8Array };
    fromPartial: (value: any) => any;
  };
};

// Shared registry with both default CosmJS types and Akash-specific types
let _registry: Registry | null = null;

function getRegistry(): Registry {
  if (!_registry) {
    _registry = new Registry([
      ...defaultRegistryTypes,
      ...getAkashTypeRegistry(),
    ]);
  }
  return _registry;
}

// Chain IDs
const CHAIN_IDS = {
  mainnet: "akashnet-2",
  testnet: "sandbox-01",
} as const;

export interface UnsignedTxResult {
  signDocBytes: string;   // hex-encoded SignDoc bytes (Agent A sha256+signs this)
  bodyBytes: string;      // hex-encoded TxBody bytes (needed for broadcast)
  authInfoBytes: string;  // hex-encoded AuthInfo bytes (needed for broadcast)
  gasLimit: number;       // gas limit used in the fee
  fee: { amount: string; denom: string }; // fee amount
}

export interface BroadcastResult {
  txHash: string;
  code: number;
  gasUsed: string;
  rawLog?: string;
}

/**
 * Query account info (accountNumber + sequence) from chain.
 * Returns null if account doesn't exist yet (unfunded).
 */
export async function queryAccountInfo(
  address: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<{ accountNumber: number; sequence: number } | null> {
  console.error(
    `[agent-pay:trustless:queryAccountInfo] Querying account ${address} on ${network}`
  );

  const client = await getStargateClient(network);
  const account = await client.getAccount(address);

  if (!account) {
    console.error(
      `[agent-pay:trustless:queryAccountInfo] Account ${address} not found (unfunded)`
    );
    return null;
  }

  console.error(
    `[agent-pay:trustless:queryAccountInfo] Account ${address} → number=${account.accountNumber}, sequence=${account.sequence}`
  );

  return {
    accountNumber: account.accountNumber,
    sequence: account.sequence,
  };
}

/**
 * Simulate a transaction to estimate gas.
 * Constructs a TX with a dummy signature and sends it to the simulate endpoint.
 * Returns estimated gas with a 1.3x multiplier for safety.
 */
export async function simulateGas(params: {
  messages: EncodeObject[];
  senderPubkey: Uint8Array;
  accountNumber: number;
  sequence: number;
  network?: "mainnet" | "testnet";
  memo?: string;
}): Promise<number> {
  const {
    messages,
    senderPubkey,
    accountNumber,
    sequence,
    network = "mainnet",
    memo = "",
  } = params;

  console.error(
    `[agent-pay:trustless:simulateGas] Simulating ${messages.length} msgs for gas estimation`
  );

  const registry = getRegistry();

  // Encode messages as Any for the simulate RPC
  const encodedMsgs = messages.map((msg) => registry.encodeAsAny(msg));

  // The query client's tx.simulate expects (messages, memo, signerPubkey, sequence)
  // where signerPubkey is an amino-style pubkey { type, value }
  const aminoPubkey = {
    type: "tendermint/PubKeySecp256k1",
    value: Buffer.from(senderPubkey).toString("base64"),
  };

  const client = await getStargateClient(network);
  const queryClient = (client as any).forceGetQueryClient();

  try {
    const simResult = await queryClient.tx.simulate(
      encodedMsgs,
      memo,
      aminoPubkey,
      sequence,
    );
    const gasUsed = Number(simResult.gasInfo?.gasUsed ?? 0);
    const estimated = Math.ceil(gasUsed * 1.3); // 1.3x multiplier

    console.error(
      `[agent-pay:trustless:simulateGas] Simulation result: gasUsed=${gasUsed}, estimated (1.3x)=${estimated}`
    );

    return estimated;
  } catch (error: any) {
    console.error(
      `[agent-pay:trustless:simulateGas] Simulation failed: ${error.message}. Using fallback gas estimate.`
    );

    // Fallback: conservative fixed estimates per message type
    return estimateGasFallback(messages);
  }
}

/**
 * Fallback gas estimation when simulation fails (e.g., account doesn't exist yet).
 * Uses conservative fixed estimates per message type.
 */
function estimateGasFallback(messages: EncodeObject[]): number {
  const GAS_MAP: Record<string, number> = {
    "/akash.cert.v1.MsgCreateCertificate": 300_000,
    "/akash.deployment.v1beta4.MsgCreateDeployment": 1_000_000,
    "/akash.market.v1beta5.MsgCreateLease": 300_000,
    "/akash.deployment.v1beta4.MsgCloseDeployment": 300_000,
  };

  let total = 0;
  for (const msg of messages) {
    total += GAS_MAP[msg.typeUrl] ?? 500_000;
  }

  console.error(
    `[agent-pay:trustless:estimateGasFallback] Fallback gas for ${messages.length} msgs: ${total}`
  );

  return total;
}

/**
 * Construct an unsigned transaction for an external agent to sign.
 * Returns the SignDoc bytes (to be sha256+signed), plus bodyBytes and authInfoBytes
 * for reassembling after signing.
 *
 * Gas is estimated via simulation when possible, with a fallback to fixed estimates.
 */
export async function constructUnsignedTx(params: {
  messages: EncodeObject[];
  senderPubkey: Uint8Array;
  accountNumber: number;
  sequence: number;
  network?: "mainnet" | "testnet";
  memo?: string;
}): Promise<UnsignedTxResult> {
  const {
    messages,
    senderPubkey,
    accountNumber,
    sequence,
    network = "mainnet",
    memo = "",
  } = params;

  const chainId = CHAIN_IDS[network];
  const registry = getRegistry();

  // Estimate gas via simulation
  const gasLimit = await simulateGas(params);

  // Calculate fee: gasLimit * 0.025 uakt
  const feeAmount = Math.ceil(gasLimit * 0.025).toString();

  console.error(
    `[agent-pay:trustless:constructUnsignedTx] ${messages.length} msgs, gas=${gasLimit}, fee=${feeAmount}uakt, chain=${chainId}`
  );

  // Encode messages into TxBody
  const encodedMsgs = messages.map((msg) => registry.encodeAsAny(msg));
  const txBody = TxBody.fromPartial({ messages: encodedMsgs, memo });
  const bodyBytes = TxBody.encode(txBody).finish();

  // Build AuthInfo
  const pubkeyEncoded = encodePubkey({
    type: "tendermint/PubKeySecp256k1",
    value: Buffer.from(senderPubkey).toString("base64"),
  });

  const authInfoBytes = makeAuthInfoBytes(
    [{ pubkey: pubkeyEncoded, sequence }],
    [{ denom: "uakt", amount: feeAmount }],
    gasLimit,
    undefined, // feeGranter
    undefined, // feePayer
  );

  // Build SignDoc and serialize
  const signDoc = makeSignDoc(bodyBytes, authInfoBytes, chainId, accountNumber);
  const signDocBytes = makeSignBytes(signDoc);

  return {
    signDocBytes: toHex(signDocBytes),
    bodyBytes: toHex(bodyBytes),
    authInfoBytes: toHex(authInfoBytes),
    gasLimit,
    fee: { amount: feeAmount, denom: "uakt" },
  };
}

/**
 * Broadcast a signed transaction to the Akash chain.
 * Takes the bodyBytes + authInfoBytes from constructUnsignedTx, plus Agent A's signature.
 */
export async function broadcastSignedTx(params: {
  bodyBytes: string;      // hex
  authInfoBytes: string;  // hex
  signature: string;      // hex, 64 bytes (r||s). If 65 bytes, last byte (v) is stripped.
  network?: "mainnet" | "testnet";
}): Promise<BroadcastResult> {
  const { bodyBytes, authInfoBytes, network = "mainnet" } = params;

  // Handle 64 or 65 byte signatures
  let sigHex = params.signature.startsWith("0x")
    ? params.signature.slice(2)
    : params.signature;

  const sigBytes = fromHex(sigHex);
  let signature: Uint8Array;

  if (sigBytes.length === 64) {
    signature = sigBytes;
  } else if (sigBytes.length === 65) {
    // Strip v byte (EVM recovery byte)
    signature = sigBytes.slice(0, 64);
    console.error(
      `[agent-pay:trustless:broadcastSignedTx] Stripped v byte from 65-byte signature`
    );
  } else {
    throw new Error(
      `Invalid signature length: expected 64 or 65 bytes, got ${sigBytes.length}`
    );
  }

  // Assemble TxRaw
  const txRaw = TxRaw.fromPartial({
    bodyBytes: fromHex(bodyBytes),
    authInfoBytes: fromHex(authInfoBytes),
    signatures: [signature],
  });
  const txBytes = TxRaw.encode(txRaw).finish();

  console.error(
    `[agent-pay:trustless:broadcastSignedTx] Broadcasting TX (${txBytes.length} bytes) on ${network}...`
  );

  // Broadcast
  const client = await getStargateClient(network);
  const result = await client.broadcastTx(txBytes);

  const broadcastResult: BroadcastResult = {
    txHash: result.transactionHash,
    code: result.code,
    gasUsed: result.gasUsed?.toString() ?? "0",
    rawLog: result.code !== 0 ? (result as any).rawLog : undefined,
  };

  console.error(
    `[agent-pay:trustless:broadcastSignedTx] TX hash=${broadcastResult.txHash}, code=${broadcastResult.code}, gasUsed=${broadcastResult.gasUsed}`
  );

  return broadcastResult;
}

// --- Message Constructors ---

/**
 * Construct MsgCreateDeployment
 */
export function constructDeploymentMsg(
  owner: string,
  dseq: string,
  sdlGroups: any[],
  version: Uint8Array,
  deposit: { amount: string; denom: string }
): EncodeObject {
  return {
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
}

/**
 * Construct MsgCreateLease
 */
export function constructLeaseMsg(bidId: {
  owner: string;
  dseq: string;
  gseq: number;
  oseq: number;
  provider: string;
}): EncodeObject {
  return {
    typeUrl: "/akash.market.v1beta5.MsgCreateLease",
    value: {
      bidId: {
        owner: bidId.owner,
        dseq: BigInt(bidId.dseq),
        gseq: bidId.gseq,
        oseq: bidId.oseq,
        provider: bidId.provider,
        bseq: 0,
      },
    },
  };
}

/**
 * Construct MsgCloseDeployment
 */
export function constructCloseMsg(owner: string, dseq: string): EncodeObject {
  return {
    typeUrl: "/akash.deployment.v1beta4.MsgCloseDeployment",
    value: {
      id: {
        owner,
        dseq: BigInt(dseq),
      },
    },
  };
}

/**
 * Construct MsgCreateCertificate
 * The cert and pubkey PEM strings are base64-decoded to bytes for the protobuf message.
 */
export function constructCertificateMsg(
  address: string,
  certPem: string,
  pubKeyPem: string
): EncodeObject {
  // The akashjs broadcastCertificate does: toBase64(pem) → base64ToUInt
  // PEM strings are already base64-encoded DER, so we extract the base64 body
  const certBytes = pemToBytes(certPem);
  const pubkeyBytes = pemToBytes(pubKeyPem);

  return {
    typeUrl: "/akash.cert.v1.MsgCreateCertificate",
    value: {
      owner: address,
      cert: certBytes,
      pubkey: pubkeyBytes,
    },
  };
}

/**
 * Extract the binary content from a PEM-encoded string.
 * Removes header/footer lines and decodes the base64 body.
 */
function pemToBytes(pem: string): Uint8Array {
  const lines = pem
    .split("\n")
    .filter((line) => !line.startsWith("-----") && line.trim().length > 0);
  const base64 = lines.join("");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

// --- JWT / ADR-036 Amino Signing ---

/**
 * Construct an ADR-036 amino sign doc for JWT authentication.
 * Returns the canonical JSON string that Agent A must sha256 + secp256k1_sign,
 * plus the JWT header and payload for reassembly after signing.
 */
export function constructAminoJwtSignDoc(
  address: string,
  expiresInSeconds: number = 3600
): {
  signDocCanonicalJson: string;
  jwtHeader: string;
  jwtPayload: string;
} {
  const now = Math.floor(Date.now() / 1000);

  // JWT header
  const header = { alg: "ES256KADR36", typ: "JWT" };
  const jwtHeader = base64url(JSON.stringify(header));

  // JWT payload
  const payload = {
    version: "v1",
    iss: address,
    iat: now,
    nbf: now,
    exp: now + expiresInSeconds,
    leases: { access: "full" },
  };
  const jwtPayload = base64url(JSON.stringify(payload));

  // ADR-036 amino sign doc
  // The data to sign is the JWT payload section (header.payload is signed in standard JWT)
  const dataToSign = `${jwtHeader}.${jwtPayload}`;
  const dataBase64 = Buffer.from(dataToSign).toString("base64");

  // Canonical amino sign doc (keys must be sorted alphabetically at every level)
  const signDoc = {
    account_number: "0",
    chain_id: "",
    fee: { amount: [], gas: "0" },
    memo: "",
    msgs: [
      {
        type: "sign/MsgSignData",
        value: {
          data: dataBase64,
          signer: address,
        },
      },
    ],
    sequence: "0",
  };

  // Canonical JSON: keys sorted alphabetically at every nesting level
  const signDocCanonicalJson = sortedJsonStringify(signDoc);

  console.error(
    `[agent-pay:trustless:constructAminoJwtSignDoc] JWT for ${address}, expires in ${expiresInSeconds}s`
  );

  return { signDocCanonicalJson, jwtHeader, jwtPayload };
}

/**
 * Assemble a complete JWT token from the header, payload, and Agent A's amino signature.
 *
 * The third segment is the raw 64-byte signature in base64url — matching the chain-sdk
 * JwtTokenManager format. The provider obtains the public key from the on-chain account
 * (published when the first TX was sent), so the pubkey is NOT embedded in the JWT.
 */
export function assembleJwt(
  jwtHeader: string,
  jwtPayload: string,
  signature: string, // hex, 64 bytes (r||s)
  _pubkey?: Uint8Array  // unused — kept for backward compat, provider gets pubkey from chain
): string {
  // Strip 0x prefix if present
  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBytes = fromHex(sigHex);

  // The JWT signature segment is base64url(rawSignatureBytes) — just the raw 64-byte
  // secp256k1 signature. This matches how @akashnetwork/chain-sdk's JwtTokenManager
  // encodes it: toBase64Url(StdSignature.signature), which is base64url of the raw sig.
  const sigBase64 = Buffer.from(sigBytes).toString("base64");
  const jwtSignature = sigBase64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const jwt = `${jwtHeader}.${jwtPayload}.${jwtSignature}`;

  console.error(`[agent-pay:trustless:assembleJwt] Assembled JWT token`);

  return jwt;
}

// --- Helpers ---

let _stargateClients: Record<string, StargateClient> = {};

async function getStargateClient(
  network: "mainnet" | "testnet"
): Promise<StargateClient> {
  if (_stargateClients[network]) {
    return _stargateClients[network];
  }

  const endpoints = AKASH_RPC_ENDPOINTS[network];
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const client = await StargateClient.connect(endpoint);
      _stargateClients[network] = client;
      return client;
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError || new Error("Failed to connect to any Akash RPC endpoint");
}

/**
 * JSON stringify with sorted keys at every level (canonical JSON).
 */
function sortedJsonStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(sortedJsonStringify).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(
    (key) => JSON.stringify(key) + ":" + sortedJsonStringify(obj[key])
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Base64url encode (no padding, URL-safe chars)
 */
function base64url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
