/**
 * Prepare Bridge TX Tool
 *
 * Constructs an unsigned EVM transaction for bridging USDC from Base to Akash.
 * Uses Skip Go API for the route. Agent A signs and broadcasts the EVM TX externally.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSkipBridge } from "../bridge/index.js";

export function registerPrepareBridgeTx(server: McpServer) {
  server.registerTool(
    "prepare_bridge_tx",
    {
      title: "Prepare Bridge Transaction",
      description:
        "Creates an unsigned EVM transaction to bridge USDC from Base to Akash via Skip Go API. " +
        "Returns the unsigned TX fields (to, data, value, chainId) for Agent A to sign and broadcast. " +
        "After broadcasting, call track_bridge with the txHash to monitor progress.",
      inputSchema: {
        evmAddress: z
          .string()
          .describe("The sender's EVM address on Base (0x-prefixed)."),
        akashAddress: z
          .string()
          .describe("The destination Akash address."),
        amountUSDC: z
          .string()
          .describe("Amount of USDC to bridge (human readable, e.g., '10.50')."),
        destinationType: z
          .enum(["usdc", "akt"])
          .optional()
          .describe("What to receive on Akash. Defaults to 'akt'."),
      },
    },
    async (args) => {
      try {
        const destinationType = args.destinationType || "akt";

        console.error(
          `[agent-pay:prepare-bridge-tx] Route: Base→Akash, amount=$${args.amountUSDC}, dest=${destinationType}`
        );

        const result = await createSkipBridge({
          fromAddress: args.evmAddress,
          toAddress: args.akashAddress,
          amountUSDC: args.amountUSDC,
          destinationType,
        });

        // Extract the EVM transaction(s)
        const evmTxs = result.transactions.filter((tx) => tx.txType === "evm");

        if (evmTxs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "## No EVM Transaction\n\nThe bridge route doesn't require an EVM transaction. This is unexpected.",
              },
            ],
            isError: true,
          };
        }

        const evmTx = evmTxs[0].evmTx!;
        const route = result.route;

        console.error(
          `[agent-pay:prepare-bridge-tx] Route found: ${route.chainPath.join(" → ")}, est.fees=$${route.fees.totalUsd}`
        );

        const text = [
          "## Bridge TX Ready to Sign",
          "",
          "### Route",
          `**Path:** ${route.chainPath.join(" → ")}`,
          `**Amount In:** $${route.usdIn} (${route.amountIn} micro)`,
          `**Estimated Out:** $${route.usdOut} (${route.estimatedAmountOut} micro)`,
          `**Estimated Duration:** ${Math.ceil(route.estimatedDurationSeconds / 60)} minutes`,
          `**Estimated Fees:** $${route.fees.totalUsd}`,
          `**TXs Required:** ${route.txsRequired}`,
          "",
          "### Unsigned EVM Transaction",
          `**Chain ID:** ${evmTx.chainId} (Base)`,
          `**To:** \`${evmTx.to}\``,
          `**Value:** ${evmTx.value}`,
          evmTx.gasLimit ? `**Gas Limit:** ${evmTx.gasLimit}` : "",
          "",
          "**Data (hex):**",
          "```",
          evmTx.data,
          "```",
          "",
          "### Instructions",
          "1. Sign this EVM transaction with your Base wallet",
          "2. Broadcast it on Base (chain ID 8453)",
          "3. Call `track_bridge` with the txHash and chainId '8453' to monitor progress",
          "",
          "**Note:** After the EVM TX is confirmed, Skip's Smart Relay automatically handles " +
          "the CCTP attestation and IBC hops. No further signing is needed.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error preparing bridge TX: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
