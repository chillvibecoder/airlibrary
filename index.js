require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const vision = require('@google-cloud/vision');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const os = require('os');
const sharp = require('sharp');
const UserSheetManager = require('./user_sheet_manager');

const authDir = 'auth_info';
const sheetIdsFile = path.join(authDir, 'sheet_ids.json');
const userBooksFile = path.join(authDir, 'user_books.json');
const authenticatedNumber = '85292853890@s.whatsapp.net'; // Your number as admin
const approvedSenders = new Set([
    '85292853890@s.whatsapp.net',
    '85267582915@s.whatsapp.net',
    '85266986123@s.whatsapp.net',
    '85298289259@s.whatsapp.net'
]);
const userSheetIds = new Map(); // Map phone numbers to their sheet IDs
const userDatabases = new Map(); // Store books in memory per user
let readyMessageSent = false; // Flag to track if ready message has been sent
let isShuttingDown = false; // Flag to track shutdown state
let reconnectAttempts = 0; // Track reconnection attempts
const MAX_RECONNECT_ATTEMPTS = 3; // Maximum number of reconnection attempts
const userViewState = new Map(); // Track pagination state for view books command

// UserSheets Database Constants
const USER_SHEETS_SHEET_ID = '116-zHa2ssfuE5V4N1rYqeTVt1fAbfJh-n5ISmr8IOzg'; // Master sheet ID
const USER_SHEETS_SHEET_NAME = 'UserSheets';
const USER_SHEETS_RANGE = 'A:E'; // WhatsApp Number, Sheet ID, Created Date, Gmail, Last Updated
const waitingForGmail = new Map(); // Track users waiting for Gmail input

// Load existing sheet IDs and book data if available
if (fs.existsSync(sheetIdsFile)) {
    const savedIds = JSON.parse(fs.readFileSync(sheetIdsFile, 'utf8'));
    Object.entries(savedIds).forEach(([key, value]) => userSheetIds.set(key, value));
    console.log('Loaded existing sheet IDs:', savedIds);
}

if (fs.existsSync(userBooksFile)) {
    const savedBooks = JSON.parse(fs.readFileSync(userBooksFile, 'utf8'));
    Object.entries(savedBooks).forEach(([key, value]) => userDatabases.set(key, value));
    console.log('Loaded existing book data:', savedBooks);
}

// Helper function to save sheet IDs
function saveSheetIds() {
    const ids = Object.fromEntries(userSheetIds);
    fs.writeFileSync(sheetIdsFile, JSON.stringify(ids, null, 2));
    console.log('Saved sheet IDs:', ids);
}

// Helper function to save book data
function saveUserBooks() {
    const books = Object.fromEntries(userDatabases);
    fs.writeFileSync(userBooksFile, JSON.stringify(books, null, 2));
    console.log('Saved book data:', books);
}

// Initialize Gemini with updated model
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 256
    }
});

// Add retry logic for Gemini API calls
async function retryWithBackoff(fn, maxRetries = 3, delay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            console.log(`Retry attempt ${i + 1} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Add retry logic for sending messages
async function sendMessageWithRetry(client, userId, message, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            if (i > 0) await new Promise(resolve => setTimeout(resolve, 1000));
            console.log(`Attempting to send message to ${userId} (attempt ${i + 1}/${maxRetries})`);
            const result = await client.sendMessage(userId, message);
            console.log('Message sent successfully to:', userId);
            return true;
        } catch (error) {
            console.error(`Failed to send message (attempt ${i + 1}/${maxRetries}):`, error);
            if (i === maxRetries - 1) {
                console.error('All retry attempts failed for message:', message);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return false;
}

// Simplify the downloadWhatsAppImageFromMessage function
async function downloadWhatsAppImageFromMessage(msg, client) {
    try {
        console.log('Directly downloading WhatsApp image from message');
        if (!msg?.message?.imageMessage) {
            throw new Error('No image message in the message object');
        }
        
        console.log('Using baileys downloadMediaMessage...');
        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: console }
        );
        
        console.log('Download successful, buffer size:', buffer?.length || 0);
        return buffer;
    } catch (error) {
        console.error('Error downloading WhatsApp image:', error);
        return null;
    }
}

// Update the saveImageToDrive function using the successful approach from the test script
async function saveImageToDrive(imageUrl, title, isbn, drive, client = null, messageObj = null) {
    try {
        console.log('Starting image save process...');
        
        // Sanitize the title and ISBN for use in filenames
        const safeTitle = (title || 'Unknown').replace(/[\/\?<>\\:\*\|"]/g, '_').substring(0, 50);
        const safeIsbn = (isbn || 'NoISBN').replace(/[\/\?<>\\:\*\|"]/g, '_');
        
        // Create a unique temp directory if it doesn't exist
        const tempDir = path.join(os.tmpdir(), 'airlibrary');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Create temp file path
        const tempFilePath = path.join(tempDir, `${safeTitle}_${safeIsbn}_${Date.now()}.jpg`);
        console.log('Temp file path:', tempFilePath);
        
        let downloadSuccess = false;
        
        // OPTION 1: Try to download directly from the message object if available
        if (messageObj && messageObj.message?.imageMessage) {
            try {
                console.log('Attempting direct download from message object');
                const buffer = await downloadMediaMessage(
                    messageObj,
                    'buffer',
                    {},
                    { logger: console }
                );
                
                if (buffer && buffer.length > 0) {
                    console.log('Downloaded from message object, buffer size:', buffer.length);
                    fs.writeFileSync(tempFilePath, buffer);
                    const stats = fs.statSync(tempFilePath);
                    if (stats.size > 0) {
                        console.log('File written successfully, size:', stats.size);
                        downloadSuccess = true;
                    }
                }
            } catch (directError) {
                console.error('Direct download error:', directError.message);
            }
        }
        
        // OPTION 2: Try URL-based download if direct download failed
        if (!downloadSuccess && imageUrl) {
            try {
                console.log('Attempting URL-based download:', imageUrl);
                const response = await axios.get(imageUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br'
                    }
                });
                
                console.log('URL download response:', response.status, response.headers['content-type']);
                fs.writeFileSync(tempFilePath, Buffer.from(response.data));
                const stats = fs.statSync(tempFilePath);
                if (stats.size > 0) {
                    console.log('File written successfully from URL, size:', stats.size);
                    downloadSuccess = true;
                }
            } catch (urlError) {
                console.error('URL download error:', urlError.message);
            }
        }
        
        // If we couldn't download the image by any method, return null
        if (!downloadSuccess) {
            console.error('Failed to download image by any method');
            return null;
        }
        
        // Now upload to Google Drive
        try {
            // Create file metadata
            let fileName = `${safeTitle}_${safeIsbn}.jpg`;
            try {
                const query = `name contains '${safeTitle}_${safeIsbn}' and mimeType contains 'image/'`;
                const existingFiles = await drive.files.list({ q: query, fields: 'files(name)', spaces: 'drive' });
                
                if (existingFiles.data.files.length > 0) {
                    const count = existingFiles.data.files.length;
                    fileName = `${safeTitle}_${safeIsbn}(${count}).jpg`;
                }
            } catch (listError) {
                console.error('Error checking for existing files:', listError.message);
                // Continue with default filename
            }
            
            console.log('Using filename for Drive:', fileName);
            
            const fileMetadata = {
                name: fileName,
                mimeType: 'image/jpeg',
                parents: ['root']
            };
            
            const media = {
                mimeType: 'image/jpeg',
                body: fs.createReadStream(tempFilePath)
            };
            
            console.log('Starting Drive upload...');
            const file = await drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id'
            });
            
            console.log('File uploaded to Drive, ID:', file.data.id);
            
            // Set public permissions
            await drive.permissions.create({
                fileId: file.data.id,
                requestBody: {
                    role: 'reader',
                    type: 'anyone'
                }
            });
            
            // Try to transfer ownership (may fail, but that's OK)
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
                console.log('Ownership transferred successfully');
            } catch (ownerError) {
                console.warn('Could not transfer ownership:', ownerError.message);
                // This is not a critical error, can continue
            }
            
            // Clean up temp file
            try {
                fs.unlinkSync(tempFilePath);
                console.log('Temp file deleted');
            } catch (unlinkError) {
                console.warn('Failed to delete temp file:', unlinkError.message);
            }
            
            // Generate and return the direct download URL
            const downloadUrl = `https://drive.google.com/uc?id=${file.data.id}&export=download`;
            console.log('Final Drive URL:', downloadUrl);
            return downloadUrl;
        } catch (uploadError) {
            console.error('Drive upload error:', uploadError.message);
            
            // Try to clean up temp file if it exists
            try {
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            } catch (cleanupError) {
                console.warn('Failed to clean up temp file:', cleanupError.message);
            }
            
            return null;
        }
    } catch (overallError) {
        console.error('saveImageToDrive overall error:', overallError.message);
        return null;
    }
}

