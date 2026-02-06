#!/usr/bin/env node

/**
 * End-to-end test of the trustless agent-to-agent deployment flow.
 *
 * Uses the local wallet as "Agent A" — extracts its pubkey, calls the
 * trustless functions (as Agent B would), signs with the wallet key,
 * and broadcasts. Deploys a tiny nginx container, then closes it.
 */

import { toHex, fromHex } from "@cosmjs/encoding";

// Wallet (Agent A side)
import {
  getOrUnlockWallet,
  getDefaultWalletAddress,
  evmPubkeyToAkashAddress,
  verifyEvmPubkey,
} from "./dist/wallet/index.js";

// Trustless functions (Agent B side)
import {
  queryAccountInfo,
  constructUnsignedTx,
  broadcastSignedTx,
  constructCertificateMsg,
  constructDeploymentMsg,
  constructLeaseMsg,
  constructCloseMsg,
  constructAminoJwtSignDoc,
  assembleJwt,
} from "./dist/akash/trustless.js";

import {
  generateCertificateKeyPair,
  loadStoredCert,
  saveStoredCert,
  generateSDLYaml,
  calculateDeposit,
  getCurrentBlockHeight,
  queryBids,
  selectBestBid,
  queryProvider,
  mtlsFetch,
} from "./dist/akash/index.js";

import { SDL } from "@akashnetwork/chain-sdk";

// ─── Config ───
const NETWORK = "mainnet";
const SPECS = {
  cpu: 1,
  memory: "512Mi",
  storage: "1Gi",
  image: "nginx:latest",
  hours: 1,
  ports: [{ port: 80, protocol: "tcp", expose: true }],
};
const BID_WAIT_SEC = 60;

// ─── Helpers ───
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(step, msg) {
  console.log(`\n[${ step }] ${ msg }`);
}

