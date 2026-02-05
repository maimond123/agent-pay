/**
 * SDL Generator
 *
 * Generates Akash SDL (Stack Definition Language) manifests from compute specs.
 * SDL defines the deployment requirements sent to providers.
 */

import type { ComputeSpecs, PortConfig } from "../types.js";

export interface SDLSpec {
  version: string;
  services: Record<string, SDLService>;
  profiles: {
    compute: Record<string, SDLComputeProfile>;
    placement: Record<string, SDLPlacement>;
  };
  deployment: Record<string, SDLDeployment>;
}

interface SDLService {
  image: string;
  expose: SDLExpose[];
  env?: string[];
  command?: string[];
  args?: string[];
}

interface SDLExpose {
  port: number;
  as?: number;
  to?: { global: boolean }[];
  proto?: string;
}

interface SDLComputeProfile {
  resources: {
    cpu: { units: string };
    memory: { size: string };
    storage: { size: string }[];
    gpu?: { units: string; attributes: { vendor: { nvidia: { model: string }[] } } };
  };
}

interface SDLPlacement {
  attributes: Record<string, string>;
  signedBy: { anyOf: string[] };
  pricing: Record<string, { denom: string; amount: number }>;
}

interface SDLDeployment {
  [profile: string]: { profile: string; count: number };
}

// USDC IBC denom on Akash
const USDC_DENOM = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";

/**
 * Parse memory/storage string to bytes
 */
function parseSize(size: string): number {
  const units: Record<string, number> = {
    "B": 1,
    "KB": 1024,
    "MB": 1024 * 1024,
    "GB": 1024 * 1024 * 1024,
    "TB": 1024 * 1024 * 1024 * 1024,
    "Ki": 1024,
    "Mi": 1024 * 1024,
    "Gi": 1024 * 1024 * 1024,
    "Ti": 1024 * 1024 * 1024 * 1024,
  };

  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|Ki|Mi|Gi|Ti)?$/i);
  if (!match) {
    throw new Error(`Invalid size format: ${size}`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2]?.toUpperCase() || "B";
  const multiplier = units[unit] || units[unit.replace(/B$/i, "")] || 1;

  return Math.floor(value * multiplier);
}

/**
 * Format bytes to Akash-compatible size string
 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${Math.ceil(bytes / (1024 * 1024 * 1024))}Gi`;
  } else if (bytes >= 1024 * 1024) {
    return `${Math.ceil(bytes / (1024 * 1024))}Mi`;
  }
  return `${bytes}`;
}

/**
 * Generate SDL from compute specs
 */
