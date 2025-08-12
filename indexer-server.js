import express from "express";
import dotenv from "dotenv";
import Web3 from "web3";
import fetch from "node-fetch";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Load your API key from env
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_API_KEY) {
  console.error("❌ Missing ALCHEMY_API_KEY in environment variables.");
  process.exit(1);
}

const web3 = new Web3(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`);

// Example: Load contract addresses to scan
const contracts = [
  // Put your NFT contract addresses here
  "0x1234567890abcdef1234567890abcdef12345678",
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  // ...
];

// Scan contracts in small batches to prevent memory overload
async function scanContracts(batchSize = 2) {
  console.log(`🔍 Starting batch scan with batch size ${batchSize}...`);

  for (let i = 0; i < contracts.length; i += batchSize) {
    const batch = contracts.slice(i, i + batchSize);
    console.log(`📦 Processing batch: ${batch.join(", ")}`);

    const promises = batch.map(async (address) => {
      try {
        const code = await web3.eth.getCode(address);
        if (code && code !== "0x") {
          console.log(`✅ Contract ${address} is active.`);
          // You can add token scanning logic here
        } else {
          console.log(`⚠️ ${address} is not a contract.`);
        }
      } catch (err) {
        console.error(`❌ Error scanning ${address}:`, err.message);
      }
    });

    await Promise.all(promises);
    console.log("⏳ Waiting before next batch...");
    await new Promise((res) => setTimeout(res, 3000)); // Pause 3s between batches
  }

  console.log("✅ All contracts scanned.");
}

app.get("/", (req, res) => {
  res.send("Universal NFT Indexer is running.");
});

app.get("/scan", async (req, res) => {
  await scanContracts(2);
  res.send("Scanning completed.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
