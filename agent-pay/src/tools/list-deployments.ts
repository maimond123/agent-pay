/**
 * List Deployments Tool (Trustless Flow)
 *
 * Direct query tool to list all deployments for a wallet.
 * This is a read-only operation - no signing required.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryDeployments, queryLeases, queryProvider } from "../akash/index.js";
import { listStoredWallets, getDefaultWalletAddress } from "../wallet/index.js";

export function registerListDeployments(server: McpServer) {
  server.registerTool(
    "list_deployments",
    {
      title: "List Deployments",
      description:
        "List all Akash deployments for a wallet, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["all", "active", "closed"])
          .optional()
          .describe("Filter by deployment status. Defaults to 'active'."),
        akashAddress: z
          .string()
          .optional()
          .describe("Optional Akash wallet address. If omitted, uses the default local wallet."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network to query. Defaults to mainnet."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";
        const statusFilter = args.status || "active";

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

        // Query deployments from chain
        let deployments = await queryDeployments(owner, network);

        // Filter by status
        if (statusFilter === "active") {
          deployments = deployments.filter((d) => d.state === 1); // ACTIVE state
        } else if (statusFilter === "closed") {
          deployments = deployments.filter((d) => d.state === 2); // CLOSED state
        }

        if (deployments.length === 0) {
          const qualifier = statusFilter !== "all" ? ` with status "${statusFilter}"` : "";
          const text = [
            `## No Deployments Found`,
            "",
            `No deployments${qualifier} for wallet \`${owner}\``,
            "",
            statusFilter === "active"
              ? "You don't have any active deployments. Use `provision_compute` to create one."
              : "Use `provision_compute` to create a new deployment.",
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        // Build deployment list
        const lines = [
          `## Deployments (${statusFilter})`,
          "",
          `**Wallet:** \`${owner}\``,
          `**Network:** ${network}`,
          `**Total:** ${deployments.length}`,
          "",
        ];

        for (const deployment of deployments) {
          const dseq = deployment.deploymentId.dseq;
          const stateMap: Record<number, string> = {
            0: "Invalid",
            1: "Active",
            2: "Closed",
          };
          const state = stateMap[deployment.state] || "Unknown";

          // Try to get lease info
          let providerInfo = "";
          try {
            const leases = await queryLeases(owner, dseq, network);
            const activeLease = leases.find((l) => l.state === 1);
            if (activeLease) {
              providerInfo = `Provider: \`${activeLease.leaseId.provider.slice(0, 20)}...\``;
            }
          } catch {
            // Lease query may fail
          }

          lines.push(
            `### DSEQ ${dseq}`,
            `- **Status:** ${state}`,
            `- **Created:** ${deployment.createdAt}`,
            providerInfo ? `- ${providerInfo}` : null,
            ""
          );
        }

        // Filter out null entries
        const filteredLines = lines.filter((l) => l !== null);

        // Add management commands
        if (statusFilter === "active" && deployments.length > 0) {
          filteredLines.push(
            "### Commands",
            "",
            "Check deployment status:",
            "```",
            "check_deployment(dseq: \"<DSEQ>\")",
            "```",
            "",
            "Close a deployment:",
            "```",
            "npx @agent-pay/mcp close <DSEQ>",
            "```"
          );
        }

        return { content: [{ type: "text" as const, text: filteredLines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error listing deployments: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
