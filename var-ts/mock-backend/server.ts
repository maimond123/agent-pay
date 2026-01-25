/**
 * Mock Backend Server for Local Testing
 *
 * Simulates:
 * - x402 Payment Gateway
 * - VPS Provisioning Service
 *
 * Run with: bun run mock-backend/server.ts
 */

const PORT = 3001;

// In-memory storage for demo
const provisions: Map<string, any> = new Map();
const payments: Map<string, any> = new Map();

// Simple router
const routes: Record<string, (req: Request) => Promise<Response>> = {
  // Health check
  "GET /health": async () => {
    return Response.json({ status: "ok", timestamp: Date.now() });
  },

  // Get quote for service
  "POST /services/quote": async (req) => {
    const body = await req.json();
    console.log("[Quote] Request:", body);

    // Mock pricing based on specs
    const basePrice: Record<string, number> = {
      vps: 5000000,      // 5 USDC
      compute: 10000000, // 10 USDC
      storage: 2000000,  // 2 USDC
      api: 1000000,      // 1 USDC
    };

    const price = basePrice[body.serviceType] || 5000000;

    const quote = {
      price: price.toString(),
      currency: "USDC",
      paymentAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f5bE21",
      validFor: 3600, // 1 hour
      specs: body.specs,
    };

    console.log("[Quote] Response:", quote);
    return Response.json(quote);
  },

  // x402 Payment Gateway
  "POST /x402/pay": async (req) => {
    const body = await req.json();
    const paymentHeader = req.headers.get("X-402-Payment");

    console.log("[Payment] Request:", body);
    console.log("[Payment] X-402-Payment:", paymentHeader);

    // Simulate payment processing
    const txHash = `0x${Buffer.from(Date.now().toString()).toString("hex").padStart(64, "0")}`;

    const payment = {
      txHash,
      amount: body.amount,
      recipient: body.recipient,
      memo: body.memo,
      timestamp: Date.now(),
      status: "confirmed",
    };

    payments.set(txHash, payment);

    console.log("[Payment] Confirmed:", txHash);
    return Response.json(payment);
  },

  // Provision service
  "POST /services/provision": async (req) => {
    const body = await req.json();
    const paymentProof = req.headers.get("X-Payment-Proof");

    console.log("[Provision] Request:", body);
    console.log("[Provision] Payment Proof:", paymentProof);

    // Verify payment exists
    if (paymentProof && !payments.has(paymentProof)) {
      console.log("[Provision] Warning: Payment not found, proceeding anyway (mock mode)");
    }

    // Generate mock credentials
    const serviceId = `svc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const provision = {
      serviceId,
      serviceType: body.serviceType,
      specs: body.specs,
      credentials: {
        host: `${serviceId}.mock-vps.example.com`,
        port: 22,
        username: "root",
        password: `mock_${Math.random().toString(36).slice(2, 14)}`,
      },
      status: "running",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    };

    provisions.set(serviceId, provision);

    console.log("[Provision] Created:", serviceId);
    console.log("[Provision] Credentials:", provision.credentials);

    return Response.json(provision);
  },

  // Get provision status
  "GET /services/:id": async (req) => {
    const url = new URL(req.url);
    const id = url.pathname.split("/").pop();

    const provision = provisions.get(id!);
    if (!provision) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json(provision);
  },

  // List all provisions (for debugging)
  "GET /services": async () => {
    return Response.json(Array.from(provisions.values()));
  },

  // List all payments (for debugging)
  "GET /payments": async () => {
    return Response.json(Array.from(payments.values()));
  },
};

// Request handler
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  console.log(`\n[${new Date().toISOString()}] ${method} ${path}`);

  // Try exact match first
  const routeKey = `${method} ${path}`;
  if (routes[routeKey]) {
    return routes[routeKey](req);
  }

  // Try pattern matching for dynamic routes
  for (const [pattern, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = pattern.split(" ");
    if (method !== routeMethod) continue;

    // Simple pattern matching for :id style params
    if (routePath.includes(":")) {
      const regex = new RegExp(
        "^" + routePath.replace(/:[\w]+/g, "[^/]+") + "$"
      );
      if (regex.test(path)) {
        return handler(req);
      }
    }
  }

  // 404
  return Response.json(
    { error: "Not found", path, method },
    { status: 404 }
  );
}

// Start server
console.log(`
╔═══════════════════════════════════════════════════════════╗
║     VERIFIABLE AGENT RUNTIME - Mock Backend Server        ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                               ║
║  • POST /services/quote     - Get price quote             ║
║  • POST /x402/pay           - Process payment             ║
║  • POST /services/provision - Provision service           ║
║  • GET  /services           - List provisions             ║
║  • GET  /payments           - List payments               ║
║  • GET  /health             - Health check                ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                  ║
╚═══════════════════════════════════════════════════════════╝
`);

Bun.serve({
  port: PORT,
  fetch: handleRequest,
});
