require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const vision = require('@google-cloud/vision');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const os = require('os');

const authDir = 'auth_info';
const sheetIdsFile = path.join(authDir, 'sheet_ids.json');
const userBooksFile = path.join(authDir, 'user_books.json');
const authenticatedNumber = '85267582915@s.whatsapp.net'; // Your number as admin
const approvedSenders = new Set([authenticatedNumber, '85262022358@s.whatsapp.net', '85290977671@s.whatsapp.net']); // Initial approved senders
const userSheetIds = new Map(); // Map phone numbers to their sheet IDs
const userDatabases = new Map(); // Store books in memory per user
let readyMessageSent = false; // Flag to track if ready message has been sent
let isShuttingDown = false; // Flag to track shutdown state
let reconnectAttempts = 0; // Track reconnection attempts
const MAX_RECONNECT_ATTEMPTS = 3; // Maximum number of reconnection attempts

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
        maxOutputTokens: 2048
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
    if (isShuttingDown) return;
    
    console.log('Script starting...');
    try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
        console.log('Auth state loaded');
        
        const client = makeWASocket({ 
            auth: state,
            connectTimeoutMs: 180000,
            retryRequestDelayMs: 10000,
            browser: ['Chrome', 'Desktop', '1.0.0'],
            qrTimeout: 180000,
            maxRetries: 15,
            patchMessageBeforeSending: message => {
                const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
                if (requiresPatch) {
                    message = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...message } } };
                }
                return message;
            }
        });
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

                    if (!approvedSenders.has(sender) || (userId !== authenticatedNumber && !approvedSenders.has(userId))) {
                console.log(`Ignoring message from ${sender} to ${userId}`);
                continue;
            }

            let userBooks = userDatabases.get(sender) || [];
            let queue = imageQueue.get(sender) || [];

            if (msg.message?.conversation) {
                const text = msg.message.conversation.toLowerCase();
                if (text === 'finish') {
                    console.log(`Finish command received from ${sender}, queue length: ${queue.length}`);
                    if (queue.length > 0) {
                                userBooks = await processBatch(sender, queue, userBooks, client, sheets, drive);
                        imageQueue.set(sender, []);
                    }
                            
                    if (userBooks.length > 0) {
                        try {
                                    console.log(`Attempting to save ${userBooks.length} books to sheet for ${sender}`);
                                    const link = await appendToSheet(sender, userBooks, sheets, serviceAccount);
                                    console.log(`Successfully saved to sheet: ${link}`);
                                    await sendMessageWithRetry(client, sender, { text: `Your book database: ${link}` });
                                    userDatabases.set(sender, []);
                                    saveUserBooks();
                        } catch (error) {
                            console.error('Error in finish flow:', error);
                                    await sendMessageWithRetry(client, sender, { text: 'Error saving to sheet. Please try again.' });
                        }
                    } else {
                        const existingSheetId = userSheetIds.get(sender);
                        const link = existingSheetId ? `https://docs.google.com/spreadsheets/d/${existingSheetId}/edit` : 'No books yet.';
                        console.log(`No new books, sending: ${link}`);
                                await sendMessageWithRetry(client, sender, { text: link });
                            }
                        } else if (text === 'next') {
                            console.log(`Next command received from ${sender}, clearing queue`);
                            imageQueue.set(sender, []);
                            await sendMessageWithRetry(client, sender, { text: 'Queue cleared. Send ISBN image to start new entry.' });
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
                        } else if (text.startsWith('isbn:')) {
                            const isbn = text.split('isbn:')[1].trim().replace(/[^0-9]/g, '');
                            console.log('Processing ISBN input:', isbn);
                            
                            if (isbn.length === 10 || isbn.length === 13) {
                                try {
                                    const metadata = await fetchMetadata(isbn);
                                    if (metadata.title && metadata.authors?.[0]) {
                                        const bookData = {
                                            isbn: isbn,
                                            title: metadata.title,
                                            author: metadata.authors[0],
                                            cover: metadata.imageLinks?.thumbnail || 'Unknown',
                                            condition: '',
                                            metadata: metadata
                                        };
                                        userBooks.push(bookData);
                                        userDatabases.set(sender, userBooks);
                                        saveUserBooks();
                                        await sendMessageWithRetry(client, sender, { text: `Added book: ${bookData.title} by ${bookData.author}\nSend a cover image to complete the entry.` });
                                        queue.push({ type: 'isbn', data: null, url: null, metadata });
                                        imageQueue.set(sender, queue);
                                        
                                        // Save to sheet immediately
                                        try {
                                            await appendToSheet(sender, {
                                                isbn: isbn,
                                                title: metadata.title,
                                                authors: metadata.authors.join(', '),
                                                publisher: metadata.publisher || '',
                                                publishedDate: metadata.publishedDate || '',
                                                description: metadata.description || '',
                                                pageCount: metadata.pageCount || '',
                                                categories: metadata.categories?.join(', ') || '',
                                                imageUrl: '',
                                                timestamp: new Date().toISOString()
                                            });
                                        } catch (error) {
                                            console.error('Error saving to sheet:', error);
                                        }
                                    } else {
                                        await sendMessageWithRetry(client, sender, { text: 'Could not find book details for this ISBN. Please try again.' });
                                    }
                                } catch (error) {
                                    console.error('Error processing ISBN:', error);
                                    await sendMessageWithRetry(client, sender, { text: 'Error processing ISBN. Please try again.' });
                                }
                            } else {
                                await sendMessageWithRetry(client, sender, { text: 'Invalid ISBN format. Please provide a valid 10 or 13-digit ISBN.' });
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
        
        const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
        
        if (response.data.items && response.data.items.length > 0) {
            const bookData = response.data.items[0].volumeInfo;
            const newMetadata = {
                ...baseMetadata,
                title: bookData.title,
                subtitle: bookData.subtitle,
                authors: bookData.authors,
                publisher: bookData.publisher,
                publishedDate: bookData.publishedDate,
                description: bookData.description,
                pageCount: bookData.pageCount,
                printType: bookData.printType,
                categories: bookData.categories,
                imageLinks: bookData.imageLinks,
                language: bookData.language,
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
        
        // If Google Books API failed, return the base metadata with existing fields merged
        if (existingMetadata) {
            return { ...baseMetadata, ...existingMetadata, googleDriveUrl: baseMetadata.googleDriveUrl };
        }
        
        return baseMetadata;
    } catch (error) {
        console.error('Error fetching metadata:', error);
        
        // Create a base metadata with Drive URL preserved
        const baseMetadata = {
            isbn: isbn,
            title: 'Unknown',
            source: 'Manual Entry'
        };
        
        // Preserve the Google Drive URL from existing metadata
        if (existingMetadata && existingMetadata.googleDriveUrl) {
            baseMetadata.googleDriveUrl = existingMetadata.googleDriveUrl;
        }
        
        // Return existing metadata if available, otherwise just the base
        return existingMetadata ? { ...baseMetadata, ...existingMetadata, googleDriveUrl: baseMetadata.googleDriveUrl } : baseMetadata;
    }
}

async function appendToSheet(userId, books, sheets, serviceAccount) {
    console.log('Appending to sheet for user:', userId);
    
    try {
        // Ensure books is an array
        const booksArray = Array.isArray(books) ? books : [books];
        console.log('Books to append:', JSON.stringify(booksArray, null, 2));
        
        const sheetId = '1ul3-t3GyJdt5k1--AaSEVPmFZja4BmcvhETeTUqaNvM';
        
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
                thumbnailUrl || driveUrl, // Column K - Thumbnail (API first, Drive as fallback)
                smallThumbnailUrl || driveUrl, // Column L - Small Thumbnail (API first, Drive as fallback)
                metadata.language || '',
                userId.replace('@s.whatsapp.net', ''),
                '',
                '',
                1,
                1,
                isbn10,
                metadata.source || 'Unknown',
                new Date().toISOString(),
                driveUrl // Column V - Google Drive URL
            ];
        }).filter(row => row !== null);

        if (rows.length === 0) {
            console.log('No valid rows to append');
            return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
        }

        console.log(`Appending ${rows.length} rows to sheet`);
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Books!A:V',
            valueInputOption: 'RAW',
            resource: { values: rows }
        });
        
        console.log('Sheet append response:', response.data);
        return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
            } catch (error) {
        console.error('Error in appendToSheet:', error);
                throw error;
            }
        }

