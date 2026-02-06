/**
 * Prepare Lease TX Tool
 *
 * Constructs an unsigned MsgCreateLease transaction for a selected provider bid.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  queryAccountInfo,
  constructUnsignedTx,
  constructLeaseMsg,
} from "../akash/index.js";
import { compressedPubkeyFromHex } from "../wallet/index.js";

export function registerPrepareLeaseTx(server: McpServer) {
  server.registerTool(
    "prepare_lease_tx",
    {
      title: "Prepare Lease Transaction",
      description:
        "Constructs an unsigned MsgCreateLease transaction. " +
        "Call this after selecting a provider from query_bids. " +
        "Sign and broadcast via broadcast_cosmos_tx.",
      inputSchema: {
        akashAddress: z
          .string()
          .describe("The deployment owner's Akash address."),
        publicKey: z
          .string()
          .describe("Compressed secp256k1 public key (33 bytes, hex)."),
        dseq: z
          .string()
          .describe("The deployment sequence number (DSEQ)."),
        provider: z
          .string()
          .describe("The selected provider's Akash address."),
        gseq: z
          .number()
          .optional()
          .describe("Group sequence number. Defaults to 1."),
        oseq: z
          .number()
          .optional()
          .describe("Order sequence number. Defaults to 1."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network. Defaults to mainnet."),
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";
        const gseq = args.gseq || 1;
        const oseq = args.oseq || 1;
        const pubkey = compressedPubkeyFromHex(args.publicKey);

        console.error(
          `[agent-pay:prepare-lease-tx] Lease for DSEQ=${args.dseq}, provider=${args.provider}`
        );

        // Check account exists
        const accountInfo = await queryAccountInfo(args.akashAddress, network);
        if (!accountInfo) {
          return {
            content: [
              {
                type: "text" as const,
                text: `## Account Not Found\n\nAccount \`${args.akashAddress}\` not found on-chain.`,
              },
            ],
            isError: true,
          };
        }

        // Construct lease message
        const leaseMsg = constructLeaseMsg({
          owner: args.akashAddress,
          dseq: args.dseq,
          gseq,
          oseq,
          provider: args.provider,
        });

        // Construct unsigned TX
        const unsignedTx = await constructUnsignedTx({
          messages: [leaseMsg],
          senderPubkey: pubkey,
          accountNumber: accountInfo.accountNumber,
          sequence: accountInfo.sequence,
          network,
          memo: "Akash lease creation via agent-pay",
        });

        const text = [
          "## Lease TX Ready to Sign",
          "",
          `**DSEQ:** ${args.dseq}`,
          `**Provider:** \`${args.provider}\``,
          `**GSEQ:** ${gseq}, **OSEQ:** ${oseq}`,
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
          "1. Sign: `sha256(signDocBytes) → secp256k1_sign → 64-byte signature`",
          "2. Call `broadcast_cosmos_tx` with bodyBytes, authInfoBytes, and signature",
          "3. After broadcast, call `prepare_jwt_sign_doc` then `send_manifest`",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error preparing lease TX: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
