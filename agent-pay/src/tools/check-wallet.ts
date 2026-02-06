/**
 * Check Wallet Tool
 *
 * Direct query tool to check if user has an Akash wallet and query its balance.
 * This is a read-only operation - no signing required.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWalletBalance, queryDeployments } from "../akash/index.js";
import { listStoredWallets, getDefaultWalletAddress, getStoredEvmAddress, getEvmBalance, loadBudget, getBudgetSummary } from "../wallet/index.js";

export function registerCheckWallet(server: McpServer) {
  server.registerTool(
    "check_wallet",
    {
      title: "Check Akash Wallet",
      description:
        "Check if user has an Akash wallet and query its balance. Returns wallet address, USDC balance, AKT balance, and active deployments count.",
      inputSchema: {
        akashAddress: z
          .string()
          .optional()
          .describe("Optional specific Akash address to check. If omitted, uses the default local wallet."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network to query (mainnet or testnet). Defaults to mainnet."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const network = args.network || "mainnet";

        // Try to find wallet address
        let address = args.akashAddress;

        if (!address) {
          // Check for locally stored wallets
          const storedWallets = listStoredWallets();

          if (storedWallets.length === 0) {
            // No wallet found - return instructions to create one
            const text = [
              "## No Akash Wallet Found",
              "",
              "You need an Akash wallet to deploy compute. Create one by running:",
              "",
              "```",
              "npx @agent-pay/mcp wallet create",
              "```",
              "",
              "This will:",
              "1. Generate a new wallet with a 24-word recovery phrase",
              "2. Show you the recovery phrase (save it securely!)",
              "3. Encrypt and store it locally at ~/.agent-pay/wallets/",
              "",
              "After creating your wallet, you'll need to fund it with USDC.",
            ].join("\n");

            return { content: [{ type: "text" as const, text }] };
          }

          // Use the first/default wallet
          address = getDefaultWalletAddress() || storedWallets[0].address;
        }

        // Query balance from chain
        const balance = await getWalletBalance(address, network);

        // Query active deployments
        let activeDeployments = 0;
        try {
          const deployments = await queryDeployments(address, network);
          activeDeployments = deployments.filter(d => d.state === 1).length; // ACTIVE state
        } catch {
          // Deployments query may fail if no deployments exist
        }

        // Check if wallet has sufficient funds
        const usdcBalance = parseFloat(balance.usdcFormatted);
        const aktBalance = parseFloat(balance.uaktFormatted);

        const hasFunds = usdcBalance >= 1.0; // Minimum $1 USDC for small deployments
        const hasGas = aktBalance >= 0.1; // Minimum 0.1 AKT for gas

        // Look up EVM address and query Base balance
        const evmAddr = getStoredEvmAddress(address);
        let evmUsdcFormatted = "N/A";
        let evmEthFormatted = "N/A";
        if (evmAddr) {
          try {
            const evmBal = await getEvmBalance(evmAddr as `0x${string}`);
            evmUsdcFormatted = evmBal.usdcFormatted;
            evmEthFormatted = evmBal.ethFormatted;
          } catch {
            // Base balance query may fail
          }
        }

        // Budget summary
        const budgetState = loadBudget();
        const budgetSummary = getBudgetSummary(budgetState);

        // Build response
        const lines = [
          "## Wallet Found",
          "",
          `**Akash Address:** \`${address}\``,
          ...(evmAddr ? [`**Base Address:** \`${evmAddr}\``] : []),
          `**Network:** ${network}`,
          "",
          "### Akash Balances",
          `- **USDC:** ${balance.usdcFormatted} axlUSDC`,
          `- **AKT:** ${balance.uaktFormatted} AKT (for gas)`,
          "",
          "### Base Balances",
          `- **USDC:** ${evmUsdcFormatted} USDC`,
          `- **ETH:** ${evmEthFormatted} ETH (for gas)`,
          "",
          "### Budget",
          `- **Daily:** $${budgetSummary.dailySpent.toFixed(2)} / $${budgetSummary.config.maxDailyUsd.toFixed(2)} (remaining: $${budgetSummary.dailyRemaining.toFixed(2)})`,
          `- **Lifetime:** $${budgetSummary.totalSpent.toFixed(2)} / $${budgetSummary.config.maxTotalUsd.toFixed(2)} (remaining: $${budgetSummary.totalRemaining.toFixed(2)})`,
          `- **Per-tx limit:** $${budgetSummary.config.maxTransactionUsd.toFixed(2)}`,
          "",
          "### Status",
          `- **Active Deployments:** ${activeDeployments}`,
          `- **Sufficient USDC (Akash):** ${hasFunds ? "Yes" : "No (need at least $1)"}`,
          `- **Sufficient AKT for gas:** ${hasGas ? "Yes" : "No (need ~0.1 AKT)"}`,
        ];

        // Add funding instructions if needed
        if (!hasFunds || !hasGas) {
          lines.push(
            "",
            "### Funding Required",
            "",
            "To fund your Akash wallet, bridge USDC from Base:",
            "",
            "```",
            "npx @agent-pay/mcp bridge --amount 10",
            "```",
            "",
            ...(evmAddr
              ? [`Or send USDC directly to your Base address: \`${evmAddr}\``]
              : []),
            "",
            "The bridge command will transfer USDC from Base to Akash,",
            "including a small amount of AKT for transaction gas."
          );
        } else {
          lines.push(
            "",
            "### Ready to Deploy",
            "",
            "Your wallet is funded and ready. You can now provision compute!"
          );
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error checking wallet: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
