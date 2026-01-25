/**
 * Enhanced Mock Backend Server for AI-Powered Compute Provisioning
 *
 * Simulates:
 * - LLM API for task analysis and provider selection
 * - x402 Akash-style Compute Gateway with multiple providers
 * - x402 Payment Gateway (USDC on Base)
 *
 * Run with: bun run server.ts
 */

const PORT = 3002;

// In-memory storage
const quotes: Map<string, any> = new Map();
const provisions: Map<string, any> = new Map();
const payments: Map<string, any> = new Map();

// Simulated compute providers (Akash-style)
const PROVIDERS = [
  {
    id: "akash-provider-1",
    name: "Akash US-East",
    region: "us-east",
    capabilities: "gpu,high-memory",
    reliability: 0.99,
    priceMultiplier: 1.0,
  },
  {
    id: "akash-provider-2",
    name: "Akash EU-West",
    region: "eu-west",
    capabilities: "cpu,standard",
    reliability: 0.98,
    priceMultiplier: 0.85,
  },
  {
    id: "flux-provider-1",
    name: "Flux Global",
    region: "global",
    capabilities: "cpu,gpu,storage",
    reliability: 0.97,
    priceMultiplier: 0.90,
  },
];

// Base pricing per hour (in USDC cents)
const BASE_PRICING = {
  cpu: 5,      // $0.05 per CPU core per hour
  ram: 2,      // $0.02 per GB RAM per hour
  storage: 1,  // $0.01 per GB storage per hour
  gpu: 50,     // $0.50 per GPU per hour
};

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

