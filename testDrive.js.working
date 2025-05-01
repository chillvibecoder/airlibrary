const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');

// Load the service account key
const serviceAccount = require('./service-account.json');
console.log('Service account email:', serviceAccount.client_email);

// Create a new OAuth2 client
const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive.file']
});

// Create Drive client
const drive = google.drive({ version: 'v3', auth });

// WhatsApp URL to test
const whatsappUrl = 'https://mmg.whatsapp.net/o1/v/t62.7118-24/f2/m238/AQMm2ufl8GLoqIDajbRWfJ7Pkf6ytY7R3SsnqRU4Iydw5lHJcQWsBccC2Egapt5iNFFnx8Z_2YC6_dWrxNW7QBBUXAnji_ASXYhgqlqn5A?ccb=9-4&oh=01_Q5AaIfZihXLhnTw4sV_IRcnAb0UEhZXjvwJ-w6wCGcy3sUlC&oe=6809121A&_nc_sid=e6ed6c&mms3=true';

// Function to download a file and save it to disk
async function downloadFile(url, filePath) {
    console.log('Downloading file from:', url);
    try {
        // Try different headers to see which works
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br'
        };
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: headers,
            timeout: 30000
        });
        
        console.log('Download successful, content type:', response.headers['content-type']);
        console.log('Content length:', response.headers['content-length']);
        console.log('Status:', response.status);
        
        fs.writeFileSync(filePath, Buffer.from(response.data));
        console.log('File saved to:', filePath);
        return true;
    } catch (error) {
        console.error('Error downloading file:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response headers:', error.response.headers);
        }
        return false;
    }
}

// Function to upload a file to Google Drive
async function uploadToDrive(filePath, fileName) {
    console.log('Uploading file to Google Drive:', filePath);
    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            console.error('File does not exist:', filePath);
            return null;
        }
        
        // Log file size
        const stats = fs.statSync(filePath);
        console.log('File size:', stats.size);
        
        // Create file metadata
        const fileMetadata = {
            name: fileName,
            mimeType: 'image/jpeg',
            parents: ['root'] // Save to root folder
        };
        
        // Create media object
        const media = {
            mimeType: 'image/jpeg',
            body: fs.createReadStream(filePath)
        };
        
        // Upload file
        console.log('Starting Drive upload...');
        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id,webViewLink'
        });
        
        console.log('File uploaded, id:', file.data.id);
        
        // Make file public
        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });
        
        // Try to transfer ownership
        try {
            await drive.permissions.create({
                fileId: file.data.id,
                requestBody: {
                    role: 'owner',
                    type: 'user',
                    emailAddress: 'mansonwong.consulting@gmail.com',
                    transferOwnership: true
                }
            });
            console.log('Ownership transferred');
        } catch (ownerError) {
            console.error('Error transferring ownership:', ownerError.message);
            // Continue anyway
        }
        
        // Generate download URL
        const downloadUrl = `https://drive.google.com/uc?id=${file.data.id}&export=download`;
        console.log('Download URL:', downloadUrl);
        
        return downloadUrl;
    } catch (error) {
        console.error('Error uploading to Drive:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
        return null;
    }
}

// Main function
async function testDriveUpload() {
    // Create a test file
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }
    
    // Test file path
    const tempFilePath = path.join(tempDir, 'test_file.jpg');
    
    // First try to download from WhatsApp URL
    console.log('STEP 1: Download from WhatsApp URL');
    const downloadSuccess = await downloadFile(whatsappUrl, tempFilePath);
    
    if (!downloadSuccess) {
        console.log('STEP 1 FAILED: Using a local test image instead');
        // Create a simple test image if download fails
        const testImagePath = path.join(__dirname, 'test_image.jpg');
        if (fs.existsSync(testImagePath)) {
            fs.copyFileSync(testImagePath, tempFilePath);
        } else {
            // Create a simple colored rectangle as an image
            console.log('No test_image.jpg found, creating a blank image');
            const blankImage = Buffer.alloc(100 * 100 * 3); // 100x100 RGB image
            for (let i = 0; i < blankImage.length; i += 3) {
                blankImage[i] = 255; // Red
                blankImage[i + 1] = 0; // Green
                blankImage[i + 2] = 0; // Blue
            }
            fs.writeFileSync(tempFilePath, blankImage);
        }
    }
    
    // Then upload to Drive
    console.log('STEP 2: Upload to Google Drive');
    const driveUrl = await uploadToDrive(tempFilePath, 'TestImage_' + Date.now() + '.jpg');
    
    if (driveUrl) {
        console.log('SUCCESS: File uploaded to Google Drive');
        console.log('Download URL:', driveUrl);
    } else {
        console.log('FAILED: Could not upload to Google Drive');
    }
    
    // Clean up
    try {
        fs.unlinkSync(tempFilePath);
        console.log('Temp file deleted');
    } catch (error) {
        console.warn('Could not delete temp file:', error.message);
    }
}

// Run the test
testDriveUpload().catch(error => {
    console.error('Test failed:', error);
}); 