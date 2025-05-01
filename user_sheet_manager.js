const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');

class UserSheetManager {
    constructor() {
        // Initialize Google Sheets API with credentials
        const auth = new google.auth.GoogleAuth({
            keyFile: path.join(__dirname, 'service-account.json'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
        });

        this.sheets = google.sheets({ version: 'v4', auth });
        this.drive = google.drive({ version: 'v3', auth });
        this.userSheetsPath = path.join(__dirname, 'user_sheets.json');
        this.syncLogPath = path.join(__dirname, 'sync_log.json');
        this.maxRetries = 3;
        this.retryDelay = 5000; // 5 seconds
    }

    // Load user sheets data
    async loadUserSheets() {
        try {
            const data = await fs.readFile(this.userSheetsPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            // Initialize if file doesn't exist
            const initialData = {};
            await this.saveUserSheets(initialData);
            return initialData;
        }
    }

    // Save user sheets data
    async saveUserSheets(data) {
        await fs.writeFile(this.userSheetsPath, JSON.stringify(data, null, 2));
    }

    // Load sync log
    async loadSyncLog() {
        try {
            const data = await fs.readFile(this.syncLogPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            // Initialize if file doesn't exist
            const initialData = { logs: [] };
            await this.saveSyncLog(initialData);
            return initialData;
        }
    }

    // Save sync log
    async saveSyncLog(data) {
        await fs.writeFile(this.syncLogPath, JSON.stringify(data, null, 2));
    }

    // Log sync operation
    async logSync(phoneNumber, operation, status, details) {
        const log = await this.loadSyncLog();
        log.logs.push({
            timestamp: new Date().toISOString(),
            phoneNumber,
            operation,
            status,
            details
        });
        await this.saveSyncLog(log);
    }

    // Verify sheet structure
    async verifySheetStructure(sheetId) {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: sheetId,
                range: 'Books!A1:V1'  // Headers only
            });

            if (!response.data.values || response.data.values.length === 0) {
                return { valid: false, error: 'No headers found' };
            }

            const headers = response.data.values[0];
            const expectedHeaders = [
                'ISBN', 'Title', 'Subtitle', 'Author', 'Publisher',
                'Published Date', 'Description', 'Page', 'PrintType',
                'Categories', 'Thumbnail', 'Thumbnail Small', 'Language',
                'Sender_Whatsapp', 'Sender_Email', 'Sender_Name',
                'Sender_Frequency', 'Global_Frequency', 'ISBN_10',
                'Source', 'Timestamps', 'Image URL'
            ];

            const isValid = expectedHeaders.every((header, index) => 
                headers[index] === header
            );

            return {
                valid: isValid,
                error: isValid ? null : 'Headers do not match expected structure'
            };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    // Share sheet with user
    async shareSheetWithUser(sheetId, email) {
        try {
            await this.drive.permissions.create({
                fileId: sheetId,
                requestBody: {
                    role: 'reader',
                    type: 'user',
                    emailAddress: email
                }
            });
            return true;
        } catch (error) {
            console.error('Error sharing sheet:', error);
            return false;
        }
    }

    // Get or create user sheet
    async getUserSheet(phoneNumber, email) {
        const userSheets = await this.loadUserSheets();
        
        if (userSheets[phoneNumber]) {
            // Verify existing sheet
            const verification = await this.verifySheetStructure(userSheets[phoneNumber]);
            if (verification.valid) {
                return userSheets[phoneNumber];
            }
            // If sheet is invalid, we'll create a new one
            await this.logSync(phoneNumber, 'sheet_verification', 'failed', verification.error);
        }

        // Create new sheet
        try {
            const response = await this.sheets.spreadsheets.create({
                requestBody: {
                    properties: {
                        title: `BOOKDB_${phoneNumber}`
                    },
                    sheets: [{
                        properties: {
                            title: 'Books',
                            gridProperties: {
                                rowCount: 1000,
                                columnCount: 26
                            }
                        }
                    }]
                }
            });

            const sheetId = response.data.spreadsheetId;
            
            // Add headers
            await this.sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: 'Books!A1:V1',
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[
                        'ISBN', 'Title', 'Subtitle', 'Author', 'Publisher',
                        'Published Date', 'Description', 'Page', 'PrintType',
                        'Categories', 'Thumbnail', 'Thumbnail Small', 'Language',
                        'Sender_Whatsapp', 'Sender_Email', 'Sender_Name',
                        'Sender_Frequency', 'Global_Frequency', 'ISBN_10',
                        'Source', 'Timestamps', 'Image URL'
                    ]]
                }
            });

            // Save sheet ID to user sheets database
            userSheets[phoneNumber] = sheetId;
            await this.saveUserSheets(userSheets);

            // Share with user
            await this.shareSheetWithUser(sheetId, email);

            return sheetId;
        } catch (error) {
            console.error('Error creating user sheet:', error);
            throw error;
        }
    }

    // Sync new data to user sheet
    async syncNewData(phoneNumber, newData, email) {
        try {
            let sheetId = await this.getUserSheet(phoneNumber, email);
            
            // Append new data
            await this.sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: 'Books!A:V',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                requestBody: {
                    values: [newData]
                }
            });

            await this.logSync(phoneNumber, 'sync_new_data', 'success', 'Data synced successfully');
            return { success: true };
        } catch (error) {
            console.error('Error syncing new data:', error);
            await this.logSync(phoneNumber, 'sync_new_data', 'error', error.message);
            return { success: false, error: error.message };
        }
    }

    // Verify sync by checking if data exists in sheet
    async verifySync(phoneNumber, newData) {
        try {
            const userSheets = await this.loadUserSheets();
            const sheetId = userSheets[phoneNumber];
            
            if (!sheetId) {
                return { verified: false, error: 'Sheet not found' };
            }

            // Get all data from sheet
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: sheetId,
                range: 'Books!A:V'
            });

            if (!response.data.values || response.data.values.length <= 1) {
                return { verified: false, error: 'No data found in sheet' };
            }

            // Check if new data exists in sheet
            const dataExists = response.data.values.some(row => 
                row[0] === newData[0] && // ISBN
                row[1] === newData[1] && // Title
                row[3] === newData[3]    // Author
            );

            return { 
                verified: dataExists,
                error: dataExists ? null : 'Data not found in sheet'
            };
        } catch (error) {
            console.error('Error verifying sync:', error);
            return { verified: false, error: error.message };
        }
    }
}

module.exports = UserSheetManager; 