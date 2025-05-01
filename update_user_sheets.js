const { google } = require('googleapis');
const auth = new google.auth.GoogleAuth({
    credentials: require('./service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const USER_SHEETS_ID = '116-zHa2ssfuE5V4N1rYqeTVt1fAbfJh-n5ISmr8IOzg';

async function checkSheetStatus(sheetId) {
    try {
        // Try to read the first cell to check if the sheet is accessible
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'A1'
        });
        
        // Check if the cell contains a formula
        const value = response.data.values?.[0]?.[0] || '';
        if (value.includes('=QUERY(IMPORTRANGE')) {
            return 'Working';
        } else if (value.includes('=IMPORTRANGE')) {
            return 'Needs Authorization';
        } else if (value === '#REF!') {
            return 'Broken';
        } else {
            return 'Unknown';
        }
    } catch (error) {
        console.error(`Error checking sheet ${sheetId}:`, error.message);
        return 'Error';
    }
}

async function updateUserSheets() {
    try {
        // First, ensure the Status column exists by updating the sheet properties
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: USER_SHEETS_ID,
            requestBody: {
                requests: [
                    {
                        updateSheetProperties: {
                            properties: {
                                sheetId: 0,
                                gridProperties: {
                                    columnCount: 6,
                                    rowCount: 1000
                                }
                            },
                            fields: 'gridProperties'
                        }
                    }
                ]
            }
        });

        // Get all existing data
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: USER_SHEETS_ID,
            range: 'UserSheets!A:F'
        });

        const rows = response.data.values || [];
        const headers = ['WhatsApp Number', 'Sheet ID', 'Created Date', 'Gmail', 'Last Updated', 'Status'];
        
        // Update headers
        await sheets.spreadsheets.values.update({
            spreadsheetId: USER_SHEETS_ID,
            range: 'UserSheets!A1:F1',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [headers]
            }
        });

        // Format headers with darker gray background and bold text
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: USER_SHEETS_ID,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: {
                                sheetId: 0,
                                startRowIndex: 0,
                                endRowIndex: 1,
                                startColumnIndex: 0,
                                endColumnIndex: 6
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: {
                                        red: 0.8,
                                        green: 0.8,
                                        blue: 0.8
                                    },
                                    textFormat: {
                                        bold: true,
                                        fontSize: 11
                                    },
                                    horizontalAlignment: "CENTER",
                                    borders: {
                                        bottom: {
                                            style: "SOLID",
                                            width: 2,
                                            color: {
                                                red: 0.6,
                                                green: 0.6,
                                                blue: 0.6
                                            }
                                        }
                                    }
                                }
                            },
                            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,borders)"
                        }
                    }
                ]
            }
        });

        // Process each row (skip header)
        const updatedRows = [headers];
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i] || [];
            // Ensure row has 6 columns
            while (row.length < 6) {
                row.push('');
            }
            
            if (row[1]) { // If there's a sheet ID
                const status = await checkSheetStatus(row[1]);
                row[5] = status; // Update status in column F
                console.log(`Updated status for sheet ${row[1]}: ${status}`);
            }
            updatedRows.push(row);
        }

        // Update all rows with their current status
        await sheets.spreadsheets.values.update({
            spreadsheetId: USER_SHEETS_ID,
            range: 'UserSheets!A1:F' + updatedRows.length,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: updatedRows
            }
        });

        // Format status column with bold text and colored backgrounds based on status
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: USER_SHEETS_ID,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: {
                                sheetId: 0,
                                startRowIndex: 1,
                                endRowIndex: 1000,
                                startColumnIndex: 5,
                                endColumnIndex: 6
                            },
                            cell: {
                                userEnteredFormat: {
                                    textFormat: {
                                        bold: true,
                                        fontSize: 11
                                    },
                                    horizontalAlignment: "CENTER",
                                    backgroundColor: {
                                        red: 0.95,
                                        green: 0.95,
                                        blue: 1.0
                                    }
                                }
                            },
                            fields: "userEnteredFormat(textFormat,horizontalAlignment,backgroundColor)"
                        }
                    }
                ]
            }
        });

        // Add conditional formatting for status column
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: USER_SHEETS_ID,
            requestBody: {
                requests: [
                    {
                        addConditionalFormatRule: {
                            rule: {
                                ranges: [{
                                    sheetId: 0,
                                    startRowIndex: 1,
                                    endRowIndex: 1000,
                                    startColumnIndex: 5,
                                    endColumnIndex: 6
                                }],
                                booleanRule: {
                                    condition: {
                                        type: "TEXT_EQ",
                                        values: [{ userEnteredValue: "Working" }]
                                    },
                                    format: {
                                        backgroundColor: {
                                            red: 0.85,
                                            green: 0.92,
                                            blue: 0.85
                                        }
                                    }
                                }
                            }
                        }
                    },
                    {
                        addConditionalFormatRule: {
                            rule: {
                                ranges: [{
                                    sheetId: 0,
                                    startRowIndex: 1,
                                    endRowIndex: 1000,
                                    startColumnIndex: 5,
                                    endColumnIndex: 6
                                }],
                                booleanRule: {
                                    condition: {
                                        type: "TEXT_EQ",
                                        values: [{ userEnteredValue: "Broken" }]
                                    },
                                    format: {
                                        backgroundColor: {
                                            red: 0.95,
                                            green: 0.85,
                                            blue: 0.85
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        });

        console.log('UserSheets database updated successfully with status');
    } catch (error) {
        console.error('Error updating UserSheets database:', error);
    }
}

updateUserSheets(); 