async function connectToWhatsApp() {
    console.log('Script starting...');
    try {
        // Handle WhatsApp Auth State
        let authState = {};
        if (process.env.WHATSAPP_AUTH_STATE) {
            try {
                authState = JSON.parse(process.env.WHATSAPP_AUTH_STATE);
            } catch (error) {
                console.error('Error handling WhatsApp auth state:', error);
                process.exit(1);
            }
        }

        // Create a custom auth state handler that works in memory
        const state = {
            creds: authState.creds || {},
            keys: authState.keys || {}
        };

        const saveCreds = async () => {
            // In production, you would want to store this in a database
            // For now, we'll just log it
            console.log('New auth state:', state);
            return state;
        };

        console.log('Auth state loaded');

        const sock = makeWASocket({
            printQRInTerminal: true,
            auth: state,
            browser: ['AirLibrary Bot', 'Chrome', '1.0.0'],
            getMessage: async (key) => {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg?.message || undefined;
                }
                return {
                    conversation: 'Hello!'
                };
            }
        });

        // Handle auth updates
        sock.ev.on('creds.update', async () => {
            const newState = await saveCreds();
            console.log('New auth state:', newState);
        });

        const client = sock;
        console.log('WhatsApp socket created');

        client.ev.on('creds.update', saveCreds);

        const visionClient = new vision.ImageAnnotatorClient({ credentials: require('./service-account.json') });
        console.log('Vision client initialized successfully');

        const serviceAccount = require('./service-account.json');
        console.log('Service account loaded:', serviceAccount.client_email);

        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccount,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        console.log('Google Sheets client initialized successfully');

        const drive = google.drive({ version: 'v3', auth });
        console.log('Google Drive client initialized successfully');

        const imageQueue = new Map();

        client.ev.on('connection.update', (update) => {
            if (isShuttingDown) return;
            
            const { connection, lastDisconnect, qr } = update;
            console.log('Connection update:', { connection, lastDisconnect, qr: qr ? 'QR received' : 'No QR' });
            
            if (qr) {
                console.log('\n\n=== QR CODE RECEIVED ===\n');
                require('qrcode-terminal').generate(qr, { small: true });
                console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
            }
            
            if (connection === 'open') {
                console.log('WhatsApp connected successfully!');
                reconnectAttempts = 0;
                if (!readyMessageSent) {
                    const sendReadyMessage = async () => {
                        await new Promise(resolve => setTimeout(resolve, 15000));
                        await sendMessageWithRetry(client, authenticatedNumber, { text: 'Bot ready. Send book images or "approve <number>" to add senders.' });
                        readyMessageSent = true;
                    };
                    setTimeout(sendReadyMessage, 10000);
                }
            }
            
            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                console.log('Connection closed:', error);
                
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.log('Maximum reconnection attempts reached. Please restart the bot manually.');
                    return;
                }
                
                if (statusCode === 401) {
                    console.log('401 detected, forcing re-authentication...');
                    require('fs').rmSync(authDir, { recursive: true, force: true });
                    if (!isShuttingDown) {
                        reconnectAttempts++;
                        setTimeout(connectToWhatsApp, 15000);
                    }
                } else if (statusCode === 440) {
                    console.log('Stream conflict detected, reconnecting...');
                    if (!isShuttingDown) {
                        reconnectAttempts++;
                        setTimeout(connectToWhatsApp, 15000);
                    }
                } else if (statusCode !== DisconnectReason.loggedOut && !isShuttingDown) {
                    reconnectAttempts++;
                    setTimeout(connectToWhatsApp, 15000);
                }
            }
        });

        process.on('SIGINT', async () => {
            console.log('Shutting down...');
            isShuttingDown = true;
            try {
                await client.logout();
                console.log('Logged out successfully');
            } catch (error) {
                console.error('Error during logout:', error);
            }
            process.exit(0);
        });

        client.ev.on('messages.upsert', async (messageUpdate) => {
            const messages = messageUpdate.messages;
            for (const msg of messages) {
                try {
                    const userId = msg.key.remoteJid;
                    const isGroupChat = userId.endsWith('@g.us');
                    const sender = isGroupChat ? msg.key.participant : userId;
                    const isFromMe = msg.key.fromMe;

                    if (isGroupChat) {
                        console.log(`Ignoring group message from ${userId}`);
                        continue;
                    }

                    if (isFromMe && userId === authenticatedNumber) {
                        if (msg.message?.conversation) {
                            const text = msg.message.conversation.toLowerCase();
                            if (text.startsWith('approve ')) {
                                const newSender = text.split('approve ')[1].trim() + '@s.whatsapp.net';
                                approvedSenders.add(newSender);
                                console.log(`Approved new sender: ${newSender}`);
                                await client.sendMessage(authenticatedNumber, { text: `${newSender} approved.` });
                                continue;
                            } else if (text === 'show approved') {
                                const sendersList = Array.from(approvedSenders).join('\n');
                                console.log('Current approved senders:', sendersList);
                                await client.sendMessage(authenticatedNumber, { text: `Current approved senders:\n${sendersList}` });
                                continue;
                            }
                        }
                    }

                    // Handle user messages - check both sender and userId
                    if (!approvedSenders.has(sender) && !approvedSenders.has(userId)) {
                        console.log(`Ignoring message from unauthorized sender: ${sender}`);
                        continue;
                    }

                    let userBooks = userDatabases.get(sender) || [];
                    let queue = imageQueue.get(sender) || [];

                    if (msg.message?.conversation) {
                        const text = msg.message.conversation.toLowerCase();
                        console.log('Received message:', text);
                        
                        // Handle admin commands
                        if (userId === authenticatedNumber) {
                            if (text.startsWith('approve ')) {
                                const newSender = text.split(' ')[1] + '@s.whatsapp.net';
                                approvedSenders.add(newSender);
                                console.log(`Approved new sender: ${newSender}`);
                                await client.sendMessage(authenticatedNumber, { text: `${newSender} approved.` });
                                continue;
                            } else if (text === 'show approved') {
                                const sendersList = Array.from(approvedSenders).join('\n');
                                console.log('Current approved senders:', sendersList);
                                await client.sendMessage(authenticatedNumber, { text: `Current approved senders:\n${sendersList}` });
                                continue;
                            }
                        }
                        
                        // Handle user messages
                        if (text === 'finish') {
                            console.log(`Finish command received from ${sender}, queue length: ${queue.length}`);
                            if (queue.length > 0) {
                                userBooks = await processBatch(sender, queue, userBooks, client, sheets, drive);
                                imageQueue.set(sender, []);
                            }
                                    
                            if (userBooks.length > 0) {
                                try {
                                    console.log(`Attempting to save ${userBooks.length} books to master sheet for ${sender}`);
                                    const masterSheetLink = await appendToSheet(sender, userBooks, sheets, serviceAccount);
                                    console.log(`Successfully saved to master sheet: ${masterSheetLink}`);
                                    
                                    // Check if user has individual sheet in UserSheets database
                                    const userInfo = await getUserSheetInfo(sender, sheets);
                                    
                                    if (userInfo && userInfo.gmail) {
                                        // Existing user - sync to their sheet
                                        console.log(`Found existing sheet for ${sender}: ${userInfo.sheetId}`);
                                        
                                        // Format data for User Sheet
                                        const formattedData = userBooks.map(book => [
                                            book.isbn,                    // ISBN
                                            book.title,                   // Title
                                            book.metadata.subtitle || '', // Subtitle
                                            book.author,                  // Author
                                            book.metadata.publisher || '', // Publisher
                                            book.metadata.publishedDate || '', // Published Date
                                            book.metadata.description || '', // Description
                                            book.metadata.pageCount || '', // Page
                                            book.metadata.printType || '', // PrintType
                                            (book.metadata.categories || []).join(', '), // Categories
                                            book.metadata.imageLinks?.thumbnail || '', // Thumbnail
                                            book.metadata.imageLinks?.smallThumbnail || '', // Thumbnail Small
                                            book.metadata.language || '', // Language
                                            sender,                       // Sender_Whatsapp
                                            userInfo.gmail,               // Sender_Email
                                            userInfo.name || '',          // Sender_Name
                                            '1',                          // Sender_Frequency
                                            '1',                          // Global_Frequency
                                            book.metadata.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier || '', // ISBN_10
                                            'WhatsApp',                   // Source
                                            new Date().toISOString(),     // Timestamps
                                            book.cover || ''              // Image URL
                                        ]);

                                        // Directly append to the user's sheet
                                        try {
                                            await sheets.spreadsheets.values.append({
                                                spreadsheetId: userInfo.sheetId,
                                                range: 'A:V',
                                                valueInputOption: 'RAW',
                                                insertDataOption: 'INSERT_ROWS',
                                                resource: {
                                                    values: formattedData
                                                }
                                            });
                                            
                                            console.log(`Successfully synced ${formattedData.length} books to user sheet`);
                                            
                                            // Send success message with sheet URL
                                            const sheetUrl = `https://docs.google.com/spreadsheets/d/${userInfo.sheetId}/edit`;
                                            await sendMessageWithRetry(client, sender, {
                                                text: `Books saved successfully!\n\nYour Sheet: ${sheetUrl}`
                                            });
                                        } catch (syncError) {
                                            console.error('Error syncing to user sheet:', syncError);
                                            
                                            // If there's an error, try to create a new sheet
                                            console.log(`Attempting to create new sheet for ${sender}`);
                                            const sheetId = await createUserSheet(sender, userBooks, sheets);
                                            
                                            // Save to UserSheets database
                                            await saveUserSheetInfo(sender, sheetId, userInfo.gmail, sheets);
                                            
                                            // Share with user
                                            await shareSheetWithUser(sheetId, userInfo.gmail, drive);
                                            
                                            // Send URL
                                            const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
                                            await sendMessageWithRetry(client, sender, {
                                                text: `Your book database has been recreated and shared: ${sheetUrl}`
                                            });
                                        }
                                    } else {
                                        // New user - ask for Gmail
                                        waitingForGmail.set(sender, userBooks);
                                        await sendMessageWithRetry(client, sender, { 
                                            text: 'Please share your Gmail, your BOOKDB will be shared with your Gmail soon.' 
                                        });
                                    }
                                    
                                    userDatabases.set(sender, []);
                                    saveUserBooks();
                                } catch (error) {
                                    console.error('Error in finish flow:', error);
                                    await sendMessageWithRetry(client, sender, { 
                                        text: 'Error saving to sheets. Please try again or contact support.' 
                                    });
                                }
                            } else {
                                // No new books, check for existing sheet
                                const userInfo = await getUserSheetInfo(sender, sheets);
                                if (userInfo && userInfo.sheetId) {
                                    const sheetUrl = `https://docs.google.com/spreadsheets/d/${userInfo.sheetId}/edit`;
                                    await sendMessageWithRetry(client, sender, { 
                                        text: `Your book database: ${sheetUrl}` 
                                    });
                                } else {
                                    await sendMessageWithRetry(client, sender, { 
                                        text: 'No books yet. Send ISBN image to start new entry.' 
                                    });
                                }
                            }
                        } else if (waitingForGmail.has(sender)) {
                            // Handle Gmail input
                            const email = text.trim();
                            if (email.includes('@gmail.com')) {
                                const userBooks = waitingForGmail.get(sender);
                                try {
                                    // Create new sheet
                                    const sheetId = await createUserSheet(sender, userBooks, sheets);
                                    // Save to UserSheets database
                                    await saveUserSheetInfo(sender, sheetId, email, sheets);
                                    // Share with user
                                    await shareSheetWithUser(sheetId, email, drive);
                                    // Send URL
                                    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
                                    await sendMessageWithRetry(client, sender, { 
                                        text: `Your book database has been created and shared: ${sheetUrl}` 
                                    });
                                    // Clean up
                                    waitingForGmail.delete(sender);
                                } catch (error) {
                                    console.error('Error creating/sharing sheet:', error);
                                    await sendMessageWithRetry(client, sender, { 
                                        text: 'Error creating your book database. Please try again.' 
                                    });
                                }
                                continue;
                            } else {
                                await sendMessageWithRetry(client, sender, { 
                                    text: 'Please provide a valid Gmail address.' 
                                });
                                continue;
                            }
                        } else if (text === 'next') {
                            console.log(`Next command received from ${sender} (redirecting to skip command)`);
                            // For backward compatibility, redirect to skip logic
                            if (queue.length === 1) {
                                const isbnData = queue[0];
                                
                                // Add book with metadata and default cover
                                const bookData = {
                                    isbn: isbnData.metadata.isbn,
                                    title: isbnData.metadata.title || 'Unknown',
                                    author: isbnData.metadata.authors?.[0] || 'Unknown Author',
                                    cover: isbnData.metadata.imageLinks?.thumbnail || 'Unknown',
                                    condition: '',
                                    metadata: isbnData.metadata
                                };
                                
                                userBooks.push(bookData);
                                userDatabases.set(sender, userBooks);
                                saveUserBooks();
                                
                                // Clear the queue
                                imageQueue.set(sender, []);
                                
                                // Detailed confirmation message with full book details
                                const bookDetails = [
                                    `Title: ${bookData.title}`,
                                    `Author: ${bookData.author}`,
                                    `ISBN: ${bookData.isbn}`,
                                    bookData.metadata.publishedDate ? `Published: ${bookData.metadata.publishedDate}` : '',
                                    bookData.metadata.publisher ? `Publisher: ${bookData.metadata.publisher}` : '',
                                    bookData.metadata.categories?.length > 0 ? `Categories: ${bookData.metadata.categories.join(', ')}` : '',
                                ].filter(line => line).join('\n');
                                
                                await sendMessageWithRetry(client, sender, { text: `Added book (no cover):\n${bookDetails}\n\nSend ISBN image to start new entry.` });
                                
                                // Try to save to sheet if possible
                                try {
                                    if (sheets) {
                                        await appendToSheet(sender, bookData, sheets, serviceAccount);
                                        console.log('Book added to sheet immediately after next command');
                                    }
                                } catch (error) {
                                    console.error('Error saving to sheet after next command:', error);
                                }
                            } else {
                                // Old behavior - clear queue
                                imageQueue.set(sender, []);
                                await sendMessageWithRetry(client, sender, { text: 'Queue cleared. Send ISBN image to start new entry.' });
                            }
                        } else if (text === 'skip') {
                            console.log(`Skip command received from ${sender}, processing current ISBN without cover`);
                            
                            // If we have an ISBN in the queue but no cover yet
                            if (queue.length === 1) {
                                const isbnData = queue[0];
                                
                                // Add book with metadata and default cover
                                const bookData = {
                                    isbn: isbnData.metadata.isbn,
                                    title: isbnData.metadata.title || 'Unknown',
                                    author: isbnData.metadata.authors?.[0] || 'Unknown Author',
                                    cover: isbnData.metadata.imageLinks?.thumbnail || 'Unknown',
                                    condition: '',
                                    metadata: isbnData.metadata
                                };
                                
                                userBooks.push(bookData);
                                userDatabases.set(sender, userBooks);
                                saveUserBooks();
                                
                                // Clear the queue
                                imageQueue.set(sender, []);
                                
                                // Detailed confirmation message with full book details
                                const bookDetails = [
                                    `Title: ${bookData.title}`,
                                    `Author: ${bookData.author}`,
                                    `ISBN: ${bookData.isbn}`,
                                    bookData.metadata.publishedDate ? `Published: ${bookData.metadata.publishedDate}` : '',
                                    bookData.metadata.publisher ? `Publisher: ${bookData.metadata.publisher}` : '',
                                    bookData.metadata.categories?.length > 0 ? `Categories: ${bookData.metadata.categories.join(', ')}` : '',
                                ].filter(line => line).join('\n');
                                
                                await sendMessageWithRetry(client, sender, { text: `Added book (no cover):\n${bookDetails}\n\nSend ISBN image to start new entry.` });
                                
                                // Try to save to sheet if possible
                                try {
                                    if (sheets) {
                                        await appendToSheet(sender, bookData, sheets, serviceAccount);
                                        console.log('Book added to sheet immediately after skip command');
                                    }
                                } catch (error) {
                                    console.error('Error saving to sheet after skip command:', error);
                                }
                            } else {
                                // Old behavior - clear queue
                                imageQueue.set(sender, []);
                                await sendMessageWithRetry(client, sender, { text: 'Queue cleared. Send ISBN image to start new entry.' });
                            }
                        } else if (text === 'clear this') {
                            console.log(`Clear this command received from ${sender}`);
                            
                            // Clear only the current ISBN in the queue
                            if (queue.length > 0) {
                                imageQueue.set(sender, []);
                                await sendMessageWithRetry(client, sender, { text: 'Current ISBN entry cleared. Send ISBN image to start new entry.' });
                            } else {
                                await sendMessageWithRetry(client, sender, { text: 'No current ISBN to clear. Send ISBN image to start new entry.' });
                            }
                        } else if (text === 'clear same') {
                            console.log(`Clear same command received from ${sender}`);
                            
                            // Get current ISBN if it exists
                            let currentIsbn = '';
                            if (queue.length > 0 && queue[0].metadata && queue[0].metadata.isbn) {
                                currentIsbn = queue[0].metadata.isbn;
                            }
                            
                            if (currentIsbn) {
                                // Remove all books with the same ISBN
                                const initialCount = userBooks.length;
                                userBooks = userBooks.filter(book => book.isbn !== currentIsbn);
                                const removedCount = initialCount - userBooks.length;
                                
                                // Clear the current queue
                                imageQueue.set(sender, []);
                                
                                // Update user database
                                userDatabases.set(sender, userBooks);
                                saveUserBooks();
                                
                                await sendMessageWithRetry(client, sender, { 
                                    text: `Removed ${removedCount} entries with ISBN: ${currentIsbn}. Send ISBN image to start new entry.` 
                                });
                            } else {
                                await sendMessageWithRetry(client, sender, { 
                                    text: 'No current ISBN to match. Send ISBN image to start new entry.' 
                                });
                            }
                        } else if (text === 'clear all') {
                            console.log(`Clear all command received from ${sender}`);
                            
                            // Clear all entries without saving
                            userBooks = [];
                            userDatabases.set(sender, userBooks);
                            imageQueue.set(sender, []);
                            saveUserBooks();
                            
                            await sendMessageWithRetry(client, sender, { 
                                text: 'All entries cleared. No data was saved to Google Sheets. Send ISBN image to start new entry.' 
                            });
                        } else if (text === 'help' || text === 'commands' || text === 'show commands') {
                            console.log(`Help command requested by ${sender}`);
                            
                            const helpMessage = [
                                "ℹ️ *Help Commands:*",
                                "",
                                "📚 *Book Management:*",
                                "• Send ISBN image to start new entry",
                                "• Send cover image to complete entry",
                                "• *finish* - Save all entries to sheet",
                                "• *skip* - Skip cover image and save entry",
                                "• *clear this* - Clear current ISBN entry",
                                "• *clear same* - Remove all entries with same ISBN",
                                "• *clear all* - Clear all unsaved entries",
                                "",
                                "📖 *Viewing Books:*",
                                "• *view books* or *my books* - View your library",
                                "• *view more* or *next page* - Show more books",
                                "",
                                "✏️ *Manual Entry:*",
                                "• *no isbn* - Skip ISBN requirement",
                                "• *title: <text>* - Set book title",
                                "• *author: <text>* - Set book author",
                                "• *isbn: <number>* - Enter ISBN manually",
                                "",
                                "ℹ️ *Other Commands:*",
                                "• *show commands* - Show this list (alias)"
                            ].join('\n');
                            
                            await sendMessageWithRetry(client, sender, { text: helpMessage });
                        } else if (text === 'view books' || text === 'my books') {
                            console.log(`View books command requested by ${sender}`);
                            
                            try {
                                // Get the user's phone number without the WhatsApp suffix
                                const userPhone = sender.replace('@s.whatsapp.net', '');
                                
                                await sendMessageWithRetry(client, sender, { 
                                    text: `Fetching your books, please wait...` 
                                });
                                
                                // Get user's books from the Google Sheet
                                const userBooksFromSheet = await getUserBooksFromSheet(userPhone, sheets, serviceAccount);
                                
                                if (!userBooksFromSheet || userBooksFromSheet.length === 0) {
                                    await sendMessageWithRetry(client, sender, { 
                                        text: 'You have not added any books to your library yet. Use the "isbn:" command to add books.' 
                                    });
                                    return;
                                }
                                
                                // Reset page to 1 for new view books request
                                userViewState.set(sender, { 
                                    page: 1,
                                    totalBooks: userBooksFromSheet.length,
                                    books: userBooksFromSheet
                                });
                                
                                // Format the books list for page 1
                                const booksMessage = formatBooksListMessage(userBooksFromSheet, 1);
                                
                                // Send the formatted list to the user
                                await sendMessageWithRetry(client, sender, { text: booksMessage });
                            } catch (error) {
                                console.error('Error fetching user books:', error);
                                await sendMessageWithRetry(client, sender, { 
                                    text: 'Error retrieving your books. Please try again later.' 
                                });
                            }
                        } else if (text === 'view more' || text === 'next page') {
                            console.log(`View more books requested by ${sender}`);
                            
                            // Check if the user has an active view state
                            const viewState = userViewState.get(sender);
                            
                            if (!viewState) {
                                await sendMessageWithRetry(client, sender, { 
                                    text: 'Please use "view books" first to start browsing your library.' 
                                });
                                continue;
                            }
                            
                            // Increment the page number
                            viewState.page += 1;
                            userViewState.set(sender, viewState);
                            
                            // Format the books list for the next page
                            const booksMessage = formatBooksListMessage(viewState.books, viewState.page);
                            
                            // Send the formatted list to the user
                            await sendMessageWithRetry(client, sender, { text: booksMessage });
                        } else if (text === 'no isbn') {
                            console.log(`No ISBN command received from ${sender}`);
                            if (queue.length === 0) {
                                queue.push({ 
                                    type: 'isbn', 
                                    data: null, 
                                    url: null, 
                                    metadata: { isbn: 'NO_ISBN_' + Date.now(), title: 'Unknown', authors: ['Unknown'], source: 'Manual Entry' }
                                });
                                imageQueue.set(sender, queue);
                                await sendMessageWithRetry(client, sender, { text: 'ISBN requirement skipped. Send cover image to complete the entry.' });
                            } else {
                                await sendMessageWithRetry(client, sender, { text: 'Please send a cover image first.' });
                            }
                        } else if (text.startsWith('title:')) {
                            const title = text.split('title:')[1].trim();
                            console.log('Processing manual title input:', title);
                            
                            if (queue.length > 0) {
                                const currentBook = queue[0];
                                currentBook.metadata.title = title;
                                queue[0] = currentBook;
                                imageQueue.set(sender, queue);
                                await sendMessageWithRetry(client, sender, { text: `Title updated to: ${title}\nSend cover image to complete the entry.` });
                            } else if (userBooks.length > 0) {
                                const lastBook = userBooks[userBooks.length - 1];
                                lastBook.title = title;
                                lastBook.metadata.title = title;
                                userBooks[userBooks.length - 1] = lastBook;
                                userDatabases.set(sender, userBooks);
                                saveUserBooks();
                                await sendMessageWithRetry(client, sender, { text: `Title updated to: ${title} for the last book.` });
                            } else {
                                await sendMessageWithRetry(client, sender, { text: 'No book to update. Please send ISBN image first.' });
                            }
                        } else if (text.startsWith('author:')) {
                            const author = text.split('author:')[1].trim();
                            console.log('Processing manual author input:', author);
                            
                            if (queue.length > 0) {
                                const currentBook = queue[0];
                                currentBook.metadata.authors = [author];
                                queue[0] = currentBook;
                                imageQueue.set(sender, queue);
                                await sendMessageWithRetry(client, sender, { text: `Author updated to: ${author}\nSend cover image to complete the entry.` });
                            } else if (userBooks.length > 0) {
                                const lastBook = userBooks[userBooks.length - 1];
                                lastBook.author = author;
                                lastBook.metadata.authors = [author];
                                userBooks[userBooks.length - 1] = lastBook;
                                userDatabases.set(sender, userBooks);
                                saveUserBooks();
                                await sendMessageWithRetry(client, sender, { text: `Author updated to: ${author} for the last book.` });
                            } else {
                                await sendMessageWithRetry(client, sender, { text: 'No book to update. Please send ISBN image first.' });
                            }
                        } else if (text.startsWith('isbn:')) {
                            const isbn = text.split('isbn:')[1].trim().replace(/[^0-9]/g, '');
                            console.log('Processing ISBN input:', isbn);
                            
                            if (isbn.length === 10 || isbn.length === 13) {
                                try {
                                    const metadata = await fetchMetadata(isbn);
                                    if (metadata.title && metadata.authors?.[0]) {
                                        // Only add to queue, not to userBooks yet
                                        queue.push({ type: 'isbn', data: null, url: null, metadata });
                                        imageQueue.set(sender, queue);
                                        await sendMessageWithRetry(client, sender, { 
                                            text: `Found: ${metadata.title} by ${metadata.authors[0]}\nSend cover image next.` 
                                        });
                                    } else {
                                        await sendMessageWithRetry(client, sender, { text: 'Could not find book details for this ISBN. Please try again.' });
                                    }
                                } catch (error) {
                                    console.error('Error processing ISBN:', error);
                                    await sendMessageWithRetry(client, sender, { text: 'Error processing ISBN. Please try again.' });
                                }
                            } else {
                                await sendMessageWithRetry(client, sender, { text: 'Invalid ISBN format. Please enter a valid 10 or 13 digit ISBN.' });
                            }
                        }
                        continue;
                    }

                    if (msg.message?.imageMessage) {
                        console.log('Received image message');
                        try {
                            const media = await downloadMediaMessage(msg, 'buffer', {}, { logger: client.logger, reuploadRequest: client.updateMediaMessage });
                            console.log('Successfully downloaded image');
                            
                            if (queue.length === 0) {
                                console.log('Processing ISBN image first...');
                                const isbnNumber = await extractISBN(media, visionClient);
                                if (isbnNumber) {
                                    console.log('Found ISBN:', isbnNumber);
                                    // Send immediate confirmation that ISBN was found
                                    await sendMessageWithRetry(client, sender, { text: `Found ISBN: ${isbnNumber}\nLooking up book details...` });
                                    
                                    const metadata = await fetchMetadata(isbnNumber);
                                    if (metadata.title && metadata.authors?.[0]) {
                                        metadata.isbn = isbnNumber;
                                        queue.push({ type: 'isbn', data: media, url: msg.message.imageMessage.url, metadata });
                                        imageQueue.set(sender, queue);
                                        await sendMessageWithRetry(client, sender, { text: `Found: ${metadata.title} by ${metadata.authors[0]}\nSend cover image next.` });
                                    } else {
                                        await sendMessageWithRetry(client, sender, { text: 'Could not find book details. Please try again with a clearer ISBN image.' });
                                    }
                                } else {
                                    console.log('Image is not an ISBN, ignoring...');
                                    await sendMessageWithRetry(client, sender, { text: 'Could not find a valid ISBN in the image. Please try again with a clearer image of the ISBN.' });
                                }
                            } else if (queue.length === 1) {
                                console.log('Processing cover image...');
                                const isbnData = queue[0];
                                
                                try {
                                    console.log(`Processing book: ${isbnData.metadata.title}, ISBN: ${isbnData.metadata.isbn}`);
                                    console.log(`Original cover URL: ${msg.message.imageMessage.url}`);
                                    
                                    // Save image to Drive
                                    const driveUrl = await saveImageToDrive(
                                        msg.message.imageMessage.url,
                                        isbnData.metadata.title || 'Unknown',
                                        isbnData.metadata.isbn || 'NoISBN',
                                        drive,
                                        client,
                                        msg
                                    );
                                    
                                    // If we couldn't save to Drive, use WhatsApp URL but with a warning
                                    const finalCoverUrl = driveUrl || msg.message.imageMessage.url;
                                    const driveWarning = !driveUrl ? " (WARNING: Could not save to Google Drive, using WhatsApp URL instead)" : "";
                                    
                                    console.log(`Using cover URL: ${finalCoverUrl}${driveWarning}`);
                                    
                                    // Create metadata object with the URL
                                    const baseMetadata = {
                                        ...isbnData.metadata,
                                        googleDriveUrl: driveUrl || msg.message.imageMessage.url
                                    };
                                    
                                    // Fetch additional metadata
                                    const metadata = await fetchMetadata(isbnData.metadata.isbn, baseMetadata);
                                    console.log(`Using URL for metadata: ${metadata.googleDriveUrl}`);
                                    
                                    // Create the book data object
                                    const bookData = {
                                        isbn: isbnData.metadata.isbn,
                                        title: metadata?.title || isbnData.metadata.title || 'Unknown',
                                        author: metadata?.authors?.[0] || isbnData.metadata.author || 'Unknown Author',
                                        cover: finalCoverUrl,
                                        condition: '',
                                        sheetId: isbnData.sheetId,
                                        metadata: metadata
                                    };
                                    
                                    // Add to user's books
                                    userBooks.push(bookData);
                                    userDatabases.set(sender, userBooks);
                                    saveUserBooks();
                                    
                                    // Send confirmation message
                                    await sendMessageWithRetry(client, sender, { 
                                        text: `Added: ${bookData.title}${driveWarning}`
                                    });
                                    
                                    // Clear the queue after processing
                                    imageQueue.set(sender, []);
                                } catch (error) {
                                    console.error('Error processing cover image:', error);
                                    await sendMessageWithRetry(client, sender, { 
                                        text: `Error processing book: ${error.message}. Try again.`
                                    });
                                }
                            }
                        } catch (error) {
                            console.error('Error processing image:', error);
                            if (queue.length === 0) {
                                await sendMessageWithRetry(client, sender, { text: 'Error processing ISBN image. Please try again.' });
                            }
                        }
                        continue;
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                    await client.sendMessage(msg.key.remoteJid, { text: 'Sorry, there was an error processing your message. Please try again.' });
                }
            }
        });
    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        if (!isShuttingDown) setTimeout(connectToWhatsApp, 10000);
    }
}

