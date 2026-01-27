import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayRequestError } from "../gateway-client.js";

export function registerStopDeployment(
  server: McpServer,
  gateway: GatewayClient,
) {
  server.registerTool(
    "stop_deployment",
    {
      title: "Stop Deployment",
      description:
        "Stop a running Akash compute deployment. This closes the lease and frees the resources. Cannot be undone.",
      inputSchema: {
        deploymentId: z
          .string()
          .describe('The deployment ID to stop (e.g. "deploy_abc123")'),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await gateway.closeDeployment(args.deploymentId);

        return {
          content: [
            {
              type: "text" as const,
              text: `Deployment **${result.deploymentId}** has been **stopped**. ${result.message}`,
            },
          ],
        };
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
