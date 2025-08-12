require("dotenv").config();
const { ethers } = require("ethers");

// =================== CONFIG ===================
const RPC_URL = process.env.RPC_URL;
const START_BLOCK = parseInt(process.env.START_BLOCK || "0");
const BATCH_SIZE = 100; // Max 100 blocks at a time
const MAX_RETRIES = 5; // Retry attempts for each batch
const RETRY_DELAY = 3000; // Delay between retries in ms
const TARGET_CONTRACTS = process.env.TARGET_CONTRACTS
  ? process.env.TARGET_CONTRACTS.split(",").map(c => c.toLowerCase())
  : [];

// =================== PROVIDER ===================
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Track last processed block
let lastProcessedBlock = START_BLOCK;

// Helper: delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Process events in a given block range
async function processBatch(fromBlock, toBlock) {
  console.log(`🔍 Scanning blocks ${fromBlock} → ${toBlock} ...`);

  const logs = await provider.getLogs({
    fromBlock,
    toBlock
  });

  for (const log of logs) {
    const address = log.address.toLowerCase();
    if (TARGET_CONTRACTS.length === 0 || TARGET_CONTRACTS.includes(address)) {
      console.log(`📦 Found event in ${address} @ block ${log.blockNumber}`);
      // Here you could decode and save NFT transfer/mint/burn events
    }
  }
}

// Retry wrapper
async function processBatchWithRetry(fromBlock, toBlock) {
  let attempts = 0;
  while (attempts < MAX_RETRIES) {
    try {
      await processBatch(fromBlock, toBlock);
      return; // Success → exit retry loop
    } catch (err) {
      attempts++;
      console.warn(
        `⚠️ Batch ${fromBlock} → ${toBlock} failed (Attempt ${attempts}/${MAX_RETRIES}): ${err.message}`
      );
      if (attempts < MAX_RETRIES) {
        console.log(`⏳ Retrying in ${RETRY_DELAY / 1000}s...`);
        await sleep(RETRY_DELAY);
      } else {
        throw new Error(`❌ Failed after ${MAX_RETRIES} retries`);
      }
    }
  }
}

// Main loop
async function main() {
  const latestBlock = await provider.getBlockNumber();
  console.log(`📢 Latest block: ${latestBlock}`);

  while (lastProcessedBlock <= latestBlock) {
    const fromBlock = lastProcessedBlock;
    const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, latestBlock);

    await processBatchWithRetry(fromBlock, toBlock);

    lastProcessedBlock = toBlock + 1;
    console.log(`✅ Finished batch up to block ${toBlock}\n`);
  }

  console.log("🎉 Indexing complete!");
}

// Start indexing
main().catch(err => {
  console.error("Fatal error:", err);
});
