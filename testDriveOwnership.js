const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Load the service account key
const serviceAccount = require('./service-account.json');
console.log('Service account email:', serviceAccount.client_email);

// Create a new OAuth2 client
const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
        'https://www.googleapis.com/auth/drive',  // Full Drive access
        'https://www.googleapis.com/auth/drive.file' 
    ]
});

// Create Drive client
const drive = google.drive({ version: 'v3', auth });

// Function to create a test file and test ownership transfer
async function testOwnershipTransfer() {
    console.log('=== Testing Google Drive Ownership Transfer ===');
    
    // Create a simple test file
    const tempFilePath = path.join(__dirname, 'test_ownership.txt');
    fs.writeFileSync(tempFilePath, 'This is a test file for ownership transfer.');
    console.log('Created test file:', tempFilePath);
    
    try {
        // Step 1: Upload the file
        console.log('Step 1: Uploading test file to Drive...');
        const fileMetadata = {
            name: 'OwnershipTest_' + Date.now() + '.txt',
            mimeType: 'text/plain',
            parents: ['root']
        };
        
        const media = {
            mimeType: 'text/plain',
            body: fs.createReadStream(tempFilePath)
        };
        
        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id,name,owners,webViewLink'
        });
        
        console.log('File uploaded successfully:');
        console.log('- File ID:', file.data.id);
        console.log('- File Name:', file.data.name);
        console.log('- Current Owners:', JSON.stringify(file.data.owners, null, 2));
        console.log('- Web View Link:', file.data.webViewLink);
        
        // Step 2: List permissions
        console.log('\nStep 2: Listing current permissions...');
        const permissionsList = await drive.permissions.list({
            fileId: file.data.id,
            fields: 'permissions(id,type,role,emailAddress)'
        });
        
        console.log('Current permissions:');
        console.log(JSON.stringify(permissionsList.data.permissions, null, 2));
        
        // Step 3: Make the file public
        console.log('\nStep 3: Making the file publicly accessible...');
        const publicPermission = await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            },
            fields: 'id'
        });
        
        console.log('Public permission added, ID:', publicPermission.data.id);
        
        // Step 4: Try to transfer ownership (standard way)
        console.log('\nStep 4: Attempting to transfer ownership (standard way)...');
        try {
            const transferPermission = await drive.permissions.create({
                fileId: file.data.id,
                requestBody: {
                    role: 'owner',
                    type: 'user',
                    emailAddress: 'mansonwong.consulting@gmail.com'
                },
                transferOwnership: true,
                fields: 'id'
            });
            
            console.log('Standard transfer successful, new owner permission ID:', transferPermission.data.id);
        } catch (transferError) {
            console.error('Standard transfer failed:', transferError.message);
            
            // Step 5: Try alternate method
            console.log('\nStep 5: Attempting alternate transfer method...');
            try {
                const alternateTransfer = await drive.permissions.create({
                    fileId: file.data.id,
                    requestBody: {
                        role: 'owner',
                        type: 'user',
                        emailAddress: 'mansonwong.consulting@gmail.com',
                        transferOwnership: true
                    },
                    fields: 'id'
                });
                
                console.log('Alternate transfer successful, permission ID:', alternateTransfer.data.id);
            } catch (alternateError) {
                console.error('Alternate transfer failed:', alternateError.message);
                
                // Step 6: Try manual sharing with max permissions
                console.log('\nStep 6: Sharing with max permissions instead...');
                try {
                    const editorPermission = await drive.permissions.create({
                        fileId: file.data.id,
                        requestBody: {
                            role: 'writer',  // Maximum role if not owner
                            type: 'user',
                            emailAddress: 'mansonwong.consulting@gmail.com'
                        },
                        fields: 'id,role'
                    });
                    
                    console.log('Editor permission added:', JSON.stringify(editorPermission.data, null, 2));
                    console.log('The file should now appear in shared with me section of your Drive');
                } catch (editorError) {
                    console.error('Editor permission failed:', editorError.message);
                }
            }
        }
        
        // Final step: Check permissions
        console.log('\nFinal step: Checking final permissions...');
        const finalPermissions = await drive.permissions.list({
            fileId: file.data.id,
            fields: 'permissions(id,type,role,emailAddress)'
        });
        
        console.log('Final permissions:');
        console.log(JSON.stringify(finalPermissions.data.permissions, null, 2));
        
        // Create direct download link
        const downloadUrl = `https://drive.google.com/uc?id=${file.data.id}&export=download`;
        console.log('\nThe file should be accessible at:');
        console.log('- Web View Link:', file.data.webViewLink);
        console.log('- Direct Download Link:', downloadUrl);
        
        console.log('\nPlease check your Google Drive to see if the file appears.');
        
    } catch (error) {
        console.error('Error during ownership transfer test:', error.message);
        if (error.response) {
            console.error('Error details:', error.response.data);
        }
    } finally {
        // Clean up local file
        try {
            fs.unlinkSync(tempFilePath);
            console.log('Local test file deleted');
        } catch (cleanupError) {
            console.warn('Failed to delete local test file:', cleanupError.message);
        }
    }
}

// Run the test
testOwnershipTransfer().catch(error => {
    console.error('Test failed:', error);
}); 