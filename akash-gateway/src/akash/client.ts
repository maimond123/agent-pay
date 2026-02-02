import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { generateSdl, validateSdlConfig } from './sdl.js';
import { createChildLogger } from '../server/logger.js';
import type { AkashDeploymentConfig } from '../types/index.js';

const logger = createChildLogger('akash-client');

// ============================================================================
// DYNAMIC IMPORTS FOR AKASH SDK
// ============================================================================

let akashSdk: {
  SDL: any;
  getAkashTypeRegistry: any;
  certificateManager: any;
  broadcastCertificate: any;
  getRpc: any;
  MsgCreateDeployment: any;
  MsgCreateLease: any;
  MsgCloseDeployment: any;
  QueryBidsRequest: any;
  QueryProviderRequest: any;
  Source: any;
} | null = null;

async function loadAkashSdk() {
  if (akashSdk) return akashSdk;

  try {
    const [
      sdlModule,
      stargateModule,
      certModule,
      certManagerModule,
      rpcModule,
      deploymentTypes,
      leaseTypes,
      providerTypes,
      commonTypes,
    ] = await Promise.all([
      import('@akashnetwork/akashjs/build/sdl/index.js'),
      import('@akashnetwork/akashjs/build/stargate/index.js'),
      import('@akashnetwork/akashjs/build/certificates/index.js'),
      import('@akashnetwork/akashjs/build/certificates/certificate-manager/index.js'),
      import('@akashnetwork/akashjs/build/rpc/index.js'),
      import('@akashnetwork/chain-sdk/private-types/akash.v1beta4').catch(() => null),
      import('@akashnetwork/chain-sdk/private-types/akash.v1beta5').catch(() => null),
      import('@akashnetwork/chain-sdk/private-types/akash.v1beta4').catch(() => null),
      import('@akashnetwork/chain-sdk/private-types/akash.v1').catch(() => null),
    ]);

    akashSdk = {
      SDL: sdlModule.SDL,
      getAkashTypeRegistry: stargateModule.getAkashTypeRegistry,
      certificateManager: certManagerModule.certificateManager,
      broadcastCertificate: certModule.broadcastCertificate,
      getRpc: rpcModule.getRpc,
      MsgCreateDeployment: deploymentTypes?.MsgCreateDeployment,
      MsgCreateLease: leaseTypes?.MsgCreateLease,
      MsgCloseDeployment: deploymentTypes?.MsgCloseDeployment,
      QueryBidsRequest: leaseTypes?.QueryBidsRequest,
      QueryProviderRequest: providerTypes?.QueryProviderRequest,
      Source: commonTypes?.Source,
    };

    logger.info('Akash SDK loaded successfully');
    return akashSdk;
  } catch (error) {
    logger.error({ error }, 'Failed to load Akash SDK - running in mock mode');
    return null;
  }
}

// ============================================================================
// CERTIFICATE TYPES
// ============================================================================

interface CertificatePem {
  cert: string;
  privateKey: string;
  publicKey: string;
}

// ============================================================================
// AKASH CLIENT
// ============================================================================

export class AkashClient {
  private wallet: DirectSecp256k1HdWallet | null = null;
  private client: SigningStargateClient | null = null;
  private address: string = '';
  private certificate: CertificatePem | null = null;
  private sdkLoaded: boolean = false;

  private readonly rpcEndpoint: string;
  private readonly chainId: string;
  private readonly certPath: string;

  constructor() {
    this.rpcEndpoint = process.env.AKASH_RPC_ENDPOINT || 'https://rpc.akashnet.net:443';
    this.chainId = process.env.AKASH_CHAIN_ID || 'akashnet-2';

    // Certificate storage path
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.certPath = process.env.AKASH_CERT_PATH || path.join(__dirname, '../../data/cert.json');
  }

  /**
   * Initialize wallet, client, and certificate
   */
  async initialize(): Promise<void> {
    const mnemonic = process.env.AKASH_MNEMONIC;

    if (!mnemonic) {
      logger.warn('AKASH_MNEMONIC not set - running in mock mode');
      return;
    }

    try {
      // Load Akash SDK
      const sdk = await loadAkashSdk();
      if (!sdk) {
        logger.warn('Akash SDK not available - running in mock mode');
        return;
      }
      this.sdkLoaded = true;

      // Create wallet from mnemonic
      this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
        prefix: 'akash',
      });

      const [account] = await this.wallet.getAccounts();
      this.address = account.address;

      // Get Akash type registry
      const registry = sdk.getAkashTypeRegistry();

      // Connect to RPC with Akash registry
      this.client = await SigningStargateClient.connectWithSigner(
        this.rpcEndpoint,
        this.wallet,
        {
          registry: new Registry(registry),
        }
      );

      // Load or create certificate
      await this.loadOrCreateCertificate();

