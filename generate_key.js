// generate_key.js
import crypto from "crypto";

function generateApiKey() {
  return crypto.randomBytes(32).toString("hex");
}

const key = generateApiKey();
console.log("Generated API key (save this safely):");
console.log(key);
