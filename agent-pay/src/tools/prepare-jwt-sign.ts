/**
 * Prepare JWT Sign Doc Tool
 *
 * Constructs an ADR-036 amino sign doc for JWT authentication with Akash providers.
 * Agent A signs the canonical JSON, then passes the signature to send_manifest.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { constructAminoJwtSignDoc } from "../akash/index.js";

export function registerPrepareJwtSign(server: McpServer) {
  server.registerTool(
    "prepare_jwt_sign_doc",
    {
      title: "Prepare JWT Sign Document",
      description:
        "Constructs an ADR-036 amino sign document for JWT authentication with Akash providers. " +
        "The returned canonical JSON must be sha256-hashed and signed with secp256k1. " +
        "Pass the signature to send_manifest for provider authentication.",
      inputSchema: {
        akashAddress: z
          .string()
          .describe("The Akash address to authenticate as."),
      },
    },
    async (args) => {
      try {
        console.error(
          `[agent-pay:prepare-jwt-sign] JWT sign doc for ${args.akashAddress}`
        );

        const result = constructAminoJwtSignDoc(args.akashAddress);

        const text = [
          "## JWT Sign Document Ready",
          "",
          `**Akash Address:** \`${args.akashAddress}\``,
          `**Expires:** 3600 seconds (1 hour)`,
          "",
          "### Canonical JSON to Sign",
          "```json",
          result.signDocCanonicalJson,
          "```",
          "",
          "### JWT Header (for reassembly)",
          "```",
          result.jwtHeader,
          "```",
          "",
          "### JWT Payload (for reassembly)",
          "```",
          result.jwtPayload,
          "```",
          "",
          "### Instructions",
          "1. Convert the canonical JSON to bytes (UTF-8)",
          "2. Compute `sha256(bytes)`",
          "3. Sign the hash with your secp256k1 private key → 64-byte signature (r||s)",
          "4. Pass the signature (hex) to `send_manifest` as `jwtSignature`",
          "",
          "The jwtHeader and jwtPayload are needed internally for JWT reassembly — " +
          "pass them to send_manifest if prompted.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error preparing JWT sign doc: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
