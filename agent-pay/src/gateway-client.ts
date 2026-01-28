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
  GatewayError,
  AuthRegisterResponse,
  AuthVerifyResponse,
  AuthInfoResponse,
} from "./types.js";

export class GatewayClient {
  private baseUrl: string;
  private token: string | undefined;

  constructor(baseUrl: string, token?: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Add auth token if available
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const opts: RequestInit = {
      method,
      headers,
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

  // ── Auth ──

  async register(walletAddress: string): Promise<AuthRegisterResponse> {
    return this.request<AuthRegisterResponse>("POST", "/auth/register", {
      walletAddress,
    });
  }

  async verify(): Promise<AuthVerifyResponse> {
    return this.request<AuthVerifyResponse>("POST", "/auth/verify", {});
  }

  async getAuthInfo(): Promise<AuthInfoResponse> {
    return this.request<AuthInfoResponse>("GET", "/auth/info");
  }

  // ── Compute ──

  async getQuote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("POST", "/compute/quote", req);
  }

  async getMultiQuotes(req: QuoteRequest): Promise<MultiQuoteResponse> {
    return this.request<MultiQuoteResponse>("POST", "/compute/quotes", req);
  }

  /**
   * Provision compute - gateway will automatically charge the authenticated wallet
   */
  async provision(req: ProvisionRequest): Promise<ProvisionResponse> {
    return this.request<ProvisionResponse>("POST", "/compute/provision", req);
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
