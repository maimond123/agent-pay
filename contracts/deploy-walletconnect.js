#!/usr/bin/env node

/**
 * Deploy AgentPayEscrow contract to Base using WalletConnect
 *
 * This will display a QR code - scan it with your Base wallet app to connect and sign.
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Dynamic imports for WalletConnect
const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
const { createWalletClient, custom } = await import('viem');

// Load bytecode from .env.deploy
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '.env.deploy');

let BYTECODE = '';
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^BYTECODE=["']?(.+?)["']?$/);
      if (match) {
        BYTECODE = match[1];
      }
    }
  }
} catch (e) {
  console.error('Error reading contracts/.env.deploy:', e.message);
}

if (!BYTECODE || BYTECODE.length < 100) {
  console.error('Error: BYTECODE not found in contracts/.env.deploy');
  process.exit(1);
}

// Base mainnet USDC
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Your gateway address
const GATEWAY_ADDRESS = '0xD526BF202e4C46333d5CbA8b7228a92c8257795F';

// Contract ABI (just constructor needed for deployment)
const ABI = [
  {
    type: 'constructor',
    inputs: [
      { name: '_usdc', type: 'address' },
      { name: '_gateway', type: 'address' }
    ]
  }
];

async function main() {
  console.log('🚀 Deploy AgentPayEscrow to Base via WalletConnect\n');

  // Initialize WalletConnect provider
  const provider = await EthereumProvider.init({
    projectId: '0e3b56acde363c1e5a630e03d39c0a8c', // Public demo project ID
    chains: [8453], // Base mainnet
    showQrModal: true,
    methods: ['eth_sendTransaction', 'eth_accounts'],
    events: ['accountsChanged', 'chainChanged'],
    metadata: {
      name: 'AgentPay Deployer',
      description: 'Deploy AgentPayEscrow contract',
      url: 'https://agentpay.dev',
      icons: []
    }
  });

  console.log('📱 Scan the QR code with your Base wallet app...\n');

  // Connect - this will show QR code
  await provider.connect();

  const accounts = await provider.request({ method: 'eth_accounts' });
  const deployerAddress = accounts[0];

  console.log(`\n✅ Connected!`);
  console.log(`Deployer address: ${deployerAddress}`);

  // Create clients
  const publicClient = createPublicClient({
    chain: base,
    transport: http()
  });

  const walletClient = createWalletClient({
    account: deployerAddress,
    chain: base,
    transport: custom(provider)
  });

  // Check balance
  const balance = await publicClient.getBalance({ address: deployerAddress });
  console.log(`Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);

  if (balance === 0n) {
    console.error('\n❌ No ETH balance! You need ETH on Base for gas.');
    await provider.disconnect();
    process.exit(1);
  }

  console.log(`\nConstructor args:`);
  console.log(`  _usdc:    ${USDC_ADDRESS}`);
  console.log(`  _gateway: ${GATEWAY_ADDRESS}`);

  const bytecode = BYTECODE.startsWith('0x') ? BYTECODE : `0x${BYTECODE}`;

  console.log('\n📤 Sending deployment transaction...');
  console.log('📱 Please approve the transaction in your wallet app...\n');

  try {
    // Deploy
    const hash = await walletClient.deployContract({
      abi: ABI,
      bytecode: bytecode,
      args: [USDC_ADDRESS, GATEWAY_ADDRESS]
    });

    console.log(`Transaction hash: ${hash}`);
    console.log('\n⏳ Waiting for confirmation...');

    // Wait for receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === 'success') {
      console.log('\n✅ Contract deployed successfully!');
      console.log(`\n📋 Contract address: ${receipt.contractAddress}`);
      console.log('\nNext steps:');
      console.log(`1. Add to your .env.production:`);
      console.log(`   ESCROW_CONTRACT_ADDRESS=${receipt.contractAddress}`);
      console.log(`\n2. Verify on Basescan (optional):`);
      console.log(`   https://basescan.org/address/${receipt.contractAddress}#code`);
    } else {
      console.error('\n❌ Deployment failed!');
      console.error(receipt);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }

  await provider.disconnect();
}

main().catch(console.error);
