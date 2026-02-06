/**
 * Prepare Deploy TX Tool
 *
 * Constructs an unsigned MsgCreateDeployment transaction.
 * Generates SDL from specs, computes manifest version, and returns signDocBytes.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SDL } from "@akashnetwork/chain-sdk";
import {
  generateSDLYaml,
  calculateDeposit,
  getCurrentBlockHeight,
  queryAccountInfo,
  constructUnsignedTx,
  constructDeploymentMsg,
} from "../akash/index.js";
import { compressedPubkeyFromHex } from "../wallet/index.js";
import type { ComputeSpecs } from "../types.js";

export function registerPrepareDeployTx(server: McpServer) {
  server.registerTool(
    "prepare_deploy_tx",
    {
      title: "Prepare Deployment Transaction",
      description:
        "Constructs an unsigned MsgCreateDeployment transaction for Akash. " +
        "Generates SDL from compute specs, computes manifest version hash, and returns signDocBytes. " +
        "Sign and broadcast via broadcast_cosmos_tx. The returned DSEQ is needed for subsequent steps.",
      inputSchema: {
        akashAddress: z
          .string()
          .describe("The Akash address that will own the deployment."),
        publicKey: z
          .string()
          .describe("Compressed secp256k1 public key (33 bytes, hex)."),
        specs: z.object({
          cpu: z.number().describe("CPU cores (e.g., 1, 2, 4)"),
          memory: z.string().describe("Memory size (e.g., '1Gi', '4Gi')"),
          storage: z.string().describe("Storage size (e.g., '10Gi', '50Gi')"),
          image: z.string().describe("Docker image (e.g., 'nginx:latest')"),
          hours: z.number().describe("Lease duration in hours"),
          gpu: z.object({
            count: z.number(),
            model: z.string().optional(),
          }).optional().describe("GPU requirements"),
          ports: z.array(z.object({
            port: z.number(),
            protocol: z.enum(["tcp", "udp"]).optional(),
            expose: z.boolean().optional(),
          })).optional().describe("Ports to expose"),
        }).describe("Compute specifications for the deployment."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables to set in the container."),
        command: z
          .array(z.string())
          .optional()
          .describe("Override container command."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network. Defaults to mainnet."),
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";
        const pubkey = compressedPubkeyFromHex(args.publicKey);

        // Check account exists
        const accountInfo = await queryAccountInfo(args.akashAddress, network);
        if (!accountInfo) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "## Account Not Found\n\n" +
                  `Account \`${args.akashAddress}\` does not exist on-chain.\n` +
                  "Fund the account first via bridge before creating a deployment.",
              },
            ],
            isError: true,
          };
        }

        // Build specs with defaults
        const specs: ComputeSpecs = {
          cpu: args.specs.cpu,
          memory: args.specs.memory,
          storage: args.specs.storage,
          image: args.specs.image,
          hours: args.specs.hours,
          gpu: args.specs.gpu,
          ports: args.specs.ports?.map((p) => ({
            port: p.port,
            protocol: (p.protocol || "tcp") as "tcp" | "udp",
            expose: p.expose !== false,
          })),
        };

        // Generate SDL
        const sdlYaml = generateSDLYaml(specs, args.env, args.command);
        const sdl = SDL.fromString(sdlYaml, "beta3");
        const deposit = calculateDeposit(specs, specs.hours);
        const version = await sdl.manifestVersion();
        const sdlGroups = sdl.groups();

        // Get block height for DSEQ
        const blockHeight = await getCurrentBlockHeight(network);
        const dseq = blockHeight.toString();

        console.error(
          `[agent-pay:prepare-deploy-tx] DSEQ=${dseq}, deposit=${deposit.amount}${deposit.denom}, image=${specs.image}`
        );

        // Construct deployment message
        const deployMsg = constructDeploymentMsg(
          args.akashAddress,
          dseq,
          sdlGroups,
          version,
          deposit
        );

        // Construct unsigned TX
        const unsignedTx = await constructUnsignedTx({
          messages: [deployMsg],
          senderPubkey: pubkey,
          accountNumber: accountInfo.accountNumber,
          sequence: accountInfo.sequence,
          network,
          memo: "Akash deployment via agent-pay",
        });

        const text = [
          "## Deployment TX Ready to Sign",
          "",
          `**DSEQ:** \`${dseq}\``,
          `**Owner:** \`${args.akashAddress}\``,
          `**Image:** ${specs.image}`,
          `**CPU:** ${specs.cpu}, **Memory:** ${specs.memory}, **Storage:** ${specs.storage}`,
          `**Deposit:** ${(parseInt(deposit.amount) / 1_000_000).toFixed(6)} AKT (escrowed, refunded on close)`,
          `**Gas Limit:** ${unsignedTx.gasLimit}`,
          `**Fee:** ${unsignedTx.fee.amount} ${unsignedTx.fee.denom}`,
          "",
          "### Sign Doc (hex)",
          "```",
          unsignedTx.signDocBytes,
          "```",
          "",
          "### Body Bytes (hex)",
          "```",
          unsignedTx.bodyBytes,
          "```",
          "",
          "### Auth Info Bytes (hex)",
          "```",
          unsignedTx.authInfoBytes,
          "```",
          "",
          "### Instructions",
          `1. Sign the signDocBytes: \`sha256(bytes) → secp256k1_sign\``,
          "2. Call `broadcast_cosmos_tx` with bodyBytes, authInfoBytes, and 64-byte signature",
          `3. Save the DSEQ (\`${dseq}\`) — you'll need it for lease creation and management`,
          "",
          "**Important:** Sign and broadcast within ~30 seconds. If too much time passes, " +
          "the DSEQ (block height) may become stale and you'll need to re-prepare.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error preparing deploy TX: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
