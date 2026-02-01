#!/usr/bin/env node

/**
 * Deploy AgentPayEscrow contract to Base using viem
 *
 * Usage:
 *   1. Edit contracts/.env.deploy with your mnemonic
 *   2. Run: node contracts/deploy-with-viem.js
 */

import { createWalletClient, createPublicClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env.deploy manually (no dotenv dependency)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '.env.deploy');

try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([^=]+)=["']?(.+?)["']?$/);
      if (match) {
        process.env[match[1]] = match[2];
      }
    }
  }
} catch (e) {
  console.error('Error reading contracts/.env.deploy:', e.message);
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

// PASTE YOUR BYTECODE FROM REMIX HERE (the "object" field from Compilation Details)
// It should start with "608060..."
const BYTECODE = process.env.BYTECODE || '';

async function main() {
  const mnemonic = process.env.MNEMONIC;

  if (!mnemonic || mnemonic.includes('your new twelve')) {
    console.error('Error: MNEMONIC not set in contracts/.env.deploy');
    console.error('Edit the file and replace the placeholder with your actual mnemonic');
    process.exit(1);
  }

  if (!BYTECODE || BYTECODE.length < 100) {
    console.error('Error: BYTECODE not set in contracts/.env.deploy');
    console.error('The bytecode should already be in the file - check if it was removed');
    process.exit(1);
  }

  console.log('🚀 Deploying AgentPayEscrow to Base mainnet...\n');

  // Create account from mnemonic
  const account = mnemonicToAccount(mnemonic);
  console.log(`Deployer address: ${account.address}`);

  // Create clients
  const publicClient = createPublicClient({
    chain: base,
    transport: http()
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http()
  });

  // Check balance
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);

  if (balance === 0n) {
    console.error('\n❌ No ETH balance! You need ETH on Base for gas.');
    process.exit(1);
  }

  console.log(`\nConstructor args:`);
  console.log(`  _usdc:    ${USDC_ADDRESS}`);
  console.log(`  _gateway: ${GATEWAY_ADDRESS}`);

  const bytecode = BYTECODE.startsWith('0x') ? BYTECODE : `0x${BYTECODE}`;

  console.log('\n📤 Sending deployment transaction...');

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
    process.exit(1);
  }
}

main().catch(console.error);
