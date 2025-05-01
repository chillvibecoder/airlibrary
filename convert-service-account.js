const fs = require('fs');
const path = require('path');

// Read the service account JSON file
const serviceAccountPath = path.join(__dirname, 'service-account.json');
const serviceAccountJson = fs.readFileSync(serviceAccountPath, 'utf8');

// Convert to base64
const base64 = Buffer.from(serviceAccountJson).toString('base64');

// Update the .env file
const envPath = path.join(__dirname, '.env');
let envContent = fs.readFileSync(envPath, 'utf8');

// Replace the GOOGLE_SERVICE_ACCOUNT value
envContent = envContent.replace(
    /GOOGLE_SERVICE_ACCOUNT=.*/,
    `GOOGLE_SERVICE_ACCOUNT=${base64}`
);

fs.writeFileSync(envPath, envContent);

console.log('Service account converted to base64 and .env file updated'); 