import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayRequestError } from "../gateway-client.js";
import type { UsdcWallet } from "../wallet.js";

export function registerProvisionCompute(
  server: McpServer,
  gateway: GatewayClient,
  _wallet: UsdcWallet | null, // Kept for backwards compatibility but not used
) {
  server.registerTool(
    "provision_compute",
    {
      title: "Provision Compute",
      description:
        "Provision cloud compute on Akash Network. Analyzes your task, gets pricing from multiple providers, pays with USDC, and deploys — all in one step. Returns deployment ID, endpoints, and SSH credentials.",
      inputSchema: {
        task: z
          .string()
          .describe(
            "Description of what the compute will be used for (e.g. 'run a PyTorch training job', 'host a Node.js API server')",
          ),
        cpu: z
          .number()
          .min(1)
          .max(256)
          .optional()
          .describe("CPU cores (1-256). If omitted, auto-detected from task."),
        memory: z
          .string()
          .optional()
          .describe(
            'RAM size (e.g. "4GB", "16GB"). If omitted, auto-detected from task.',
          ),
        storage: z
          .string()
          .optional()
          .describe(
            'Storage size (e.g. "20GB", "100GB"). If omitted, auto-detected from task.',
          ),
        image: z
          .string()
          .optional()
          .describe(
            "Docker image to deploy. If omitted, auto-detected from task.",
          ),
        hours: z
          .number()
          .min(1)
          .max(720)
          .optional()
          .describe(
            "Lease duration in hours (1-720). If omitted, auto-detected from task.",
          ),
        maxBudget: z
          .number()
          .optional()
          .describe("Maximum budget in USD. Defaults to $10."),
        gpu: z
          .object({
            count: z.number().min(1).describe("Number of GPUs"),
            model: z
              .string()
              .optional()
              .describe('GPU model (e.g. "nvidia-a100")'),
          })
          .optional()
          .describe("GPU requirements, if any."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables to set in the container."),
        command: z
          .array(z.string())
          .optional()
          .describe("Override container command."),
        ports: z
          .array(
            z.object({
              port: z.number().describe("Port number"),
              protocol: z
                .enum(["tcp", "udp"])
                .default("tcp")
                .describe("Protocol"),
              expose: z
                .boolean()
                .default(true)
                .describe("Expose to the internet"),
            }),
          )
          .optional()
          .describe("Ports to expose from the container."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const maxBudget = args.maxBudget ?? 10;

        // Step 1: If specs are incomplete, ask the LLM to analyze the task
        let cpu = args.cpu;
        let memory = args.memory;
        let storage = args.storage;
        let image = args.image;
        let hours = args.hours;

        if (!cpu || !memory || !storage || !image || !hours) {
          const analysis = await gateway.analyzeTask({
            task: args.task,
            maxBudget,
          });
          cpu = cpu ?? analysis.recommendedCpu;
          memory = memory ?? analysis.recommendedRam;
          storage = storage ?? analysis.recommendedStorage;
          image = image ?? analysis.recommendedImage;
          hours = hours ?? analysis.estimatedDurationHours;
        }

        // Step 2: Get quotes from multiple providers
        const quoteReq = {
          cpu,
          memory,
          storage,
          image,
          hours,
          gpu: args.gpu,
        };
        const { quotes } = await gateway.getMultiQuotes(quoteReq);

        if (quotes.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No providers returned quotes for the requested specs. Try adjusting CPU, memory, or GPU requirements.",
              },
            ],
            isError: true,
          };
        }

        // Step 3: Select best provider
        const selection = await gateway.selectProvider({
          task: args.task,
          budget: maxBudget,
          quotes,
        });

        const chosenQuoteId =
          selection.selectedQuoteId ?? quotes[0].quoteId;
        const chosenQuote = quotes.find((q) => q.quoteId === chosenQuoteId) ?? quotes[0];

        // Step 4: Provision - gateway handles payment automatically via transferFrom
        const deployment = await gateway.provision({
          quoteId: chosenQuoteId,
          env: args.env,
          command: args.command,
          ports: args.ports,
        });

        // Get payment info from response
        const paymentInfo = (deployment as any).payment || {};
        const paymentTxHash = paymentInfo.txHash || "pending";

        // Step 5: Poll for running status (up to 90s)
        let status = await gateway.getDeploymentStatus(
          deployment.deploymentId,
        );
        const deadline = Date.now() + 90_000;
        while (
          status.status !== "running" &&
          status.status !== "failed" &&
          Date.now() < deadline
        ) {
          await sleep(3000);
          status = await gateway.getDeploymentStatus(
            deployment.deploymentId,
          );
        }

        const endpointLines =
          status.endpoints && status.endpoints.length > 0
            ? status.endpoints
                .map(
                  (ep) => `  ${ep.protocol}://${ep.host}:${ep.port}`,
                )
                .join("\n")
            : "  (endpoints not yet available — check status again shortly)";

        const text = [
          `Deployment **${deployment.deploymentId}** is **${status.status}**.`,
          "",
          `Provider: ${chosenQuote.providerName} (${chosenQuote.region})`,
          `Image: ${image}`,
          `Specs: ${cpu} CPU, ${memory} RAM, ${storage} storage, ${hours}h`,
          `Cost: ${chosenQuote.priceUsdc} USDC`,
          `Payment tx: ${paymentTxHash}`,
          "",
          "Endpoints:",
          endpointLines,
          "",
          `SSH: ssh ${deployment.credentials.sshUser}@${deployment.credentials.sshHost} -p ${deployment.credentials.sshPort}`,
          `Access token: ${deployment.credentials.accessToken}`,
          "",
          `Expires: ${new Date(status.expiresAt).toISOString()}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        if (err instanceof GatewayRequestError) {
          // Handle payment failures with helpful message
          if (err.status === 402) {
            const body = err.body as any;
            const msg = [
              `Payment failed: ${body.reason || body.error}`,
              "",
              body.details ? `Required: ${body.details.required}` : "",
              body.details ? `Allowance: ${body.details.allowance}` : "",
              "",
              body.action || "Run 'npx @anthropic/agent-pay setup' to configure your wallet.",
            ].filter(Boolean).join("\n");
            return {
              content: [{ type: "text" as const, text: msg }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: `Gateway error (${err.status}): ${err.message}` }],
            isError: true,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: msg }],
          isError: true,
        };
      }
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
