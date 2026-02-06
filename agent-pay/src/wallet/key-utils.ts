/**
 * Cross-Chain Key Utilities
 *
 * Derives Akash (Cosmos) addresses from EVM secp256k1 public keys.
 * The same raw secp256k1 key pair can sign on both EVM and Cosmos chains:
 *   - EVM address:  keccak256(uncompressedPubkey[1:])[12:]
 *   - Cosmos address: ripemd160(sha256(compressedPubkey)) → bech32("akash", ...)
 */

import { Ripemd160, sha256, Secp256k1 } from "@cosmjs/crypto";
import { toBech32, fromHex, toHex } from "@cosmjs/encoding";
import { keccak256 } from "viem";

/**
 * Validate and parse a hex-encoded compressed secp256k1 public key.
 * Must be exactly 33 bytes starting with 0x02 or 0x03.
 */
export function compressedPubkeyFromHex(hex: string): Uint8Array {
  // Strip 0x prefix if present
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = fromHex(cleanHex);

  if (bytes.length !== 33) {
    throw new Error(
      `Invalid compressed pubkey: expected 33 bytes, got ${bytes.length}`
    );
  }

  if (bytes[0] !== 0x02 && bytes[0] !== 0x03) {
    throw new Error(
      `Invalid compressed pubkey: must start with 0x02 or 0x03, got 0x${bytes[0].toString(16).padStart(2, "0")}`
    );
  }

  return bytes;
}

/**
 * Derive an Akash bech32 address from a compressed secp256k1 public key.
 * Uses the standard Cosmos address derivation: ripemd160(sha256(compressedPubkey))
 */
export function evmPubkeyToAkashAddress(compressedPubkey: Uint8Array): string {
  const sha256Hash = sha256(compressedPubkey);
  const ripemdHash = new Ripemd160().update(sha256Hash).digest();
  const address = toBech32("akash", ripemdHash);

  console.error(
    `[agent-pay:key-utils:evmPubkeyToAkashAddress] Derived ${address} from pubkey ${toHex(compressedPubkey).slice(0, 10)}...`
  );

  return address;
}

/**
 * Verify that a compressed secp256k1 public key corresponds to a given EVM address.
 * Decompresses the pubkey, takes keccak256 of the uncompressed key (without prefix),
 * and checks that the last 20 bytes match the EVM address.
 */
export function verifyEvmPubkey(
  evmAddress: string,
  compressedPubkey: Uint8Array
): boolean {
  // Decompress the public key (returns 65 bytes: 0x04 || x || y)
  const uncompressed = Secp256k1.uncompressPubkey(compressedPubkey);

  // EVM address = keccak256(uncompressed[1:])[12:]  (skip the 0x04 prefix byte)
  const uncompressedWithoutPrefix = uncompressed.slice(1);
  const hash = keccak256(("0x" + toHex(uncompressedWithoutPrefix)) as `0x${string}`);

  // keccak256 returns a hex string like "0x..."
  // The EVM address is the last 20 bytes (40 hex chars)
  const derivedAddress = `0x${hash.slice(-40)}`;

  const normalizedInput = evmAddress.toLowerCase();
  const normalizedDerived = derivedAddress.toLowerCase();
  const matches = normalizedInput === normalizedDerived;

  console.error(
    `[agent-pay:key-utils:verifyEvmPubkey] Pubkey ${matches ? "matches" : "MISMATCHES"} EVM address ${evmAddress}`
  );

  return matches;
}
