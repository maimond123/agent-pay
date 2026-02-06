/**
 * Prepare Certificate TX Tool
 *
 * Generates an mTLS certificate and constructs an unsigned MsgCreateCertificate TX.
 * The certificate is stored locally; Agent A must sign and broadcast the TX
 * to register it on-chain before it can be used for provider authentication.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  generateCertificateKeyPair,
  loadStoredCert,
  saveStoredCert,
  deleteStoredCert,
} from "../akash/index.js";
import {
  queryAccountInfo,
  constructUnsignedTx,
  constructCertificateMsg,
} from "../akash/index.js";
import { compressedPubkeyFromHex } from "../wallet/index.js";

export function registerPrepareCertificateTx(server: McpServer) {
  server.registerTool(
    "prepare_certificate_tx",
    {
      title: "Prepare Certificate Transaction",
      description:
        "Generates an mTLS certificate for Akash provider authentication and constructs " +
        "an unsigned MsgCreateCertificate transaction. The certificate is stored locally. " +
        "You must sign the returned signDocBytes and broadcast via broadcast_cosmos_tx. " +
        "If a certificate already exists for this address, returns its info without creating a new one.",
      inputSchema: {
        akashAddress: z
          .string()
          .describe("The Akash address to create the certificate for."),
        publicKey: z
          .string()
          .describe("Compressed secp256k1 public key (33 bytes, hex)."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network. Defaults to mainnet."),
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";
        const pubkey = compressedPubkeyFromHex(args.publicKey);

        console.error(
          `[agent-pay:prepare-certificate-tx] Preparing cert for ${args.akashAddress}`
        );

        // Check for existing cert
        const existing = loadStoredCert(args.akashAddress);
        if (existing) {
          console.error(
            `[agent-pay:prepare-certificate-tx] Cert already exists (tx: ${existing.txHash})`
          );

          const text = [
            "## Certificate Already Exists",
            "",
            `**Akash Address:** \`${args.akashAddress}\``,
            `**Created:** ${existing.createdAt}`,
            `**TX Hash:** \`${existing.txHash}\``,
            "",
            "A certificate already exists for this address. You can proceed to deployment.",
            "If you need to create a new certificate, delete the existing one first.",
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        // Check account exists on-chain
        const accountInfo = await queryAccountInfo(args.akashAddress, network);
        if (!accountInfo) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "## Account Not Found\n\n" +
                  `Account \`${args.akashAddress}\` does not exist on-chain.\n\n` +
                  "You must fund this address first (e.g., via bridge) before creating a certificate.",
              },
            ],
            isError: true,
          };
        }

        // Generate certificate key pair
        const certPem = await generateCertificateKeyPair(args.akashAddress);

        // Store cert locally (with placeholder txHash — will be real after broadcast)
        saveStoredCert(args.akashAddress, {
          cert: certPem.cert,
          publicKey: certPem.publicKey,
          privateKey: certPem.privateKey,
          createdAt: new Date().toISOString(),
          txHash: "pending", // Updated after successful broadcast
        });

        // Construct the MsgCreateCertificate
        const certMsg = constructCertificateMsg(
          args.akashAddress,
          certPem.cert,
          certPem.publicKey
        );

        // Construct unsigned TX
        const unsignedTx = await constructUnsignedTx({
          messages: [certMsg],
          senderPubkey: pubkey,
          accountNumber: accountInfo.accountNumber,
          sequence: accountInfo.sequence,
          network,
          memo: "mTLS certificate via agent-pay",
        });

        console.error(
          `[agent-pay:prepare-certificate-tx] TX constructed, gas=${unsignedTx.gasLimit}`
        );

        const text = [
          "## Certificate TX Ready to Sign",
          "",
          `**Akash Address:** \`${args.akashAddress}\``,
          `**Gas Limit:** ${unsignedTx.gasLimit}`,
          `**Fee:** ${unsignedTx.fee.amount} ${unsignedTx.fee.denom}`,
          "",
          "### Sign Doc (hex)",
          "```",
          unsignedTx.signDocBytes,
          "```",
          "",
          "### Body Bytes (hex)",
          "```",
          unsignedTx.bodyBytes,
          "```",
          "",
          "### Auth Info Bytes (hex)",
          "```",
          unsignedTx.authInfoBytes,
          "```",
          "",
          "### Instructions",
          "1. Compute `sha256(signDocBytes)` over the raw bytes",
          "2. Sign the hash with your secp256k1 private key",
          "3. Call `broadcast_cosmos_tx` with bodyBytes, authInfoBytes, and the 64-byte signature",
          "",
          "**Note:** The certificate has been stored locally. If broadcast fails, " +
          "run this tool again to regenerate.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Clean up cert if we stored it but TX construction failed
        try {
          deleteStoredCert(args.akashAddress);
        } catch {
          // Ignore cleanup errors
        }
        return {
          content: [{ type: "text" as const, text: `Error preparing certificate TX: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
