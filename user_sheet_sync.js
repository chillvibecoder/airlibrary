const { google } = require('googleapis');
const fs = require('fs');

// Load credentials
const credentials = JSON.parse(fs.readFileSync('./service-account.json'));

// Initialize Google Sheets API
const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

// Store user sheet IDs
const userSheetIds = new Map();

// Master Sheet ID
const MASTER_SHEET_ID = '1ul3-t3GyJdt5k1--AaSEVPmFZja4BmcvhETeTUqaNvM';

async function getMasterSheetStructure() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: 'Books!A1:Z1'  // Get header row
        });

        if (!response.data.values || response.data.values.length === 0) {
            throw new Error('Could not get master sheet structure');
        }

        return response.data.values[0];
    } catch (error) {
        console.error('Error getting master sheet structure:', error);
        throw error;
    }
}

async function createUserSheet(phoneNumber, userEmail) {
    try {
        // Check if user sheet already exists
        if (userSheetIds.has(phoneNumber)) {
            return {
                success: true,
                spreadsheetId: userSheetIds.get(phoneNumber),
                spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${userSheetIds.get(phoneNumber)}`
            };
        }

        // Get master sheet structure
        const headers = await getMasterSheetStructure();

        // Create new spreadsheet
        const spreadsheet = await sheets.spreadsheets.create({
            requestBody: {
                properties: {
                    title: `BOOKDB_${phoneNumber}`
                },
                sheets: [
                    {
                        properties: {
                            title: 'Books',
                            gridProperties: {
                                rowCount: 1000,
                                columnCount: headers.length
                            }
                        }
                    }
                ]
            }
        });

        const spreadsheetId = spreadsheet.data.spreadsheetId;
        userSheetIds.set(phoneNumber, spreadsheetId);

        // Set up header row with same structure as master sheet
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Books!A1:${String.fromCharCode(65 + headers.length - 1)}1`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [headers]
            }
        });

        // Share with user
        await drive.permissions.create({
            fileId: spreadsheetId,
            requestBody: {
                role: 'reader',
                type: 'user',
                emailAddress: userEmail
            }
        });

        return {
            success: true,
            spreadsheetId,
            spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        };
    } catch (error) {
        console.error('Error creating user sheet:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function syncToUserSheet(phoneNumber, bookData) {
    try {
        const spreadsheetId = userSheetIds.get(phoneNumber);
        if (!spreadsheetId) {
            throw new Error('User sheet not found');
        }

        // Get current data
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Books!A:Z'  // Get all columns
        });

        const rows = response.data.values || [];
        const nextRow = rows.length + 1;

        // Get master sheet structure for column order
        const headers = await getMasterSheetStructure();
        
        // Create row data in same order as master sheet
        const rowData = headers.map(header => {
            switch(header.toLowerCase()) {
                case 'title': return bookData.title;
                case 'author': return bookData.author;
                case 'isbn': return bookData.isbn;
                case 'cover image url': return bookData.coverImageUrl;
                case 'date added': return new Date().toISOString();
                default: return '';  // For any additional columns
            }
        });

        // Add new book data
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Books!A${nextRow}:${String.fromCharCode(65 + headers.length - 1)}${nextRow}`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [rowData]
            }
        });

        return {
            success: true,
            row: nextRow
        };
    } catch (error) {
        console.error('Error syncing to user sheet:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Load existing user sheet IDs from a file
function loadUserSheetIds() {
    try {
        if (fs.existsSync('./user_sheet_ids.json')) {
            const data = JSON.parse(fs.readFileSync('./user_sheet_ids.json'));
            Object.entries(data).forEach(([phone, id]) => {
                userSheetIds.set(phone, id);
            });
        }
    } catch (error) {
        console.error('Error loading user sheet IDs:', error);
    }
}

// Save user sheet IDs to a file
function saveUserSheetIds() {
    try {
        const data = Object.fromEntries(userSheetIds);
        fs.writeFileSync('./user_sheet_ids.json', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving user sheet IDs:', error);
    }
}

// Load existing IDs on startup
loadUserSheetIds();

// Save IDs periodically and on process exit
setInterval(saveUserSheetIds, 5 * 60 * 1000); // Every 5 minutes
process.on('SIGINT', () => {
    saveUserSheetIds();
    process.exit();
});

module.exports = {
    createUserSheet,
    syncToUserSheet,
    userSheetIds
}; 