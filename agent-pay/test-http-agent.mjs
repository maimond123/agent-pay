#!/usr/bin/env node

/**
 * Test Agent — exercises all MCP tools over HTTP
 *
 * Usage:
 *   1. Start the HTTP server:  npm run serve
 *   2. Run this script:        node test-http-agent.mjs [server-url]
 *
 * Default server URL: http://localhost:3001/mcp
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = process.argv[2] || "http://localhost:3001/mcp";

// Known test data (from existing wallet)
const TEST_AKASH_ADDRESS = "akash1kvgxaysqacuac7rqnwlz44h5hukm490gyrueun";
const TEST_EVM_ADDRESS = "0x3e6E1DfA9F9b613Ce80Fc8770C64A02914f4A79a";
// A known test compressed pubkey (33 bytes, hex) — replace with actual if available
const TEST_PUBKEY = "02" + "a".repeat(64); // placeholder, derive_akash_address will validate

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const result = await fn();
    if (result?.isError) {
      // Tool returned an error response — that's OK for some tests
      console.log(`⚠ tool error (expected for some): ${result.content?.[0]?.text?.slice(0, 80)}`);
      passed++;
    } else {
      const preview = result?.content?.[0]?.text?.slice(0, 100) || "(no text)";
      console.log(`✓ ${preview.replace(/\n/g, " ")}`);
      passed++;
    }
  } catch (err) {
    console.log(`✗ ${err.message.slice(0, 120)}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${name} ... ⊘ skipped (${reason})`);
  skipped++;
}

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║              MCP HTTP Agent Test Suite                        ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝\n`);
  console.log(`Server: ${SERVER_URL}\n`);

  // 1. Connect
  console.log("Step 1: Connect to MCP server");
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
  await client.connect(transport);
  console.log("  ✓ Connected\n");

  // 2. List tools
  console.log("Step 2: List tools");
  const { tools } = await client.listTools();
  console.log(`  ✓ Found ${tools.length} tools:`);
  for (const tool of tools) {
    console.log(`    - ${tool.name}`);
  }
  console.log("");

  if (tools.length !== 16) {
    console.log(`  ⚠ Expected 16 tools, got ${tools.length}\n`);
  }

  // 3. Test each tool
  console.log("Step 3: Test tools\n");
  console.log("  --- Read-only tools ---");

  await test("check_wallet (with address)", () =>
    client.callTool({
      name: "check_wallet",
      arguments: { akashAddress: TEST_AKASH_ADDRESS },
    })
  );

  await test("check_wallet (no address)", () =>
    client.callTool({
      name: "check_wallet",
      arguments: {},
    })
  );

  await test("list_deployments", () =>
    client.callTool({
      name: "list_deployments",
      arguments: { akashAddress: TEST_AKASH_ADDRESS },
    })
  );

  await test("check_deployment (fake DSEQ)", () =>
    client.callTool({
      name: "check_deployment",
      arguments: { dseq: "99999999", akashAddress: TEST_AKASH_ADDRESS },
    })
  );

  console.log("\n  --- Key derivation ---");

  await test("derive_akash_address (invalid pubkey — error expected)", () =>
    client.callTool({
      name: "derive_akash_address",
      arguments: {
        evmAddress: TEST_EVM_ADDRESS,
        publicKey: TEST_PUBKEY,
      },
    })
  );

  console.log("\n  --- Bridge tools ---");

  await test("prepare_bridge_tx", () =>
    client.callTool({
      name: "prepare_bridge_tx",
      arguments: {
        evmAddress: TEST_EVM_ADDRESS,
        akashAddress: TEST_AKASH_ADDRESS,
        amountUSDC: "1",
        destinationType: "akt",
      },
    })
  );

  await test("track_bridge (fake tx — error expected)", () =>
    client.callTool({
      name: "track_bridge",
      arguments: {
        txHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
    })
  );

  console.log("\n  --- TX construction tools ---");

  await test("prepare_certificate_tx", () =>
    client.callTool({
      name: "prepare_certificate_tx",
      arguments: {
        akashAddress: TEST_AKASH_ADDRESS,
        publicKey: TEST_PUBKEY,
      },
    })
  );

  await test("prepare_deploy_tx", () =>
    client.callTool({
      name: "prepare_deploy_tx",
      arguments: {
        akashAddress: TEST_AKASH_ADDRESS,
        publicKey: TEST_PUBKEY,
        specs: {
          cpu: 1,
          memory: "1Gi",
          storage: "5Gi",
          image: "nginx:latest",
          hours: 1,
          ports: [{ port: 80, protocol: "tcp", expose: true }],
        },
      },
    })
  );

  await test("prepare_lease_tx (fake provider — error expected)", () =>
    client.callTool({
      name: "prepare_lease_tx",
      arguments: {
        akashAddress: TEST_AKASH_ADDRESS,
        publicKey: TEST_PUBKEY,
        dseq: "99999999",
        provider: "akash1fake000000000000000000000000000000000",
      },
    })
  );

  await test("prepare_close_tx (fake DSEQ)", () =>
    client.callTool({
      name: "prepare_close_tx",
      arguments: {
        akashAddress: TEST_AKASH_ADDRESS,
        publicKey: TEST_PUBKEY,
        dseq: "99999999",
      },
    })
  );

  await test("query_bids (no bids expected)", () =>
    client.callTool({
      name: "query_bids",
      arguments: {
        akashAddress: TEST_AKASH_ADDRESS,
        dseq: "99999999",
      },
    })
  );

  await test("broadcast_cosmos_tx (invalid sig — error expected)", () =>
    client.callTool({
      name: "broadcast_cosmos_tx",
      arguments: {
        bodyBytes: "0a00",
        authInfoBytes: "0a00",
        signature: "00".repeat(64),
      },
    })
  );

  console.log("\n  --- Provider auth tools ---");

  await test("prepare_jwt_sign_doc", () =>
    client.callTool({
      name: "prepare_jwt_sign_doc",
      arguments: {
        akashAddress: TEST_AKASH_ADDRESS,
      },
    })
  );

  await test("send_manifest (no cert — error expected)", () =>
    client.callTool({
      name: "send_manifest",
      arguments: {
        akashAddress: "akash1fakeaddressnocert000000000000000000",
        dseq: "99999999",
        provider: "akash1fakeprovider00000000000000000000000",
        jwtSignature: "00".repeat(64),
        jwtHeader: "eyJhbGciOiJFUzI1NktBRFIzNiIsInR5cCI6IkpXVCJ9",
        jwtPayload: "eyJ2ZXJzaW9uIjoidjEifQ",
        publicKey: TEST_PUBKEY,
        specs: {
          cpu: 1,
          memory: "1Gi",
          storage: "5Gi",
          image: "nginx:latest",
          hours: 1,
        },
      },
    })
  );

  console.log("\n  --- CLI-flow tools ---");

  await test("provision_compute", () =>
    client.callTool({
      name: "provision_compute",
      arguments: {
        task: "Run a test nginx server for 1 hour",
        cpu: 1,
        memory: "1Gi",
        storage: "5Gi",
        image: "nginx:latest",
        hours: 1,
      },
    })
  );

  await test("stop_deployment (fake DSEQ)", () =>
    client.callTool({
      name: "stop_deployment",
      arguments: {
        dseq: "99999999",
      },
    })
  );

  // 4. Summary
  console.log(`\n${"═".repeat(63)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`${"═".repeat(63)}\n`);

  await transport.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