async function processBatch(userId, queue, userBooks, client, sheets, drive) {
    console.log(`Processing batch for ${userId}, queue length: ${queue.length}`);
    console.log('Queue contents:', JSON.stringify(queue, null, 2));
    
    for (let i = 0; i < queue.length; i += 2) {
        if (queue[i] && queue[i + 1]) {
            const isbnData = queue[i];
            const coverData = queue[i + 1];
            
            try {
                console.log(`Processing book: ${isbnData.metadata.title}, ISBN: ${isbnData.metadata.isbn}`);
                console.log(`Original cover URL: ${coverData.url}`);
                
                // Save image to Drive
                const driveUrl = await saveImageToDrive(
                    coverData.url,
                    isbnData.metadata.title || 'Unknown',
                    isbnData.metadata.isbn || 'NoISBN',
                    drive,
                    client,
                    coverData
                );
                
                // If we couldn't save to Drive, use WhatsApp URL but with a warning
                const finalCoverUrl = driveUrl || coverData.url;
                const driveWarning = !driveUrl ? " (WARNING: Could not save to Google Drive, using WhatsApp URL instead)" : "";
                
                console.log(`Using cover URL: ${finalCoverUrl}${driveWarning}`);
                
                // Create metadata object with the URL
                const baseMetadata = {
                    ...isbnData.metadata,
                    googleDriveUrl: driveUrl || coverData.url
                };
                
                // Fetch additional metadata
                const metadata = await fetchMetadata(isbnData.metadata.isbn, baseMetadata);
                console.log(`Using URL for metadata: ${metadata.googleDriveUrl}`);
                
                // Create the book data object
                const bookData = {
                    isbn: isbnData.metadata.isbn,
                    title: metadata?.title || isbnData.metadata.title || 'Unknown',
                    author: metadata?.authors?.[0] || isbnData.metadata.author || 'Unknown Author',
                    cover: finalCoverUrl,
                    condition: '',
                    sheetId: isbnData.sheetId,
                    metadata: metadata
                };
                
                // Add to user's books
                userBooks.push(bookData);
                userDatabases.set(userId, userBooks);
                saveUserBooks();
                
                // Send confirmation message
                await client.sendMessage(userId, { 
                    text: `Added: ${bookData.title}${driveWarning}`
                });
            } catch (error) {
                console.error(`Error processing book pair at index ${i}:`, error);
                await client.sendMessage(userId, { 
                    text: `Error processing book: ${error.message}. Try again.`
                });
            }
        } else {
            console.log(`Skipping incomplete pair at index ${i}`);
        }
    }
    
    console.log(`Finished processing batch, total books: ${userBooks.length}`);
    return userBooks;
}

