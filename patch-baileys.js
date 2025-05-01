// Script to patch @whiskeysockets/baileys crypto module
const fs = require('fs');
const path = require('path');

const cryptoJsPath = path.join(__dirname, 'node_modules/@whiskeysockets/baileys/lib/Utils/crypto.js');
const noiseHandlerPath = path.join(__dirname, 'node_modules/@whiskeysockets/baileys/lib/Utils/noise-handler.js');

console.log('Patching Baileys crypto module...');

// Read the original file
try {
  // Fix crypto.js first
  let cryptoContent = fs.readFileSync(cryptoJsPath, 'utf8');
  
  // Add explicit crypto require at the top
  if (!cryptoContent.includes('const crypto = require("crypto");')) {
    cryptoContent = `const crypto = require("crypto");\n${cryptoContent}`;
    fs.writeFileSync(cryptoJsPath, cryptoContent);
    console.log('Successfully patched crypto.js');
  } else {
    console.log('crypto.js already patched');
  }

  // Fix noise-handler.js
  let noiseContent = fs.readFileSync(noiseHandlerPath, 'utf8');
  
  // Add explicit crypto require at the top
  if (!noiseContent.includes('const crypto = require("crypto");')) {
    noiseContent = `const crypto = require("crypto");\n${noiseContent}`;
    fs.writeFileSync(noiseHandlerPath, noiseContent);
    console.log('Successfully patched noise-handler.js');
  } else {
    console.log('noise-handler.js already patched');
  }

  console.log('All patches applied successfully!');
} catch (err) {
  console.error('Failed to patch Baileys:', err);
  process.exit(1);
} 