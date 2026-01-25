import { logger } from '../server/logger.js';

// ============================================================================
// AKASH PRICING CONSTANTS
// ============================================================================

// Base pricing in uAKT per block (~6 seconds)
// These are approximate values based on Akash network rates
const PRICING_PER_BLOCK = {
  cpu: 10,        // uAKT per CPU core per block
  memory: 5,      // uAKT per MB RAM per block
  storage: 1,     // uAKT per MB storage per block
  gpuNvidia: 500, // uAKT per GPU per block (varies by model)
};

// Blocks per hour (10 blocks/min * 60 min)
const BLOCKS_PER_HOUR = 600;

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
  const totalBlocks = input.hours * BLOCKS_PER_HOUR;

  // Calculate individual costs in uAKT
  const cpuCostUakt = BigInt(Math.ceil(input.cpu * PRICING_PER_BLOCK.cpu * totalBlocks));
  const memoryCostUakt = BigInt(Math.ceil(input.memoryMb * PRICING_PER_BLOCK.memory * totalBlocks));
  const storageCostUakt = BigInt(Math.ceil(input.storageMb * PRICING_PER_BLOCK.storage * totalBlocks));

  let gpuCostUakt = BigInt(0);
  if (input.gpu && input.gpu.count > 0) {
    gpuCostUakt = BigInt(Math.ceil(input.gpu.count * PRICING_PER_BLOCK.gpuNvidia * totalBlocks));
  }

  // Total Akash cost in uAKT
  const akashCostUakt = cpuCostUakt + memoryCostUakt + storageCostUakt + gpuCostUakt;

  // Convert to AKT (1 AKT = 1,000,000 uAKT)
  const akashCostAkt = Number(akashCostUakt) / 1_000_000;

  // Convert to USD
  const akashCostUsd = akashCostAkt * aktUsdRate;

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