async function fetchMetadata(isbn, existingMetadata = null) {
    try {
        console.log('Fetching metadata for ISBN:', isbn);
        
        // Always create a base metadata object with the Drive URL if it exists
        const baseMetadata = {
            isbn: isbn,
            title: 'Unknown',
            source: 'Manual Entry'
        };
        
        // Preserve the Google Drive URL from existing metadata
        if (existingMetadata && existingMetadata.googleDriveUrl) {
            baseMetadata.googleDriveUrl = existingMetadata.googleDriveUrl;
            console.log(`Preserving Drive URL: ${baseMetadata.googleDriveUrl}`);
        }
        
        // 1. Try Google Books API first
        const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
        
        if (response.data.items && response.data.items.length > 0) {
            const bookData = response.data.items[0].volumeInfo;
            console.log('Found book data:', JSON.stringify(bookData, null, 2));
            
            // Create new metadata with available fields
            const newMetadata = {
                ...baseMetadata,
                title: bookData.title || 'Unknown',
                subtitle: bookData.subtitle || '',
                authors: bookData.authors || ['Unknown Author'],
                publisher: bookData.publisher || '',
                publishedDate: bookData.publishedDate || '',
                description: bookData.description || '',
                pageCount: bookData.pageCount || '',
                printType: bookData.printType || '',
                categories: bookData.categories || [],
                imageLinks: bookData.imageLinks || {},
                language: bookData.language || '',
                source: 'Google Books API'
            };
            
            // Merge other fields from existing metadata if they exist
            if (existingMetadata) {
                Object.keys(existingMetadata).forEach(key => {
                    if (!newMetadata[key] && existingMetadata[key] && key !== 'googleDriveUrl') {
                        newMetadata[key] = existingMetadata[key];
                    }
                });
            }
            
            return newMetadata;
        }
        
        console.log('No book data found in Google Books API');
        
        // 2. Try OpenBD API
        try {
            console.log('Trying OpenBD API...');
            const openbdResponse = await axios.get(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
            const openbdData = openbdResponse.data[0];
            
            if (openbdData && openbdData.summary) {
                console.log('Found OpenBD data:', JSON.stringify(openbdData, null, 2));
                
                const newMetadata = {
                    ...baseMetadata,
                    title: openbdData.summary.title || 'Unknown',
                    subtitle: openbdData.summary.subtitle || '',
                    authors: openbdData.summary.author ? [openbdData.summary.author] : ['Unknown Author'],
                    publisher: openbdData.summary.publisher || '',
                    publishedDate: openbdData.summary.pubdate || '',
                    description: openbdData.summary.description || '',
                    pageCount: openbdData.summary.pages || '',
                    printType: 'Unknown',
                    categories: openbdData.summary.subject || [],
                    imageLinks: {
                        thumbnail: openbdData.summary.cover || '',
                        smallThumbnail: openbdData.summary.cover || ''
                    },
                    language: openbdData.summary.lang || '',
                    source: 'OpenBD API'
                };
                
                // Merge other fields from existing metadata if they exist
                if (existingMetadata) {
                    Object.keys(existingMetadata).forEach(key => {
                        if (!newMetadata[key] && existingMetadata[key] && key !== 'googleDriveUrl') {
                            newMetadata[key] = existingMetadata[key];
                        }
                    });
                }
                
                return newMetadata;
            }
        } catch (openbdError) {
            console.error('OpenBD API error:', openbdError.message);
        }
        
        // 3. Try OpenLibrary API
        try {
            console.log('Trying OpenLibrary...');
            const openLibraryResponse = await axios.get(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`);
            const openLibraryData = openLibraryResponse.data[`ISBN:${isbn}`];

            if (openLibraryData) {
                console.log('Found OpenLibrary data:', JSON.stringify(openLibraryData, null, 2));
                
                const newMetadata = {
                    ...baseMetadata,
                    title: openLibraryData.title || 'Unknown',
                    subtitle: openLibraryData.subtitle || '',
                    authors: openLibraryData.authors ? openLibraryData.authors.map(author => author.name) : ['Unknown Author'],
                    publisher: openLibraryData.publishers?.[0]?.name || '',
                    publishedDate: openLibraryData.publish_date || '',
                    description: openLibraryData.description || '',
                    pageCount: openLibraryData.number_of_pages || '',
                    printType: 'Unknown',
                    categories: openLibraryData.subjects ? openLibraryData.subjects.map(s => s.name) : [],
                    imageLinks: openLibraryData.cover ? {
                        thumbnail: openLibraryData.cover.large || '',
                        smallThumbnail: openLibraryData.cover.medium || ''
                    } : {},
                    language: openLibraryData.languages?.[0]?.key || '',
                    source: 'OpenLibrary'
                };
                
                // Merge other fields from existing metadata if they exist
                if (existingMetadata) {
                    Object.keys(existingMetadata).forEach(key => {
                        if (!newMetadata[key] && existingMetadata[key] && key !== 'googleDriveUrl') {
                            newMetadata[key] = existingMetadata[key];
                        }
                    });
                }
                
                return newMetadata;
            }
        } catch (openLibraryError) {
            console.error('OpenLibrary API error:', openLibraryError.message);
        }
        
        // If all APIs failed, return the base metadata with existing fields merged
        if (existingMetadata) {
            return { ...baseMetadata, ...existingMetadata, googleDriveUrl: baseMetadata.googleDriveUrl };
        }
        
        return baseMetadata;
    } catch (error) {
        console.error('Error fetching metadata:', error);
        if (error.response) {
            console.error('API Error response:', error.response.status, error.response.data);
        }
        return baseMetadata;
    }
}

async function appendToSheet(userId, books, sheets, serviceAccount) {
    console.log('Appending to sheet for user:', userId);
    
    try {
        // Check if the user is approved
        if (!approvedSenders.has(userId)) {
            console.log(`Unauthorized user ${userId} attempted to append to sheet`);
            return null; // Return null to indicate no sheet access
        }
        
        // Ensure books is an array
        const booksArray = Array.isArray(books) ? books : [books];
        console.log('Books to append:', JSON.stringify(booksArray, null, 2));
        
        const sheetId = '1ul3-t3GyJdt5k1--AaSEVPmFZja4BmcvhETeTUqaNvM';
        const userPhone = userId.replace('@s.whatsapp.net', '');
        
        // Prepare rows for master sheet
        const rows = booksArray.map(b => {
            if (!b) {
                console.log('Skipping null/undefined book entry');
                return null;
            }

            const metadata = b.metadata || {};
            console.log(`Processing book ISBN ${b.isbn} with Drive URL: ${metadata.googleDriveUrl || 'Not Available'}`);
            
            // Get thumbnail URLs from API sources first
            const thumbnailUrl = metadata.imageLinks?.thumbnail || '';
            const smallThumbnailUrl = metadata.imageLinks?.smallThumbnail || '';
            
            // Use Drive URL as last resort
            const driveUrl = metadata.googleDriveUrl || b.cover || 'Unknown';
            console.log('Using Drive URL for column V:', driveUrl);
            
            let isbn10 = '';
            if (b.isbn && b.isbn.length === 13) {
                const base = b.isbn.slice(3, -1);
                let sum = 0;
                for (let i = 0; i < 9; i++) {
                    sum += parseInt(base[i]) * (10 - i);
                }
                const checkDigit = (11 - (sum % 11)) % 11;
                isbn10 = base + checkDigit;
            } else if (b.isbn && b.isbn.length === 10) {
                isbn10 = b.isbn;
            }
            
            return [
                b.isbn || '',
                b.title || metadata.title || 'Unknown',
                metadata.subtitle || '',
                b.author || metadata.authors?.[0] || 'Unknown',
                metadata.publisher || '',
                metadata.publishedDate || '',
                metadata.description || '',
                metadata.pageCount || '',
                metadata.printType || '',
                metadata.categories ? metadata.categories.join(', ') : '',
                thumbnailUrl || driveUrl,
                smallThumbnailUrl || driveUrl,
                metadata.language || '',
                userPhone,
                '',
                '',
                1,
                1,
                isbn10,
                metadata.source || 'Unknown',
                new Date().toISOString(),
                driveUrl
            ];
        }).filter(row => row !== null);

        if (rows.length === 0) {
            console.log('No valid rows to append');
            return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
        }

        // Append to master sheet only
        console.log(`Appending ${rows.length} rows to master sheet`);
        try {
            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: 'Books!A:V',
                valueInputOption: 'RAW',
                resource: { values: rows }
            });
            console.log('Successfully appended to master sheet');
            
            // Auto-sync user's personal sheet if it exists
            try {
                const userInfo = await getUserSheetInfo(userId, sheets);
                if (userInfo && userInfo.sheetId) {
                    console.log(`User ${userId} has a personal sheet. Auto-syncing...`);
                    const syncResult = await syncUserSheet(userId, sheets);
                    if (syncResult) {
                        console.log(`Auto-sync successful for user ${userId}`);
                    } else {
                        console.error(`Auto-sync failed for user ${userId}`);
                    }
                } else {
                    console.log(`User ${userId} doesn't have a personal sheet yet. Skipping auto-sync.`);
                }
            } catch (syncError) {
                console.error('Error during auto-sync:', syncError);
                // Continue even if sync fails - don't block the main flow
            }
        } catch (error) {
            console.error('Error appending to master sheet:', error);
            // Try to get more details about the error
            if (error.response && error.response.data) {
                console.error('Error details:', JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }
        
        return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    } catch (error) {
        console.error('Error in appendToSheet:', error);
        throw error;
    }
}

// Helper function to sync user sheet with master data
async function syncUserSheet(userId, sheets) {
    try {
        const userInfo = await getUserSheetInfo(userId, sheets);
        if (!userInfo || !userInfo.sheetId) {
            console.log(`No sheet found for user ${userId}`);
            return false;
        }
        
        // Get the user's books from the master sheet
        const masterSheetId = '1ul3-t3GyJdt5k1--AaSEVPmFZja4BmcvhETeTUqaNvM';
        const userPhone = userId.replace('@s.whatsapp.net', '');
        
        // Fetch user's books from master sheet
        const masterResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: masterSheetId,
            range: 'Books!A:V'
        });
        
        const allRows = masterResponse.data.values || [];
        
        // Filter for this user's books only (skip header row, start from index 1)
        // Normalize the WhatsApp numbers in the master sheet for comparison
        const userBooks = allRows.slice(1).filter(row => {
            if (!row[13]) return false; // Skip rows without WhatsApp number
            const rowPhone = row[13].replace('@s.whatsapp.net', '');
            return rowPhone === userPhone;
        });
        
        // Get spreadsheet info to find what sheets exist
        const spreadsheetInfo = await sheets.spreadsheets.get({
            spreadsheetId: userInfo.sheetId
        });
        
        // Find the first sheet in the spreadsheet
        const firstSheet = spreadsheetInfo.data.sheets[0].properties.title;
        console.log(`Using sheet name '${firstSheet}' for user ${userId}`);
        
        // Clear existing data in user sheet (keeping the header)
        await sheets.spreadsheets.values.clear({
            spreadsheetId: userInfo.sheetId,
            range: `${firstSheet}!A2:V`
        });
        
        // Make sure header row exists
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: userInfo.sheetId,
            range: `${firstSheet}!A1:V1`
        });
        
        if (!headerResponse.data.values || headerResponse.data.values.length === 0) {
            // Add header row if it doesn't exist
            await sheets.spreadsheets.values.update({
                spreadsheetId: userInfo.sheetId,
                range: `${firstSheet}!A1:V1`,
                valueInputOption: 'RAW',
                resource: {
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
        }
        
        // If user has books, append them to their sheet
        if (userBooks.length > 0) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: userInfo.sheetId,
                range: `${firstSheet}!A:V`,
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: userBooks
                }
            });
            console.log(`Successfully synced ${userBooks.length} books to user sheet`);
        }
        
        // Update LastUpdated timestamp in UserSheets database
        await sheets.spreadsheets.values.update({
            spreadsheetId: USER_SHEETS_SHEET_ID,
            range: `${USER_SHEETS_SHEET_NAME}!E${userInfo.rowIndex}`,
            valueInputOption: 'RAW',
            resource: {
                values: [[new Date().toISOString()]]
            }
        });
        
        return true;
    } catch (error) {
        console.error(`Error syncing sheet for user ${userId}:`, error);
        return false;
    }
}

