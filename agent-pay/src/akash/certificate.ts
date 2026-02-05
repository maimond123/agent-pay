/**
 * Akash Certificate and Authentication Manager
 *
 * Manages authentication with Akash providers using:
 * 1. mTLS certificates - establishes secure connection identity
 * 2. JWT tokens - provides authorization for specific actions
 *
 * Flow:
 * 1. Generate a self-signed x509 certificate (ECDSA secp256r1)
 * 2. Broadcast MsgCreateCertificate to register cert on the Akash chain
 * 3. Store cert + private key locally
 * 4. Generate JWT tokens signed by the wallet for provider API calls
 * 5. Use cert for mTLS + JWT for Authorization header
 */

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { assertIsDeliverTxSuccess } from "@cosmjs/stargate";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import https from "https";
import { createCertificate, broadcastCertificate } from "@akashnetwork/akashjs/build/certificates/index.js";
import { JwtTokenManager } from "@akashnetwork/chain-sdk";
import { createSigningClient } from "./sdk-client.js";

const CERT_DIR = join(homedir(), ".agent-pay", "certs");

interface StoredCert {
  cert: string;      // PEM-encoded x509 certificate
  publicKey: string;  // PEM-encoded public key
  privateKey: string; // PEM-encoded private key
  createdAt: string;
  txHash: string;
}

/**
 * Get or create an mTLS certificate for the given address.
 * If a valid cert exists on disk, returns it.
 * Otherwise generates a new one, broadcasts it on-chain, and stores it.
 */
export async function getOrCreateCertificate(
  wallet: DirectSecp256k1HdWallet,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<StoredCert> {
  const [account] = await wallet.getAccounts();
  const address = account.address;
  const certPath = join(CERT_DIR, `${address}.json`);

  // Check for existing cert
  if (existsSync(certPath)) {
    const stored: StoredCert = JSON.parse(readFileSync(certPath, "utf8"));
    console.log("  Using existing certificate");
    return stored;
  }

  console.log("  Generating new mTLS certificate...");

  // 1. Generate self-signed certificate
  const pem = await createCertificate(address);

  // 2. Broadcast to chain
  console.log("  Broadcasting certificate to chain...");
  const signingClient = await createSigningClient(wallet, network);
  // Cast to any to work around version mismatch between our @cosmjs/stargate
  // and the one bundled inside @akashnetwork/akashjs
  const txResult = await broadcastCertificate(
    { cert: pem.cert, publicKey: pem.publicKey },
    address,
    signingClient as any
  );
  assertIsDeliverTxSuccess(txResult);
  console.log(`  Certificate registered (tx: ${txResult.transactionHash})`);

  // 3. Store locally
  if (!existsSync(CERT_DIR)) {
    mkdirSync(CERT_DIR, { recursive: true });
  }

  const stored: StoredCert = {
    cert: pem.cert,
    publicKey: pem.publicKey,
    privateKey: pem.privateKey,
    createdAt: new Date().toISOString(),
    txHash: txResult.transactionHash,
  };

  writeFileSync(certPath, JSON.stringify(stored, null, 2));

  return stored;
}

/**
 * Generate a JWT token for provider API authentication.
 * The token is signed by the amino wallet and grants full lease access.
 * Requires Secp256k1HdWallet (amino) because it has signAmino for ADR-036 signing.
 */
export async function generateProviderJwt(
  aminoWallet: Secp256k1HdWallet,
  expiresInSeconds: number = 3600
): Promise<string> {
  const [account] = await aminoWallet.getAccounts();
  const address = account.address;

  // JwtTokenManager auto-wraps OfflineAminoSigner with createOfflineDataSigner
  const tokenManager = new JwtTokenManager(aminoWallet);

  const now = Math.floor(Date.now() / 1000);

  const token = await tokenManager.generateToken({
    version: "v1",
    iss: address,
    iat: now,
    nbf: now,
    exp: now + expiresInSeconds,
    leases: { access: "full" },
  });

  return token;
}

/**
 * Create an HTTPS agent configured with the mTLS client certificate.
 * This agent is used for all requests to Akash providers.
 */
export function createMtlsAgent(cert: StoredCert): https.Agent {
  return new https.Agent({
    cert: cert.cert,
    key: cert.privateKey,
    rejectUnauthorized: false, // Provider certs are self-signed
  });
}

/**
 * Fetch with mTLS client certificate + JWT bearer token authentication.
 * Uses Node.js https module directly since global fetch doesn't support client certs easily.
 */
export async function mtlsFetch(
  url: string,
  cert: StoredCert,
  jwtToken: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        ...options.headers,
        "Authorization": `Bearer ${jwtToken}`,
      },
      cert: cert.cert,
      key: cert.privateKey,
      rejectUnauthorized: false, // Provider certs are self-signed
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 0,
          statusText: res.statusMessage || "",
          text: async () => data,
          json: async () => JSON.parse(data),
        });
      });
    });

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
