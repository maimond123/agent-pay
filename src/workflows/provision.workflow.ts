/**
 * Provision Workflow - CRE Verifiable Infrastructure Provisioning
 *
 * This workflow enables agents to autonomously provision
 * infrastructure with verifiable execution and payment.
 */

// Service provider configurations
const SERVICE_PROVIDERS = {
  vps: {
    // Providers that accept x402 or have APIs
    bitlaunch: {
      apiUrl: 'https://api.bitlaunch.io/v1',
      paymentMethod: 'crypto',
    },
    hetzner: {
      apiUrl: 'https://api.hetzner.cloud/v1',
      paymentMethod: 'api_key', // Requires pre-funded account
    },
  },
  compute: {
    akash: {
      apiUrl: 'https://api.akash.network',
      paymentMethod: 'crypto',
    },
  },
  storage: {
    filecoin: {
      apiUrl: 'https://api.web3.storage',
      paymentMethod: 'crypto',
    },
  },
};

interface ProvisionParams {
  agentId: string;
  serviceType: 'vps' | 'compute' | 'storage' | 'api';
  provider?: string;
  specs: {
    ram?: string;
    cpu?: number;
    storage?: string;
    region?: string;
    os?: string;
    duration?: number;
  };
  maxBudget: string; // USDC amount as string
}

interface ProvisionResult {
  serviceId: string;
  credentials: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    sshKey?: string;
    apiKey?: string;
  };
  expiresAt: number;
  cost: string;
}

/**
 * Main provisioning workflow
 */
export const provisionWorkflow = {
  name: 'agent-provision',
  version: '1.0.0',

  trigger: {
    type: 'http',
    path: '/provision',
    method: 'POST',
  },

  steps: [
    // Step 1: Validate request and select provider
    {
      id: 'validate_and_select',
      type: 'compute',
      fn: async (input: ProvisionParams) => {
        const { serviceType, specs, maxBudget } = input;

        // Select best provider based on specs and budget
        const providers = SERVICE_PROVIDERS[serviceType as keyof typeof SERVICE_PROVIDERS];
        if (!providers) {
          throw new Error(`Unsupported service type: ${serviceType}`);
        }

        // Default provider selection logic
        const selectedProvider = input.provider || Object.keys(providers)[0];
        const providerConfig = providers[selectedProvider as keyof typeof providers];

        if (!providerConfig) {
          throw new Error(`Unknown provider: ${selectedProvider}`);
        }

        return {
          ...input,
          provider: selectedProvider,
          providerConfig,
        };
      },
    },

    // Step 2: Get pricing quote
    {
      id: 'get_quote',
      type: 'http_request',
      config: {
        url: '{{validate_and_select.providerConfig.apiUrl}}/quote',
        method: 'POST',
        body: {
          specs: '{{validate_and_select.specs}}',
        },
      },
    },

    // Step 3: Verify budget covers cost
    {
      id: 'verify_budget',
      type: 'compute',
      fn: async (input: { get_quote: { price: string }; validate_and_select: { maxBudget: string } }) => {
        const price = BigInt(input.get_quote.price);
        const budget = BigInt(input.validate_and_select.maxBudget);

        if (price > budget) {
          throw new Error(`Cost ${price} exceeds budget ${budget}`);
        }

        return { approved: true, finalCost: price.toString() };
      },
    },

    // Step 4: Execute payment (using payment workflow)
    {
      id: 'execute_payment',
      type: 'workflow_call',
      config: {
        workflow: 'agent-payment',
        params: {
          recipient: '{{validate_and_select.providerConfig.paymentAddress}}',
          amount: '{{verify_budget.finalCost}}',
          token: 'USDC',
          memo: 'provision:{{validate_and_select.serviceType}}:{{validate_and_select.provider}}',
        },
      },
    },

    // Step 5: Provision the service
    {
      id: 'provision_service',
      type: 'http_request',
      config: {
        url: '{{validate_and_select.providerConfig.apiUrl}}/provision',
        method: 'POST',
        headers: {
          'X-Payment-Proof': '{{execute_payment.attestation.txHash}}',
        },
        body: {
          specs: '{{validate_and_select.specs}}',
          paymentTx: '{{execute_payment.data.txHash}}',
        },
      },
    },

    // Step 6: Record provisioning attestation
    {
      id: 'record_attestation',
      type: 'evm_write',
      config: {
        contract: '{{env.ATTESTATION_REGISTRY}}',
        method: 'recordAttestation',
        args: [
          '{{validate_and_select.agentId}}',
          'provision',
          JSON.stringify({
            serviceType: '{{validate_and_select.serviceType}}',
            provider: '{{validate_and_select.provider}}',
            serviceId: '{{provision_service.serviceId}}',
            cost: '{{verify_budget.finalCost}}',
          }),
          '{{block.timestamp}}',
        ],
      },
    },
  ],

  output: {
    success: true,
    data: {
      serviceId: '{{provision_service.serviceId}}',
      credentials: '{{provision_service.credentials}}',
      expiresAt: '{{provision_service.expiresAt}}',
      cost: '{{verify_budget.finalCost}}',
    },
    attestation: {
      txHash: '{{record_attestation.txHash}}',
      attestationId: '{{record_attestation.returnData.attestationId}}',
      blockNumber: '{{record_attestation.blockNumber}}',
      timestamp: '{{block.timestamp}}',
      proof: {
        type: 'cre_consensus',
        data: '{{consensus.proof}}',
      },
    },
  },
};

/**
 * VPS-specific provisioning with SSH setup
 */
export const vpsProvisionWorkflow = {
  name: 'agent-provision-vps',
  version: '1.0.0',

  trigger: {
    type: 'http',
    path: '/provision/vps',
    method: 'POST',
  },

  steps: [
    // Use base provision workflow
    {
      id: 'base_provision',
      type: 'workflow_call',
      config: {
        workflow: 'agent-provision',
        params: {
          serviceType: 'vps',
          specs: '{{trigger.specs}}',
          maxBudget: '{{trigger.maxBudget}}',
          agentId: '{{trigger.agentId}}',
        },
      },
    },

    // Setup script execution via SSH
    {
      id: 'setup_vps',
      type: 'http_request',
      config: {
        // Call a setup service or execute directly
        url: '{{env.SETUP_SERVICE_URL}}/setup',
        method: 'POST',
        body: {
          host: '{{base_provision.data.credentials.host}}',
          credentials: '{{base_provision.data.credentials}}',
          setupScript: `
            #!/bin/bash
            set -e

            # Update system
            apt-get update && apt-get upgrade -y

            # Install Node.js
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs

            # Install Claude Code
            npm install -g @anthropic-ai/claude-code

            # Setup tmux for persistent sessions
            apt-get install -y tmux

            # Create welcome script
            cat > /root/start-claude.sh << 'EOF'
            #!/bin/bash
            tmux new-session -d -s claude 'claude'
            echo "Claude Code started in tmux session 'claude'"
            echo "Attach with: tmux attach -t claude"
            EOF
            chmod +x /root/start-claude.sh

            echo "Setup complete!"
          `,
        },
      },
    },
  ],

  output: {
    success: true,
    data: {
      ...('{{base_provision.data}}' as unknown as object),
      setupComplete: true,
      connectionCommand: 'ssh root@{{base_provision.data.credentials.host}}',
      claudeStartCommand: '/root/start-claude.sh',
    },
    attestation: '{{base_provision.attestation}}',
  },
};

export default provisionWorkflow;