async function extractISBN(media, visionClient) {
    console.log('Starting ISBN extraction...');
    
    try {
        // Use Gemini for OCR - it's more reliable for ISBN detection
        const geminiResult = await retryWithBackoff(async () => {
            return await model.generateContent([
                "Extract the ISBN number from this image. Look for any 10 or 13 digit number that appears to be an ISBN. Only return the ISBN number, nothing else.",
                { inlineData: { mimeType: "image/jpeg", data: media.toString('base64') } }
            ]);
        });
        
        const geminiText = geminiResult.response.text();
        console.log('Gemini ISBN OCR result:', geminiText);
        
        // First try to match exact ISBN pattern in Gemini result
        const isbnMatch = geminiText.match(/(\d[\d\-]{8,}[\dXx])/);
        if (isbnMatch) {
            const isbn = isbnMatch[1].replace(/[^0-9Xx]/g, '');
            if (isbn.length === 10 || isbn.length === 13) {
                console.log('Found ISBN with Gemini:', isbn);
                return isbn;
            }
        }
        
        // If no match with regex, try to use the full text if it's a clean number
        const cleanText = geminiText.replace(/[^0-9Xx]/g, '');
        if (cleanText.length === 10 || cleanText.length === 13) {
            console.log('Found ISBN from clean Gemini text:', cleanText);
            return cleanText;
        }
        
        console.log('No valid ISBN found with Gemini');
        return null;
        } catch (error) {
        console.error('Gemini ISBN OCR error:', error);
        
        // Fall back to Google Vision if Gemini fails
        try {
            console.log('Falling back to Google Vision OCR...');
            const [result] = await visionClient.textDetection({ 
                image: { content: media } 
            });
            
            const isbnText = result.textAnnotations[0]?.description || '';
            console.log('Google Vision OCR result:', isbnText);
            
            // Look for ISBN label with more flexible pattern
            const isbnLabelMatch = isbnText.match(/ISBN[:\-\s]*(\d[\d\-\s]{8,}[\dXx])/i);
            if (isbnLabelMatch) {
                const isbn = isbnLabelMatch[1].replace(/[^0-9Xx]/g, '');
                if (isbn.length === 10 || isbn.length === 13) {
                    console.log('Found ISBN with label from Vision:', isbn);
                    return isbn;
                }
            }
            
            // Look for any ISBN-like number with more flexible pattern
            const allNumbers = isbnText.match(/\d[\d\-\s]{8,}[\dXx]/g) || [];
            for (const numStr of allNumbers) {
                const isbn = numStr.replace(/[^0-9Xx]/g, '');
                if (isbn.length === 10 || isbn.length === 13) {
                    console.log('Found ISBN by pattern from Vision:', isbn);
                    return isbn;
                }
            }
            
            // If no match found, try to find any 10 or 13 digit number
            const cleanText = isbnText.replace(/[^0-9Xx]/g, '');
            const isbnMatch = cleanText.match(/\d{10}|\d{13}/);
            if (isbnMatch) {
                console.log('Found ISBN from clean text:', isbnMatch[0]);
                return isbnMatch[0];
            }
        } catch (visionError) {
            console.error('Google Vision fallback error:', visionError);
        }
        
        return null;
    }
}