export function generateSDL(
  specs: ComputeSpecs,
  env?: Record<string, string>,
  command?: string[],
  serviceName: string = "main"
): SDLSpec {
  // Convert env to array format
  const envArray = env
    ? Object.entries(env).map(([key, value]) => `${key}=${value}`)
    : undefined;

  // Build expose rules from ports
  const expose: SDLExpose[] = [];

  // Always expose SSH if it's an interactive container
  const sshPort = specs.ports?.find(p => p.port === 22);
  if (sshPort) {
    expose.push({
      port: 22,
      as: 22,
      to: [{ global: true }],
      proto: "tcp",
    });
  }

  // Add other ports
  if (specs.ports) {
    for (const port of specs.ports) {
      if (port.port === 22) continue; // Already handled
      if (port.expose) {
        expose.push({
          port: port.port,
          as: port.port,
          to: [{ global: true }],
          proto: port.protocol || "tcp",
        });
      }
    }
  }

  // If no ports specified, expose port 80 by default for web services
  if (expose.length === 0) {
    expose.push({
      port: 80,
      as: 80,
      to: [{ global: true }],
    });
  }

  // Build compute resources
  const memoryBytes = parseSize(specs.memory);
  const storageBytes = parseSize(specs.storage);

  const resources: SDLComputeProfile["resources"] = {
    cpu: { units: `${specs.cpu * 1000}m` }, // Convert to millicpu
    memory: { size: formatSize(memoryBytes) },
    storage: [{ size: formatSize(storageBytes) }],
  };

  // Add GPU if specified
  if (specs.gpu && specs.gpu.count > 0) {
    resources.gpu = {
      units: `${specs.gpu.count}`,
      attributes: {
        vendor: {
          nvidia: specs.gpu.model
            ? [{ model: specs.gpu.model }]
            : [{ model: "*" }],
        },
      },
    };
  }

  // Calculate hourly price in USDC (micro units)
  // Base price estimation: ~$0.05/CPU/hour + memory/storage costs
  const cpuCost = specs.cpu * 50000; // $0.05 per CPU
  const memoryCostPerGi = 10000; // $0.01 per Gi
  const storageCostPerGi = 5000; // $0.005 per Gi
  const gpuCost = specs.gpu ? specs.gpu.count * 500000 : 0; // $0.50 per GPU

  const memoryGi = memoryBytes / (1024 * 1024 * 1024);
  const storageGi = storageBytes / (1024 * 1024 * 1024);

  const hourlyPriceMicro = Math.ceil(
    cpuCost +
    memoryCostPerGi * memoryGi +
    storageCostPerGi * storageGi +
    gpuCost
  );

  // Build SDL
  const sdl: SDLSpec = {
    version: "2.0",
    services: {
      [serviceName]: {
        image: specs.image,
        expose,
        ...(envArray && { env: envArray }),
        ...(command && { command }),
      },
    },
    profiles: {
      compute: {
        [serviceName]: { resources },
      },
      placement: {
        dcloud: {
          attributes: {},
          signedBy: { anyOf: ["akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63"] },
          pricing: {
            [serviceName]: {
              denom: USDC_DENOM,
              amount: hourlyPriceMicro,
            },
          },
        },
      },
    },
    deployment: {
      [serviceName]: {
        dcloud: { profile: serviceName, count: 1 },
      },
    },
  };

  return sdl;
}

/**
 * Convert SDL to YAML string for display/debugging
 */
export function sdlToYaml(sdl: SDLSpec): string {
  // Simple YAML serialization for logging
  return JSON.stringify(sdl, null, 2);
}

/**
 * Calculate deposit amount for a deployment
 * Deposit = hourly_price * hours * 1.1 (10% buffer)
 */
export function calculateDeposit(
  specs: ComputeSpecs,
  hours: number
): { amount: string; denom: string } {
  const memoryBytes = parseSize(specs.memory);
  const storageBytes = parseSize(specs.storage);

  const cpuCost = specs.cpu * 50000;
  const memoryCostPerGi = 10000;
  const storageCostPerGi = 5000;
  const gpuCost = specs.gpu ? specs.gpu.count * 500000 : 0;

  const memoryGi = memoryBytes / (1024 * 1024 * 1024);
  const storageGi = storageBytes / (1024 * 1024 * 1024);

  const hourlyPriceMicro = Math.ceil(
    cpuCost +
    memoryCostPerGi * memoryGi +
    storageCostPerGi * storageGi +
    gpuCost
  );

  // Akash requires deposits in uakt (native AKT), not USDC.
  // Minimum deposit is 0.5 AKT (500000 uakt) — this is escrowed and refunded on close.
  return {
    amount: "500000",
    denom: "uakt",
  };
}

/**
 * Build groups for deployment transaction
 */
export function buildDeploymentGroups(sdl: SDLSpec): any[] {
  const groups: any[] = [];

  for (const [serviceName, deployment] of Object.entries(sdl.deployment)) {
    for (const [placementName, config] of Object.entries(deployment)) {
      if (typeof config !== "object") continue;

      const profile = sdl.profiles.compute[config.profile];
      const placement = sdl.profiles.placement[placementName];
      const service = sdl.services[serviceName];

      if (!profile || !placement || !service) continue;

      groups.push({
        name: placementName,
        requirements: {
          signedBy: placement.signedBy,
          attributes: Object.entries(placement.attributes).map(([key, value]) => ({
            key,
            value,
          })),
        },
        resources: [
          {
            resources: profile.resources,
            count: config.count,
            price: placement.pricing[serviceName],
          },
        ],
      });
    }
  }

  return groups;
}
