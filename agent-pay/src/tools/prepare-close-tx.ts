/**
 * Prepare Close TX Tool
 *
 * Constructs an unsigned MsgCloseDeployment transaction.
 * Closing a deployment refunds unused escrowed funds.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  queryAccountInfo,
  constructUnsignedTx,
  constructCloseMsg,
  getDeploymentStatus,
} from "../akash/index.js";
import { compressedPubkeyFromHex } from "../wallet/index.js";

export function registerPrepareCloseTx(server: McpServer) {
  server.registerTool(
    "prepare_close_tx",
    {
      title: "Prepare Close Deployment Transaction",
      description:
        "Constructs an unsigned MsgCloseDeployment transaction. " +
        "Closing refunds unused escrowed AKT. " +
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
          .describe("The deployment sequence number (DSEQ) to close."),
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
          `[agent-pay:prepare-close-tx] Closing DSEQ=${args.dseq} for ${args.akashAddress}`
        );

        // Verify deployment exists
        const status = await getDeploymentStatus(
          args.akashAddress,
          args.dseq,
          network
        );

        if (status.status === "unknown") {
          return {
            content: [
              {
                type: "text" as const,
                text: `## Deployment Not Found\n\nNo deployment found with DSEQ \`${args.dseq}\` for \`${args.akashAddress}\`.`,
              },
            ],
            isError: true,
          };
        }

        if (status.status === "closed") {
          return {
            content: [
              {
                type: "text" as const,
                text: `## Already Closed\n\nDeployment DSEQ \`${args.dseq}\` is already closed.`,
              },
            ],
          };
        }

        // Check account
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

        // Construct close message
        const closeMsg = constructCloseMsg(args.akashAddress, args.dseq);

        // Construct unsigned TX
        const unsignedTx = await constructUnsignedTx({
          messages: [closeMsg],
          senderPubkey: pubkey,
          accountNumber: accountInfo.accountNumber,
          sequence: accountInfo.sequence,
          network,
          memo: "Close Akash deployment via agent-pay",
        });

        const text = [
          "## Close Deployment TX Ready to Sign",
          "",
          `**DSEQ:** ${args.dseq}`,
          `**Current Status:** ${status.status}`,
          `**Active Leases:** ${status.leases.filter((l) => l.state === 1).length}`,
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
          "",
          "Unused escrowed AKT will be refunded to your account after the deployment closes.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error preparing close TX: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