async function extractISBN(media, visionClient) {
    console.log('Starting ISBN extraction...');
    
    try {
        const geminiResult = await retryWithBackoff(async () => {
            return await model.generateContent([
                "Extract the ISBN number from this image. Look for any 10 or 13 digit number that appears to be an ISBN. Only return the ISBN number, nothing else.",
                { inlineData: { mimeType: "image/jpeg", data: media.toString('base64') } }
            ]);
        });
        const geminiText = geminiResult.response.text();
        console.log('Gemini ISBN OCR result:', geminiText);
        
        const isbnMatch = geminiText.match(/(\d{10,13})/);
        if (isbnMatch) return isbnMatch[1];
        } catch (error) {
        console.error('Gemini ISBN OCR error:', error);
    }
    
    try {
        const [result] = await retryWithBackoff(async () => {
            return await visionClient.textDetection({ image: { content: media } });
        });
        const isbnText = result.textAnnotations[0]?.description || '';
        console.log('Google Vision OCR result:', isbnText);
        
        const isbnMatch = isbnText.match(/(?:ISBN[- ]*(?:10|13)*:*\s*)?(?:\d[- ]*){10,13}/i);
        if (isbnMatch) return isbnMatch[0].replace(/[^0-9]/g, '');
        } catch (error) {
        console.error('Google Vision ISBN OCR error:', error);
    }
    
    console.log('No valid ISBN found');
    return null;
}

connectToWhatsApp();