      const balance = await this.getBalance();
      logger.info({
        address: this.address,
        rpc: this.rpcEndpoint,
        balance: `${balance.akt} AKT`,
        hasCertificate: !!this.certificate,
      }, 'Akash client initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Akash client');
      throw error;
    }
  }

  /**
   * Load certificate from file or create new one
   */
  private async loadOrCreateCertificate(): Promise<void> {
    const sdk = await loadAkashSdk();
    if (!sdk || !this.client) return;

    // Try to load existing certificate
    if (fs.existsSync(this.certPath)) {
      try {
        const json = fs.readFileSync(this.certPath, 'utf8');
        this.certificate = JSON.parse(json);
        logger.info('Loaded existing certificate');
        return;
      } catch (e) {
        logger.warn({ error: e }, 'Failed to load certificate, creating new one');
      }
    }

    // Create new certificate
    try {
      this.certificate = sdk.certificateManager.generatePEM(this.address);

      // Broadcast certificate to chain
      const result = await sdk.broadcastCertificate(
        this.certificate,
        this.address,
        this.client
      );

      if (result.code === 0) {
        // Save certificate
        const dir = path.dirname(this.certPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.certPath, JSON.stringify(this.certificate));
        logger.info({ txHash: result.transactionHash }, 'Certificate created and saved');
      } else {
        throw new Error(`Certificate broadcast failed: ${result.rawLog}`);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to create certificate');
      this.certificate = null;
    }
  }

  /**
   * Check if client is fully connected
   */
  isConnected(): boolean {
    return this.client !== null && this.wallet !== null && this.sdkLoaded;
  }

  /**
   * Check if client has valid certificate for provider communication
   */
  hasCertificate(): boolean {
    return this.certificate !== null;
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Create a deployment on Akash Network
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

    // Generate SDL YAML
    const sdlYaml = generateSdl(config);
    logger.debug({ sdl: sdlYaml.substring(0, 200) }, 'Generated SDL');

    if (!this.isConnected() || !this.client || !this.wallet) {
      // Mock mode
      logger.info('Running in mock mode - simulating deployment');
      const mockDseq = Date.now().toString();
      return {
        dseq: mockDseq,
        txHash: `0x${Buffer.from(mockDseq).toString('hex').padStart(64, '0')}`,
      };
    }

    const sdk = await loadAkashSdk();
    if (!sdk || !sdk.MsgCreateDeployment) {
      throw new Error('Akash SDK deployment types not available');
    }

    try {
      // Parse SDL
      const sdl = sdk.SDL.fromString(sdlYaml, 'beta3');
      const groups = sdl.groups();
      const manifestVersion = await sdl.manifestVersion();

      // Get current block height for dseq
      const blockHeight = await this.client.getHeight();

      // Create deployment message
      const deployment = {
        id: {
          owner: this.address,
          dseq: String(blockHeight),
        },
        groups: groups,
        deposit: {
          sources: [sdk.Source?.balance || 0],
          amount: {
            denom: 'uakt',
            amount: process.env.AKASH_DEPOSIT_AMOUNT || '5000000', // 5 AKT default
          },
        },
        hash: manifestVersion,
      };

      const msg = {
        typeUrl: `/${sdk.MsgCreateDeployment.$type}`,
        value: sdk.MsgCreateDeployment.fromPartial(deployment),
      };

      const fee = {
        amount: [{ denom: 'uakt', amount: '25000' }],
        gas: '1000000',
      };

      // Broadcast transaction
      const tx = await this.client.signAndBroadcast(
        this.address,
        [msg],
        fee,
        'x402-akash-gateway deployment'
      );

      if (tx.code !== 0) {
        throw new Error(`Deployment failed: ${tx.rawLog}`);
      }

      logger.info({
        dseq: deployment.id.dseq,
        txHash: tx.transactionHash,
      }, 'Deployment created on Akash');

      return {
        dseq: deployment.id.dseq,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to create deployment');
      throw error;
    }
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
          provider: 'akash1mock1xxxxxxxxxxxxxxxxxxxxxxxxx',
          price: '100uakt',
          attributes: { region: 'us-east', capability: 'gpu' },
        },
        {
          provider: 'akash1mock2xxxxxxxxxxxxxxxxxxxxxxxxx',
          price: '85uakt',
          attributes: { region: 'eu-west', capability: 'cpu' },
        },
      ];
    }

    const sdk = await loadAkashSdk();
    if (!sdk) throw new Error('SDK not loaded');

    try {
      // Use REST API (v1beta5) instead of broken protobuf SDK
      const apiEndpoint = 'https://api.akashnet.net';

      // Poll for bids with timeout
      const startTime = Date.now();
      const timeout = 5 * 60 * 1000; // 5 minutes

      while (Date.now() - startTime < timeout) {
        try {
          // Query bids from chain via REST API
          logger.info({ dseq, elapsed: Date.now() - startTime }, 'Querying for bids via REST API');

          const url = `${apiEndpoint}/akash/market/v1beta5/bids/list?filters.owner=${this.address}&filters.dseq=${dseq}`;
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`REST API error: ${res.status} ${res.statusText}`);
          }
          const response: any = await res.json();

          logger.info({ dseq, bidCount: response.bids?.length || 0 }, 'Bid query response');

          if (response.bids && response.bids.length > 0) {
            return response.bids.map((bidResponse: any) => ({
              provider: bidResponse.bid.id.provider,
              price: bidResponse.bid.price.amount,
              attributes: { state: bidResponse.bid.state },
            }));
          }
        } catch (e: any) {
          logger.warn({
            error: e?.message || String(e),
            stack: e?.stack,
            dseq
          }, 'Bid query attempt failed, retrying...');
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      throw new Error('No bids received within timeout');
    } catch (error) {
      logger.error({ error, dseq }, 'Failed to fetch bids');
      throw error;
    }
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
    if (!this.isConnected() || !this.client) {
      return {
        leaseId: `${dseq}/${gseq}/${oseq}/${provider}`,
        txHash: `0x${Date.now().toString(16).padStart(64, '0')}`,
      };
    }

    const sdk = await loadAkashSdk();
    if (!sdk || !sdk.MsgCreateLease) {
      throw new Error('Akash SDK lease types not available');
    }

    try {
      const msg = {
        typeUrl: `/${sdk.MsgCreateLease.$type}`,
        value: sdk.MsgCreateLease.fromPartial({
          bidId: {
            owner: this.address,
            dseq: dseq,
            gseq: gseq,
            oseq: oseq,
            provider: provider,
          },
        }),
      };

      const fee = {
        amount: [{ denom: 'uakt', amount: '20000' }],
        gas: '800000',
      };

      const tx = await this.client.signAndBroadcast(
        this.address,
        [msg],
        fee,
        'x402-akash-gateway lease'
      );

      if (tx.code !== 0) {
        throw new Error(`Lease creation failed: ${tx.rawLog}`);
      }

      const leaseId = `${this.address}/${dseq}/${gseq}/${oseq}/${provider}`;
      logger.info({ leaseId, txHash: tx.transactionHash }, 'Lease created');

      return {
        leaseId,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to create lease');
      throw error;
    }
  }

  /**
   * Get provider URI from chain
   */
  async getProviderUri(provider: string): Promise<string | null> {
    try {
      const apiEndpoint = 'https://api.akashnet.net';
      const providerUrl = `${apiEndpoint}/akash/provider/v1beta4/providers/${provider}`;
      const providerRes = await fetch(providerUrl);

      if (!providerRes.ok) {
        logger.warn({ provider, status: providerRes.status }, 'Failed to get provider info');
        return null;
      }

      const providerData: any = await providerRes.json();
      return providerData.provider?.host_uri || null;
    } catch (error: any) {
      logger.warn({ provider, error: error?.message }, 'Error fetching provider URI');
      return null;
    }
  }

  /**
   * Send manifest to provider via mTLS
   */
  async sendManifest(
    dseq: string,
    provider: string,
    config: AkashDeploymentConfig
  ): Promise<void> {
    const sdlYaml = generateSdl(config);

    if (!this.isConnected() || !this.certificate) {
      logger.info({ dseq, provider }, 'Mock: Manifest sent to provider');
      return;
    }

    const sdk = await loadAkashSdk();
    if (!sdk) throw new Error('SDK not loaded');

    try {
      // Get provider info via REST API (v1beta4)
      const apiEndpoint = 'https://api.akashnet.net';
      const providerUrl = `${apiEndpoint}/akash/provider/v1beta4/providers/${provider}`;
      const providerRes = await fetch(providerUrl);
      if (!providerRes.ok) {
        throw new Error(`Failed to get provider info: ${providerRes.status}`);
      }
      const providerData: any = await providerRes.json();

      if (!providerData.provider) {
        throw new Error(`Provider ${provider} not found`);
      }

      const providerUri = providerData.provider.host_uri;
      const sdl = sdk.SDL.fromString(sdlYaml, 'beta3');
      const manifest = sdl.manifestSortedJSON();

      // Send manifest via mTLS
      const uri = new URL(providerUri);
      const agent = new https.Agent({
        cert: this.certificate.cert,
        key: this.certificate.privateKey,
        rejectUnauthorized: false, // Provider uses self-signed cert
        servername: '', // Disable SNI for mTLS
      });

      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: uri.hostname,
            port: uri.port || 8443,
            path: `/deployment/${dseq}/manifest`,
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': manifest.length,
            },
            agent,
          },
          (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`Manifest send failed: ${res.statusCode}`));
              return;
            }
            resolve();
          }
        );

        req.on('error', reject);
        req.write(manifest);
        req.end();
      });

      logger.info({ dseq, provider }, 'Manifest sent to provider');
    } catch (error: any) {
      logger.error({
        error: error?.message || String(error),
        stack: error?.stack
      }, 'Failed to send manifest');
      throw error;
    }
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
    if (!this.isConnected() || !this.certificate) {
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

    const sdk = await loadAkashSdk();
    if (!sdk) throw new Error('SDK not loaded');

    try {
      // Get provider URI via REST API (v1beta4)
      const apiEndpoint = 'https://api.akashnet.net';
      const providerUrl = `${apiEndpoint}/akash/provider/v1beta4/providers/${provider}`;
      const providerRes = await fetch(providerUrl);
      if (!providerRes.ok) {
        throw new Error(`Failed to get provider info: ${providerRes.status}`);
      }
      const providerData: any = await providerRes.json();

      if (!providerData.provider) {
        throw new Error(`Provider ${provider} not found`);
      }

      const providerUri = providerData.provider.host_uri;
      const uri = new URL(providerUri);

      // Query lease status via mTLS
      const agent = new https.Agent({
        cert: this.certificate.cert,
        key: this.certificate.privateKey,
        rejectUnauthorized: false,
        servername: '',
      });

      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: uri.hostname,
            port: uri.port || 8443,
            path: `/lease/${dseq}/${gseq}/${oseq}/status`,
            method: 'GET',
            headers: {
              Accept: 'application/json',
            },
            agent,
          },
          (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`Status query failed: ${res.statusCode}`));
              return;
            }

            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                const status = JSON.parse(data);
                logger.info({ rawStatus: JSON.stringify(status).substring(0, 1000) }, 'Raw lease status from provider');

                // Get top-level forwarded_ports (keyed by service name)
                const topLevelForwardedPorts = status.forwarded_ports || {};
                const topLevelIps = status.ips || {};

                // Parse services - Akash providers may use different field names
                const services = Object.entries(status.services || {}).map(([name, svc]: [string, any]) => {
                  // Try different sources for IPs/ports:
                  // 1. Top-level forwarded_ports[serviceName]
                  // 2. Service-level ips/forwarded_ports
                  // 3. Top-level ips[serviceName]
                  const forwardedPorts = topLevelForwardedPorts[name] || svc.forwarded_ports || svc.ips || topLevelIps[name] || [];
                  const uris = svc.uris || svc.hostnames || [];

                  logger.info({
                    serviceName: name,
                    forwardedPortsCount: forwardedPorts.length,
                    urisCount: uris.length,
                    svcKeys: Object.keys(svc),
                    hasTopLevelPorts: !!topLevelForwardedPorts[name],
                  }, 'Parsing service');

                  return {
                    name,
                    available: svc.available || svc.ready_replicas || 0,
                    total: svc.total || svc.replicas || 0,
                    uris,
                    ips: forwardedPorts.map((ip: any) => ({
                      port: ip.port,
                      externalPort: ip.externalPort || ip.external_port,
                      protocol: ip.protocol || ip.proto || 'TCP',
                      ip: ip.ip || ip.host,
                    })),
                  };
                });

                resolve({
                  state: 'active',
                  services,
                });
              } catch (e) {
                reject(e);
              }
            });
          }
        );

        req.on('error', reject);
        req.end();
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get lease status');
      throw error;
    }
  }

  /**
   * Close a deployment
   */
  async closeDeployment(dseq: string): Promise<{ txHash: string }> {
    if (!this.isConnected() || !this.client) {
      return {
        txHash: `0x${Date.now().toString(16).padStart(64, '0')}`,
      };
    }

    const sdk = await loadAkashSdk();
    if (!sdk || !sdk.MsgCloseDeployment) {
      throw new Error('Akash SDK close deployment types not available');
    }

    try {
      const msg = {
        typeUrl: `/${sdk.MsgCloseDeployment.$type}`,
        value: sdk.MsgCloseDeployment.fromPartial({
          id: {
            owner: this.address,
            dseq: dseq,
          },
        }),
      };

      const fee = {
        amount: [{ denom: 'uakt', amount: '20000' }],
        gas: '800000',
      };

      const tx = await this.client.signAndBroadcast(
        this.address,
        [msg],
        fee,
        'x402-akash-gateway close deployment'
      );

      if (tx.code !== 0) {
        throw new Error(`Close deployment failed: ${tx.rawLog}`);
      }

      logger.info({ dseq, txHash: tx.transactionHash }, 'Deployment closed');
      return { txHash: tx.transactionHash };
    } catch (error) {
      logger.error({ error }, 'Failed to close deployment');
      throw error;
    }
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
