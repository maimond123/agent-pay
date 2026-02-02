// ── Gateway API Types ──

export interface PortConfig {
  port: number;
  protocol: "tcp" | "udp";
  expose: boolean;
}

export interface ComputeSpecs {
  cpu: number;
  memory: string;
  storage: string;
  image: string;
  hours: number;
  region?: string;
  gpu?: {
    count: number;
    model?: string;
  };
  ports?: PortConfig[];
}

export interface QuoteRequest {
  cpu: number;
  memory: string;
  storage: string;
  image: string;
  hours: number;
  region?: string;
  gpu?: {
    count: number;
    model?: string;
  };
  ports?: PortConfig[];
}

export interface QuotePricing {
  akashCostUakt: string;
  akashCostUsd: string;
  markupUsd: string;
  totalUsd: string;
  totalUsdc: string;
}

export interface PaymentDetails {
  network: string;
  token: string;
  recipient: string;
  amount: string;
}

export interface QuoteResponse {
  quoteId: string;
  specs: ComputeSpecs;
  pricing: QuotePricing;
  paymentDetails: PaymentDetails;
  validUntil: number;
  createdAt: number;
}

export interface ProviderQuote {
  quoteId: string;
  provider: string;
  providerName: string;
  region: string;
  priceUsdc: string;
  currency: string;
  validUntil: number;
  capabilities: string;
  specs: ComputeSpecs;
}

export interface MultiQuoteResponse {
  quotes: ProviderQuote[];
}

export interface ProvisionRequest {
  quoteId: string;
  paymentTx?: string;
  image?: string;
  provider?: string;
  specs?: {
    cpu?: number;
    ram?: string;
    memory?: string;
    storage?: string;
  };
  env?: Record<string, string>;
  command?: string[];
  ports?: Array<{
    port: number;
    protocol: "tcp" | "udp";
    expose: boolean;
  }>;
}

export interface ProvisionResponse {
  deploymentId: string;
  provider: string;
  providerName: string;
  host: string;
  ports: {
    http: number;
    https: number;
    ssh: number;
  };
  status: string;
  expiresAt: number;
  credentials: {
    sshHost: string;
    sshPort: number;
    sshUser: string;
    accessToken: string;
  };
  message: string;
}

export interface AkashInfo {
  dseq?: string;
  gseq?: number;
  oseq?: number;
  provider?: string;
  leaseId?: string;
}

export interface DeploymentEndpoint {
  host: string;
  port: number;
  protocol: string;
}

export interface DeploymentStatus {
  deploymentId: string;
  status: "pending" | "deploying" | "running" | "stopped" | "failed";
  quoteId: string;
  paymentTxHash?: string;
  // Escrow-related fields
  escrowId?: string;
  userAddress?: string;
  escrowProofTx?: string;
  akash: AkashInfo;
  endpoints?: DeploymentEndpoint[];
  specs: ComputeSpecs;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ListDeploymentsResponse {
  deployments: DeploymentStatus[];
  total: number;
}

export interface CloseDeploymentResponse {
  deploymentId: string;
  status: "stopped";
  message: string;
}

export interface AnalyzeRequest {
  task: string;
  maxBudget?: number;
}

export interface AnalyzeResponse {
  recommendedCpu: number;
  recommendedRam: string;
  recommendedStorage: string;
  recommendedImage: string;
  estimatedDurationHours: number;
  reasoning: string;
  confidence: "high" | "medium" | "low";
}

export interface SelectProviderRequest {
  task: string;
  budget: number | string;
  quotes: ProviderQuote[];
}

export interface SelectProviderResponse {
  selectedProvider: string | null;
  selectedQuoteId: string | null;
  selectionReason: string;
  confidence: "high" | "medium" | "low";
}

export interface PayRequest {
  quoteId?: string;
  amount?: string;
  recipient?: string;
  memo?: string;
  currency?: string;
  network?: string;
}

export interface PayResponse {
  txHash: string;
  amount: string;
  recipient: string;
  memo: string;
  currency: string;
  network: string;
  timestamp: number;
  status: "confirmed";
  blockNumber: number;
}

export interface GatewayError {
  error: string;
  details?: unknown[];
  reason?: string;
  required?: {
    amount: string;
    token: string;
    recipient: string;
    network: string;
  };
  setup?: string;
  action?: string;
}

// ── Auth Types ──

export interface AuthRegisterResponse {
  token: string;
  walletAddress: string;
  balance: {
    usdc: string;
    raw: string;
  };
  allowance: {
    usdc: string;
    raw: string;
  };
  message: string;
}

export interface AuthVerifyResponse {
  valid: boolean;
  walletAddress?: string;
  error?: string;
  balance?: {
    usdc: string;
    raw: string;
  };
  allowance?: {
    usdc: string;
    raw: string;
  };
}

export interface AuthInfoResponse {
  walletAddress: string;
  balance: {
    usdc: string;
    raw: string;
  };
  allowance: {
    usdc: string;
    raw: string;
    sufficient: boolean;
  };
  network: string;
  gatewayAddress: string;
}
