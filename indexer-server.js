// index.js - Universal NFT Indexer for MegaETH (Batch Optimized)

import express from "express";
import fetch from "node-fetch";
import { ethers } from "ethers";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Configurable ENV variables
const MEGAETH_RPC = process.env.MEGAETH_RPC || "https://rpc.megaeth.network"; // Replace if needed
const START_BLOCK = parseInt(process.env.START_BLOCK || "1"); // First block to scan
const BLOCK_BATCH_SIZE = parseInt(process.env.BLOCK_BATCH_SIZE || "200"); // Keep small to avoid memory crash

// Initialize provider
const provider = new ethers.JsonRpcProvider(MEGAETH_RPC);

// Function to fetch NFT metadata for a given contract
async function fetchNFTMetadata(contractAddress, tokenId) {
  try {
    const abi = [
      "function tokenURI(uint256 tokenId) view returns (string memory)",
    ];
    const contract = new ethers.Contract(contractAddress, abi, provider);
    const uri = await contract.tokenURI(tokenId);

    let metadataUrl = uri;
    if (uri.startsWith("ipfs://")) {
      metadataUrl = uri.replace("ipfs://", "https://ipfs.io/ipfs/");
    }

    const res = await fetch(metadataUrl);
    if (!res.ok) throw new Error(`Failed to fetch metadata: ${metadataUrl}`);
    return await res.json();
  } catch (err) {
    console.error(`Error fetching metadata for ${contractAddress} #${tokenId}:`, err.message);
    return null;
  }
}

// Batch scanning blocks for NFT transfers
async function scanBlocksInBatches() {
  let latestBlock = await provider.getBlockNumber();
  console.log(`🔍 Latest Block on MegaETH: ${latestBlock}`);

  for (let fromBlock = START_BLOCK; fromBlock <= latestBlock; fromBlock += BLOCK_BATCH_SIZE) {
    let toBlock = Math.min(fromBlock + BLOCK_BATCH_SIZE - 1, latestBlock);
    console.log(`📦 Scanning blocks ${fromBlock} to ${toBlock}...`);

    try {
      const logs = await provider.getLogs({
        fromBlock,
        toBlock,
        topics: [
          ethers.id("Transfer(address,address,uint256)"), // ERC-721 Transfer event
        ],
      });

      for (const log of logs) {
        const contractAddress = log.address;
        const tokenId = ethers.getBigInt(log.topics[3]).toString();

        console.log(`📌 Found NFT Transfer: ${contractAddress} Token #${tokenId}`);

        const metadata = await fetchNFTMetadata(contractAddress, tokenId);
        if (metadata) {
          console.log(`✅ ${metadata.name || "Unnamed NFT"} - ${metadata.description || ""}`);
        }
      }
    } catch (err) {
      console.error(`⚠️ Error scanning block range ${fromBlock}-${toBlock}:`, err.message);
    }
  }
}

app.get("/", async (req, res) => {
  res.send("Universal NFT Indexer is running ✅");
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await scanBlocksInBatches();
});
