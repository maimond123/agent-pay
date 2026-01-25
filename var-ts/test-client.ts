/**
 * Test Client for Verifiable Agent Runtime
 *
 * Simulates an AI agent making a provision request.
 * Run with: bun run test-client.ts
 */

const CRE_ENDPOINT = process.env.CRE_ENDPOINT || "http://localhost:8080";
const MOCK_BACKEND = process.env.MOCK_BACKEND || "http://localhost:3001";

interface ProvisionRequest {
  agentId: string;
  serviceType: "vps" | "compute" | "storage" | "api";
  specs: {
    ram?: string;
    cpu?: number;
    storage?: string;
    region?: string;
    os?: string;
  };
  maxBudget: string;
  paymentSignature?: string;
}

async function testProvision() {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║     VERIFIABLE AGENT RUNTIME - Test Client                ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log();

  // Test request
  const request: ProvisionRequest = {
    agentId: "test-agent-001",
    serviceType: "vps",
    specs: {
      ram: "2GB",
      cpu: 1,
      storage: "50GB",
      region: "us-east",
      os: "ubuntu-24.04",
    },
    maxBudget: "10000000", // 10 USDC (6 decimals)
    paymentSignature: "mock_signature_for_testing",
  };

  console.log("[1] Sending provision request...");
  console.log("    Agent ID:", request.agentId);
  console.log("    Service:", request.serviceType);
  console.log("    Specs:", JSON.stringify(request.specs));
  console.log("    Budget:", request.maxBudget, "USDC units");
  console.log();

  try {
    // Option 1: Direct to CRE workflow (when running via cre workflow simulate)
    console.log("[2] Calling CRE endpoint:", `${CRE_ENDPOINT}/api/provision`);

    const response = await fetch(`${CRE_ENDPOINT}/api/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    console.log();
    console.log("[3] Response received:");
    console.log("    Success:", result.success);

    if (result.success) {
      console.log("    Service ID:", result.serviceId);
      console.log("    Credentials:");
      console.log("      Host:", result.credentials?.host);
      console.log("      Port:", result.credentials?.port);
      console.log("      User:", result.credentials?.username);
      console.log("      Pass:", result.credentials?.password);
      console.log("    Attestation:");
      console.log("      TX Hash:", result.attestation?.txHash);
      console.log("      ID:", result.attestation?.attestationId);
    } else {
      console.log("    Error:", result.error);
    }

    console.log();
    console.log("═══════════════════════════════════════════════════════════");
    console.log("TEST COMPLETE");
    console.log("═══════════════════════════════════════════════════════════");

  } catch (error) {
    console.error();
    console.error("[ERROR]", error);
    console.error();
    console.error("Make sure:");
    console.error("  1. Mock backend is running: bun run mock-backend/server.ts");
    console.error("  2. CRE workflow is simulating: cre workflow simulate agent-provision");
  }
}

// Also test mock backend directly
async function testMockBackend() {
  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("TESTING MOCK BACKEND DIRECTLY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log();

  try {
    // Test quote
    console.log("[1] Testing /services/quote...");
    const quoteRes = await fetch(`${MOCK_BACKEND}/services/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceType: "vps",
        specs: { ram: "2GB", cpu: 1 },
      }),
    });
    const quote = await quoteRes.json();
    console.log("    Quote:", quote);

    // Test payment
    console.log();
    console.log("[2] Testing /x402/pay...");
    const payRes = await fetch(`${MOCK_BACKEND}/x402/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-402-Payment": "test_signature",
      },
      body: JSON.stringify({
        amount: quote.price,
        recipient: quote.paymentAddress,
        memo: "test:vps:test-agent",
      }),
    });
    const payment = await payRes.json();
    console.log("    Payment:", payment);

    // Test provision
    console.log();
    console.log("[3] Testing /services/provision...");
    const provRes = await fetch(`${MOCK_BACKEND}/services/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Proof": payment.txHash,
      },
      body: JSON.stringify({
        serviceType: "vps",
        specs: { ram: "2GB", cpu: 1 },
        paymentTx: payment.txHash,
      }),
    });
    const provision = await provRes.json();
    console.log("    Provision:", provision);

    console.log();
    console.log("MOCK BACKEND TEST: SUCCESS");

  } catch (error) {
    console.error("[ERROR] Mock backend test failed:", error);
    console.error("Make sure mock backend is running: bun run mock-backend/server.ts");
  }
}

// Run tests
const args = process.argv.slice(2);

if (args.includes("--mock-only")) {
  testMockBackend();
} else if (args.includes("--cre-only")) {
  testProvision();
} else {
  // Test mock backend first, then full flow
  testMockBackend().then(() => {
    console.log();
    testProvision();
  });
}
