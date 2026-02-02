import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayRequestError } from "../gateway-client.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerWatchEscrowDeployment(
  server: McpServer,
  gateway: GatewayClient,
) {
  server.registerTool(
    "watch_escrow_deployment",
    {
      title: "Watch Escrow Deployment",
      description:
        "Watch an escrow deployment by quote ID. Polls the gateway until the deployment is running or failed. Use this after the user says they deposited via escrow. Returns real-time status updates.",
      inputSchema: {
        quoteId: z
          .string()
          .describe('The quote ID from provision_compute (e.g. "quote_abc123")'),
        timeoutSeconds: z
          .number()
          .min(10)
          .max(300)
          .optional()
          .describe("How long to wait for deployment (default: 120 seconds)"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const timeout = (args.timeoutSeconds ?? 120) * 1000;
      const pollInterval = 3000; // 3 seconds
      const startTime = Date.now();
      const statusUpdates: string[] = [];
      let lastStatus = "";

      try {
        statusUpdates.push(`Watching for deposit on quote ${args.quoteId}...`);

        while (Date.now() - startTime < timeout) {
          const result = await gateway.getDeploymentByQuoteId(args.quoteId);

          if (result.status === "not_found") {
            return {
              content: [{
                type: "text" as const,
                text: `Quote ${args.quoteId} not found. It may have expired. Please request a new quote.`,
              }],
              isError: true,
            };
          }

          if (result.status === "awaiting_deposit") {
            // Still waiting - update message periodically
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed % 15 === 0 && elapsed > 0) {
              statusUpdates.push(`Still waiting for deposit... (${elapsed}s elapsed)`);
            }
            await sleep(pollInterval);
            continue;
          }

          if (result.status === "deployment_found" && result.deployment) {
            const deployment = result.deployment;
            const currentStatus = deployment.status;

            // Track status changes
            if (currentStatus !== lastStatus) {
              lastStatus = currentStatus;

              if (currentStatus === "pending") {
                statusUpdates.push("Deposit detected! Deployment created.");
              } else if (currentStatus === "deploying") {
                statusUpdates.push("Deploying to Akash Network...");
                if (deployment.akash?.dseq) {
                  statusUpdates.push(`  - Akash dseq: ${deployment.akash.dseq}`);
                }
                if (deployment.akash?.provider) {
                  statusUpdates.push(`  - Provider: ${deployment.akash.provider.slice(0, 30)}...`);
                }
                if (deployment.akash?.leaseId) {
                  statusUpdates.push(`  - Lease created`);
                }
              }
            }

            // Check for terminal states
            if (currentStatus === "running") {
              statusUpdates.push("Container is now RUNNING!");

              const endpointLines = deployment.endpoints && deployment.endpoints.length > 0
                ? deployment.endpoints.map(ep => `  ${ep.protocol}://${ep.host}:${ep.port}`).join("\n")
                : "  (endpoints still provisioning - check again in a moment)";

              const text = [
                "## Deployment Status Updates",
                "",
                ...statusUpdates.map(s => s.startsWith("  ") ? s : `- ${s}`),
                "",
                "---",
                "",
                "## Deployment Complete",
                "",
                `**Deployment ID:** ${deployment.deploymentId}`,
                `**Status:** ${deployment.status}`,
                `**Akash dseq:** ${deployment.akash?.dseq || "N/A"}`,
                "",
                "**Endpoints:**",
                endpointLines,
                "",
                `**Expires:** ${new Date(deployment.expiresAt).toISOString()}`,
                "",
                deployment.escrowProofTx
                  ? `**Escrow proof tx:** ${deployment.escrowProofTx}`
                  : "",
              ].filter(Boolean).join("\n");

              return { content: [{ type: "text" as const, text }] };
            }

            if (currentStatus === "failed") {
              statusUpdates.push("Deployment FAILED");

              const text = [
                "## Deployment Status Updates",
                "",
                ...statusUpdates.map(s => s.startsWith("  ") ? s : `- ${s}`),
                "",
                "---",
                "",
                "## Deployment Failed",
                "",
                `**Deployment ID:** ${deployment.deploymentId}`,
                "",
                "Your deposit has been automatically refunded via the escrow contract.",
                "",
                deployment.escrowProofTx
                  ? `**Refund tx:** ${deployment.escrowProofTx}`
                  : "",
                "",
                "You can try again with different specs.",
              ].filter(Boolean).join("\n");

              return { content: [{ type: "text" as const, text }], isError: true };
            }

            // Still deploying - continue polling
          }

          await sleep(pollInterval);
        }

        // Timeout reached
        const text = [
          "## Deployment Status Updates",
          "",
          ...statusUpdates.map(s => s.startsWith("  ") ? s : `- ${s}`),
          "",
          "---",
          "",
          `**Timed out after ${Math.round(timeout / 1000)} seconds.**`,
          "",
          "The deployment may still be in progress. You can:",
          "1. Call this tool again to continue watching",
          "2. Use `check_deployment` with the deployment ID if you have it",
          "3. Use `list_deployments` to see all deployments",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };

      } catch (err) {
        const msg =
          err instanceof GatewayRequestError
            ? `Gateway error (${err.status}): ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          content: [{ type: "text" as const, text: msg }],
          isError: true,
        };
      }
    },
  );
}