async function getUserBooksFromSheet(userId, sheets, serviceAccount) {
    console.log('Getting books from sheet for user:', userId);
    
    try {
        // Get user sheet info
        const userInfo = await getUserSheetInfo(userId, sheets);
        console.log('User sheet info:', userInfo);
        
        if (!userInfo || !userInfo.sheetId) {
            console.log('No user sheet found for:', userId);
            return [];
        }
        
        // Get from user sheet instead of master sheet - use the default sheet (Sheet1)
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: userInfo.sheetId,
            range: 'Sheet1!A:V'  // Use Sheet1 instead of Books
        });
        
        const rows = response.data.values || [];
        console.log(`Found ${rows.length} total rows in user sheet`);
        
        // If only header row exists or no rows at all, return empty array
        if (rows.length <= 1) {
            console.log('No books found in user sheet');
            return [];
        }
        
        // Skip header row
        const userBooks = rows.slice(1);
        console.log(`Found ${userBooks.length} books for user ${userId}`);
        
        // Filter out any empty rows
        const validBooks = userBooks.filter(row => row[0] && row[1]); // Check if ISBN and title exist
        console.log(`Found ${validBooks.length} valid books for user ${userId}`);
        
        return validBooks.map(row => ({
            isbn: row[0] || 'Unknown',
            title: row[1] || 'Unknown',
            author: row[3] || 'Unknown',
            cover: row[10] || '',
            condition: '',
            sheetId: userInfo.sheetId,
            metadata: {
                subtitle: row[2] || '',
                publisher: row[4] || '',
                publishedDate: row[5] || '',
                description: row[6] || '',
                pageCount: row[7] || '',
                printType: row[8] || '',
                categories: row[9] ? row[9].split(', ') : [],
                language: row[12] || '',
                source: row[18] || ''
            }
        }));
    } catch (error) {
        console.error('Error getting books from sheet:', error);
        throw error;
    }
}

