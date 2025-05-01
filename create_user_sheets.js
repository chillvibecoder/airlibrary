require('dotenv').config();
const { google } = require('googleapis');

async function createUserSheetsDatabase() {
    try {
        // Create auth client using service account
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const drive = google.drive({ version: 'v3', auth });

        // Create new spreadsheet
        const spreadsheet = await sheets.spreadsheets.create({
            resource: {
                properties: {
                    title: 'UserSheets Database'
                }
            }
        });

        const spreadsheetId = spreadsheet.data.spreadsheetId;
        console.log('Created UserSheets database with ID:', spreadsheetId);

        // Add headers
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: 'A1:E1',
            valueInputOption: 'RAW',
            resource: {
                values: [['WhatsApp Number', 'Sheet ID', 'Created Date', 'Gmail', 'Last Updated']]
            }
        });

        // Format headers
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
                requests: [{
                    repeatCell: {
                        range: {
                            sheetId: 0,
                            startRowIndex: 0,
                            endRowIndex: 1,
                            startColumnIndex: 0,
                            endColumnIndex: 5
                        },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: {
                                    red: 0.8,
                                    green: 0.8,
                                    blue: 0.8
                                },
                                textFormat: {
                                    bold: true
                                }
                            }
                        },
                        fields: 'userEnteredFormat(backgroundColor,textFormat)'
                    }
                }]
            }
        });

        console.log('UserSheets database created and formatted successfully!');
        console.log('Please update the USER_SHEETS_SHEET_ID in index.js to:', spreadsheetId);

    } catch (error) {
        console.error('Error creating UserSheets database:', error);
    }
}

createUserSheetsDatabase(); 