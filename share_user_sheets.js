require('dotenv').config();
const { google } = require('googleapis');

async function shareUserSheetsDatabase() {
    try {
        // Create auth client using service account
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/drive']
        });

        const drive = google.drive({ version: 'v3', auth });
        const SHEET_ID = '116-zHa2ssfuE5V4N1rYqeTVt1fAbfJh-n5ISmr8IOzg';
        const USER_EMAIL = 'mansonwong.consulting@gmail.com';

        // Share the sheet with editor permissions
        await drive.permissions.create({
            fileId: SHEET_ID,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: USER_EMAIL
            }
        });

        console.log(`Successfully shared UserSheets database with ${USER_EMAIL}`);
        console.log('You can now access the sheet at:');
        console.log(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);

    } catch (error) {
        console.error('Error sharing UserSheets database:', error);
    }
}

shareUserSheetsDatabase(); 