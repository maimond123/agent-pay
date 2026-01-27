import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayRequestError } from "../gateway-client.js";

export function registerListDeployments(
  server: McpServer,
  gateway: GatewayClient,
) {
  server.registerTool(
    "list_deployments",
    {
      title: "List Deployments",
      description:
        "List all Akash compute deployments, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["pending", "deploying", "running", "stopped", "failed"])
          .optional()
          .describe("Filter by deployment status. Omit to list all."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const { deployments, total } = await gateway.listDeployments(
          args.status,
        );

        if (total === 0) {
          const qualifier = args.status ? ` with status "${args.status}"` : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `No deployments found${qualifier}.`,
              },
            ],
          };
        }

        const lines = deployments.map((d) => {
          const endpoints =
            d.endpoints && d.endpoints.length > 0
              ? d.endpoints
                  .map((ep) => `${ep.protocol}://${ep.host}:${ep.port}`)
                  .join(", ")
              : "none";
          return [
            `- **${d.deploymentId}** [${d.status}]`,
            `  Image: ${d.specs.image} | ${d.specs.cpu} CPU, ${d.specs.memory} RAM`,
            `  Endpoints: ${endpoints}`,
            `  Expires: ${new Date(d.expiresAt).toISOString()}`,
          ].join("\n");
        });

        const text = [
          `${total} deployment(s)${args.status ? ` (status: ${args.status})` : ""}:`,
          "",
          ...lines,
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
