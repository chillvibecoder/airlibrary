// Polyfill for crypto to work with baileys in serverless environments
const crypto = require('crypto');

// Ensure crypto is globally available
if (!global.crypto) {
    global.crypto = crypto;
}

// Export crypto to be required elsewhere
module.exports = crypto; 