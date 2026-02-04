/**
 * Check Deployment Tool (Trustless Flow)
 *
 * Direct query tool to check deployment status from the Akash chain.
 * This is a read-only operation - no signing required.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDeploymentStatus, queryLeases } from "../akash/index.js";
import { listStoredWallets, getDefaultWalletAddress } from "../wallet/index.js";

export function registerCheckDeployment(server: McpServer) {
  server.registerTool(
    "check_deployment",
    {
      title: "Check Deployment Status",
      description:
        "Check the status of an Akash deployment by DSEQ (deployment sequence number). Returns status, provider, lease info, and endpoints.",
      inputSchema: {
        dseq: z.string().describe("The deployment sequence number (DSEQ)"),
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

        // Query deployment status from chain
        const status = await getDeploymentStatus(owner, args.dseq, network);

        if (!status.deployment) {
          const text = [
            `## Deployment Not Found`,
            "",
            `No deployment found with DSEQ **${args.dseq}** for wallet \`${owner}\``,
            "",
            "The deployment may have been closed or the DSEQ may be incorrect.",
            "",
            "Use `list_deployments` to see all your active deployments.",
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        // Build status display
        const stateMap: Record<number, string> = {
          0: "Invalid",
          1: "Active",
          2: "Closed",
        };

        const deploymentState = stateMap[status.deployment.state] || "Unknown";

        const lines = [
          `## Deployment ${args.dseq}`,
          "",
          `**Status:** ${status.status}`,
          `**Owner:** \`${owner}\``,
          `**State:** ${deploymentState}`,
          `**Created:** ${status.deployment.createdAt}`,
        ];

        // Add lease info
        if (status.leases.length > 0) {
          lines.push("", "### Leases");
          for (const lease of status.leases) {
            const leaseStateMap: Record<number, string> = {
              0: "Invalid",
              1: "Active",
              2: "Insufficient Funds",
              3: "Closed",
            };
            const leaseState = leaseStateMap[lease.state] || "Unknown";
            lines.push(
              `- **GSEQ ${lease.leaseId.gseq}** [${leaseState}]`,
              `  Provider: \`${lease.leaseId.provider}\``,
              `  Price: ${(parseInt(lease.price.amount) / 1_000_000).toFixed(6)} ${lease.price.denom.includes("ibc") ? "USDC" : "AKT"}/block`
            );
          }
        }

        // Add endpoints
        if (status.endpoints.length > 0) {
          lines.push("", "### Endpoints");
          for (const ep of status.endpoints) {
            lines.push(`- ${ep.uri}`);
          }
        } else if (status.status === "active") {
          lines.push(
            "",
            "### Endpoints",
            "(Endpoints not yet available - deployment may still be starting)"
          );
        }

        // Add management commands
        if (status.status === "active") {
          lines.push(
            "",
            "### Management",
            "",
            "To close this deployment and get a refund for unused time:",
            "",
            "```",
            `npx @agent-pay/mcp close ${args.dseq}`,
            "```"
          );
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error checking deployment: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
