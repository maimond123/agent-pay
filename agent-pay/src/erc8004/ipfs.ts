/**
 * IPFS Upload via Pinata
 *
 * Uploads agent metadata JSON to IPFS using Pinata's HTTP API.
 * No extra dependencies — uses native fetch.
 *
 * Requires PINATA_JWT environment variable (free account at https://app.pinata.cloud).
 */

import type { AgentMetadata } from "./agent-metadata.js";

const PINATA_PIN_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

/**
 * Upload agent metadata to IPFS via Pinata.
 * Returns the IPFS URI (ipfs://Qm...).
 */
export async function uploadToIPFS(metadata: AgentMetadata): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error(
      "PINATA_JWT environment variable not set.\n" +
        "Create a free account at https://app.pinata.cloud and get a JWT from API Keys."
    );
  }

  console.error("[agent-pay:ipfs] Uploading agent metadata to IPFS via Pinata...");

  const response = await fetch(PINATA_PIN_JSON_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: {
        name: "agent-pay-registration.json",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pinata upload failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as { IpfsHash: string };
  const ipfsURI = `ipfs://${result.IpfsHash}`;

  console.error(`[agent-pay:ipfs] Uploaded successfully: ${ipfsURI}`);
  return ipfsURI;
}
