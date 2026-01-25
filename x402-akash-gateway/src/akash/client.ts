import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import { generateSdl, validateSdlConfig } from './sdl.js';
import { createChildLogger } from '../server/logger.js';
import type { AkashDeploymentConfig } from '../types/index.js';

const logger = createChildLogger('akash-client');

// ============================================================================
// AKASH CLIENT
// ============================================================================

/**
 * Akash Network client for deployment operations
 *
 * Note: This is a simplified implementation. Production usage requires:
 * - Full Akash API protobuf integration (@akashnetwork/akash-api)
 * - Provider marketplace querying
 * - Bid selection and lease management
 * - Certificate management for mTLS
 */
export class AkashClient {
  private wallet: DirectSecp256k1HdWallet | null = null;
  private client: SigningStargateClient | null = null;
  private address: string = '';

  private readonly rpcEndpoint: string;
  private readonly chainId: string;

  constructor() {
    this.rpcEndpoint = process.env.AKASH_RPC_ENDPOINT || 'https://rpc.akashnet.net:443';
    this.chainId = process.env.AKASH_CHAIN_ID || 'akashnet-2';
  }

  /**
   * Initialize wallet and client connection
   */
  async initialize(): Promise<void> {
    const mnemonic = process.env.AKASH_MNEMONIC;

    if (!mnemonic) {
      logger.warn('AKASH_MNEMONIC not set - running in mock mode');
      return;
    }

    try {
      // Create wallet from mnemonic
      this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
        prefix: 'akash',
      });

      const [account] = await this.wallet.getAccounts();
      this.address = account.address;

      // Connect to RPC
      this.client = await SigningStargateClient.connectWithSigner(
        this.rpcEndpoint,
        this.wallet,
        {
          gasPrice: GasPrice.fromString('0.025uakt'),
        }
      );

      logger.info({ address: this.address, rpc: this.rpcEndpoint }, 'Akash client initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Akash client');
      throw error;
    }
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.client !== null && this.wallet !== null;
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Create a deployment on Akash Network
   *
   * Full flow:
   * 1. Create deployment transaction
   * 2. Wait for bids from providers
   * 3. Select best bid
   * 4. Create lease
   * 5. Send manifest to provider
   * 6. Get lease status with endpoints
   */
  async createDeployment(config: AkashDeploymentConfig): Promise<{
    dseq: string;
    txHash: string;
  }> {
    // Validate config
    const validation = validateSdlConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid deployment config: ${validation.errors.join(', ')}`);
    }

    // Generate SDL
    const sdl = generateSdl(config);
    logger.debug({ sdl }, 'Generated SDL');

    if (!this.isConnected()) {
      // Mock mode
      logger.info('Running in mock mode - simulating deployment');
      const mockDseq = Date.now().toString();
      return {
        dseq: mockDseq,
        txHash: `0x${Buffer.from(mockDseq).toString('hex').padStart(64, '0')}`,
      };
    }

    // In production, this would:
    // 1. Parse SDL to deployment message
    // 2. Broadcast MsgCreateDeployment transaction
    // 3. Return dseq from transaction result

    // For now, we'll implement a simplified version
    // Full implementation requires @akashnetwork/akash-api protobuf types

    throw new Error('Full Akash deployment not yet implemented - use mock mode');
  }

  /**
   * Get bids for a deployment
   */
  async getBids(dseq: string): Promise<Array<{
    provider: string;
    price: string;
    attributes: Record<string, string>;
  }>> {
    if (!this.isConnected()) {
      // Mock bids
      return [
        {
          provider: 'akash1provider1...',
          price: '100uakt',
          attributes: { region: 'us-east', capability: 'gpu' },
        },
        {
          provider: 'akash1provider2...',
          price: '85uakt',
          attributes: { region: 'eu-west', capability: 'cpu' },
        },
      ];
    }

    // Query bids from chain
    throw new Error('Bid querying not yet implemented');
  }

  /**
   * Accept a bid and create lease
   */
  async createLease(
    dseq: string,
    gseq: number,
    oseq: number,
    provider: string
  ): Promise<{
    leaseId: string;
    txHash: string;
  }> {
    if (!this.isConnected()) {
      return {
        leaseId: `${dseq}/${gseq}/${oseq}/${provider}`,
        txHash: `0x${Date.now().toString(16).padStart(64, '0')}`,
      };
    }

    throw new Error('Lease creation not yet implemented');
  }

  /**
   * Send manifest to provider
   */
  async sendManifest(
    dseq: string,
    provider: string,
    config: AkashDeploymentConfig
  ): Promise<void> {
    const sdl = generateSdl(config);

    if (!this.isConnected()) {
      logger.info({ dseq, provider }, 'Mock: Manifest sent to provider');
      return;
    }

    // In production, this sends the manifest via mTLS to the provider
    throw new Error('Manifest sending not yet implemented');
  }

  /**
   * Get lease status including endpoints
   */
  async getLeaseStatus(
    dseq: string,
    gseq: number,
    oseq: number,
    provider: string
  ): Promise<{
    state: 'active' | 'closed' | 'insufficient_funds';
    services: Array<{
      name: string;
      available: number;
      total: number;
      uris: string[];
      ips: Array<{
        port: number;
        externalPort: number;
        protocol: string;
        ip: string;
      }>;
    }>;
  }> {
    if (!this.isConnected()) {
      // Mock status
      return {
        state: 'active',
        services: [
          {
            name: 'app',
            available: 1,
            total: 1,
            uris: [`${dseq}.provider.akash.network`],
            ips: [
              {
                port: 80,
                externalPort: 80,
                protocol: 'TCP',
                ip: '203.0.113.42',
              },
            ],
          },
        ],
      };
    }

    throw new Error('Lease status querying not yet implemented');
  }

  /**
   * Close a deployment
   */
  async closeDeployment(dseq: string): Promise<{ txHash: string }> {
    if (!this.isConnected()) {
      return {
        txHash: `0x${Date.now().toString(16).padStart(64, '0')}`,
      };
    }

    throw new Error('Deployment closing not yet implemented');
  }

  /**
   * Get account balance
   */
  async getBalance(): Promise<{ akt: string; uakt: string }> {
    if (!this.isConnected() || !this.client) {
      return { akt: '0', uakt: '0' };
    }

    const balance = await this.client.getBalance(this.address, 'uakt');
    const uakt = balance.amount;
    const akt = (parseInt(uakt) / 1_000_000).toFixed(6);

    return { akt, uakt };
  }
}

// Singleton instance
let akashClient: AkashClient | null = null;

export function getAkashClient(): AkashClient {
  if (!akashClient) {
    akashClient = new AkashClient();
  }
  return akashClient;
}

export async function initializeAkashClient(): Promise<AkashClient> {
  const client = getAkashClient();
  await client.initialize();
  return client;
}
