/**
 * Payment Workflow - CRE Verifiable Payment Execution
 *
 * This workflow handles x402-compatible payments with:
 * - Multi-node consensus on payment parameters
 * - On-chain attestation of payment execution
 * - Support for USDC on Base
 */

// CRE SDK imports (will be available when CRE project is initialized)
// import { workflow, httpTrigger, httpClient, evmClient } from '@chainlink/cre-sdk';

// Types for payment workflow
interface PaymentParams {
  agentId: string;
  recipient: string;
  amount: string; // BigInt as string for serialization
  token: 'USDC' | 'ETH';
  memo?: string;
}

interface PaymentResult {
  txHash: string;
  attestationId: string;
  blockNumber: number;
  gasUsed: string;
}

// Contract addresses (Base Sepolia)
const CONTRACTS = {
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
  ATTESTATION_REGISTRY: '0x0000000000000000000000000000000000000000', // To be deployed
  X402_FACILITATOR: 'https://x402-facilitator.coinbase.com',
};

/**
 * CRE Workflow Definition
 *
 * When deployed to CRE, this workflow:
 * 1. Receives payment request via HTTP trigger
 * 2. Multiple Chainlink nodes validate parameters
 * 3. Execute payment with BFT consensus
 * 4. Record attestation on-chain
 * 5. Return verified result
 */
export const paymentWorkflow = {
  name: 'agent-payment',
  version: '1.0.0',

  // HTTP trigger - agents call this endpoint
  trigger: {
    type: 'http',
    path: '/payment',
    method: 'POST',
  },

  // Workflow steps executed with consensus
  steps: [
    {
      id: 'validate_params',
      type: 'compute',
      fn: async (input: PaymentParams) => {
        // Validate payment parameters
        if (!input.recipient || !input.amount || !input.token) {
          throw new Error('Missing required payment parameters');
        }
        if (BigInt(input.amount) <= 0) {
          throw new Error('Amount must be positive');
        }
        return { validated: true, ...input };
      },
    },
    {
      id: 'check_balance',
      type: 'evm_read',
      config: {
        contract: CONTRACTS.USDC,
        method: 'balanceOf',
        args: ['{{trigger.walletAddress}}'],
      },
    },
    {
      id: 'execute_payment',
      type: 'evm_write',
      config: {
        contract: CONTRACTS.USDC,
        method: 'transfer',
        args: ['{{validate_params.recipient}}', '{{validate_params.amount}}'],
      },
    },
    {
      id: 'record_attestation',
      type: 'evm_write',
      config: {
        contract: CONTRACTS.ATTESTATION_REGISTRY,
        method: 'recordAttestation',
        args: [
          '{{validate_params.agentId}}',
          'payment',
          '{{execute_payment.txHash}}',
          '{{block.timestamp}}',
        ],
      },
    },
  ],

  // Return value after all steps complete
  output: {
    success: true,
    data: {
      txHash: '{{execute_payment.txHash}}',
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
 * x402 Payment Handler
 *
 * For services that support x402 protocol, this handles
 * the HTTP 402 Payment Required flow automatically.
 */
export const x402PaymentHandler = {
  name: 'x402-payment',

  trigger: {
    type: 'http',
    path: '/x402',
    method: 'POST',
  },

  steps: [
    {
      id: 'initial_request',
      type: 'http_request',
      config: {
        url: '{{trigger.serviceUrl}}',
        method: 'GET',
      },
    },
    {
      id: 'check_402',
      type: 'compute',
      fn: async (input: { initial_request: { status: number; headers: Record<string, string> } }) => {
        if (input.initial_request.status !== 402) {
          return { requiresPayment: false };
        }
        // Parse x402 payment requirements from header
        const paymentRequired = input.initial_request.headers['x-payment-required'];
        return {
          requiresPayment: true,
          paymentDetails: JSON.parse(paymentRequired || '{}'),
        };
      },
    },
    {
      id: 'execute_x402_payment',
      type: 'http_request',
      condition: '{{check_402.requiresPayment}}',
      config: {
        url: CONTRACTS.X402_FACILITATOR,
        method: 'POST',
        body: {
          payment: '{{check_402.paymentDetails}}',
          signature: '{{wallet.sign(check_402.paymentDetails)}}',
        },
      },
    },
    {
      id: 'retry_with_payment',
      type: 'http_request',
      condition: '{{check_402.requiresPayment}}',
      config: {
        url: '{{trigger.serviceUrl}}',
        method: 'GET',
        headers: {
          'X-Payment-Signature': '{{execute_x402_payment.signature}}',
        },
      },
    },
  ],

  output: {
    success: true,
    data: '{{retry_with_payment.body || initial_request.body}}',
    paymentMade: '{{check_402.requiresPayment}}',
  },
};

export default paymentWorkflow;
