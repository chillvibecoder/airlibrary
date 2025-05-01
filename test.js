require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { v4: uuidv4 } = require('uuid');

// Initialize Google APIs
const serviceAccount = require('./service-account.json');
const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

// Constants
const TEST_ISBN = '9784634590649'; // もういちど読む山川日本史
const MASTER_SHEET_ID = '1ul3-t3GyJdt5k1--AaSEVPmFZja4BmcvhETeTUqaNvM';
const SERVICE_ACCOUNT_EMAIL = 'airlibraryserviceaccount@calm-aegis-452408-u7.iam.gserviceaccount.com';
const ADMIN_EMAIL = 'mansonwong.consulting@gmail.com';

// Test master sheet access and get sheet names
async function testMasterSheetAccess() {
    console.log('\n=== Testing Master Sheet Access ===');
    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: MASTER_SHEET_ID
        });
        console.log('Master sheet title:', response.data.properties.title);
        
        // Get all sheet names
        const sheetNames = response.data.sheets.map(sheet => sheet.properties.title);
        console.log('Available sheets:', sheetNames);
        
        // Try to read from Books sheet
        const booksData = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: 'Books!A1'
        });
        console.log('Books sheet header:', booksData.data.values?.[0]?.[0]);
        
        console.log('Master sheet access: Success');
        return true;
    } catch (error) {
        console.error('Master sheet access error:', error.message);
        if (error.response) {
            console.error('Error details:', error.response.data);
        }
        return false;
    }
}

// Test Google Books API
async function testGoogleBooksAPI() {
    console.log('\n=== Testing Google Books API ===');
    try {
        const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${TEST_ISBN}`);
        if (response.data.items && response.data.items.length > 0) {
            const bookData = response.data.items[0].volumeInfo;
            console.log('Book details:', {
                title: bookData.title,
                author: bookData.authors?.[0],
                publisher: bookData.publisher,
                publishedDate: bookData.publishedDate
            });
            return bookData;
        }
        console.log('No book found for ISBN:', TEST_ISBN);
        return null;
    } catch (error) {
        console.error('Google Books API error:', error);
        return null;
    }
}

// Test sheet creation
async function testSheetCreation() {
    console.log('\n=== Testing Sheet Creation ===');
    try {
        // Create a new test sheet
        const newSheet = await sheets.spreadsheets.create({
            requestBody: {
                properties: {
                    title: 'Test User Sheet'
                }
            }
        });
        console.log('Created new test sheet:', newSheet.data.spreadsheetId);

        // Get headers from master sheet
        const masterHeaders = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: 'Books!A1:V1'
        });

        // Add headers to new sheet
        await sheets.spreadsheets.values.update({
            spreadsheetId: newSheet.data.spreadsheetId,
            range: 'A1',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: masterHeaders.data.values
            }
        });
        console.log('Added headers from master sheet');

        // Get data from master sheet
        const masterData = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: 'Books!A2:V1000'
        });

        // Filter for test user's books (using a test user number)
        const testUserNumber = '85292853890'; // Using existing test user number
        const userBooks = masterData.data.values.filter(row => row[1] === testUserNumber);

        // Update new sheet with filtered data
        if (userBooks.length > 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: newSheet.data.spreadsheetId,
                range: 'A2',
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: userBooks
                }
            });
            console.log('Added filtered data from master sheet');
        } else {
            console.log('No books found for test user');
        }

        // Share with admin
        await drive.permissions.create({
            fileId: newSheet.data.spreadsheetId,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: ADMIN_EMAIL
            }
        });
        console.log('Shared sheet with admin');

        return newSheet.data.spreadsheetId;
    } catch (error) {
        console.error('Error in testSheetCreation:', error);
        throw error;
    }
}

// Test sheet sharing
async function testSheetSharing(sheetId) {
    console.log('\n=== Testing Sheet Sharing ===');
    try {
        // Share with admin email
        await drive.permissions.create({
            fileId: sheetId,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: ADMIN_EMAIL
            }
        });
        
        console.log('Shared sheet with admin');
        return true;
    } catch (error) {
        console.error('Sheet sharing error:', error);
        return false;
    }
}

// Main test function
async function runTests() {
    console.log('Starting tests...');
    
    // First test master sheet access
    const masterAccess = await testMasterSheetAccess();
    if (!masterAccess) {
        console.log('Cannot access master sheet, stopping tests');
        return;
    }
    
    // Test Google Books API
    const bookData = await testGoogleBooksAPI();
    if (!bookData) {
        console.log('Google Books API lookup failed, stopping tests');
        return;
    }
    
    // Test sheet creation
    const sheetId = await testSheetCreation();
    if (!sheetId) {
        console.log('Sheet creation failed, stopping tests');
        return;
    }
    
    // Test sheet sharing
    const sharingSuccess = await testSheetSharing(sheetId);
    if (!sharingSuccess) {
        console.log('Sheet sharing failed');
    }
    
    console.log('\n=== Test Summary ===');
    console.log('Master Sheet Access:', masterAccess ? 'Success' : 'Failed');
    console.log('Google Books API:', bookData ? 'Success' : 'Failed');
    console.log('Sheet Creation:', sheetId ? 'Success' : 'Failed');
    console.log('Sheet Sharing:', sharingSuccess ? 'Success' : 'Failed');
}

// Run the tests
runTests().catch(console.error);

async function startWhatsApp() {
    try {
        // Create auth folder if it doesn't exist
        const fs = require('fs');
        if (!fs.existsSync('auth_info')) {
            fs.mkdirSync('auth_info');
        }

        // Get auth state
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        console.log('Auth state loaded');

        // Create WhatsApp connection
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['Chrome', 'Desktop', '1.0.0'],
            generateHighQualityLinkPreview: true,
        });
        console.log('Socket created');

        // Handle auth updates
        sock.ev.on('creds.update', saveCreds);

        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n=== QR CODE RECEIVED ===\n');
                require('qrcode-terminal').generate(qr, { small: true });
                console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed due to:', lastDisconnect.error);
                if (shouldReconnect) {
                    startWhatsApp();
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connection opened!');
            }
        });

        // Handle messages
        sock.ev.on('messages.upsert', async (m) => {
            console.log('Got message:', m);
        });

    } catch (err) {
        console.error('Error in WhatsApp connection:', err);
    }
}

// Start WhatsApp
startWhatsApp(); 