/**
 * Stop/Close Deployment Tool (Trustless Flow)
 *
 * Returns CLI command to close a deployment.
 * Closing requires signing, so we return a command for the user to execute.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDeploymentStatus, queryLeases } from "../akash/index.js";
import { listStoredWallets, getDefaultWalletAddress } from "../wallet/index.js";

export function registerStopDeployment(server: McpServer) {
  server.registerTool(
    "stop_deployment",
    {
      title: "Stop/Close Deployment",
      description:
        "Stop (close) an Akash deployment. Returns a CLI command for the user to execute. Closing a deployment refunds any unused time.",
      inputSchema: {
        dseq: z.string().describe("The deployment sequence number (DSEQ) to close"),
        akashAddress: z
          .string()
          .optional()
          .describe("Optional Akash wallet address. If omitted, uses the default local wallet."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network. Defaults to mainnet."),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";

        // Get wallet address
        let owner = args.akashAddress;
        if (!owner) {
          const storedWallets = listStoredWallets();
          if (storedWallets.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No wallet found. Please provide an akashAddress or create a wallet first.",
                },
              ],
              isError: true,
            };
          }
          owner = getDefaultWalletAddress() || storedWallets[0].address;
        }

        // Check if deployment exists and is active
        const status = await getDeploymentStatus(owner, args.dseq, network);

        if (!status.deployment) {
          const text = [
            `## Deployment Not Found`,
            "",
            `No deployment found with DSEQ **${args.dseq}** for wallet \`${owner}\``,
            "",
            "The deployment may have already been closed or the DSEQ may be incorrect.",
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        if (status.deployment.state === 2) {
          // Already closed
          const text = [
            `## Deployment Already Closed`,
            "",
            `Deployment **${args.dseq}** is already closed.`,
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        // Get lease info for cost estimate
        let priceInfo = "";
        try {
          const leases = await queryLeases(owner, args.dseq, network);
          const activeLease = leases.find((l) => l.state === 1);
          if (activeLease) {
            const pricePerBlock = parseInt(activeLease.price.amount) / 1_000_000;
            priceInfo = `Current cost: ~$${pricePerBlock.toFixed(6)}/block`;
          }
        } catch {
          // Lease query may fail
        }

        // Build response with CLI command
        const cliCommand = `npx @agent-pay/mcp close ${args.dseq}${network === "testnet" ? " --testnet" : ""}`;

        const text = [
          `## Close Deployment ${args.dseq}`,
          "",
          `**Wallet:** \`${owner}\``,
          `**Status:** ${status.status}`,
          priceInfo ? `**${priceInfo}**` : null,
          "",
          "### What happens when you close:",
          "1. The lease with the provider is terminated",
          "2. Your container is stopped",
          "3. Unused funds are refunded to your wallet",
          "",
          "### Close Command",
          "",
          "Run this command to close the deployment:",
          "",
          "```",
          cliCommand,
          "```",
          "",
          "The CLI will prompt for your wallet password to sign the transaction.",
          "",
          "**Note:** This action cannot be undone. Make sure you've saved any data from the deployment.",
        ]
          .filter(Boolean)
          .join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
