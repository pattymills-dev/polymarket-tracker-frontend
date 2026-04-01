/**
 * derive-api-key.mjs
 *
 * One-time script to derive Polymarket CLOB API credentials from your wallet private key.
 * Run this locally ONCE, then store the output as GitHub Secrets:
 *   POLYMARKET_API_KEY
 *   POLYMARKET_API_SECRET
 *   POLYMARKET_API_PASSPHRASE
 *
 * Usage:
 *   cd .github/scripts/live-trading && npm install
 *   POLYMARKET_PK=<your_private_key> node derive-api-key.mjs
 */

import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

async function main() {
  if (!process.env.POLYMARKET_PK) {
    console.error("Set POLYMARKET_PK environment variable");
    process.exit(1);
  }

  const pk = process.env.POLYMARKET_PK.startsWith("0x")
    ? process.env.POLYMARKET_PK
    : `0x${process.env.POLYMARKET_PK}`;

  const wallet = new ethers.Wallet(pk);
  console.log(`Wallet address: ${wallet.address}`);
  console.log("Deriving API credentials...");

  // L1 auth only for key derivation
  const clob = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
  const creds = await clob.createOrDeriveApiKey();

  console.log("\n✅ API credentials derived. Add these as GitHub Secrets:\n");
  console.log(`POLYMARKET_API_KEY=${creds.ApiKey ?? creds.key ?? creds.apiKey}`);
  console.log(`POLYMARKET_API_SECRET=${creds.Secret ?? creds.secret}`);
  console.log(`POLYMARKET_API_PASSPHRASE=${creds.PassPhrase ?? creds.passphrase}`);
  console.log("\nKeep these private — they control your trading wallet.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
