import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayRequestError } from "../gateway-client.js";
import type { UsdcWallet } from "../wallet.js";

export function registerGetComputeQuote(
  server: McpServer,
  gateway: GatewayClient,
  wallet: UsdcWallet | null,
) {
  server.registerTool(
    "get_compute_quote",
    {
      title: "Get Compute Quote",
      description:
        "Get pricing for Akash compute without provisioning. Returns quotes from multiple providers so you can compare before committing.",
      inputSchema: {
        cpu: z.number().min(1).max(256).describe("CPU cores (1-256)"),
        memory: z
          .string()
          .describe('RAM size (e.g. "4GB", "16GB", "32GB")'),
        storage: z
          .string()
          .describe('Storage size (e.g. "20GB", "50GB", "100GB")'),
        image: z.string().describe("Docker image to deploy"),
        hours: z
          .number()
          .min(1)
          .max(720)
          .describe("Lease duration in hours (1-720)"),
        region: z.string().optional().describe("Preferred region"),
        gpu: z
          .object({
            count: z.number().min(1).describe("Number of GPUs"),
            model: z
              .string()
              .optional()
              .describe('GPU model (e.g. "nvidia-a100")'),
          })
          .optional()
          .describe("GPU requirements, if any"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const { quotes } = await gateway.getMultiQuotes(args);

        if (quotes.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No providers returned quotes for the requested specs.",
              },
            ],
          };
        }

        // If wallet is configured, show balance (non-blocking)
        let balanceLine = "";
        if (wallet) {
          try {
            const balance = await wallet.getBalance();
            balanceLine = `Your wallet (${wallet.address}) has **${balance} USDC** on ${wallet.network}.\n\n`;
          } catch {
            // Network error — don't block showing quotes
          }
        }

        const lines = quotes.map((q, i) => {
          return [
            `**Option ${i + 1}: ${q.providerName}** (${q.region})`,
            `  Quote ID: ${q.quoteId}`,
            `  Price: ${q.priceUsdc} USDC`,
            `  Capabilities: ${q.capabilities}`,
            `  Valid until: ${new Date(q.validUntil).toISOString()}`,
          ].join("\n");
        });

        const text = [
          balanceLine +
            `Found ${quotes.length} provider quote(s) for ${args.cpu} CPU, ${args.memory} RAM, ${args.storage} storage, ${args.hours}h:`,
          "",
          ...lines,
          "",
          "Use `provision_compute` to deploy with one of these quotes, or adjust specs and re-quote.",
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
