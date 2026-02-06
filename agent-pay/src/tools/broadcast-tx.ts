/**
 * Broadcast Cosmos TX Tool
 *
 * Broadcasts a signed Cosmos transaction to the Akash chain.
 * Agent A provides the signature (from signing the signDocBytes),
 * and we assemble the full TxRaw and broadcast it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { broadcastSignedTx } from "../akash/index.js";

export function registerBroadcastTx(server: McpServer) {
  server.registerTool(
    "broadcast_cosmos_tx",
    {
      title: "Broadcast Signed Cosmos Transaction",
      description:
        "Broadcasts a signed Cosmos transaction to the Akash chain. " +
        "Provide the bodyBytes and authInfoBytes from a prepare_*_tx call, " +
        "plus the 64-byte secp256k1 signature (r||s). " +
        "If a 65-byte EVM signature is provided, the v byte is automatically stripped.",
      inputSchema: {
        bodyBytes: z
          .string()
          .describe("Hex-encoded TxBody bytes from prepare_*_tx response."),
        authInfoBytes: z
          .string()
          .describe("Hex-encoded AuthInfo bytes from prepare_*_tx response."),
        signature: z
          .string()
          .describe(
            "Hex-encoded secp256k1 signature (64 bytes r||s). " +
            "If 65 bytes (r+s+v from EVM), the recovery byte is stripped automatically."
          ),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network to broadcast on. Defaults to mainnet."),
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";

        console.error(
          `[agent-pay:broadcast-tx] Broadcasting TX on ${network}`
        );

        const result = await broadcastSignedTx({
          bodyBytes: args.bodyBytes,
          authInfoBytes: args.authInfoBytes,
          signature: args.signature,
          network,
        });

        console.error(
          `[agent-pay:broadcast-tx] TX hash=${result.txHash}, code=${result.code}`
        );

        if (result.code !== 0) {
          const text = [
            "## Transaction Failed",
            "",
            `**TX Hash:** \`${result.txHash}\``,
            `**Error Code:** ${result.code}`,
            `**Gas Used:** ${result.gasUsed}`,
            "",
            "### Error Details",
            result.rawLog || "No error details available.",
            "",
            "The transaction was rejected by the chain. Check the error details above.",
          ].join("\n");

          return {
            content: [{ type: "text" as const, text }],
            isError: true,
          };
        }

        const text = [
          "## Transaction Broadcast Successfully",
          "",
          `**TX Hash:** \`${result.txHash}\``,
          `**Status:** Success (code 0)`,
          `**Gas Used:** ${result.gasUsed}`,
          "",
          `View on explorer: https://www.mintscan.io/akash/tx/${result.txHash}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error broadcasting TX: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
