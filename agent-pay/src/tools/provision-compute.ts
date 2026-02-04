/**
 * Provision Compute Tool (Trustless Flow)
 *
 * Orchestrates compute provisioning on Akash Network.
 * For write operations that require signing, returns CLI commands for the user to execute.
 * The agent NEVER signs transactions - all signing happens in the user's CLI process.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWalletBalance, queryDeployments, calculateDeposit } from "../akash/index.js";
import { listStoredWallets, getDefaultWalletAddress } from "../wallet/index.js";
import type { ComputeSpecs } from "../types.js";

export function registerProvisionCompute(server: McpServer) {
  server.registerTool(
    "provision_compute",
    {
      title: "Provision Compute",
      description:
        "Provision cloud compute on Akash Network. Analyzes requirements, checks wallet balance, and returns a CLI command for the user to execute. The agent orchestrates but never signs transactions.",
      inputSchema: {
        task: z
          .string()
          .describe(
            "Description of what the compute will be used for (e.g. 'run a PyTorch training job', 'host a Node.js API server')"
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
          .describe('RAM size (e.g. "4GB", "16GB"). If omitted, auto-detected from task.'),
        storage: z
          .string()
          .optional()
          .describe('Storage size (e.g. "20GB", "100GB"). If omitted, auto-detected from task.'),
        image: z
          .string()
          .optional()
          .describe("Docker image to deploy. If omitted, auto-detected from task."),
        hours: z
          .number()
          .min(1)
          .max(720)
          .optional()
          .describe("Lease duration in hours (1-720). If omitted, auto-detected from task."),
        maxBudget: z
          .number()
          .optional()
          .describe("Maximum budget in USD. Defaults to $10."),
        gpu: z
          .object({
            count: z.number().min(1).describe("Number of GPUs"),
            model: z.string().optional().describe('GPU model (e.g. "nvidia-a100")'),
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
              protocol: z.enum(["tcp", "udp"]).default("tcp").describe("Protocol"),
              expose: z.boolean().default(true).describe("Expose to the internet"),
            })
          )
          .optional()
          .describe("Ports to expose from the container."),
        akashAddress: z
          .string()
          .optional()
          .describe("Optional Akash wallet address. If omitted, uses the default local wallet."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network to deploy on. Defaults to mainnet."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";
        const maxBudget = args.maxBudget ?? 10;

        // Step 0: Check if ports are specified
        if (!args.ports || args.ports.length === 0) {
          const text = [
            "## Port Selection Required",
            "",
            "No ports were specified for this deployment. What type of access do you need?",
            "",
            "**Common options:**",
            "1. **SSH only** (port 22) - Remote terminal access",
            "2. **Web server** (ports 80, 443) - HTTP/HTTPS traffic",
            "3. **SSH + Web** (ports 22, 80, 443) - Both terminal and web access",
            "4. **Custom** - Specify your own ports",
            "",
            "Please specify which option you want, or provide custom ports like:",
            "`ports: [{ port: 22 }, { port: 8080 }]`",
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        // Step 1: Check for wallet
        let walletAddress = args.akashAddress;

        if (!walletAddress) {
          const storedWallets = listStoredWallets();

          if (storedWallets.length === 0) {
            const text = [
              "## No Akash Wallet Found",
              "",
              "You need an Akash wallet to deploy compute. Create one by running:",
              "",
              "```",
              "npx @agent-pay/mcp wallet create",
              "```",
              "",
              "This will generate a new wallet and securely store it locally.",
              "After creating your wallet, you'll need to fund it with USDC by bridging from Base.",
            ].join("\n");

            return { content: [{ type: "text" as const, text }] };
          }

          walletAddress = getDefaultWalletAddress() || storedWallets[0].address;
        }

        // Step 2: Analyze task to fill in missing specs
        let cpu = args.cpu;
        let memory = args.memory;
        let storage = args.storage;
        let image = args.image;
        let hours = args.hours;

        // Auto-detect specs from task description if not provided
        if (!cpu || !memory || !storage || !image || !hours) {
          const analysis = analyzeTaskForSpecs(args.task, maxBudget);
          cpu = cpu ?? analysis.cpu;
          memory = memory ?? analysis.memory;
          storage = storage ?? analysis.storage;
          image = image ?? analysis.image;
          hours = hours ?? analysis.hours;
        }

        // Step 3: Check wallet balance
        const balance = await getWalletBalance(walletAddress, network);
        const usdcBalance = parseFloat(balance.usdcFormatted);

        // Calculate estimated cost
        const specs: ComputeSpecs = {
          cpu,
          memory,
          storage,
          image,
          hours,
          gpu: args.gpu,
          ports: args.ports,
        };

        const deposit = calculateDeposit(specs, hours);
        const estimatedCost = parseInt(deposit.amount) / 1_000_000;

        // Step 4: Check if funds are sufficient
        if (usdcBalance < estimatedCost) {
          const shortfall = (estimatedCost - usdcBalance).toFixed(2);

          const text = [
            "## Insufficient Funds",
            "",
            `**Your wallet:** \`${walletAddress}\``,
            `**Balance:** ${balance.usdcFormatted} USDC`,
            `**Required:** ~$${estimatedCost.toFixed(2)} USDC`,
            `**Shortfall:** ~$${shortfall} USDC`,
            "",
            "### Bridge Funds",
            "",
            "Run this command to bridge USDC from your Base wallet:",
            "",
            "```",
            `npx @agent-pay/mcp bridge --amount ${Math.ceil(estimatedCost + 1)}`,
            "```",
            "",
            "After bridging completes (~2-3 minutes), come back and try deploying again.",
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        // Step 5: Generate CLI command for deployment
        const portsDisplay = args.ports
          .map((p) => `${p.port}/${p.protocol || "tcp"}`)
          .join(", ");

        // Build CLI command
        const cliArgs: string[] = [
          `--cpu ${cpu}`,
          `--memory ${memory}`,
          `--storage ${storage}`,
          `--image "${image}"`,
          `--hours ${hours}`,
        ];

        if (args.gpu) {
          cliArgs.push(`--gpu-count ${args.gpu.count}`);
          if (args.gpu.model) {
            cliArgs.push(`--gpu-model "${args.gpu.model}"`);
          }
        }

        for (const port of args.ports) {
          cliArgs.push(`--port ${port.port}${port.protocol !== "tcp" ? `/${port.protocol}` : ""}`);
        }

        if (args.env) {
          for (const [key, value] of Object.entries(args.env)) {
            cliArgs.push(`--env "${key}=${value}"`);
          }
        }

        if (args.command && args.command.length > 0) {
          cliArgs.push(`--command "${args.command.join(" ")}"`);
        }

        if (network === "testnet") {
          cliArgs.push("--testnet");
        }

        const cliCommand = `npx @agent-pay/mcp deploy ${cliArgs.join(" \\\n  ")}`;

        const text = [
          "## Ready to Deploy",
          "",
          "### Deployment Summary",
          `**Task:** ${args.task}`,
          "",
          "### Specs",
          `- **CPU:** ${cpu} cores`,
          `- **Memory:** ${memory}`,
          `- **Storage:** ${storage}`,
          `- **Image:** ${image}`,
          `- **Duration:** ${hours} hours`,
          `- **Ports:** ${portsDisplay}`,
          args.gpu ? `- **GPU:** ${args.gpu.count}x ${args.gpu.model || "any"}` : null,
          "",
          "### Cost Estimate",
          `- **Estimated:** ~$${estimatedCost.toFixed(2)} USDC`,
          `- **Your Balance:** ${balance.usdcFormatted} USDC`,
          "",
          "### Wallet",
          `- **Address:** \`${walletAddress}\``,
          `- **Network:** ${network}`,
          "",
          "### Deploy Command",
          "",
          "Run this command to deploy (your wallet will sign the transaction):",
          "",
          "```",
          cliCommand,
          "```",
          "",
          "The CLI will:",
          "1. Prompt for your wallet password",
          "2. Create the deployment on Akash",
          "3. Wait for provider bids",
          "4. Accept the best bid and create a lease",
          "5. Return your deployment endpoints",
          "",
          "**Note:** All transactions are signed locally on your machine.",
          "The agent never has access to your keys or mnemonic.",
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

/**
 * Simple task analysis to determine specs
 * In production, this could use an LLM for better analysis
 */
