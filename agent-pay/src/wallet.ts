import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

// ── USDC contract addresses ──

const USDC_ADDRESSES: Record<string, Address> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const CHAINS: Record<string, Chain> = {
  "base-sepolia": baseSepolia,
  base: base,
};

// Minimal ERC-20 ABI — only the methods we need
const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface TransferResult {
  txHash: Hash;
}

export class UsdcWallet {
  public readonly address: Address;
  public readonly network: string;

  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private usdcAddress: Address;

  constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    address: Address,
    usdcAddress: Address,
    network: string,
  ) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.address = address;
    this.usdcAddress = usdcAddress;
    this.network = network;
  }

  /**
   * Transfer USDC to a recipient.
   * @param to - recipient address
   * @param amount - raw amount in USDC smallest unit (6 decimals, e.g. "32200" = 0.0322 USDC)
   */
  async transferUsdc(to: Address, amount: bigint): Promise<TransferResult> {
    // Simulate first to catch errors (e.g. insufficient balance) before spending gas
    const { request } = await this.publicClient.simulateContract({
      account: this.address,
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, amount],
    });

    const txHash = await this.walletClient.writeContract(request);

    // Wait for 1 confirmation so the gateway can verify the receipt
    await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });

    return { txHash };
  }

  /**
   * Get USDC balance formatted as a human-readable string (e.g. "12.50").
   */
  async getBalance(): Promise<string> {
    const raw = await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.address],
    });

    // USDC has 6 decimals
    const whole = raw / 1_000_000n;
    const frac = raw % 1_000_000n;
    const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
    return fracStr.length > 0
      ? `${whole}.${fracStr.slice(0, 2).padEnd(2, "0")}`
      : `${whole}.00`;
  }
}

/**
 * Create a USDC wallet from environment variables.
 * Returns null if AGENT_PAY_WALLET_KEY is not set (simulated mode).
 */
export function createWallet(): UsdcWallet | null {
  const privateKey = process.env.AGENT_PAY_WALLET_KEY;
  if (!privateKey) {
    return null;
  }

  const network = process.env.AGENT_PAY_NETWORK ?? "base";
  const chain = CHAINS[network];
  if (!chain) {
    throw new Error(
      `Unknown network "${network}". Supported: ${Object.keys(CHAINS).join(", ")}`,
    );
  }

  const usdcAddress = USDC_ADDRESSES[network];
  if (!usdcAddress) {
    throw new Error(`No USDC address configured for network "${network}".`);
  }

  // Ensure the key has 0x prefix
  const key = (
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
  ) as `0x${string}`;

  const account = privateKeyToAccount(key);

  const publicClient = createPublicClient({
    chain,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  return new UsdcWallet(
    publicClient,
    walletClient,
    account.address,
    usdcAddress,
    network,
  );
}
