#!/usr/bin/env node

/**
 * Full ERC-8004 Deployment Test over HTTP MCP
 *
 * Simulates the real ERC-8004 agent-to-agent flow:
 *   Agent A: Has only an EVM wallet (Base) with USDC
 *   Agent B: This MCP server (compute provider)
 *
 * Flow:
 *   Phase 0 — Wallet:   Create a brand-new agent wallet (--new-wallet)
 *   Phase 0b — Fund:    Transfer ETH + USDC from existing wallet to new one
 *   Phase 1 — Bridge:   Bridge USDC from Base → AKT on Akash
 *   Phase 2 — Deploy:   Certificate → Deploy → Bids → Lease → JWT → Manifest
 *   Phase 3 — Cleanup:  Close deployment, refund deposit
 *
 * Usage:
 *   1. Start the HTTP server:  npm run serve
 *   2. Run this script:        node test-http-deploy.mjs [server-url] [flags]
 *
 * Flags:
 *   --new-wallet       Create a brand-new wallet and fund it from existing one
 *   --skip-bridge      Skip bridging (assumes Akash account already funded)
 *   --bridge-only      Only do the bridge, then exit
 *   --amount <USDC>    Bridge amount in USDC (default: 1.50)
 *
 * Default server URL: http://localhost:3001/mcp
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toHex, fromHex } from "@cosmjs/encoding";
import { encodeFunctionData, parseEther, parseUnits } from "viem";
import { base } from "viem/chains";

// Wallet (Agent A side — local signing for both EVM and Cosmos)
import {
  getOrUnlockWallet,
  getDefaultWalletAddress,
  listStoredWallets,
  getStoredEvmAddress,
  createAkashWallet,
  saveWallet,
  loadWallet,
  createEvmWalletClient,
  createEvmPublicClient,
  promptPassword,
  getEvmBalance,
} from "./dist/wallet/index.js";

const cliArgs = process.argv.slice(2);
const SERVER_URL = cliArgs.find((a) => !a.startsWith("--")) || "http://localhost:3001/mcp";
const NEW_WALLET = cliArgs.includes("--new-wallet");
const SKIP_BRIDGE = cliArgs.includes("--skip-bridge");
const BRIDGE_ONLY = cliArgs.includes("--bridge-only");
const BRIDGE_AMOUNT = (() => {
  const idx = cliArgs.indexOf("--amount");
  return idx >= 0 && cliArgs[idx + 1] ? cliArgs[idx + 1] : "1.50";
})();

const NETWORK = "mainnet";
const CHAIN_ID = NETWORK === "mainnet" ? "akashnet-2" : "sandbox-01";
const BID_POLL_SEC = 60;
const BRIDGE_POLL_SEC = 300;

const SPECS = {
  cpu: 1,
  memory: "512Mi",
  storage: "1Gi",
  image: "nginx:latest",
  hours: 1,
  ports: [{ port: 80, protocol: "tcp", expose: true }],
};

// Base USDC contract
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// Gas funding amount for new wallet (enough for bridge TX + some headroom)
const FUND_ETH_AMOUNT = "0.0005"; // ~$1.50 at $3000/ETH, enough for several Base TXs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Parsing helpers ───

function extractCodeBlock(text, heading) {
  const re = new RegExp(
    `###\\s+${escapeRegex(heading)}[^\\n]*\\n\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\``,
    "m"
  );
  const m = text.match(re);
  if (!m) throw new Error(`Could not find code block for "${heading}" in response`);
  return m[1].trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractField(text, field) {
  const re = new RegExp(`\\*\\*${escapeRegex(field)}:\\*\\*\\s*\`([^\`]+)\``);
  const m = text.match(re);
  if (!m) throw new Error(`Could not find field "${field}" in response`);
  return m[1];
}

function extractRecommendedProvider(text) {
  const m = text.match(/### Recommended Provider\n`([^`]+)`/);
  if (!m) throw new Error("No recommended provider found in bids response");
  return m[1];
}

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

async function callTool(client, name, toolArgs) {
  const result = await client.callTool({ name, arguments: toolArgs });
  const text = result.content?.[0]?.text || "";
  if (result.isError) {
    throw new Error(`Tool ${name} error: ${text.slice(0, 300)}`);
  }
  return text;
}

function parseAccountNumberFromSignDoc(signDocBytes) {
  let offset = 0;
  while (offset < signDocBytes.length) {
    let key = 0;
    let shift = 0;
    while (offset < signDocBytes.length) {
      const b = signDocBytes[offset++];
      key |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const fieldNumber = key >> 3;
    const wireType = key & 0x07;

    if (fieldNumber === 4 && wireType === 0) {
      let value = 0n;
      let vShift = 0n;
      while (offset < signDocBytes.length) {
        const b = signDocBytes[offset++];
        value |= BigInt(b & 0x7f) << vShift;
        vShift += 7n;
        if ((b & 0x80) === 0) break;
      }
      return Number(value);
    }

    if (wireType === 0) {
      while (offset < signDocBytes.length && (signDocBytes[offset++] & 0x80) !== 0) {}
    } else if (wireType === 2) {
      let len = 0;
      let lShift = 0;
      while (offset < signDocBytes.length) {
        const b = signDocBytes[offset++];
        len |= (b & 0x7f) << lShift;
        lShift += 7;
        if ((b & 0x80) === 0) break;
      }
      offset += len;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    }
  }
  return 0;
}

/** Sign a Cosmos TX from MCP response, broadcast via MCP */
async function signAndBroadcast(client, wallet, akashAddress, responseText, label) {
  const body = extractCodeBlock(responseText, "Body Bytes");
  const auth = extractCodeBlock(responseText, "Auth Info Bytes");
  const signDoc = extractCodeBlock(responseText, "Sign Doc");
  const acctNum = parseAccountNumberFromSignDoc(fromHex(signDoc));

  const sigResult = await wallet.signDirect(akashAddress, {
    bodyBytes: fromHex(body),
    authInfoBytes: fromHex(auth),
    chainId: CHAIN_ID,
    accountNumber: BigInt(acctNum),
  });
  const sig = toHex(Buffer.from(sigResult.signature.signature, "base64"));

  const broadcastText = await callTool(client, "broadcast_cosmos_tx", {
    bodyBytes: body,
    authInfoBytes: auth,
    signature: sig,
    network: NETWORK,
  });

  if (broadcastText.includes("Failed")) {
    throw new Error(`${label} TX failed:\n${broadcastText}`);
  }

  const txHash = extractField(broadcastText, "TX Hash");
  console.log(`  ${label} TX: ${txHash}`);
  return txHash;
}

