import { z } from 'zod';

// ============================================================================
// REQUEST SCHEMAS
// ============================================================================

export const ComputeQuoteRequestSchema = z.object({
  cpu: z.number().min(1).max(256),
  memory: z.string().regex(/^\d+(\.\d+)?\s*(GB|MB|TB)$/i),
  storage: z.string().regex(/^\d+(\.\d+)?\s*(GB|MB|TB)$/i),
  image: z.string().min(1),
  hours: z.number().min(1).max(720),
  region: z.string().optional(),
  gpu: z.object({
    count: z.number().min(1),
    model: z.string().optional(),
  }).optional(),
});

export const ComputeProvisionRequestSchema = z.object({
  quoteId: z.string(),
  // CRE workflow compatibility fields
  paymentTx: z.string().optional(),
  image: z.string().optional(),
  provider: z.string().optional(),
  specs: z.object({
    cpu: z.number().optional(),
    ram: z.string().optional(),
    memory: z.string().optional(),
    storage: z.string().optional(),
  }).optional(),
  // Standard fields
  env: z.record(z.string()).optional(),
  command: z.array(z.string()).optional(),
  ports: z.array(z.object({
    port: z.number(),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    expose: z.boolean().default(true),
  })).optional(),
});

export const DeploymentStatusRequestSchema = z.object({
  deploymentId: z.string(),
});

// ============================================================================
// RESPONSE TYPES
// ============================================================================

export interface ComputeQuote {
  quoteId: string;
  specs: {
    cpu: number;
    memory: string;
    storage: string;
    image: string;
    hours: number;
    gpu?: {
      count: number;
      model?: string;
    };
  };
  pricing: {
    akashCostUakt: string;
    akashCostUsd: string;
    markupUsd: string;
    totalUsd: string;
    totalUsdc: string;
  };
  paymentDetails: {
    network: string;
    token: string;
    recipient: string;
    amount: string;
  };
  validUntil: number;
  createdAt: number;
}

export interface DeploymentInfo {
  deploymentId: string;
  status: 'pending' | 'deploying' | 'running' | 'stopped' | 'failed';
  quoteId: string;
  paymentTxHash?: string;
  akash: {
    dseq?: string;
    gseq?: number;
    oseq?: number;
    provider?: string;
    leaseId?: string;
  };
  endpoints?: {
    host: string;
    port: number;
    protocol: string;
  }[];
  specs: ComputeQuote['specs'];
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProvisionResponse {
  deploymentId: string;
  status: DeploymentInfo['status'];
  message: string;
  endpoints?: DeploymentInfo['endpoints'];
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

export interface StoredQuote extends ComputeQuote {
  used: boolean;
}

export interface AkashDeploymentConfig {
  cpu: number;
  memoryMb: number;
  storageMb: number;
  image: string;
  env?: Record<string, string>;
  command?: string[];
  ports?: Array<{
    port: number;
    protocol: 'tcp' | 'udp';
    expose: boolean;
  }>;
  gpu?: {
    count: number;
    model?: string;
  };
}

// Type exports from schemas
export type ComputeQuoteRequest = z.infer<typeof ComputeQuoteRequestSchema>;
export type ComputeProvisionRequest = z.infer<typeof ComputeProvisionRequestSchema>;
