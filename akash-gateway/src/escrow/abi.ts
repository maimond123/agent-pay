// AgentPayEscrow contract ABI - matches contracts/AgentPayEscrow_Remix.sol
export const ESCROW_ABI = [
  // Events
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'specsHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Released',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'toGateway', type: 'uint256', indexed: false },
      { name: 'refundToUser', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RefundedTimeout',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RefundedFailure',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'reason', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DeploymentRecorded',
    inputs: [
      { name: 'deploymentId', type: 'uint256', indexed: true },
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'akashDseq', type: 'string', indexed: false },
    ],
  },

  // Read functions
  {
    type: 'function',
    name: 'getEscrow',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [
      { name: 'user', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'quotedAmount', type: 'uint256' },
      { name: 'specsHash', type: 'bytes32' },
      { name: 'status', type: 'uint8' },
      { name: 'akashDseq', type: 'string' },
      { name: 'actualCost', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'escrows',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'user', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'quotedAmount', type: 'uint256' },
      { name: 'specsHash', type: 'bytes32' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'akashDseq', type: 'string' },
      { name: 'akashProvider', type: 'string' },
      { name: 'actualCost', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'gateway',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'escrowTimeout',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getDeploymentCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'computeSpecsHash',
    stateMutability: 'pure',
    inputs: [
      { name: 'cpu', type: 'uint256' },
      { name: 'memoryMb', type: 'uint256' },
      { name: 'storageMb', type: 'uint256' },
      { name: 'image', type: 'string' },
      { name: 'durationHours', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },

  // Write functions (gateway only)
  {
    type: 'function',
    name: 'submitProof',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'akashDseq', type: 'string' },
      { name: 'akashProvider', type: 'string' },
      { name: 'actualCost', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reportFailure',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [],
  },
] as const;

// Escrow status enum (matches Solidity)
export enum EscrowStatus {
  None = 0,
  Deposited = 1,
  Released = 2,
  Refunded = 3,
}

export function escrowStatusToString(status: number): string {
  switch (status) {
    case EscrowStatus.None:
      return 'none';
    case EscrowStatus.Deposited:
      return 'deposited';
    case EscrowStatus.Released:
      return 'released';
    case EscrowStatus.Refunded:
      return 'refunded';
    default:
      return 'unknown';
  }
}
