/**
 * Derive Akash Address Tool
 *
 * Derives an Akash (Cosmos) address from an EVM public key.
 * Same secp256k1 key works on both chains with different address encodings.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  compressedPubkeyFromHex,
  evmPubkeyToAkashAddress,
  verifyEvmPubkey,
} from "../wallet/index.js";

export function registerDeriveAddress(server: McpServer) {
  server.registerTool(
    "derive_akash_address",
    {
      title: "Derive Akash Address from EVM Key",
      description:
        "Derives an Akash (Cosmos) address from an EVM secp256k1 public key. " +
        "The same private key can sign transactions on both EVM (Base) and Cosmos (Akash) chains. " +
        "Provide the compressed public key (33 bytes, hex) and EVM address for validation.",
      inputSchema: {
        evmAddress: z
          .string()
          .describe("The EVM address (0x-prefixed hex) corresponding to this public key."),
        publicKey: z
          .string()
          .describe(
            "Compressed secp256k1 public key (33 bytes, hex-encoded, with or without 0x prefix). " +
            "Starts with 02 or 03."
          ),
      },
    },
    async (args) => {
      try {
        console.error(
          `[agent-pay:derive-address] EVM ${args.evmAddress} → deriving Akash address`
        );

        // Parse and validate public key
        const pubkey = compressedPubkeyFromHex(args.publicKey);

        // Verify pubkey matches EVM address
        const matches = verifyEvmPubkey(args.evmAddress, pubkey);
        if (!matches) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "## Public Key Mismatch\n\n" +
                  `The provided public key does not correspond to EVM address \`${args.evmAddress}\`.\n\n` +
                  "Please provide the correct compressed secp256k1 public key for this address.",
              },
            ],
            isError: true,
          };
        }

        // Derive Akash address
        const akashAddress = evmPubkeyToAkashAddress(pubkey);

        console.error(
          `[agent-pay:derive-address] EVM ${args.evmAddress} → Akash ${akashAddress}`
        );

        const text = [
          "## Cross-Chain Address Derivation",
          "",
          `**EVM Address:** \`${args.evmAddress}\``,
          `**Akash Address:** \`${akashAddress}\``,
          "",
          "Both addresses are derived from the same secp256k1 key pair:",
          "- EVM: `keccak256(uncompressedPubkey)[12:]`",
          "- Cosmos: `ripemd160(sha256(compressedPubkey))` → bech32",
          "",
          "The same private key can sign transactions on both chains.",
          "Use this Akash address for all subsequent deployment operations.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error deriving address: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