// ─── Main ───
async function main() {
  // ──────────────────────────────────────────────────────
  // STEP 0: Unlock local wallet → get compressed pubkey
  // ──────────────────────────────────────────────────────
  log("0/10", "Unlocking local wallet...");
  const defaultAddr = getDefaultWalletAddress();
  if (!defaultAddr) throw new Error("No wallet found. Run `npx @agent-pay/mcp wallet create` first.");

  const { wallet, aminoWallet, evmAddress } = await getOrUnlockWallet(defaultAddr);
  const [account] = await wallet.getAccounts();
  const akashAddress = account.address;
  const compressedPubkey = account.pubkey; // Uint8Array, 33 bytes

  console.log(`  Akash:  ${akashAddress}`);
  console.log(`  EVM:    ${evmAddress}`);
  console.log(`  Pubkey: ${toHex(compressedPubkey).slice(0, 20)}...`);

  // ──────────────────────────────────────────────────────
  // STEP 1: derive_akash_address (verify cross-chain key)
  // ──────────────────────────────────────────────────────
  log("1/10", "Verifying cross-chain key derivation...");
  const derivedAddr = evmPubkeyToAkashAddress(compressedPubkey);
  const pubkeyMatch = verifyEvmPubkey(evmAddress, compressedPubkey);
  console.log(`  Derived Akash: ${derivedAddr}`);
  console.log(`  Matches local: ${derivedAddr === akashAddress ? "YES" : "NO (different derivation paths, expected)"}`);
  console.log(`  EVM pubkey OK: ${pubkeyMatch}`);

  // ──────────────────────────────────────────────────────
  // STEP 2: check_wallet (account info)
  // ──────────────────────────────────────────────────────
  log("2/10", "Querying account info...");
  const accountInfo = await queryAccountInfo(akashAddress, NETWORK);
  if (!accountInfo) throw new Error("Account not funded! Bridge first.");
  console.log(`  Account #${accountInfo.accountNumber}, sequence ${accountInfo.sequence}`);

  // ──────────────────────────────────────────────────────
  // STEP 3: prepare_certificate_tx → sign → broadcast
  // ──────────────────────────────────────────────────────
  log("3/10", "Ensuring mTLS certificate...");
  let cert = loadStoredCert(akashAddress);
  if (cert && cert.txHash !== "pending") {
    console.log("  Certificate already exists, skipping.");
  } else {
    console.log("  Generating new certificate...");
    const certPem = await generateCertificateKeyPair(akashAddress);

    // Store cert locally
    saveStoredCert(akashAddress, {
      cert: certPem.cert,
      publicKey: certPem.publicKey,
      privateKey: certPem.privateKey,
      createdAt: new Date().toISOString(),
      txHash: "pending",
    });

    // Construct unsigned cert TX
    const certMsg = constructCertificateMsg(akashAddress, certPem.cert, certPem.publicKey);
    const freshInfo = await queryAccountInfo(akashAddress, NETWORK);
    const unsignedCertTx = await constructUnsignedTx({
      messages: [certMsg],
      senderPubkey: compressedPubkey,
      accountNumber: freshInfo.accountNumber,
      sequence: freshInfo.sequence,
      network: NETWORK,
      memo: "mTLS cert via trustless test",
    });

    console.log(`  Gas: ${unsignedCertTx.gasLimit}, Fee: ${unsignedCertTx.fee.amount} uakt`);

    // Agent A signs via wallet.signDirect
    const certSigResult = await wallet.signDirect(akashAddress, {
      bodyBytes: fromHex(unsignedCertTx.bodyBytes),
      authInfoBytes: fromHex(unsignedCertTx.authInfoBytes),
      chainId: NETWORK === "mainnet" ? "akashnet-2" : "sandbox-01",
      accountNumber: BigInt(freshInfo.accountNumber),
    });
    const certSig = toHex(Buffer.from(certSigResult.signature.signature, "base64"));
    console.log(`  Signature: ${certSig.slice(0, 20)}... (${certSig.length / 2} bytes)`);

    // Broadcast
    const certResult = await broadcastSignedTx({
      bodyBytes: unsignedCertTx.bodyBytes,
      authInfoBytes: unsignedCertTx.authInfoBytes,
      signature: certSig,
      network: NETWORK,
    });

    if (certResult.code !== 0) {
      throw new Error(`Cert TX failed: code=${certResult.code} ${certResult.rawLog}`);
    }
    console.log(`  Cert TX: ${certResult.txHash} (code ${certResult.code})`);

    // Update stored cert with real txHash
    saveStoredCert(akashAddress, {
      ...loadStoredCert(akashAddress),
      txHash: certResult.txHash,
    });

    cert = loadStoredCert(akashAddress);
  }

  // ──────────────────────────────────────────────────────
  // STEP 4: prepare_deploy_tx → sign → broadcast
  // ──────────────────────────────────────────────────────
  log("4/10", "Creating deployment...");
  const sdlYaml = generateSDLYaml(SPECS);
  const sdl = SDL.fromString(sdlYaml, "beta3");
  const deposit = calculateDeposit(SPECS, SPECS.hours);
  const version = await sdl.manifestVersion();
  const sdlGroups = sdl.groups();

  const blockHeight = await getCurrentBlockHeight(NETWORK);
  const dseq = blockHeight.toString();
  console.log(`  DSEQ: ${dseq}`);
  console.log(`  Deposit: ${(parseInt(deposit.amount) / 1e6).toFixed(6)} AKT`);

  const deployMsg = constructDeploymentMsg(akashAddress, dseq, sdlGroups, version, deposit);
  const deployAcct = await queryAccountInfo(akashAddress, NETWORK);
  const unsignedDeployTx = await constructUnsignedTx({
    messages: [deployMsg],
    senderPubkey: compressedPubkey,
    accountNumber: deployAcct.accountNumber,
    sequence: deployAcct.sequence,
    network: NETWORK,
    memo: "Akash deploy via trustless test",
  });

  console.log(`  Gas: ${unsignedDeployTx.gasLimit}`);

  // Sign
  const deploySigResult = await wallet.signDirect(akashAddress, {
    bodyBytes: fromHex(unsignedDeployTx.bodyBytes),
    authInfoBytes: fromHex(unsignedDeployTx.authInfoBytes),
    chainId: NETWORK === "mainnet" ? "akashnet-2" : "sandbox-01",
    accountNumber: BigInt(deployAcct.accountNumber),
  });
  const deploySig = toHex(Buffer.from(deploySigResult.signature.signature, "base64"));

  // Broadcast
  const deployResult = await broadcastSignedTx({
    bodyBytes: unsignedDeployTx.bodyBytes,
    authInfoBytes: unsignedDeployTx.authInfoBytes,
    signature: deploySig,
    network: NETWORK,
  });

  if (deployResult.code !== 0) {
    throw new Error(`Deploy TX failed: code=${deployResult.code} ${deployResult.rawLog}`);
  }
  console.log(`  Deploy TX: ${deployResult.txHash} (gas used: ${deployResult.gasUsed})`);

  // ──────────────────────────────────────────────────────
  // STEP 5: query_bids (poll for bids)
  // ──────────────────────────────────────────────────────
  log("5/10", `Waiting for bids (up to ${BID_WAIT_SEC}s)...`);
  let selectedBid = null;
  const bidStart = Date.now();

  while (Date.now() - bidStart < BID_WAIT_SEC * 1000) {
    await sleep(5000);
    const bids = await queryBids(akashAddress, dseq, NETWORK);
    const open = bids.filter((b) => b.state === 1);
    const elapsed = Math.round((Date.now() - bidStart) / 1000);
    process.stdout.write(`\r  ${open.length} open bids (${elapsed}s)...`);
    if (open.length > 0) {
      selectedBid = selectBestBid(open);
      break;
    }
  }
  console.log();

  if (!selectedBid) {
    console.log("  No bids received. Closing deployment to refund...");
    await closeDeployment(wallet, akashAddress, compressedPubkey, dseq);
    return;
  }
  console.log(`  Selected: ${selectedBid.bidId.provider}`);
  console.log(`  Price: ${(parseInt(selectedBid.price.amount) / 1e6).toFixed(6)} AKT/block`);

  // ──────────────────────────────────────────────────────
  // STEP 6: prepare_lease_tx → sign → broadcast
  // ──────────────────────────────────────────────────────
  log("6/10", "Creating lease...");
  const leaseMsg = constructLeaseMsg({
    owner: akashAddress,
    dseq,
    gseq: selectedBid.bidId.gseq,
    oseq: selectedBid.bidId.oseq,
    provider: selectedBid.bidId.provider,
  });

  const leaseAcct = await queryAccountInfo(akashAddress, NETWORK);
  const unsignedLeaseTx = await constructUnsignedTx({
    messages: [leaseMsg],
    senderPubkey: compressedPubkey,
    accountNumber: leaseAcct.accountNumber,
    sequence: leaseAcct.sequence,
    network: NETWORK,
    memo: "Akash lease via trustless test",
  });

  const leaseSigResult = await wallet.signDirect(akashAddress, {
    bodyBytes: fromHex(unsignedLeaseTx.bodyBytes),
    authInfoBytes: fromHex(unsignedLeaseTx.authInfoBytes),
    chainId: NETWORK === "mainnet" ? "akashnet-2" : "sandbox-01",
    accountNumber: BigInt(leaseAcct.accountNumber),
  });
  const leaseSig = toHex(Buffer.from(leaseSigResult.signature.signature, "base64"));

  const leaseResult = await broadcastSignedTx({
    bodyBytes: unsignedLeaseTx.bodyBytes,
    authInfoBytes: unsignedLeaseTx.authInfoBytes,
    signature: leaseSig,
    network: NETWORK,
  });

  if (leaseResult.code !== 0) {
    throw new Error(`Lease TX failed: code=${leaseResult.code} ${leaseResult.rawLog}`);
  }
  console.log(`  Lease TX: ${leaseResult.txHash} (gas used: ${leaseResult.gasUsed})`);

  // ──────────────────────────────────────────────────────
  // STEP 7: prepare_jwt_sign_doc → sign → assemble JWT
  // ──────────────────────────────────────────────────────
  log("7/10", "Creating JWT for provider auth...");

  const jwtDoc = constructAminoJwtSignDoc(akashAddress);
  console.log(`  Sign doc length: ${jwtDoc.signDocCanonicalJson.length} chars`);

  // Sign the amino sign doc using the amino wallet from getOrUnlockWallet
  const [aminoAccount] = await aminoWallet.getAccounts();
  const aminoSignDoc = JSON.parse(jwtDoc.signDocCanonicalJson);
  const aminoSigResult = await aminoWallet.signAmino(aminoAccount.address, aminoSignDoc);
  const jwtSigBytes = Buffer.from(aminoSigResult.signature.signature, "base64");

  const jwt = assembleJwt(
    jwtDoc.jwtHeader,
    jwtDoc.jwtPayload,
    toHex(jwtSigBytes),
    compressedPubkey
  );
  console.log(`  JWT assembled: ${jwt.slice(0, 40)}...`);

  // ──────────────────────────────────────────────────────
  // STEP 8: send_manifest
  // ──────────────────────────────────────────────────────
  log("8/10", "Sending manifest to provider...");
  const providerInfo = await queryProvider(selectedBid.bidId.provider, NETWORK);
  const providerHost = providerInfo?.provider?.host_uri;
  console.log(`  Provider host: ${providerHost}`);

  const manifestJson = sdl.manifestSortedJSON();
  const manifestUrl = `${providerHost}/deployment/${dseq}/manifest`;

  let manifestSent = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const resp = await mtlsFetch(manifestUrl, cert, jwt, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: manifestJson,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`${resp.status}: ${errText}`);
      }
      console.log(`  Manifest sent (attempt ${attempt})`);
      manifestSent = true;
      break;
    } catch (e) {
      console.log(`  Attempt ${attempt}/5 failed: ${e.message}`);
      if (attempt < 5) await sleep(3000);
    }
  }

  if (!manifestSent) {
    console.log("  Manifest failed. Closing deployment...");
    await closeDeployment(wallet, akashAddress, compressedPubkey, dseq);
    return;
  }

  // ──────────────────────────────────────────────────────
  // STEP 9: Get endpoints
  // ──────────────────────────────────────────────────────
  log("9/10", "Checking endpoints...");
  await sleep(3000); // Give container time to start

  try {
    const statusUrl = `${providerHost}/lease/${dseq}/${selectedBid.bidId.gseq}/${selectedBid.bidId.oseq}/status`;
    const statusResp = await mtlsFetch(statusUrl, cert, jwt);
    if (statusResp.ok) {
      const status = await statusResp.json();
      if (status.forwarded_ports) {
        for (const [svc, ports] of Object.entries(status.forwarded_ports)) {
          for (const p of ports) {
            const host = p.host || providerHost.replace(/^https?:\/\//, "");
            console.log(`  ${p.proto || "tcp"}://${host}:${p.externalPort}`);
          }
        }
      }
    }
  } catch {
    console.log("  Endpoints not ready yet");
  }

  // ──────────────────────────────────────────────────────
  // STEP 10: Close deployment (clean up)
  // ──────────────────────────────────────────────────────
  log("10/10", "Closing deployment (refunding deposit)...");
  await closeDeployment(wallet, akashAddress, compressedPubkey, dseq);

  console.log("\nFull trustless flow completed successfully!");
}

