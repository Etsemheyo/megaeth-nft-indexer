// indexer-server.js
/**
 * Universal MegaETH NFT Indexer (lightweight)
 *
 * Environment variables:
 *   RPC_URL         (optional, default used if not set)
 *   START_BLOCK     (block number to start initial scan from; default 0)
 *   BATCH_SIZE      (how many blocks to scan per iteration, default 2000)
 *   API_KEY         (required for API access)
 *   DB_FILE         (optional, default ./nft_db.json)
 *   PORT            (optional, default 3000)
 *
 * Notes:
 *  - This is lightweight and stores a JSON DB file (good for test/dev). For production use a real DB.
 *  - Must be run continuously (Render will run it for you).
 *  - It listens for Transfer logs and updates ownership mapping.
 */

import express from "express";
import fs from "fs";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://carrot.megaeth.com/rpc";
const START_BLOCK = Number(process.env.START_BLOCK || 0);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 2000);
const DB_FILE = process.env.DB_FILE || "./nft_db.json";
const API_KEY = process.env.API_KEY || "";
const PORT = Number(process.env.PORT || 3000);

if (!API_KEY) {
  console.warn("Warning: API_KEY not set. Set it as an environment variable for secure access.");
}

// Provider
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ABIs for parsing events and metadata calls
const ABI_EVENTS = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
];

const ABI_METADATA = [
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function uri(uint256 tokenId) view returns (string)"
];

const ifaceEvents = new ethers.Interface(ABI_EVENTS);

// Load or init DB
let db = { lastScannedBlock: START_BLOCK, tokens: {} }; // tokens: { "<contract>": { "<tokenId>": { owner, metadataUrl, name, image, metadataFetched } } }

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      db = JSON.parse(raw);
      console.log("Loaded DB:", Object.keys(db.tokens).length, "contracts");
    }
  } catch (e) {
    console.error("Failed to load DB, starting fresh:", e.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("Failed to save DB:", e.message);
  }
}

// Utility: make IPFS gateway URL
function resolveIpfs(url) {
  if (!url) return url;
  if (url.startsWith("ipfs://")) return url.replace("ipfs://", "https://ipfs.io/ipfs/");
  // sometimes metadata has ipfs://ipfs/Qm...
  if (url.startsWith("ipfs/")) return "https://ipfs.io/" + url;
  return url;
}

// Try to fetch metadata (tokenURI or uri). Cache result to avoid repeat HTTP calls.
async function fetchAndStoreMetadata(contractAddress, tokenId) {
  try {
    // Avoid re-fetch if already fetched
    const contractMap = db.tokens[contractAddress] || {};
    const info = contractMap[tokenId];
    if (info && info.metadataFetched) return info; // already fetched

    const contract = new ethers.Contract(contractAddress, ABI_METADATA, provider);

    // try tokenURI then uri
    let uri = null;
    try {
      uri = await contract.tokenURI(tokenId);
    } catch (e) {
      // fallback to uri() (ERC1155)
      try { uri = await contract.uri(tokenId); } catch (e2) { uri = null; }
    }

    if (!uri) {
      // no metadata URL available
      const fallback = { name: `Token #${tokenId}`, image: null, metadataUrl: null, metadataFetched: true, tokenId };
      db.tokens[contractAddress] = db.tokens[contractAddress] || {};
      db.tokens[contractAddress][tokenId] = { ...(db.tokens[contractAddress][tokenId] || {}), ...fallback };
      saveDB();
      return fallback;
    }

    const resolvedUri = resolveIpfs(uri);
    let json = null;
    try {
      const res = await axios.get(resolvedUri, { timeout: 10000 });
      json = res.data;
    } catch (e) {
      // try secondary ipfs gateway if initial failed
      if (resolvedUri.includes("ipfs.io")) {
        const alt = resolvedUri.replace("ipfs.io", "cloudflare-ipfs.com");
        try {
          const r2 = await axios.get(alt, { timeout: 10000 });
          json = r2.data;
        } catch (e2) {
          json = null;
        }
      }
    }

    const name = json?.name || `Token #${tokenId}`;
    let image = json?.image || json?.image_url || null;
    if (image) image = resolveIpfs(image);

    db.tokens[contractAddress] = db.tokens[contractAddress] || {};
    db.tokens[contractAddress][tokenId] = {
      ...(db.tokens[contractAddress][tokenId] || {}),
      owner: db.tokens[contractAddress]?.[tokenId]?.owner || null,
      metadataUrl: resolvedUri,
      name,
      image,
      metadataFetched: true,
      tokenId
    };

    saveDB();
    return db.tokens[contractAddress][tokenId];
  } catch (err) {
    console.warn("metadata fetch error", contractAddress, tokenId, err.message || err);
    db.tokens[contractAddress] = db.tokens[contractAddress] || {};
    db.tokens[contractAddress][tokenId] = { ...(db.tokens[contractAddress][tokenId] || {}), name: `Token #${tokenId}`, image: null, metadataFetched: true, tokenId };
    saveDB();
    return db.tokens[contractAddress][tokenId];
  }
}

