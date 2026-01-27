import type {
  QuoteRequest,
  QuoteResponse,
  MultiQuoteResponse,
  ProvisionRequest,
  ProvisionResponse,
  DeploymentStatus,
  ListDeploymentsResponse,
  CloseDeploymentResponse,
  AnalyzeRequest,
  AnalyzeResponse,
  SelectProviderRequest,
  SelectProviderResponse,
  PayRequest,
  PayResponse,
  GatewayError,
} from "./types.js";

export class GatewayClient {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const authHeaders: Record<string, string> = {};
    if (this.apiKey) {
      authHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const opts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
        ...headers,
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);

    if (!res.ok) {
      let errBody: GatewayError;
      try {
        errBody = (await res.json()) as GatewayError;
      } catch {
        errBody = { error: `HTTP ${res.status}: ${res.statusText}` };
      }
      throw new GatewayRequestError(res.status, errBody);
    }

    return (await res.json()) as T;
  }

  // ── Compute ──

  async getQuote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("POST", "/compute/quote", req);
  }

  async getMultiQuotes(req: QuoteRequest): Promise<MultiQuoteResponse> {
    return this.request<MultiQuoteResponse>("POST", "/compute/quotes", req);
  }

  async provision(
    req: ProvisionRequest,
    paymentTxHash?: string,
  ): Promise<ProvisionResponse> {
    const headers: Record<string, string> = {};
    if (paymentTxHash) {
      headers["X-Payment-TxHash"] = paymentTxHash;
    }
    return this.request<ProvisionResponse>(
      "POST",
      "/compute/provision",
      req,
      headers,
    );
  }

  async getDeploymentStatus(deploymentId: string): Promise<DeploymentStatus> {
    return this.request<DeploymentStatus>(
      "GET",
      `/compute/${deploymentId}/status`,
    );
  }

  async listDeployments(status?: string): Promise<ListDeploymentsResponse> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request<ListDeploymentsResponse>("GET", `/compute${query}`);
  }

  async closeDeployment(
    deploymentId: string,
  ): Promise<CloseDeploymentResponse> {
    return this.request<CloseDeploymentResponse>(
      "POST",
      `/compute/${deploymentId}/close`,
    );
  }

  // ── LLM ──

  async analyzeTask(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    return this.request<AnalyzeResponse>("POST", "/llm/analyze", req);
  }

  async selectProvider(
    req: SelectProviderRequest,
  ): Promise<SelectProviderResponse> {
    return this.request<SelectProviderResponse>(
      "POST",
      "/llm/select-provider",
      req,
    );
  }

  // ── Payment ──

  async pay(req: PayRequest): Promise<PayResponse> {
    return this.request<PayResponse>("POST", "/x402/pay", req);
  }
}

export class GatewayRequestError extends Error {
  public status: number;
  public body: GatewayError;

  constructor(status: number, body: GatewayError) {
    super(body.error ?? `Gateway request failed with status ${status}`);
    this.name = "GatewayRequestError";
    this.status = status;
    this.body = body;
  }
}