// ─── Refund state (module-scope so .catch() can access) ───
let funderEvmAccount = null;
let funderEvmAddress = null;
let newWalletEvmAccount = null;
let newWalletEvmAddress = null;
let fundedUsdcAmount = 0n; // exact USDC micro-units sent to new wallet

// ─── Main ───
async function main() {
  console.log(`\n${"═".repeat(63)}`);
  console.log("  ERC-8004 Agent-to-Agent Compute — Full Flow");
  console.log(`${"═".repeat(63)}`);
  console.log(`Server:     ${SERVER_URL}`);
  console.log(`New wallet: ${NEW_WALLET ? "yes" : "no"}`);
  console.log(`Bridge:     ${SKIP_BRIDGE ? "skipped" : `$${BRIDGE_AMOUNT} USDC -> AKT`}`);
  console.log();

  let wallet, aminoWallet, evmAddress, evmAccount, akashAddress, pubkeyHex;

  // ════════════════════════════════════════════════════════
  // PHASE 0: WALLET SETUP
  // ════════════════════════════════════════════════════════
  if (NEW_WALLET) {
    // Step 0a: Find the funder wallet — the one with USDC on Base
    // We scan all wallets' stored EVM addresses and check balances (no decryption needed)
    log("0a", "Finding funded wallet on Base...");
    const allWallets = listStoredWallets();
    if (allWallets.length === 0) {
      throw new Error("No existing wallet to fund from. Run: npx @agent-pay/mcp wallet create");
    }

    let funderAkashAddr = null;
    let bestBalance = 0n;

    for (const w of allWallets) {
      const evm = w.evmAddress || getStoredEvmAddress(w.address);
      if (!evm) continue;
      try {
        const bal = await getEvmBalance(evm);
        console.log(`  ${w.address.slice(0, 15)}... → ${evm} — $${bal.usdcFormatted} USDC`);
        if (bal.usdcRaw > bestBalance) {
          bestBalance = bal.usdcRaw;
          funderAkashAddr = w.address;
        }
      } catch {
        // Skip wallets we can't check
      }
    }

    if (!funderAkashAddr) {
      throw new Error("No wallet with USDC found on Base. Fund one of your wallets first.");
    }

    log("0a", `Unlocking funder wallet (${funderAkashAddr.slice(0, 15)}...)...`);
    const funder = await getOrUnlockWallet(funderAkashAddr);
    funderEvmAccount = funder.evmAccount;
    funderEvmAddress = funder.evmAddress;
    const funderWalletClient = createEvmWalletClient(funder.evmAccount);
    const evmPublicClient = createEvmPublicClient();

    // Check funder has enough funds
    const funderBal = await getEvmBalance(funder.evmAddress);
    console.log(`  Funder EVM:  ${funder.evmAddress}`);
    console.log(`  Funder USDC: $${funderBal.usdcFormatted}`);
    console.log(`  Funder ETH:  ${funderBal.ethFormatted}`);

    const bridgeAmountMicro = BigInt(Math.round(parseFloat(BRIDGE_AMOUNT) * 1e6));
    if (funderBal.usdcRaw < bridgeAmountMicro) {
      throw new Error(`Funder has insufficient USDC: $${funderBal.usdcFormatted} < $${BRIDGE_AMOUNT}`);
    }

    // Step 0b: Create brand-new wallet
    log("0b", "Creating brand-new Agent A wallet...");
    const created = await createAkashWallet();
    console.log(`  New Akash address: ${created.address}`);
    console.log(`  New EVM address:   ${created.evmAddress}`);

    const pw = await promptPassword("Set password for new wallet: ");
    const pwConfirm = await promptPassword("Confirm password: ");
    if (pw !== pwConfirm) throw new Error("Passwords don't match");

    saveWallet(created.address, created.mnemonic, pw, "akash-mainnet", created.evmAddress);
    console.log(`  Wallet saved.`);

    // Load the new wallet directly (no password prompt — we already have the password)
    const unlocked = await loadWallet(created.address, pw);
    wallet = unlocked.wallet;
    aminoWallet = unlocked.aminoWallet;
    evmAccount = unlocked.evmAccount;
    evmAddress = unlocked.evmAddress;
    newWalletEvmAccount = unlocked.evmAccount;
    newWalletEvmAddress = unlocked.evmAddress;

    const [acct] = await wallet.getAccounts();
    akashAddress = acct.address;
    pubkeyHex = toHex(acct.pubkey);

    // Step 0c: Fund new wallet from existing wallet on Base
    log("0c", "Funding new wallet from existing wallet...");

    // Transfer ETH for gas
    console.log(`  Sending ${FUND_ETH_AMOUNT} ETH for gas...`);
    const ethTxHash = await funderWalletClient.sendTransaction({
      account: funder.evmAccount,
      chain: base,
      to: evmAddress,
      value: parseEther(FUND_ETH_AMOUNT),
    });
    const ethReceipt = await evmPublicClient.waitForTransactionReceipt({ hash: ethTxHash });
    console.log(`  ETH sent: ${ethTxHash} (block ${ethReceipt.blockNumber})`);

    // Transfer USDC for bridging
    console.log(`  Sending $${BRIDGE_AMOUNT} USDC for bridging...`);
    const usdcData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [evmAddress, bridgeAmountMicro],
    });
    const usdcTxHash = await funderWalletClient.sendTransaction({
      account: funder.evmAccount,
      chain: base,
      to: BASE_USDC,
      data: usdcData,
    });
    const usdcReceipt = await evmPublicClient.waitForTransactionReceipt({ hash: usdcTxHash });
    console.log(`  USDC sent: ${usdcTxHash} (block ${usdcReceipt.blockNumber})`);
    fundedUsdcAmount = bridgeAmountMicro; // track exactly how much we sent

    // Verify new wallet balances
    const newBal = await getEvmBalance(evmAddress);
    console.log(`  New wallet ETH:  ${newBal.ethFormatted}`);
    console.log(`  New wallet USDC: $${newBal.usdcFormatted}`);
  } else {
    // ──────────────────────────────────────────────────────
    // STEP 0: Unlock existing wallet
    // ──────────────────────────────────────────────────────
    log("0", "Unlocking Agent A wallet...");
    const existingAddr = getDefaultWalletAddress();
    if (!existingAddr) throw new Error("No wallet. Run: npx @agent-pay/mcp wallet create");

    const unlocked = await getOrUnlockWallet(existingAddr);
    wallet = unlocked.wallet;
    aminoWallet = unlocked.aminoWallet;
    evmAccount = unlocked.evmAccount;
    evmAddress = unlocked.evmAddress;

    const [acct] = await wallet.getAccounts();
    akashAddress = acct.address;
    pubkeyHex = toHex(acct.pubkey);
  }

  console.log(`  EVM (Base):  ${evmAddress}`);
  console.log(`  Akash:       ${akashAddress}`);
  console.log(`  Pubkey:      ${pubkeyHex.slice(0, 20)}...`);

  // ──────────────────────────────────────────────────────
  // STEP 1: Connect to MCP server (Agent B)
  // ──────────────────────────────────────────────────────
  log("1", "Connecting to Agent B (MCP server)...");
  const client = new Client({ name: "agent-a-evm", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`  Connected — ${tools.length} tools available`);

  // ──────────────────────────────────────────────────────
  // STEP 2: Check wallet balances
  // ──────────────────────────────────────────────────────
  log("2", "Checking Agent A wallet balances...");
  const walletText = await callTool(client, "check_wallet", {
    akashAddress,
    network: NETWORK,
  });

  const balanceLines = walletText.split("\n").filter(
    (l) => l.includes("AKT") || l.includes("USDC") || l.includes("ETH") || l.includes("Balance")
  );
  for (const line of balanceLines.slice(0, 6)) {
    console.log(`  ${line.replace(/\*\*/g, "").trim()}`);
  }

  // ════════════════════════════════════════════════════════
  // PHASE 1: BRIDGE (USDC on Base → AKT on Akash)
  // ════════════════════════════════════════════════════════
  if (!SKIP_BRIDGE) {
    log("3", `Bridging $${BRIDGE_AMOUNT} USDC -> AKT...`);

    // Get bridge TX from Agent B
    const bridgeText = await callTool(client, "prepare_bridge_tx", {
      evmAddress,
      akashAddress,
      amountUSDC: BRIDGE_AMOUNT,
      destinationType: "akt",
    });

    const routeMatch = bridgeText.match(/\*\*Estimated Out:\*\*\s*(.+)/);
    const durationMatch = bridgeText.match(/\*\*Estimated Duration:\*\*\s*(.+)/);
    console.log(`  Route: ${routeMatch ? routeMatch[1] : "see response"}`);
    console.log(`  Duration: ${durationMatch ? durationMatch[1] : "unknown"}`);

    // Extract unsigned EVM TX fields
    const txTo = extractField(bridgeText, "To");
    const txValue = bridgeText.match(/\*\*Value:\*\*\s*(.+)/)?.[1]?.trim() || "0";
    const chainIdMatch = bridgeText.match(/\*\*Chain ID:\*\*\s*(\d+)/);
    const txChainId = chainIdMatch ? chainIdMatch[1] : "8453";

    const dataMatch = bridgeText.match(/\*\*Data \(hex\):\*\*\s*\n```\n([\s\S]*?)```/);
    if (!dataMatch) throw new Error("Could not find Data (hex) in bridge response");
    const txData = dataMatch[1].trim();

    console.log(`  To: ${txTo}`);

    // Agent A signs and broadcasts EVM TX
    const evmWalletClient = createEvmWalletClient(evmAccount);
    const evmPublicClient = createEvmPublicClient();

    // Check USDC allowance for the bridge contract — approve if needed
    const bridgeContract = txTo;
    const bridgeAmountMicro = parseUnits(BRIDGE_AMOUNT, 6);
    const currentAllowance = await evmPublicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [evmAddress, bridgeContract],
    });

    if (currentAllowance < bridgeAmountMicro) {
      console.log(`  USDC allowance: ${Number(currentAllowance) / 1e6} — approving bridge contract...`);
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [bridgeContract, maxApproval],
      });
      const approveTxHash = await evmWalletClient.sendTransaction({
        account: evmAccount,
        chain: base,
        to: BASE_USDC,
        data: approveData,
      });
      await evmPublicClient.waitForTransactionReceipt({ hash: approveTxHash });
      console.log(`  Approved: ${approveTxHash}`);
    } else {
      console.log(`  USDC allowance OK: ${Number(currentAllowance) / 1e6}`);
    }

    console.log("  Signing EVM bridge TX...");
    const txHash = await evmWalletClient.sendTransaction({
      account: evmAccount,
      chain: base,
      to: txTo,
      data: txData.startsWith("0x") ? txData : `0x${txData}`,
      value: BigInt(txValue || "0"),
    });

    console.log(`  Bridge TX broadcast: ${txHash}`);

    // Wait for EVM TX confirmation
    console.log("  Waiting for Base TX confirmation...");
    const receipt = await evmPublicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === "reverted") {
      throw new Error(`Bridge TX reverted: ${txHash}`);
    }
    console.log(`  Confirmed in block ${receipt.blockNumber}`);

    // Track bridge progress
    log("4", "Tracking bridge progress...");
    const bridgeStart = Date.now();
    let bridgeComplete = false;

    while (Date.now() - bridgeStart < BRIDGE_POLL_SEC * 1000) {
      await sleep(15000);
      const elapsed = Math.round((Date.now() - bridgeStart) / 1000);

      try {
        const trackText = await callTool(client, "track_bridge", {
          txHash,
          chainId: txChainId,
        });

        if (trackText.includes("Complete") || trackText.includes("success")) {
          console.log(`\n  Bridge complete (${elapsed}s)`);
          bridgeComplete = true;
          break;
        } else if (trackText.includes("Failed") || trackText.includes("Abandoned")) {
          throw new Error(`Bridge failed: ${trackText.slice(0, 200)}`);
        } else {
          const hops = trackText.match(/\| .+ → .+ \| .+ \|/g) || [];
          const hopSummary = hops.map((h) => h.replace(/\|/g, "").trim()).join(", ");
          process.stdout.write(`\r  ${elapsed}s: ${hopSummary || "waiting..."}          `);
        }
      } catch (e) {
        process.stdout.write(`\r  ${elapsed}s: waiting for indexing...          `);
      }
    }
    console.log();

    if (!bridgeComplete) {
      console.log("  Bridge still in progress — it may complete in background.");
      console.log("  Re-run with --skip-bridge once funds arrive on Akash.");
      await transport.close();
      return;
    }

    if (BRIDGE_ONLY) {
      log("done", "Verifying balances...");
      const finalWallet = await callTool(client, "check_wallet", {
        akashAddress,
        network: NETWORK,
      });
      const aktLine = finalWallet.split("\n").find((l) => l.includes("AKT"));
      console.log(`  ${aktLine ? aktLine.replace(/\*\*/g, "").trim() : "Check wallet for AKT balance"}`);

      console.log(`\n${"═".repeat(63)}`);
      console.log("  Bridge complete! Re-run with --skip-bridge to deploy.");
      console.log(`${"═".repeat(63)}\n`);
      await transport.close();
      return;
    }
  }

  // ════════════════════════════════════════════════════════
  // PHASE 2: AKASH DEPLOYMENT (all via MCP HTTP tools)
  // ════════════════════════════════════════════════════════

  // Certificate
  log("5", "Ensuring on-chain certificate...");
  const certText = await callTool(client, "prepare_certificate_tx", {
    akashAddress,
    publicKey: pubkeyHex,
    network: NETWORK,
  });

  if (certText.includes("Already Exists")) {
    console.log("  Certificate already exists, skipping.");
  } else {
    console.log("  Signing certificate TX...");
    await signAndBroadcast(client, wallet, akashAddress, certText, "Certificate");
  }

  // Deploy
  log("6", "Creating deployment...");
  const deployText = await callTool(client, "prepare_deploy_tx", {
    akashAddress,
    publicKey: pubkeyHex,
    specs: SPECS,
    network: NETWORK,
  });

  const dseq = extractField(deployText, "DSEQ");
  const depositMatch = deployText.match(/\*\*Deposit:\*\*\s*(.+)/);
  console.log(`  DSEQ: ${dseq}`);
  console.log(`  Deposit: ${depositMatch ? depositMatch[1].trim() : "see response"}`);

  await signAndBroadcast(client, wallet, akashAddress, deployText, "Deploy");

  // Poll for bids
  log("7", `Waiting for bids (up to ${BID_POLL_SEC}s)...`);
  let provider = null;
  const bidStart = Date.now();

  while (Date.now() - bidStart < BID_POLL_SEC * 1000) {
    await sleep(5000);
    const bidsText = await callTool(client, "query_bids", {
      akashAddress,
      dseq,
      network: NETWORK,
    });

    const elapsed = Math.round((Date.now() - bidStart) / 1000);

    if (bidsText.includes("Bids Available")) {
      try {
        provider = extractRecommendedProvider(bidsText);
        console.log(`  Bids found (${elapsed}s) — selected: ${provider.slice(0, 20)}...`);
        break;
      } catch {
        process.stdout.write(`\r  Bids found but no recommendation yet (${elapsed}s)...`);
      }
    } else {
      process.stdout.write(`\r  No bids yet (${elapsed}s)...`);
    }
  }
  console.log();

  if (!provider) {
    console.log("  No bids received. Closing deployment to refund...");
    await closeDeployment(client, wallet, akashAddress, pubkeyHex, dseq);
    await transport.close();
    return;
  }

  // Lease
  log("8", "Creating lease...");
  const leaseText = await callTool(client, "prepare_lease_tx", {
    akashAddress,
    publicKey: pubkeyHex,
    dseq,
    provider,
    network: NETWORK,
  });
  await signAndBroadcast(client, wallet, akashAddress, leaseText, "Lease");

  // JWT
  log("9", "Creating JWT for provider auth...");
  const jwtText = await callTool(client, "prepare_jwt_sign_doc", {
    akashAddress,
  });

  const canonicalJson = extractCodeBlock(jwtText, "Canonical JSON to Sign");
  const jwtHeader = extractCodeBlock(jwtText, "JWT Header");
  const jwtPayload = extractCodeBlock(jwtText, "JWT Payload");

  const [aminoAccount] = await aminoWallet.getAccounts();
  const aminoSignDoc = JSON.parse(canonicalJson);
  const aminoSigResult = await aminoWallet.signAmino(aminoAccount.address, aminoSignDoc);
  const jwtSigHex = toHex(Buffer.from(aminoSigResult.signature.signature, "base64"));
  console.log(`  JWT signed: ${jwtSigHex.slice(0, 20)}...`);

  // Manifest
  log("10", "Sending manifest to provider...");
  const manifestText = await callTool(client, "send_manifest", {
    akashAddress,
    dseq,
    provider,
    jwtSignature: jwtSigHex,
    jwtHeader,
    jwtPayload,
    publicKey: pubkeyHex,
    specs: SPECS,
    network: NETWORK,
  });

  if (manifestText.includes("Deployment Active")) {
    console.log("  Manifest sent — deployment active!");
    const epLines = manifestText.split("\n").filter((l) => l.startsWith("- `"));
    for (const ep of epLines) {
      console.log(`  ${ep.replace(/`/g, "")}`);
    }
  } else {
    console.log(`  Manifest result: ${manifestText.slice(0, 200)}`);
  }

  // Check status
  log("11", "Checking deployment status...");
  await sleep(5000);
  const statusText = await callTool(client, "check_deployment", {
    dseq,
    akashAddress,
    network: NETWORK,
  });
  const statusLines = statusText.split("\n").filter((l) => l.trim()).slice(0, 5);
  for (const line of statusLines) {
    console.log(`  ${line.replace(/\*\*/g, "").trim()}`);
  }

  // ════════════════════════════════════════════════════════
  // PHASE 3: CLEANUP
  // ════════════════════════════════════════════════════════
  log("12", "Closing deployment (refunding deposit)...");
  await closeDeployment(client, wallet, akashAddress, pubkeyHex, dseq);

  console.log(`\n${"═".repeat(63)}`);
  console.log("  ERC-8004 full flow completed successfully!");
  console.log(`${"═".repeat(63)}\n`);

  await transport.close();
}

// ─── Close deployment helper ───
async function closeDeployment(client, wallet, akashAddress, pubkeyHex, dseq) {
  const closeText = await callTool(client, "prepare_close_tx", {
    akashAddress,
    publicKey: pubkeyHex,
    dseq,
    network: NETWORK,
  });

  if (closeText.includes("Already Closed") || closeText.includes("Not Found")) {
    console.log(`  ${closeText.includes("Already Closed") ? "Already closed" : "Not found"}`);
    return;
  }

  await signAndBroadcast(client, wallet, akashAddress, closeText, "Close");
  console.log("  Deposit refunded.");
}

main().catch(async (e) => {
  console.error(`\nFATAL: ${e.message}`);
  console.error(e.stack);

  // If --new-wallet was used and we funded it, sweep back only what we sent
  if (NEW_WALLET && newWalletEvmAccount && newWalletEvmAddress && funderEvmAddress && fundedUsdcAmount > 0n) {
    try {
      console.log("\n  Attempting to recover funds from new wallet...");
      const publicClient = createEvmPublicClient();
      const bal = await getEvmBalance(newWalletEvmAddress);

      // Only sweep back the exact amount we funded — not the full balance
      // (in case the wallet had a pre-existing balance from another source)
      const sweepAmount = bal.usdcRaw < fundedUsdcAmount ? bal.usdcRaw : fundedUsdcAmount;

      if (sweepAmount > 0n) {
        const sweepFormatted = (Number(sweepAmount) / 1e6).toFixed(6);
        console.log(`  New wallet has $${bal.usdcFormatted} USDC — recovering $${sweepFormatted}...`);
        const sweepClient = createEvmWalletClient(newWalletEvmAccount);
        const sweepData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [funderEvmAddress, sweepAmount],
        });
        const sweepTx = await sweepClient.sendTransaction({
          account: newWalletEvmAccount,
          chain: base,
          to: BASE_USDC,
          data: sweepData,
        });
        await publicClient.waitForTransactionReceipt({ hash: sweepTx });
        console.log(`  Recovered $${sweepFormatted} USDC → ${funderEvmAddress}`);
        console.log(`  TX: ${sweepTx}`);
      } else {
        console.log("  No USDC to recover (already bridged or not yet funded).");
      }
    } catch (refundErr) {
      console.error(`  Could not recover funds: ${refundErr.message}`);
      console.error(`  Manual recovery: send USDC from ${newWalletEvmAddress} to ${funderEvmAddress}`);
    }
  }

  process.exit(1);
});
