/**
 * Send Manifest Tool
 *
 * Sends the deployment manifest to the provider with mTLS + JWT authentication.
 * This is the final step in the deployment flow — after this, the container starts running.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SDL } from "@akashnetwork/chain-sdk";
import {
  generateSDLYaml,
  queryProvider,
  loadStoredCert,
  mtlsFetch,
  assembleJwt,
} from "../akash/index.js";
import { compressedPubkeyFromHex } from "../wallet/index.js";
import type { ComputeSpecs } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerSendManifest(server: McpServer) {
  server.registerTool(
    "send_manifest",
    {
      title: "Send Deployment Manifest to Provider",
      description:
        "Sends the deployment manifest to the Akash provider with mTLS + JWT authentication. " +
        "This is the final step — after success, the container starts running. " +
        "Requires a stored certificate (from prepare_certificate_tx) and a JWT signature (from prepare_jwt_sign_doc).",
      inputSchema: {
        akashAddress: z
          .string()
          .describe("The deployment owner's Akash address."),
        dseq: z
          .string()
          .describe("The deployment sequence number (DSEQ)."),
        provider: z
          .string()
          .describe("The provider's Akash address."),
        gseq: z
          .number()
          .optional()
          .describe("Group sequence number. Defaults to 1."),
        oseq: z
          .number()
          .optional()
          .describe("Order sequence number. Defaults to 1."),
        jwtSignature: z
          .string()
          .describe("Hex-encoded 64-byte secp256k1 signature of the JWT sign doc."),
        jwtHeader: z
          .string()
          .describe("Base64url-encoded JWT header from prepare_jwt_sign_doc."),
        jwtPayload: z
          .string()
          .describe("Base64url-encoded JWT payload from prepare_jwt_sign_doc."),
        publicKey: z
          .string()
          .describe("Compressed secp256k1 public key (33 bytes, hex)."),
        specs: z.object({
          cpu: z.number(),
          memory: z.string(),
          storage: z.string(),
          image: z.string(),
          hours: z.number(),
          gpu: z.object({
            count: z.number(),
            model: z.string().optional(),
          }).optional(),
          ports: z.array(z.object({
            port: z.number(),
            protocol: z.enum(["tcp", "udp"]).optional(),
            expose: z.boolean().optional(),
          })).optional(),
        }).describe("Compute specs (must match prepare_deploy_tx specs exactly)."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables (must match prepare_deploy_tx)."),
        command: z
          .array(z.string())
          .optional()
          .describe("Container command (must match prepare_deploy_tx)."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network. Defaults to mainnet."),
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";
        const gseq = args.gseq || 1;
        const oseq = args.oseq || 1;
        const pubkey = compressedPubkeyFromHex(args.publicKey);

        console.error(
          `[agent-pay:send-manifest] Sending manifest for DSEQ=${args.dseq} to provider ${args.provider}`
        );

        // 1. Assemble JWT from signature + pubkey
        const jwtToken = assembleJwt(
          args.jwtHeader,
          args.jwtPayload,
          args.jwtSignature,
          pubkey
        );

        // 2. Load stored certificate
        const cert = loadStoredCert(args.akashAddress);
        if (!cert) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "## Certificate Not Found\n\n" +
                  `No stored certificate for \`${args.akashAddress}\`.\n\n` +
                  "Run `prepare_certificate_tx` first to create and register a certificate.",
              },
            ],
            isError: true,
          };
        }

        // 3. Regenerate SDL from specs (must match prepare_deploy_tx exactly)
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

        const sdlYaml = generateSDLYaml(specs, args.env, args.command);
        const sdl = SDL.fromString(sdlYaml, "beta3");

        // 4. Query provider host URI
        const providerInfo = await queryProvider(args.provider, network);
        const providerHost = providerInfo?.provider?.host_uri;

        if (!providerHost) {
          return {
            content: [
              {
                type: "text" as const,
                text: `## Provider Not Found\n\nCould not find host URI for provider \`${args.provider}\`.`,
              },
            ],
            isError: true,
          };
        }

        console.error(
          `[agent-pay:send-manifest] Provider host: ${providerHost}`
        );

        // 5. Send manifest with retries (provider may need time to sync cert from chain)
        const manifestJson = sdl.manifestSortedJSON();
        const manifestUrl = `${providerHost}/deployment/${args.dseq}/manifest`;

        const maxRetries = 5;
        const retryDelayMs = 3000;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const response = await mtlsFetch(manifestUrl, cert, jwtToken, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: manifestJson,
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(
                `Provider rejected manifest: ${response.status} - ${errorText}`
              );
            }

            console.error(
              `[agent-pay:send-manifest] Manifest sent successfully on attempt ${attempt}`
            );
            lastError = null;
            break;
          } catch (error: any) {
            lastError = error;
            if (attempt < maxRetries) {
              console.error(
                `[agent-pay:send-manifest] Attempt ${attempt}/${maxRetries} failed: ${error.message}`
              );
              await sleep(retryDelayMs);
            }
          }
        }

        if (lastError) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `## Manifest Send Failed\n\n` +
                  `Failed after ${maxRetries} attempts: ${lastError.message}\n\n` +
                  "Possible causes:\n" +
                  "- Certificate not yet synced on-chain (wait and retry)\n" +
                  "- JWT signature invalid\n" +
                  "- Specs don't match deployment version hash\n" +
                  "- Provider is unavailable",
              },
            ],
            isError: true,
          };
        }

        // 6. Get deployment endpoints
        let endpoints: Array<{
          host: string;
          port: number;
          externalPort: number;
          protocol: string;
        }> = [];

        try {
          const statusUrl = `${providerHost}/lease/${args.dseq}/${gseq}/${oseq}/status`;
          const statusResponse = await mtlsFetch(statusUrl, cert, jwtToken);

          if (statusResponse.ok) {
            const status = await statusResponse.json();
            if (status.forwarded_ports) {
              for (const service of Object.values<any>(status.forwarded_ports)) {
                for (const port of service) {
                  endpoints.push({
                    host:
                      port.host ||
                      providerHost.replace(/^https?:\/\//, ""),
                    port: port.port,
                    externalPort: port.externalPort,
                    protocol: port.proto || "tcp",
                  });
                }
              }
            }
          }
        } catch {
          // Endpoints may not be available immediately
        }

        const text = [
          "## Deployment Active!",
          "",
          `**DSEQ:** ${args.dseq}`,
          `**Provider:** \`${args.provider}\``,
          `**Provider Host:** ${providerHost}`,
          "",
        ];

        if (endpoints.length > 0) {
          text.push("### Endpoints");
          for (const ep of endpoints) {
            text.push(`- \`${ep.protocol}://${ep.host}:${ep.externalPort}\``);
          }
        } else {
          text.push(
            "### Endpoints",
            "Endpoints not available yet — the container may still be starting.",
            "Check back in a few seconds with `check_deployment`."
          );
        }

        text.push(
          "",
          "### Management",
          `- Check status: \`check_deployment\` with DSEQ \`${args.dseq}\``,
          `- Close: \`prepare_close_tx\` → sign → \`broadcast_cosmos_tx\``
        );

        return { content: [{ type: "text" as const, text: text.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error sending manifest: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