function formatBooksListMessage(books, page = 1) {
    // Set pagination parameters
    const MAX_BOOKS_PER_PAGE = 25;
    const totalPages = Math.ceil(books.length / MAX_BOOKS_PER_PAGE);
    
    // Calculate slice range for current page
    const startIndex = (page - 1) * MAX_BOOKS_PER_PAGE;
    const endIndex = Math.min(startIndex + MAX_BOOKS_PER_PAGE, books.length);
    
    // Get books for current page
    const booksToShow = books.slice(startIndex, endIndex);
    
    // Build message header with pagination info and sheet URL
    let message = `📚 *Your Library (${books.length} books - Page ${page}/${totalPages}):*\n`;
    message += `🔗 *Your Sheet:* https://docs.google.com/spreadsheets/d/${books[0].sheetId}\n\n`;
    
    // No books on this page
    if (booksToShow.length === 0) {
        return `You've reached the end of your library. Use "view books" to start from the beginning.`;
    }
    
    // Format each book entry
    booksToShow.forEach((book, index) => {
        const bookNumber = startIndex + index + 1;
        message += `*${bookNumber}.* ${book.title}\n`;
        message += `   Author: ${book.author}\n`;
        message += `   ISBN: ${book.isbn}\n`;
        if (book.publishedDate) {
            message += `   Published: ${book.publishedDate}\n`;
        }
        if (index < booksToShow.length - 1) {
            message += '\n';
        }
    });
    
    // Add pagination navigation help
    if (page < totalPages) {
        message += `\n\n_Showing ${booksToShow.length} of ${books.length} books. Send "view more" or "next page" to see more._`;
    } else if (page === totalPages && books.length > MAX_BOOKS_PER_PAGE) {
        message += `\n\n_End of list. Send "view books" to start again._`;
    }
    
    return message;
}

// Helper function to get user sheet info from UserSheets database
async function getUserSheetInfo(userId, sheets) {
    try {
        console.log('Getting sheet info for user:', userId);
        
        // Normalize the user ID by removing the @s.whatsapp.net suffix if present
        const normalizedUserId = userId.replace('@s.whatsapp.net', '');
        console.log('Normalized user ID:', normalizedUserId);
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: USER_SHEETS_SHEET_ID,
            range: `${USER_SHEETS_SHEET_NAME}!${USER_SHEETS_RANGE}`,
        });

        const rows = response.data.values || [];
        console.log(`Found ${rows.length} rows in UserSheets database`);
        
        // Find the user's row by exact matching of normalized numbers
        const userRowIndex = rows.findIndex(row => {
            if (!row[0]) return false;
            const rowUserId = row[0].replace('@s.whatsapp.net', '');
            return rowUserId === normalizedUserId;
        });
        
        console.log('User row index:', userRowIndex);
        
        if (userRowIndex !== -1) {
            const userRow = rows[userRowIndex];
            if (!userRow[1]) { // Check if sheetId is empty
                console.log('User sheet ID is empty for:', userId);
                return null;
            }
            const userInfo = {
                whatsappNumber: userRow[0],
                sheetId: userRow[1],
                createdDate: userRow[2],
                gmail: userRow[3],
                lastUpdated: userRow[4],
                rowIndex: userRowIndex + 1 // Add 1 because sheet rows are 1-indexed
            };
            console.log('Found user info:', userInfo);
            return userInfo;
        }
        console.log('User not found in UserSheets database:', userId);
        return null;
    } catch (error) {
        console.error('Error getting user sheet info:', error);
        return null;
    }
}

// Helper function to ensure UserSheets sheet exists
async function ensureUserSheetsSheet(sheets) {
    try {
        // Try to get the sheet
        await sheets.spreadsheets.get({
            spreadsheetId: USER_SHEETS_SHEET_ID
        });
        
        // Check if UserSheets sheet exists
        const sheetExists = await sheets.spreadsheets.values.get({
            spreadsheetId: USER_SHEETS_SHEET_ID,
            range: `${USER_SHEETS_SHEET_NAME}!A1`
        }).catch(() => null);
        
        if (!sheetExists) {
            // Create the UserSheets sheet
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: USER_SHEETS_SHEET_ID,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: USER_SHEETS_SHEET_NAME
                            }
                        }
                    }]
                }
            });
            
            // Add headers
            await sheets.spreadsheets.values.update({
                spreadsheetId: USER_SHEETS_SHEET_ID,
                range: `${USER_SHEETS_SHEET_NAME}!A:E`,
                valueInputOption: 'RAW',
                resource: {
                    values: [['WhatsApp Number', 'Sheet ID', 'Created Date', 'Gmail', 'Last Updated']]
                }
            });
            
            console.log('Created UserSheets sheet with headers');
        }
        return true;
    } catch (error) {
        console.error('Error ensuring UserSheets sheet exists:', error);
        return false;
    }
}

