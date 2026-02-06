/**
 * Query Bids Tool
 *
 * Queries provider bids for a deployment. Read-only operation.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryBids, selectBestBid } from "../akash/index.js";

export function registerQueryBids(server: McpServer) {
  server.registerTool(
    "query_bids",
    {
      title: "Query Deployment Bids",
      description:
        "Queries provider bids for an Akash deployment. " +
        "Call this after broadcasting a deployment TX to find available providers. " +
        "Poll every 5-10 seconds until bids appear (typically 10-30 seconds).",
      inputSchema: {
        akashAddress: z
          .string()
          .describe("The deployment owner's Akash address."),
        dseq: z
          .string()
          .describe("The deployment sequence number (DSEQ) from prepare_deploy_tx."),
        network: z
          .enum(["mainnet", "testnet"])
          .optional()
          .describe("Network. Defaults to mainnet."),
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

        console.error(
          `[agent-pay:query-bids] Querying bids for DSEQ ${args.dseq}`
        );

        const bids = await queryBids(args.akashAddress, args.dseq, network);
        const openBids = bids.filter((b) => b.state === 1); // OPEN state

        console.error(
          `[agent-pay:query-bids] Found ${openBids.length} open bids (${bids.length} total)`
        );

        if (openBids.length === 0) {
          const text = [
            "## No Bids Found",
            "",
            `**DSEQ:** ${args.dseq}`,
            `**Total bids:** ${bids.length} (none open)`,
            "",
            "No open bids yet. Providers typically respond within 10-30 seconds.",
            "Try polling again in 5-10 seconds.",
          ].join("\n");

          return { content: [{ type: "text" as const, text }] };
        }

        // Sort by price (lowest first)
        openBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));

        const bestBid = selectBestBid(openBids);

        const bidRows = openBids.map((bid, i) => {
          const priceUakt = parseInt(bid.price.amount);
          const priceAkt = (priceUakt / 1_000_000).toFixed(6);
          const isRecommended = bestBid && bid.bidId.provider === bestBid.bidId.provider;
          return `| ${i + 1} | \`${bid.bidId.provider.slice(0, 15)}...\` | ${priceAkt} AKT/block | ${isRecommended ? "**Recommended**" : ""} |`;
        });

        const text = [
          "## Bids Available",
          "",
          `**DSEQ:** ${args.dseq}`,
          `**Open Bids:** ${openBids.length}`,
          "",
          "| # | Provider | Price | Note |",
          "|---|----------|-------|------|",
          ...bidRows,
          "",
          "### Recommended Provider",
          bestBid
            ? `\`${bestBid.bidId.provider}\` at ${(parseInt(bestBid.price.amount) / 1_000_000).toFixed(6)} AKT/block`
            : "No recommendation available.",
          "",
          "### Next Step",
          "Call `prepare_lease_tx` with the chosen provider address to create a lease.",
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error querying bids: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