const routes: Record<string, (req: Request) => Promise<Response>> = {
  // Health check
  "GET /health": async () => {
    return Response.json({
      status: "ok",
      timestamp: Date.now(),
      services: ["llm", "compute", "payment"],
    });
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LLM API ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  // LLM: Analyze task and recommend compute specs
  "POST /llm/analyze": async (req) => {
    const body = await req.json();
    console.log("\n[LLM/Analyze] Task:", body.task);
    console.log("[LLM/Analyze] Budget:", body.maxBudget, "USDC");

    // Simulate LLM analysis based on keywords
    const task = body.task.toLowerCase();

    let analysis = {
      recommendedCpu: 2,
      recommendedRam: "4GB",
      recommendedStorage: "10GB",
      recommendedImage: "python:3.11",
      estimatedDurationHours: 1,
      reasoning: "",
      confidence: "high",
    };

    // Analyze task keywords
    if (task.includes("machine learning") || task.includes("ml") || task.includes("training")) {
      analysis = {
        recommendedCpu: 4,
        recommendedRam: "16GB",
        recommendedStorage: "50GB",
        recommendedImage: "pytorch/pytorch:latest",
        estimatedDurationHours: 4,
        reasoning: "Machine learning task detected. Recommending higher CPU cores and RAM for training workloads. PyTorch image selected for ML frameworks. Extended duration for training epochs.",
        confidence: "high",
      };
    } else if (task.includes("web") || task.includes("api") || task.includes("server")) {
      analysis = {
        recommendedCpu: 2,
        recommendedRam: "4GB",
        recommendedStorage: "20GB",
        recommendedImage: "node:20-alpine",
        estimatedDurationHours: 24,
        reasoning: "Web service task detected. Moderate resources sufficient for API hosting. Node.js image for JavaScript/TypeScript workloads. Extended duration for service availability.",
        confidence: "high",
      };
    } else if (task.includes("data") || task.includes("analysis") || task.includes("pandas")) {
      analysis = {
        recommendedCpu: 4,
        recommendedRam: "8GB",
        recommendedStorage: "100GB",
        recommendedImage: "jupyter/scipy-notebook",
        estimatedDurationHours: 2,
        reasoning: "Data analysis task detected. Higher memory for data processing. Large storage for datasets. Jupyter notebook for interactive analysis.",
        confidence: "medium",
      };
    } else if (task.includes("gpu") || task.includes("cuda") || task.includes("render")) {
      analysis = {
        recommendedCpu: 8,
        recommendedRam: "32GB",
        recommendedStorage: "100GB",
        recommendedImage: "nvidia/cuda:12.0-runtime-ubuntu22.04",
        estimatedDurationHours: 6,
        reasoning: "GPU workload detected. High resources required for CUDA operations. NVIDIA CUDA image for GPU acceleration.",
        confidence: "high",
      };
    } else {
      analysis.reasoning = "General compute task. Default configuration with Python runtime. Adjust based on actual workload requirements.";
      analysis.confidence = "medium";
    }

    console.log("[LLM/Analyze] Recommendation:", JSON.stringify(analysis, null, 2));
    return Response.json(analysis);
  },

  // LLM: Select best provider from quotes
  "POST /llm/select-provider": async (req) => {
    const body = await req.json();
    console.log("\n[LLM/Select] Task:", body.task?.substring(0, 50));
    console.log("[LLM/Select] Budget:", body.budget, "USDC");
    console.log("[LLM/Select] Quotes:", body.quotes?.length);

    const quotes = body.quotes || [];
    const budget = parseFloat(body.budget) || 100;

    // Filter quotes within budget and select best
    const validQuotes = quotes.filter((q: any) => parseFloat(q.priceUsdc) <= budget);

    if (validQuotes.length === 0) {
      return Response.json({
        selectedProvider: null,
        selectedQuoteId: null,
        selectionReason: "No providers within budget",
        confidence: "low",
      });
    }

    // Simple selection: cheapest reliable provider
    const sorted = validQuotes.sort((a: any, b: any) =>
      parseFloat(a.priceUsdc) - parseFloat(b.priceUsdc)
    );

    const selected = sorted[0];

    const response = {
      selectedProvider: selected.provider,
      selectedQuoteId: selected.quoteId,
      selectionReason: `Selected ${selected.provider} as the most cost-effective option at $${selected.priceUsdc} USDC. Provider offers ${selected.capabilities} capabilities suitable for the task.`,
      confidence: "high",
    };

    console.log("[LLM/Select] Selected:", response.selectedProvider);
    return Response.json(response);
  },

  // ══════════════════════════════════════════════════════════════════════════
  // COMPUTE GATEWAY ENDPOINTS (x402 Akash-style)
  // ══════════════════════════════════════════════════════════════════════════

  // Get quotes from multiple providers
  "POST /compute/quotes": async (req) => {
    const body = await req.json();
    console.log("\n[Compute/Quotes] Request:", JSON.stringify(body));

    const cpu = body.cpu || 1;
    const ram = parseSize(body.ram || "1GB");
    const storage = parseSize(body.storage || "1GB");
    const hours = body.hours || 1;

    // Calculate base cost
    const baseCost = (
      (cpu * BASE_PRICING.cpu) +
      (ram * BASE_PRICING.ram) +
      (storage * BASE_PRICING.storage)
    ) * hours / 100; // Convert cents to dollars

    // Generate quotes from each provider
    const providerQuotes = PROVIDERS.map((provider) => {
      const price = (baseCost * provider.priceMultiplier).toFixed(2);
      const quoteId = `quote_${provider.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const quote = {
        quoteId,
        provider: provider.id,
        providerName: provider.name,
        region: provider.region,
        priceUsdc: price,
        currency: "USDC",
        validUntil: Date.now() + 300000, // 5 minutes
        capabilities: provider.capabilities,
        specs: { cpu, ram: body.ram, storage: body.storage, hours },
      };

      quotes.set(quoteId, quote);
      return quote;
    });

    console.log("[Compute/Quotes] Generated", providerQuotes.length, "quotes");
    providerQuotes.forEach(q => console.log(`  - ${q.provider}: $${q.priceUsdc}`));

    return Response.json({ quotes: providerQuotes });
  },

  // Provision compute (requires payment proof)
  "POST /compute/provision": async (req) => {
    const body = await req.json();
    const paymentProof = req.headers.get("X-Payment-Proof");

    console.log("\n[Compute/Provision] Request:", JSON.stringify(body));
    console.log("[Compute/Provision] Payment Proof:", paymentProof);

    // Verify payment
    if (paymentProof && !payments.has(paymentProof)) {
      console.log("[Compute/Provision] Warning: Payment not found, proceeding in mock mode");
    }

    // Verify quote exists
    const quote = quotes.get(body.quoteId);
    if (!quote) {
      console.log("[Compute/Provision] Warning: Quote not found, proceeding in mock mode");
    }

    // Generate deployment
    const deploymentId = `deploy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const provider = PROVIDERS.find(p => p.id === body.provider) || PROVIDERS[0];

    const provision = {
      deploymentId,
      provider: provider.id,
      providerName: provider.name,
      host: `${deploymentId}.${provider.region}.akash.network`,
      ports: {
        http: 80,
        https: 443,
        ssh: 22,
      },
      status: "running",
      expiresAt: Date.now() + (body.specs?.hours || 1) * 3600 * 1000,
      credentials: {
        sshHost: `${deploymentId}.${provider.region}.akash.network`,
        sshPort: 22,
        sshUser: "root",
        accessToken: `token_${Math.random().toString(36).slice(2, 20)}`,
      },
      specs: body.specs,
      image: body.image,
      createdAt: Date.now(),
    };

    provisions.set(deploymentId, provision);

    console.log("[Compute/Provision] Created:", deploymentId);
    console.log("[Compute/Provision] Host:", provision.host);

    return Response.json(provision);
  },

  // Get deployment status
  "GET /compute/:id": async (req) => {
    const url = new URL(req.url);
    const id = url.pathname.split("/").pop();

    const provision = provisions.get(id!);
    if (!provision) {
      return Response.json({ error: "Deployment not found" }, { status: 404 });
    }

    return Response.json(provision);
  },

  // ══════════════════════════════════════════════════════════════════════════
  // X402 PAYMENT GATEWAY ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  // Process x402 payment
  "POST /x402/pay": async (req) => {
    const body = await req.json();
    console.log("\n[x402/Pay] Request:", JSON.stringify(body));

    // Simulate blockchain transaction
    const txHash = `0x${Buffer.from(Date.now().toString()).toString("hex").padStart(64, "0")}`;

    const payment = {
      txHash,
      amount: body.amount,
      recipient: body.recipient,
      memo: body.memo,
      currency: body.currency || "USDC",
      network: body.network || "base",
      timestamp: Date.now(),
      status: "confirmed",
      blockNumber: Math.floor(Date.now() / 1000),
    };

    payments.set(txHash, payment);

    console.log("[x402/Pay] Confirmed:", txHash);
    console.log("[x402/Pay] Amount:", payment.amount, payment.currency);

    return Response.json(payment);
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DEBUG ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  "GET /debug/quotes": async () => {
    return Response.json(Array.from(quotes.values()));
  },

  "GET /debug/provisions": async () => {
    return Response.json(Array.from(provisions.values()));
  },

  "GET /debug/payments": async () => {
    return Response.json(Array.from(payments.values()));
  },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function parseSize(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(GB|MB|TB)?$/i);
  if (!match) return 1;

  const value = parseFloat(match[1]);
  const unit = (match[2] || "GB").toUpperCase();

  switch (unit) {
    case "TB": return value * 1024;
    case "GB": return value;
    case "MB": return value / 1024;
    default: return value;
  }
}

// ============================================================================
// REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Payment-Proof, X-402-Payment",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  console.log(`\n[${new Date().toISOString()}] ${method} ${path}`);

  // Try exact match first
  const routeKey = `${method} ${path}`;
  if (routes[routeKey]) {
    const response = await routes[routeKey](req);
    // Add CORS headers to response
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, { ...response, headers });
  }

  // Try pattern matching for dynamic routes
  for (const [pattern, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = pattern.split(" ");
    if (method !== routeMethod) continue;

    if (routePath.includes(":")) {
      const regex = new RegExp(
        "^" + routePath.replace(/:[\w]+/g, "[^/]+") + "$"
      );
      if (regex.test(path)) {
        const response = await handler(req);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
        return new Response(response.body, { ...response, headers });
      }
    }
  }

  return Response.json(
    { error: "Not found", path, method },
    { status: 404, headers: corsHeaders }
  );
}

// ============================================================================
// START SERVER
// ============================================================================

console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║       AI-POWERED AUTONOMOUS COMPUTE - Mock Backend Server                    ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  LLM API Endpoints:                                                          ║
║  • POST /llm/analyze          - Analyze task, recommend compute specs        ║
║  • POST /llm/select-provider  - Select best provider from quotes             ║
║                                                                              ║
║  Compute Gateway (x402 Akash-style):                                         ║
║  • POST /compute/quotes       - Get quotes from multiple providers           ║
║  • POST /compute/provision    - Provision compute (requires payment)         ║
║  • GET  /compute/:id          - Get deployment status                        ║
║                                                                              ║
║  Payment Gateway (x402):                                                     ║
║  • POST /x402/pay             - Process USDC payment on Base                 ║
║                                                                              ║
║  Debug Endpoints:                                                            ║
║  • GET  /debug/quotes         - List all quotes                              ║
║  • GET  /debug/provisions     - List all provisions                          ║
║  • GET  /debug/payments       - List all payments                            ║
║                                                                              ║
║  Simulated Providers:                                                        ║
║  • akash-provider-1 (US-East)  - GPU, High-memory                           ║
║  • akash-provider-2 (EU-West)  - CPU, Standard (15% cheaper)                ║
║  • flux-provider-1  (Global)   - CPU, GPU, Storage (10% cheaper)            ║
║                                                                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                                     ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

Bun.serve({
  port: PORT,
  fetch: handleRequest,
});
