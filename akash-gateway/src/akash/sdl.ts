import type { AkashDeploymentConfig } from '../types/index.js';

// ============================================================================
// SDL (Stack Definition Language) TEMPLATE GENERATOR
// ============================================================================

/**
 * Generate Akash SDL (YAML) configuration for deployment
 * SDL is the deployment manifest format used by Akash Network
 */
export function generateSdl(config: AkashDeploymentConfig): string {
  const {
    cpu,
    memoryMb,
    storageMb,
    image,
    env = {},
    command = [],
    ports = [{ port: 80, protocol: 'tcp', expose: true }],
    gpu,
  } = config;

  // Build environment section
  const envLines = Object.entries(env)
    .map(([key, value]) => `        - ${key}=${value}`)
    .join('\n');

  // Build command section
  const commandSection = command.length > 0
    ? `      command:\n${command.map(c => `        - "${c}"`).join('\n')}`
    : '';

  // Build expose section
  const exposeLines = ports
    .filter(p => p.expose)
    .map(p => `        - port: ${p.port}
          as: ${p.port}
          to:
            - global: true`)
    .join('\n');

  // Build GPU section if needed
  const gpuSection = gpu && gpu.count > 0
    ? `
        gpu:
          units: ${gpu.count}
          attributes:
            vendor:
              nvidia:`
    : '';

  const sdl = `---
version: "2.0"

services:
  app:
    image: ${image}
${commandSection}
    env:
${envLines || '        []'}
    expose:
${exposeLines}

profiles:
  compute:
    app:
      resources:
        cpu:
          units: ${cpu}
        memory:
          size: ${memoryMb}Mi
        storage:
          size: ${storageMb}Mi${gpuSection}

  placement:
    dcloud:
      pricing:
        app:
          denom: uakt
          amount: 10000

deployment:
  app:
    dcloud:
      profile: app
      count: 1
`;

  return sdl;
}

/**
 * Parse SDL back to config (for validation)
 */
export function parseSdl(sdl: string): Partial<AkashDeploymentConfig> {
  // Basic parsing - in production use proper YAML parser
  const config: Partial<AkashDeploymentConfig> = {};

  // Extract image
  const imageMatch = sdl.match(/image:\s*(.+)/);
  if (imageMatch) {
    config.image = imageMatch[1].trim();
  }

  // Extract CPU
  const cpuMatch = sdl.match(/cpu:\s*\n\s*units:\s*(\d+)/);
  if (cpuMatch) {
    config.cpu = parseInt(cpuMatch[1]);
  }

  // Extract memory
  const memoryMatch = sdl.match(/memory:\s*\n\s*size:\s*(\d+)Mi/);
  if (memoryMatch) {
    config.memoryMb = parseInt(memoryMatch[1]);
  }

  // Extract storage
  const storageMatch = sdl.match(/storage:\s*\n\s*size:\s*(\d+)Mi/);
  if (storageMatch) {
    config.storageMb = parseInt(storageMatch[1]);
  }

  return config;
}

/**
 * Validate SDL configuration limits
 */
export function validateSdlConfig(config: AkashDeploymentConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.cpu < 1 || config.cpu > 256) {
    errors.push('CPU must be between 1 and 256 cores');
  }

  if (config.memoryMb < 512 || config.memoryMb > 512 * 1024) {
    errors.push('Memory must be between 512MB and 512GB');
  }

  if (config.storageMb < 512 || config.storageMb > 32 * 1024 * 1024) {
    errors.push('Storage must be between 512MB and 32TB');
  }

  if (!config.image || config.image.length === 0) {
    errors.push('Image is required');
  }

  if (config.gpu && config.gpu.count > 8) {
    errors.push('GPU count must be 8 or less');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