function analyzeTaskForSpecs(
  task: string,
  maxBudget: number
): { cpu: number; memory: string; storage: string; image: string; hours: number } {
  const taskLower = task.toLowerCase();

  // Default specs
  let cpu = 1;
  let memory = "1Gi";
  let storage = "5Gi";
  let image = "ubuntu:22.04";
  let hours = 1;

  // GPU/ML tasks
  if (
    taskLower.includes("pytorch") ||
    taskLower.includes("tensorflow") ||
    taskLower.includes("training") ||
    taskLower.includes("ml") ||
    taskLower.includes("machine learning")
  ) {
    cpu = 4;
    memory = "16Gi";
    storage = "50Gi";
    image = "pytorch/pytorch:2.0.1-cuda11.7-cudnn8-runtime";
    hours = 24;
  }
  // Web server tasks
  else if (
    taskLower.includes("web") ||
    taskLower.includes("api") ||
    taskLower.includes("server") ||
    taskLower.includes("node") ||
    taskLower.includes("express")
  ) {
    cpu = 2;
    memory = "2Gi";
    storage = "10Gi";
    image = "node:20-slim";
    hours = 168; // 1 week
  }
  // Python tasks
  else if (taskLower.includes("python") || taskLower.includes("script")) {
    cpu = 2;
    memory = "4Gi";
    storage = "10Gi";
    image = "python:3.11-slim";
    hours = 4;
  }
  // Database tasks
  else if (
    taskLower.includes("database") ||
    taskLower.includes("postgres") ||
    taskLower.includes("mysql") ||
    taskLower.includes("mongo")
  ) {
    cpu = 2;
    memory = "4Gi";
    storage = "50Gi";
    if (taskLower.includes("postgres")) {
      image = "postgres:16";
    } else if (taskLower.includes("mysql")) {
      image = "mysql:8.0";
    } else if (taskLower.includes("mongo")) {
      image = "mongo:7.0";
    }
    hours = 720; // 1 month
  }
  // Development environment
  else if (
    taskLower.includes("dev") ||
    taskLower.includes("development") ||
    taskLower.includes("coding")
  ) {
    cpu = 2;
    memory = "4Gi";
    storage = "20Gi";
    image = "ubuntu:22.04";
    hours = 8;
  }

  // Adjust hours based on budget
  const estimatedHourlyCost = cpu * 0.05 + 0.01; // Rough estimate
  const maxHours = Math.floor(maxBudget / estimatedHourlyCost);
  hours = Math.min(hours, maxHours);

  return { cpu, memory, storage, image, hours };
}