// Helper function to save user sheet info to UserSheets database
async function saveUserSheetInfo(userId, sheetId, gmail, sheets) {
    try {
        // First ensure the sheet exists
        await ensureUserSheetsSheet(sheets);
        
        const now = new Date().toISOString();
        const userInfo = await getUserSheetInfo(userId, sheets);
        
        if (userInfo) {
            // Update existing user
            await sheets.spreadsheets.values.update({
                spreadsheetId: USER_SHEETS_SHEET_ID,
                range: `${USER_SHEETS_SHEET_NAME}!B${userInfo.rowIndex}:E${userInfo.rowIndex}`,
                valueInputOption: 'RAW',
                resource: {
                    values: [[sheetId, userInfo.createdDate, gmail, now]]
                }
            });
        } else {
            // Add new user
            await sheets.spreadsheets.values.append({
                spreadsheetId: USER_SHEETS_SHEET_ID,
                range: `${USER_SHEETS_SHEET_NAME}!A:E`,
                valueInputOption: 'RAW',
                resource: {
                    values: [[userId, sheetId, now, gmail, now]]
                }
            });
        }
        return true;
    } catch (error) {
        console.error('Error saving user sheet info:', error);
        return false;
    }
}

// Helper function to create a new user sheet
async function createUserSheet(userId, books, sheets) {
    try {
        // Create new sheet with user's number as name
        const sheetName = userId.replace('@s.whatsapp.net', '');
        const sheet = await sheets.spreadsheets.create({
            resource: {
                properties: {
                    title: `BookDB_${sheetName}`
                }
            }
        });
        
        const sheetId = sheet.data.spreadsheetId;
        
        // Add headers to the sheet
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: 'A1:V1',
            valueInputOption: 'RAW',
            resource: {
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
        
        // Format the sheet - header row with special formatting, body with normal formatting
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                requests: [
                    // Header row formatting (A1:V1)
                    {
                        repeatCell: {
                            range: {
                                sheetId: 0,
                                startRowIndex: 0,
                                endRowIndex: 1,
                                startColumnIndex: 0,
                                endColumnIndex: 22
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
                                    },
                                    horizontalAlignment: 'CENTER'
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
                        }
                    },
                    // Body formatting (A2 onwards)
                    {
                        repeatCell: {
                            range: {
                                sheetId: 0,
                                startRowIndex: 1,
                                startColumnIndex: 0,
                                endColumnIndex: 22
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: null,
                                    textFormat: {
                                        bold: false
                                    },
                                    horizontalAlignment: 'LEFT'
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
                        }
                    },
                    // Auto-resize all columns
                    {
                        autoResizeDimensions: {
                            dimensions: {
                                sheetId: 0,
                                dimension: 'COLUMNS',
                                startIndex: 0,
                                endIndex: 22
                            }
                        }
                    }
                ]
            }
        });
        
        // If books are provided, add them to the sheet
        if (books && books.length > 0) {
            // Format data for User Sheet
            const formattedData = books.map(book => [
                book.isbn,                    // ISBN
                book.title,                   // Title
                book.metadata.subtitle || '', // Subtitle
                book.author,                  // Author
                book.metadata.publisher || '', // Publisher
                book.metadata.publishedDate || '', // Published Date
                book.metadata.description || '', // Description
                book.metadata.pageCount || '', // Page
                book.metadata.printType || '', // PrintType
                (book.metadata.categories || []).join(', '), // Categories
                book.metadata.imageLinks?.thumbnail || '', // Thumbnail
                book.metadata.imageLinks?.smallThumbnail || '', // Thumbnail Small
                book.metadata.language || '', // Language
                userId,                       // Sender_Whatsapp
                '',                          // Sender_Email (will be updated when shared)
                '',                          // Sender_Name
                '1',                          // Sender_Frequency
                '1',                          // Global_Frequency
                book.metadata.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier || '', // ISBN_10
                'WhatsApp',                   // Source
                new Date().toISOString(),     // Timestamps
                book.cover || ''              // Image URL
            ]);
            
            // Add the data to the sheet
            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: 'A:V',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: formattedData
                }
            });
            
            console.log(`Added ${formattedData.length} books to new sheet ${sheetId}`);
        }
        
        return sheetId;
    } catch (error) {
        console.error('Error creating user sheet:', error);
        throw error;
    }
}

// Helper function to share sheet with user
async function shareSheetWithUser(sheetId, email, drive) {
    try {
        // Share with editor permissions
        await drive.permissions.create({
            fileId: sheetId,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: email
            }
        });

        // Also share with mansonwong.consulting@gmail.com as editor
        await drive.permissions.create({
            fileId: sheetId,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: 'mansonwong.consulting@gmail.com'
            }
        });

        return true;
    } catch (error) {
        console.error('Error sharing sheet with user:', error);
        throw error;
    }
}

async function appendToMasterSheet(books, userId, sheets) {
    try {
        console.log(`Appending to sheet for user: ${userId}`);
        console.log('Books to append:', JSON.stringify(books, null, 2));
        
        // Get the master sheet ID from environment variable
        const masterSheetId = process.env.MASTER_SHEET_ID;
        if (!masterSheetId) {
            throw new Error('MASTER_SHEET_ID environment variable is not set');
        }
        
        // Prepare the rows to append
        const rowsToAppend = [];
        
        for (const book of books) {
            // Skip if the WhatsApp number contains @s.whatsapp.net
            if (userId.includes('@s.whatsapp.net')) {
                console.log(`Skipping duplicate record for ${userId} as it contains @s.whatsapp.net suffix`);
                continue;
            }
            
            console.log(`Processing book ISBN ${book.isbn} with Drive URL: ${book.metadata?.googleDriveUrl || 'Not Available'}`);
            
            // Use the Drive URL for column V if available, otherwise use the cover URL
            const imageUrl = book.metadata?.googleDriveUrl || book.cover;
            console.log(`Using Drive URL for column V: ${imageUrl}`);
            
            // Create a row with all the book data
            const row = [
                book.isbn || '',                    // A - ISBN
                book.title || '',                   // B - Title
                book.metadata?.subtitle || '',      // C - Subtitle
                book.author || '',                  // D - Author
                book.metadata?.publisher || '',     // E - Publisher
                book.metadata?.publishedDate || '', // F - Published Date
                book.metadata?.description || '',   // G - Description
                book.metadata?.pageCount || '',     // H - Page Count
                book.metadata?.printType || '',     // I - Print Type
                (book.metadata?.categories || []).join(', '), // J - Categories
                book.metadata?.imageLinks?.smallThumbnail || '', // K - Small Thumbnail
                book.metadata?.imageLinks?.thumbnail || '',      // L - Thumbnail
                book.metadata?.language || '',      // M - Language
                userId,                             // N - Sender WhatsApp
                '',                                 // O - Sender Email (empty for now)
                '',                                 // P - Sender Name (empty for now)
                '',                                 // Q - Sender Frequency (empty for now)
                '',                                 // R - Global Frequency (empty for now)
                book.metadata?.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier || '', // S - ISBN-10
                book.metadata?.source || '',        // T - Source
                new Date().toISOString(),          // U - Timestamp
                imageUrl                           // V - Image URL
            ];
            
            rowsToAppend.push(row);
        }
        
        if (rowsToAppend.length > 0) {
            console.log(`Appending ${rowsToAppend.length} rows to master sheet`);
            
            // Append the rows to the master sheet
            await sheets.spreadsheets.values.append({
                spreadsheetId: masterSheetId,
                range: 'Books!A:V',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: rowsToAppend
                }
            });
            
            console.log('Successfully appended to master sheet');
        } else {
            console.log('No rows to append after filtering duplicates');
        }
        
        return true;
    } catch (error) {
        console.error('Error appending to master sheet:', error);
        return false;
    }
}

// Enhanced environment variable handling
const requiredEnvVars = [
  'GEMINI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT',
  'WHATSAPP_BOT_NUMBER',
  'MASTER_SHEET_ID',
  'DRIVE_FOLDER_ID'
];

// Check for required environment variables
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Handle Google Service Account
if (process.env.GOOGLE_SERVICE_ACCOUNT) {
  try {
    const serviceAccountJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(serviceAccountJson);
    
    // Instead of writing to file, use the JSON directly
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/cloud-vision'
      ]
    });
    
    // Set the auth globally
    google.options({ auth });
  } catch (error) {
    console.error('Error handling service account:', error);
    process.exit(1);
  }
}

// Handle WhatsApp Auth State
const authStatePath = './auth_info/';
if (!fs.existsSync(authStatePath)) {
  fs.mkdirSync(authStatePath, { recursive: true });
}

// If auth state exists in environment variable, write it to file
if (process.env.WHATSAPP_AUTH_STATE) {
  try {
    const authState = JSON.parse(process.env.WHATSAPP_AUTH_STATE);
    fs.writeFileSync(path.join(authStatePath, 'creds.json'), JSON.stringify(authState));
  } catch (error) {
    console.error('Error handling WhatsApp auth state:', error);
    process.exit(1);
  }
}

connectToWhatsApp();