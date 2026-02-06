/**
 * Track Bridge Tool
 *
 * Tracks the status of a Skip bridge transaction.
 * Returns per-hop progress and estimated completion.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSkipTransactionStatus } from "../bridge/index.js";

export function registerTrackBridge(server: McpServer) {
  server.registerTool(
    "track_bridge",
    {
      title: "Track Bridge Transaction",
      description:
        "Tracks the status of a cross-chain bridge transaction via Skip Go API. " +
        "Returns per-hop progress (CCTP, IBC) and overall status. " +
        "Poll every 10-30 seconds until status is 'success'.",
      inputSchema: {
        txHash: z
          .string()
          .describe("The EVM transaction hash from the bridge TX broadcast."),
        chainId: z
          .string()
          .optional()
          .describe("The chain ID where the TX was broadcast. Defaults to '8453' (Base)."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const chainId = args.chainId || "8453";

        console.error(
          `[agent-pay:track-bridge] TX ${args.txHash}: querying status`
        );

        const result = await getSkipTransactionStatus(args.txHash, chainId);

        console.error(
          `[agent-pay:track-bridge] TX ${args.txHash}: status=${result.status}`
        );

        // Chain display names
        const chainNames: Record<string, string> = {
          "8453": "Base",
          "noble-1": "Noble",
          "osmosis-1": "Osmosis",
          "akashnet-2": "Akash",
          "cosmoshub-4": "Cosmos Hub",
        };

        const hopLines = result.transferDetails.map((hop) => {
          const from = chainNames[hop.fromChain] || hop.fromChain;
          const to = chainNames[hop.toChain] || hop.toChain;
          let icon = "...";
          if (hop.state === "TRANSFER_SUCCESS") icon = "OK";
          else if (hop.state === "TRANSFER_PENDING") icon = "IN PROGRESS";
          else if (hop.state === "TRANSFER_FAILURE") icon = "FAILED";
          return `| ${from} → ${to} | ${icon} |`;
        });

        const statusEmoji =
          result.status === "success"
            ? "Complete"
            : result.status === "failed"
              ? "Failed"
              : result.status === "abandoned"
                ? "Abandoned"
                : "In Progress";

        const lines = [
          "## Bridge Status",
          "",
          `**TX Hash:** \`${args.txHash}\``,
          `**Status:** ${statusEmoji}`,
          `**State:** ${result.state}`,
          "",
        ];

        if (hopLines.length > 0) {
          lines.push(
            "### Transfer Progress",
            "| Hop | Status |",
            "|-----|--------|",
            ...hopLines,
            ""
          );
        }

        if (result.assetRelease) {
          lines.push(
            "### Asset Release",
            `**Chain:** ${chainNames[result.assetRelease.chainId] || result.assetRelease.chainId}`,
            `**Denom:** ${result.assetRelease.denom}`,
            ""
          );
        }

        if (result.status === "pending") {
          lines.push(
            "Bridge is still in progress. Poll again in 10-30 seconds."
          );
        } else if (result.status === "success") {
          lines.push(
            "Bridge complete! Funds have arrived on Akash.",
            "You can now proceed with `check_wallet` to verify balances."
          );
        } else if (result.status === "failed" || result.status === "abandoned") {
          lines.push(
            "Bridge failed or was abandoned. Your funds are safe.",
            result.assetRelease
              ? `Funds should be available on ${chainNames[result.assetRelease.chainId] || result.assetRelease.chainId}.`
              : "Check the explorer for details."
          );
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error tracking bridge: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