async function closeDeployment(wallet, akashAddress, compressedPubkey, dseq) {
  const closeMsg = constructCloseMsg(akashAddress, dseq);
  const closeAcct = await queryAccountInfo(akashAddress, NETWORK);
  const unsignedCloseTx = await constructUnsignedTx({
    messages: [closeMsg],
    senderPubkey: compressedPubkey,
    accountNumber: closeAcct.accountNumber,
    sequence: closeAcct.sequence,
    network: NETWORK,
    memo: "Close via trustless test",
  });

  const closeSigResult = await wallet.signDirect(akashAddress, {
    bodyBytes: fromHex(unsignedCloseTx.bodyBytes),
    authInfoBytes: fromHex(unsignedCloseTx.authInfoBytes),
    chainId: NETWORK === "mainnet" ? "akashnet-2" : "sandbox-01",
    accountNumber: BigInt(closeAcct.accountNumber),
  });
  const closeSig = toHex(Buffer.from(closeSigResult.signature.signature, "base64"));

  const closeResult = await broadcastSignedTx({
    bodyBytes: unsignedCloseTx.bodyBytes,
    authInfoBytes: unsignedCloseTx.authInfoBytes,
    signature: closeSig,
    network: NETWORK,
  });

  if (closeResult.code !== 0) {
    console.log(`  Close failed: code=${closeResult.code} ${closeResult.rawLog}`);
  } else {
    console.log(`  Close TX: ${closeResult.txHash} (deposit refunded)`);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
