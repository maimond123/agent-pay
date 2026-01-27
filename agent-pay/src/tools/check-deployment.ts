import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayRequestError } from "../gateway-client.js";

export function registerCheckDeployment(
  server: McpServer,
  gateway: GatewayClient,
) {
  server.registerTool(
    "check_deployment",
    {
      title: "Check Deployment",
      description:
        "Check the status of an Akash compute deployment by its deployment ID. Returns status, endpoints, specs, and expiration.",
      inputSchema: {
        deploymentId: z
          .string()
          .describe('The deployment ID (e.g. "deploy_abc123")'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const status = await gateway.getDeploymentStatus(args.deploymentId);

        const endpointLines =
          status.endpoints && status.endpoints.length > 0
            ? status.endpoints
                .map(
                  (ep) => `  ${ep.protocol}://${ep.host}:${ep.port}`,
                )
                .join("\n")
            : "  (none yet)";

        const akashLines = status.akash.dseq
          ? [
              `Akash dseq: ${status.akash.dseq}`,
              status.akash.provider
                ? `Provider: ${status.akash.provider}`
                : null,
              status.akash.leaseId
                ? `Lease: ${status.akash.leaseId}`
                : null,
            ]
              .filter(Boolean)
              .join("\n")
          : "(not yet on Akash)";

        const text = [
          `Deployment **${status.deploymentId}**: **${status.status}**`,
          "",
          `Image: ${status.specs.image}`,
          `Specs: ${status.specs.cpu} CPU, ${status.specs.memory} RAM, ${status.specs.storage} storage`,
          `Duration: ${status.specs.hours}h`,
          "",
          "Endpoints:",
          endpointLines,
          "",
          akashLines,
          "",
          `Created: ${new Date(status.createdAt).toISOString()}`,
          `Expires: ${new Date(status.expiresAt).toISOString()}`,
          status.paymentTxHash
            ? `Payment tx: ${status.paymentTxHash}`
            : "",
        ]
          .filter((line) => line !== "")
          .join("\n");

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
