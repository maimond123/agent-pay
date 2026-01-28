import { logger } from '../server/logger.js';

// ============================================================================
// AKASH PRICING CONSTANTS
// ============================================================================

// Base pricing per hour in USD cents (realistic Akash-like pricing)
// Based on typical decentralized compute marketplace rates
const PRICING_PER_HOUR_CENTS = {
  cpu: 0.5,       // $0.005 per CPU core per hour
  memoryGb: 0.2,  // $0.002 per GB RAM per hour
  storageGb: 0.05, // $0.0005 per GB storage per hour
  gpuNvidia: 50,  // $0.50 per GPU per hour (varies by model)
};

// For Akash cost calculation (approximate)
const UAKT_PER_USD_CENT = 285; // ~$3.50/AKT means 1 cent = ~285 uAKT

// AKT to USD exchange rate (should be fetched from oracle in production)
let aktUsdRate = 3.50; // Default rate

// Markup percentage from env
const MARKUP_PERCENTAGE = parseFloat(process.env.MARKUP_PERCENTAGE || '15');

// ============================================================================
// PRICING CALCULATOR
// ============================================================================

export interface PricingInput {
  cpu: number;
  memoryMb: number;
  storageMb: number;
  hours: number;
  gpu?: {
    count: number;
    model?: string;
  };
}

export interface PricingResult {
  akashCostUakt: bigint;
  akashCostUsd: number;
  markupUsd: number;
  totalUsd: number;
  totalUsdc: string; // 6 decimal string for USDC
  breakdown: {
    cpuCostUakt: bigint;
    memoryCostUakt: bigint;
    storageCostUakt: bigint;
    gpuCostUakt: bigint;
  };
}

/**
 * Calculate deployment cost in Akash tokens and USD
 */
export function calculatePrice(input: PricingInput): PricingResult {
  // Convert memory/storage to GB
  const memoryGb = input.memoryMb / 1024;
  const storageGb = input.storageMb / 1024;

  // Calculate individual costs in USD cents
  const cpuCostCents = input.cpu * PRICING_PER_HOUR_CENTS.cpu * input.hours;
  const memoryCostCents = memoryGb * PRICING_PER_HOUR_CENTS.memoryGb * input.hours;
  const storageCostCents = storageGb * PRICING_PER_HOUR_CENTS.storageGb * input.hours;

  let gpuCostCents = 0;
  if (input.gpu && input.gpu.count > 0) {
    gpuCostCents = input.gpu.count * PRICING_PER_HOUR_CENTS.gpuNvidia * input.hours;
  }

  // Total cost in cents and USD
  const totalCostCents = cpuCostCents + memoryCostCents + storageCostCents + gpuCostCents;
  const akashCostUsd = totalCostCents / 100;

  // Calculate approximate uAKT cost
  const cpuCostUakt = BigInt(Math.ceil(cpuCostCents * UAKT_PER_USD_CENT));
  const memoryCostUakt = BigInt(Math.ceil(memoryCostCents * UAKT_PER_USD_CENT));
  const storageCostUakt = BigInt(Math.ceil(storageCostCents * UAKT_PER_USD_CENT));
  const gpuCostUakt = BigInt(Math.ceil(gpuCostCents * UAKT_PER_USD_CENT));
  const akashCostUakt = cpuCostUakt + memoryCostUakt + storageCostUakt + gpuCostUakt;

  // Apply markup
  const markupUsd = akashCostUsd * (MARKUP_PERCENTAGE / 100);
  const totalUsd = akashCostUsd + markupUsd;

  // Convert to USDC (6 decimals)
  const totalUsdc = (totalUsd * 1_000_000).toFixed(0);

  logger.debug({
    input,
    breakdown: {
      cpuCostUakt: cpuCostUakt.toString(),
      memoryCostUakt: memoryCostUakt.toString(),
      storageCostUakt: storageCostUakt.toString(),
      gpuCostUakt: gpuCostUakt.toString(),
    },
    akashCostUakt: akashCostUakt.toString(),
    akashCostUsd,
    markupUsd,
    totalUsd,
    totalUsdc,
  }, 'Price calculated');

  return {
    akashCostUakt,
    akashCostUsd,
    markupUsd,
    totalUsd,
    totalUsdc,
    breakdown: {
      cpuCostUakt,
      memoryCostUakt,
      storageCostUakt,
      gpuCostUakt,
    },
  };
}

/**
 * Parse memory/storage string to MB
 */
export function parseToMb(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(GB|MB|TB)$/i);
  if (!match) {
    throw new Error(`Invalid size format: ${size}`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();

  switch (unit) {
    case 'TB':
      return value * 1024 * 1024;
    case 'GB':
      return value * 1024;
    case 'MB':
      return value;
    default:
      return value * 1024; // Default to GB
  }
}

/**
 * Update AKT/USD exchange rate
 * In production, this should fetch from a price oracle
 */
export function updateAktUsdRate(rate: number): void {
  aktUsdRate = rate;
  logger.info({ rate }, 'AKT/USD rate updated');
}

/**
 * Get current AKT/USD rate
 */
export function getAktUsdRate(): number {
  return aktUsdRate;
}

/**
 * Format USD amount for display
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Format USDC amount (6 decimals) for display
 */
export function formatUsdc(amount: string): string {
  const value = parseInt(amount) / 1_000_000;
  return `${value.toFixed(2)} USDC`;
}
