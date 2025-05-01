const { google } = require('googleapis');
const serviceAccount = require('./service-account.json');

const USER_SHEETS_SHEET_ID = '116-zHa2ssfuE5V4N1rYqeTVt1fAbfJh-n5ISmr8IOzg';
const USER_SHEETS_SHEET_NAME = 'UserSheets';
const USER_SHEETS_RANGE = 'A:E';

async function deleteUserSheets() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccount,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const drive = google.drive({ version: 'v3', auth });

        // Get user sheet info
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: USER_SHEETS_SHEET_ID,
            range: `${USER_SHEETS_SHEET_NAME}!${USER_SHEETS_RANGE}`,
        });

        const rows = response.data.values || [];
        const targetUsers = ['85267582915@s.whatsapp.net', '85292853890@s.whatsapp.net'];
        
        for (const row of rows) {
            const userId = row[0];
            const sheetId = row[1];
            
            if (targetUsers.includes(userId)) {
                console.log(`Deleting sheet ${sheetId} for user ${userId}`);
                
                try {
                    // Delete the sheet
                    await drive.files.delete({
                        fileId: sheetId
                    });
                    console.log(`Successfully deleted sheet ${sheetId}`);
                    
                    // Remove the user from UserSheets database
                    const rowIndex = rows.indexOf(row) + 1;
                    await sheets.spreadsheets.values.clear({
                        spreadsheetId: USER_SHEETS_SHEET_ID,
                        range: `${USER_SHEETS_SHEET_NAME}!A${rowIndex}:E${rowIndex}`
                    });
                    console.log(`Removed user ${userId} from UserSheets database`);
                } catch (error) {
                    console.error(`Error deleting sheet ${sheetId}:`, error);
                }
            }
        }
        
        console.log('Finished deleting user sheets');
    } catch (error) {
        console.error('Error in deleteUserSheets:', error);
    }
}

async function deleteSheet(sheetId) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccount,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
        });

        const drive = google.drive({ version: 'v3', auth });
        const sheets = google.sheets({ version: 'v4', auth });

        // Delete the sheet
        await drive.files.delete({
            fileId: sheetId
        });

        console.log(`Successfully deleted sheet ${sheetId}`);
        return true;
    } catch (error) {
        console.error(`Error deleting sheet ${sheetId}:`, error.message);
        return false;
    }
}

async function main() {
    // Delete the specific sheet
    const sheetId = '1PYatD8F56fkUIJjpZFuzeJl1OlwJ1ya06zTeriNVnTc';
    await deleteSheet(sheetId);
    console.log('Finished deleting sheet');
}

deleteUserSheets();
main().catch(console.error); 