// Parse logs and update db
async function processLogs(fromBlock, toBlock) {
  if (fromBlock > toBlock) return;
  console.log(`Scanning blocks ${fromBlock} → ${toBlock} ...`);
  // topics: we want any of the three event signatures as topic0
  const topics = [[
    ethers.id("Transfer(address,address,uint256)"),
    ethers.id("TransferSingle(address,address,address,uint256,uint256)"),
    ethers.id("TransferBatch(address,address,address,uint256[],uint256[])")
  ]];

  const filter = {
    fromBlock,
    toBlock,
    topics
  };

  let logs;
  try {
    logs = await provider.getLogs(filter);
  } catch (err) {
    console.error("getLogs failed:", err.message || err);
    return;
  }

  console.log("Found logs:", logs.length);
  for (const log of logs) {
    try {
      const topic0 = log.topics[0];
      const contractAddress = log.address.toLowerCase();

      // Determine event type by topic0
      const transferSig = ethers.id("Transfer(address,address,uint256)");
      const tSingleSig = ethers.id("TransferSingle(address,address,address,uint256,uint256)");
      const tBatchSig = ethers.id("TransferBatch(address,address,address,uint256[],uint256[])");

      if (topic0 === transferSig) {
        // ERC-721 Transfer indexed all 3 args => tokenId in topics[3]
        const from = ethers.getAddress(ethers.hexZeroPad(ethers.hexStripZeros(log.topics[1]), 20)).toLowerCase();
        const to = ethers.getAddress(ethers.hexZeroPad(ethers.hexStripZeros(log.topics[2]), 20)).toLowerCase();
        const tokenId = ethers.toBigInt(log.topics[3]).toString();

        // update DB owner
        db.tokens[contractAddress] = db.tokens[contractAddress] || {};
        db.tokens[contractAddress][tokenId] = { ...(db.tokens[contractAddress][tokenId] || {}), owner: to, tokenId };

        // fetch metadata in background (don't block)
        fetchAndStoreMetadata(contractAddress, tokenId).catch(() => {});

        // remove from previous owner if tracked
        // we will just rely on current owner field for lookups

      } else if (topic0 === tSingleSig) {
        // TransferSingle: data contains id and value; topics[2]=from, topics[3]=to
        const parsed = ifaceEvents.parseLog(log);
        const from = parsed.args.from.toLowerCase();
        const to = parsed.args.to.toLowerCase();
        const tokenId = parsed.args.id.toString();

        db.tokens[contractAddress] = db.tokens[contractAddress] || {};
        db.tokens[contractAddress][tokenId] = { ...(db.tokens[contractAddress][tokenId] || {}), owner: to, tokenId };
        fetchAndStoreMetadata(contractAddress, tokenId).catch(() => {});

      } else if (topic0 === tBatchSig) {
        // TransferBatch: ids array in data
        const parsed = ifaceEvents.parseLog(log);
        const from = parsed.args.from.toLowerCase();
        const to = parsed.args.to.toLowerCase();
        const ids = parsed.args.ids;
        for (let i = 0; i < ids.length; i++) {
          const tokenId = ids[i].toString();
          db.tokens[contractAddress] = db.tokens[contractAddress] || {};
          db.tokens[contractAddress][tokenId] = { ...(db.tokens[contractAddress][tokenId] || {}), owner: to, tokenId };
          fetchAndStoreMetadata(contractAddress, tokenId).catch(() => {});
        }
      } else {
        // unknown event
      }

    } catch (e) {
      console.warn("Error parsing log:", e.message || e);
    }
  }

  db.lastScannedBlock = toBlock;
  saveDB();
}

// Scanning loop: fill gaps then watch new blocks
let scanning = false;
async function scanLoop() {
  if (scanning) return;
  scanning = true;
  try {
    const latestBlock = await provider.getBlockNumber();
    let from = (db.lastScannedBlock && db.lastScannedBlock > 0) ? db.lastScannedBlock + 1 : START_BLOCK;
    if (from < START_BLOCK) from = START_BLOCK;

    while (from <= latestBlock) {
      const to = Math.min(from + BATCH_SIZE - 1, latestBlock);
      await processLogs(from, to);
      from = to + 1;
    }
  } catch (e) {
    console.error("scanLoop error", e.message || e);
  } finally {
    scanning = false;
  }
}

// Start realtime listener (subscribe to new logs)
function startRealtimeListener() {
  console.log("Starting realtime listener for new blocks...");
  // Using block event to rescan the most recent range regularly
  provider.on("block", async (blockNumber) => {
    try {
      // scan from lastScannedBlock+1 to current block
      const from = (db.lastScannedBlock && db.lastScannedBlock > 0) ? db.lastScannedBlock + 1 : blockNumber;
      const to = blockNumber;
      if (from <= to) {
        await processLogs(from, to);
      }
    } catch (e) {
      console.error("Realtime handler error:", e.message || e);
    }
  });
}

// API: return NFTs owned by an address
function gatherByOwner(ownerAddress) {
  const out = [];
  const owner = ownerAddress.toLowerCase();
  for (const contract of Object.keys(db.tokens)) {
    for (const tokenId of Object.keys(db.tokens[contract])) {
      const info = db.tokens[contract][tokenId];
      if (info.owner && info.owner.toLowerCase() === owner) {
        out.push({
          contract,
          tokenId,
          name: info.name || `Token #${tokenId}`,
          image: info.image || null,
          metadataUrl: info.metadataUrl || null
        });
      }
    }
  }
  return out;
}

// Express server & routes
const app = express();
app.use(cors());

app.get("/health", (req, res) => {
  res.json({ status: "ok", lastScannedBlock: db.lastScannedBlock || null });
});

app.get("/nfts/:address", (req, res) => {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: "missing or invalid api key" });
  }

  const address = req.params.address;
  if (!ethers.isAddress(address)) return res.status(400).json({ error: "invalid address" });

  const nfts = gatherByOwner(address);
  res.json({ address, count: nfts.length, nfts });
});

// Start server + indexer
loadDB();
app.listen(PORT, async () => {
  console.log(`NFT indexer listening on port ${PORT}`);
  // initial scan loop
  await scanLoop();
  startRealtimeListener();
});
