require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const vision = require('@google-cloud/vision');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const authDir = 'auth_info';
const sheetIdsFile = path.join(authDir, 'sheet_ids.json');
const userBooksFile = path.join(authDir, 'user_books.json');
const authenticatedNumber = '85267582915@s.whatsapp.net'; // Your number as admin
const approvedSenders = new Set([authenticatedNumber, '85262022358@s.whatsapp.net']); // Initial approved senders
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
            // Add a small delay before each attempt
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
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
            // Simple delay between retries
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return false;
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
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {},
                                },
                                ...message,
                            },
                        },
                    };
                }
                return message;
            },
            qr: {
                quality: 1,
                scale: 8,
                margin: 4,
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            },
            connectTimeoutMs: 180000,
            retryRequestDelayMs: 10000,
            maxRetries: 15,
            qrTimeout: 180000,
            browser: ['Chrome', 'Desktop', '1.0.0'],
            connectTimeoutMs: 180000,
            retryRequestDelayMs: 10000,
            maxRetries: 15,
            qrTimeout: 180000,
            browser: ['Chrome', 'Desktop', '1.0.0']
        });
        console.log('WhatsApp socket created');

        client.ev.on('creds.update', saveCreds);

        const visionClient = new vision.ImageAnnotatorClient({
            credentials: require('./service-account.json')
        });
        console.log('Vision client initialized successfully');

        const serviceAccount = require('./service-account.json');
        console.log('Service account loaded:', serviceAccount.client_email);

        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccount,
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive.file',
                'https://www.googleapis.com/auth/drive'
            ]
        });

        // Initialize the sheets client with retry logic
        let sheets;
        try {
            sheets = google.sheets({ version: 'v4', auth });
            console.log('Google Sheets client initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Google Sheets client:', error);
            throw new Error('Failed to initialize Google Sheets client. Please check your service account credentials.');
        }

        const imageQueue = new Map(); // Queue images per user

        client.ev.on('connection.update', (update) => {
            if (isShuttingDown) return;
            
            const { connection, lastDisconnect, qr } = update;
            console.log('Connection update:', { connection, lastDisconnect, qr: qr ? 'QR received' : 'No QR' });
            
            if (qr) {
                console.log('\n\n=== QR CODE RECEIVED ===\n');
                try {
                    require('qrcode-terminal').generate(qr, { small: true });
                    console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
                } catch (error) {
                    console.error('Error generating QR code:', error);
                }
            }
            
            if (connection === 'open') {
                console.log('WhatsApp connected successfully!');
                reconnectAttempts = 0;
                // Send ready message only once
                if (!readyMessageSent) {
                    const sendReadyMessage = async () => {
                        try {
                            // Add a longer initial delay
                            await new Promise(resolve => setTimeout(resolve, 15000));
                            await sendMessageWithRetry(client, authenticatedNumber, { 
                                text: 'Bot ready. Send book images or "approve <number>" to add senders.' 
                            });
                            readyMessageSent = true;
                        } catch (error) {
                            console.error('Failed to send ready message:', error);
                            if (!readyMessageSent && !isShuttingDown) {
                                setTimeout(sendReadyMessage, 15000);
                            }
                        }
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

        // Handle process termination
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
                                userBooks = await processBatch(sender, queue, userBooks, client, sheets);
                                imageQueue.set(sender, []);
                            }
                            
                            if (userBooks.length > 0) {
                                try {
                                    console.log(`Attempting to save ${userBooks.length} books to sheet for ${sender}`);
                                    console.log('Books to save:', JSON.stringify(userBooks, null, 2));
                                    
                                    // Ensure each book has required data
                                    const validBooks = userBooks.filter(book => {
                                        if (!book.isbn) {
                                            console.error('Book missing ISBN:', book);
                                            return false;
                                        }
                                        return true;
                                    });
                                    
                                    if (validBooks.length === 0) {
                                        console.log('No valid books to save');
                                        await sendMessageWithRetry(client, sender, { text: 'No valid books to save. Please try again.' });
                                        return;
                                    }
                                    
                                    const link = await appendToSheet(sender, validBooks, sheets, serviceAccount.client_email);
                                    console.log(`Successfully saved to sheet: ${link}`);
                                    await sendMessageWithRetry(client, sender, { text: `Your book database: ${link}` });
                                    userDatabases.set(sender, []); // Clear after saving
                                    saveUserBooks(); // Save the empty state
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
                        }
                        continue;
                    }

                    // Handle image messages
                    if (msg.message?.imageMessage) {
                        console.log('Received image message');
                        try {
                            const media = await downloadMediaMessage(msg, 'buffer', {}, { logger: client.logger, reuploadRequest: client.updateMediaMessage });
                            console.log('Successfully downloaded image');
                            
                            // First image is ISBN
                            if (queue.length === 0) {
                                console.log('Processing ISBN image first...');
                                const isbnNumber = await extractISBN(media, visionClient);
                                if (isbnNumber) {
                                    console.log('Found ISBN:', isbnNumber);
                                    
                                    const metadata = await fetchMetadata(isbnNumber);
                                    if (metadata.title && metadata.authors?.[0]) {
                                        // Store the ISBN data in queue with the ISBN number
                                        metadata.isbn = isbnNumber; // Add ISBN to metadata
                                        queue.push({ type: 'isbn', data: media, url: msg.message.imageMessage.url, metadata });
                                        imageQueue.set(sender, queue);
                                        
                                        try {
                                            console.log('Metadata received:', metadata);
                                            const title = metadata.title || 'Unknown Title';
                                            const author = metadata.authors?.[0] || 'Unknown Author';
                                            
                                            await sendMessageWithRetry(client, sender, { 
                                                text: `Found: ${title} by ${author}\nSend cover image next.` 
                                            });
                                        } catch (error) {
                                            console.error('Failed to send WhatsApp message:', error);
                                        }
                                    } else {
                                        await sendMessageWithRetry(client, sender, { 
                                            text: 'Could not find book details. Please try again with a clearer ISBN image.' 
                                        });
                                    }
                                } else {
                                    console.log('Image is not an ISBN, ignoring...');
                                    await sendMessageWithRetry(client, sender, { 
                                        text: 'Could not find a valid ISBN in the image. Please try again with a clearer image of the ISBN.' 
                                    });
                                }
                            } 
                            // Second image is cover
                            else if (queue.length === 1) {
                                console.log('Processing cover image...');
                                const isbnData = queue[0];
                                
                                // Create the complete book record
                                const bookData = {
                                    isbn: isbnData.metadata.isbn,
                                    title: isbnData.metadata.title,
                                    author: isbnData.metadata.authors?.[0] || 'Unknown Author',
                                    cover: msg.message.imageMessage.url,
                                    condition: '',
                                    metadata: isbnData.metadata
                                };
                                
                                console.log('Created book data:', bookData);
                                
                                // Add to user's book database
                                userBooks.push(bookData);
                                userDatabases.set(sender, userBooks);
                                saveUserBooks();
                                
                                try {
                                    await sendMessageWithRetry(client, sender, { text: `Added: ${bookData.title}` });
                                } catch (error) {
                                    console.error('Failed to send WhatsApp message:', error);
                                }
                                
                                // Clear the queue after processing
                                imageQueue.set(sender, []);
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
                    // Try to send error message to user
                    try {
                        await client.sendMessage(msg.key.remoteJid, { text: 'Sorry, there was an error processing your message. Please try again.' });
                    } catch (sendError) {
                        console.error('Failed to send error message:', sendError);
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        if (!isShuttingDown) {
            setTimeout(connectToWhatsApp, 10000);
        }
    }
}

async function processBatch(userId, queue, userBooks, client, sheets) {
    console.log(`Processing batch for ${userId}, queue length: ${queue.length}`);
    console.log('Queue contents:', JSON.stringify(queue, null, 2));
    
    // Process each pair of images (ISBN + cover)
    for (let i = 0; i < queue.length; i += 2) {
        if (queue[i] && queue[i + 1]) {
            const isbnData = queue[i];
            const coverData = queue[i + 1];
            
            console.log('Processing pair:', {
                isbnData: isbnData.metadata,
                coverUrl: coverData.url
            });
            
            // Create the complete book record
            const bookData = {
                isbn: isbnData.metadata.isbn,
                title: isbnData.metadata.title,
                author: isbnData.metadata.authors?.[0] || 'Unknown Author',
                cover: coverData.url,
                condition: '',
                metadata: isbnData.metadata
            };
            
            console.log('Created book data:', bookData);
            
            // Add to user's book database
            userBooks.push(bookData);
            userDatabases.set(userId, userBooks);
            saveUserBooks();
            
            try {
                console.log(`Sending WhatsApp message for ${bookData.title} by ${bookData.author}`);
                await client.sendMessage(userId, { text: `Added: ${bookData.title}` });
            } catch (error) {
                console.error(`Failed to send WhatsApp message for ${bookData.title}:`, error);
            }
        } else {
            console.log('Skipping incomplete pair:', { i, queueLength: queue.length });
        }
    }
    
    console.log(`Batch processed, userBooks length: ${userBooks.length}`);
    console.log('Final userBooks:', JSON.stringify(userBooks, null, 2));
    return userBooks;
}

async function processPair(cover, isbn, visionClient) {
    console.log('Processing pair - starting OCR...');
    
    // Try multiple OCR methods with retry logic
    let isbnNumber = null;
    let title = null;
    
    // 1. Try Gemini Vision for ISBN image first
    try {
        console.log('Trying Gemini Vision on ISBN image...');
        const geminiResult = await retryWithBackoff(async () => {
            return await model.generateContent([
                "Extract the ISBN number from this image. Only return the ISBN number, nothing else.",
                {
                    inlineData: {
                        mimeType: "image/jpeg",
                        data: isbn.data.toString('base64')
                    }
                }
            ]);
        });
        const geminiText = geminiResult.response.text();
        console.log('Gemini ISBN OCR result:', geminiText);
        
        const isbnMatch = geminiText.match(/(\d{10,13})/);
        if (isbnMatch) {
            isbnNumber = isbnMatch[1];
            console.log('Found ISBN with Gemini:', isbnNumber);
        }
    } catch (error) {
        console.error('Gemini ISBN OCR error:', error);
    }
    
    // 2. If Gemini failed, try Google Vision for ISBN
    if (!isbnNumber) {
        console.log('Trying Google Vision on ISBN image...');
        try {
            const [isbnResult] = await retryWithBackoff(async () => {
                return await visionClient.textDetection({ image: { content: isbn.data } });
            });
            console.log('Google Vision ISBN OCR result:', isbnResult?.textAnnotations?.[0]?.description);
            const isbnText = isbnResult.textAnnotations[0]?.description || '';
            
            const isbnMatch = isbnText.match(/(?:ISBN[- ]*(?:10|13)*:*\s*)?(?:\d[- ]*){10,13}/i);
            if (isbnMatch) {
                isbnNumber = isbnMatch[0].replace(/[^0-9]/g, '');
                console.log('Found ISBN with Google Vision:', isbnNumber);
            }
        } catch (error) {
            console.error('Google Vision ISBN OCR error:', error);
        }
    }
    
    if (!isbnNumber) {
        console.log('No ISBN found in either OCR attempt');
        return null;
    }
    
    console.log('Final extracted ISBN:', isbnNumber);
    if (isbnNumber.length !== 10 && isbnNumber.length !== 13) {
        console.log('Invalid ISBN length:', isbnNumber.length);
        return null;
    }

    // 3. Try Gemini Vision for book title from cover with retry logic
    try {
        console.log('Trying Gemini Vision on cover image...');
        const geminiResult = await retryWithBackoff(async () => {
            return await model.generateContent([
                "Extract the book title from this cover image. Only return the title, nothing else.",
                {
                    inlineData: {
                        mimeType: "image/jpeg",
                        data: cover.data.toString('base64')
                    }
                }
            ]);
        });
        const geminiText = geminiResult.response.text();
        console.log('Gemini Cover OCR result:', geminiText);
        title = geminiText.trim();
    } catch (error) {
        console.error('Gemini Cover OCR error:', error);
    }

    console.log('Fetching metadata for ISBN:', isbnNumber);
    const metadata = await fetchMetadata(isbnNumber);
    
    if (!metadata.title && !metadata.authors?.[0]) {
        console.log('No metadata found from any source');
        return null;
    }
    
    const bookData = {
        isbn: isbnNumber,
        title: metadata.title || title || 'Unknown',
        author: metadata.authors?.[0] || 'Unknown',
        cover: cover.url,
        condition: ''
    };
    console.log('Final book data:', bookData);
    return bookData;
}

async function fetchMetadata(isbn) {
    try {
        // Try Google Books API first
        console.log('Fetching from Google Books API...');
        const googleBooksRes = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
        console.log('Google Books API response status:', googleBooksRes.status);
        
        if (googleBooksRes.data.items && googleBooksRes.data.items.length > 0) {
            const book = googleBooksRes.data.items[0].volumeInfo;
            console.log('Google Books API book data:', book);
            return {
                title: book.title || 'Unknown',
                subtitle: book.subtitle || 'Unknown',
                authors: book.authors || ['Unknown'],
                publisher: book.publisher || 'Unknown',
                publishedDate: book.publishedDate || 'Unknown',
                description: book.description || 'Unknown',
                pageCount: book.pageCount || 'Unknown',
                printType: book.printType || 'Unknown',
                categories: book.categories || ['Unknown'],
                imageLinks: book.imageLinks || {
                    thumbnail: 'Unknown',
                    smallThumbnail: 'Unknown'
                },
                language: book.language || 'Unknown',
                source: 'Google Books'
            };
        }
        
        // Try OpenLibrary API
        console.log('Fetching from OpenLibrary API...');
        try {
            const openLibraryRes = await axios.get(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
            console.log('OpenLibrary API response status:', openLibraryRes.status);
            
            const openLibraryBook = openLibraryRes.data[`ISBN:${isbn}`];
            if (openLibraryBook) {
                console.log('OpenLibrary API book data:', openLibraryBook);
                return {
                    title: openLibraryBook.title || 'Unknown',
                    subtitle: openLibraryBook.subtitle || 'Unknown',
                    authors: openLibraryBook.authors ? openLibraryBook.authors.map(a => a.name) : ['Unknown'],
                    publisher: openLibraryBook.publishers?.[0]?.name || 'Unknown',
                    publishedDate: openLibraryBook.publish_date || 'Unknown',
                    description: openLibraryBook.description || 'Unknown',
                    pageCount: openLibraryBook.number_of_pages || 'Unknown',
                    printType: 'Unknown',
                    categories: openLibraryBook.subjects ? openLibraryBook.subjects.map(s => s.name) : ['Unknown'],
                    imageLinks: {
                        thumbnail: openLibraryBook.cover?.large || 'Unknown',
                        smallThumbnail: openLibraryBook.cover?.medium || 'Unknown'
                    },
                    language: openLibraryBook.languages?.[0]?.key || 'Unknown',
                    source: 'OpenLibrary'
                };
            }
        } catch (error) {
            console.error('OpenLibrary API error:', error.message);
        }

        // Try LibraryThing API
        console.log('Fetching from LibraryThing API...');
        try {
            const libraryThingRes = await axios.get(`https://www.librarything.com/api/thingISBN/${isbn}`);
            
            if (libraryThingRes.data) {
                const book = libraryThingRes.data;
                console.log('LibraryThing API book data:', book);
                return {
                    title: book.title || 'Unknown',
                    subtitle: book.subtitle || 'Unknown',
                    authors: book.authors || ['Unknown'],
                    publisher: book.publisher || 'Unknown',
                    publishedDate: book.publishedDate || 'Unknown',
                    description: book.description || 'Unknown',
                    pageCount: book.pages || 'Unknown',
                    printType: book.format || 'Unknown',
                    categories: book.subjects || ['Unknown'],
                    imageLinks: {
                        thumbnail: book.coverUrl || 'Unknown',
                        smallThumbnail: book.coverUrl || 'Unknown'
                    },
                    language: book.language || 'Unknown',
                    source: 'LibraryThing'
                };
            }
        } catch (error) {
            console.error('LibraryThing API error:', error.message);
        }

        // Last resort: Try Gemini Vision for book details
        console.log('Trying Gemini Vision as last resort...');
        try {
            const geminiResult = await retryWithBackoff(async () => {
                return await model.generateContent([
                    "Extract the book title and author from this ISBN. Only return the title and author, nothing else.",
                    isbn
                ]);
            });
            const geminiText = geminiResult.response.text();
            console.log('Gemini result:', geminiText);
            
            // Try to parse title and author from Gemini response
            const lines = geminiText.split('\n').map(line => line.trim()).filter(line => line);
            if (lines.length >= 2) {
                return {
                    title: lines[0] || 'Unknown',
                    subtitle: 'Unknown',
                    authors: [lines[1] || 'Unknown'],
                    publisher: 'Unknown',
                    publishedDate: 'Unknown',
                    description: 'Unknown',
                    pageCount: 'Unknown',
                    printType: 'Unknown',
                    categories: ['Unknown'],
                    imageLinks: {
                        thumbnail: 'Unknown',
                        smallThumbnail: 'Unknown'
                    },
                    language: 'Unknown',
                    source: 'Gemini 1.5'
                };
            }
        } catch (error) {
            console.error('Gemini Vision error:', error.message);
        }
        
        console.log('No book data found in any source');
        return {
            title: 'Unknown',
            subtitle: 'Unknown',
            authors: ['Unknown'],
            publisher: 'Unknown',
            publishedDate: 'Unknown',
            description: 'Unknown',
            pageCount: 'Unknown',
            printType: 'Unknown',
            categories: ['Unknown'],
            imageLinks: {
                thumbnail: 'Unknown',
                smallThumbnail: 'Unknown'
            },
            language: 'Unknown',
            source: 'Unknown'
        };
    } catch (e) {
        console.error('Metadata fetch error:', e.message);
        if (e.response) {
            console.error('API Error response:', e.response.status, e.response.data);
        }
        return {
            title: 'Unknown',
            subtitle: 'Unknown',
            authors: ['Unknown'],
            publisher: 'Unknown',
            publishedDate: 'Unknown',
            description: 'Unknown',
            pageCount: 'Unknown',
            printType: 'Unknown',
            categories: ['Unknown'],
            imageLinks: {
                thumbnail: 'Unknown',
                smallThumbnail: 'Unknown'
            },
            language: 'Unknown',
            source: 'Unknown'
        };
    }
}

async function appendToSheet(userId, books, sheets, serviceAccountEmail) {
    console.log('Appending to sheet for user:', userId);
    console.log('Books to append:', JSON.stringify(books, null, 2));
    
    try {
        // Use the existing sheet ID
        const sheetId = '1ul3-t3GyJdt5k1--AaSEVPmFZja4BmcvhETeTUqaNvM';
        
        // Prepare data to write
        const rows = books.map(b => {
            // Ensure we have the ISBN
            if (!b.isbn) {
                console.error('Missing ISBN for book:', b);
                return null;
            }
            
            // Get metadata or use defaults
            const metadata = b.metadata || {};
            
            // Convert ISBN-13 to ISBN-10 if needed
            let isbn10 = '';
            if (b.isbn.length === 13) {
                const base = b.isbn.slice(3, -1);
                let sum = 0;
                for (let i = 0; i < 9; i++) {
                    sum += parseInt(base[i]) * (10 - i);
                }
                const checkDigit = (11 - (sum % 11)) % 11;
                isbn10 = base + checkDigit;
            } else if (b.isbn.length === 10) {
                isbn10 = b.isbn;
            }
            
            // Create row data
            const row = [
                b.isbn, // ISBN_13
                b.title || metadata.title || 'Unknown', // Title
                metadata.subtitle || 'Unknown', // Subtitle
                b.author || metadata.authors?.[0] || 'Unknown', // Authors
                metadata.publisher || 'Unknown', // Publisher
                metadata.publishedDate || 'Unknown', // PublishedDate
                metadata.description || 'Unknown', // Description
                metadata.pageCount || 'Unknown', // PageCount
                metadata.printType || 'Unknown', // PrintType
                metadata.categories ? metadata.categories.join(', ') : 'Unknown', // Categories
                b.cover || metadata.imageLinks?.thumbnail || 'Unknown', // Thumbnail
                b.cover || metadata.imageLinks?.smallThumbnail || 'Unknown', // SmallThumbnail
                metadata.language || 'Unknown', // Language
                userId.replace('@s.whatsapp.net', ''), // Sender's WhatsApp
                'Unknown', // Sender's Email
                'Unknown', // Sender's Name
                1, // Initial Sender's Frequency
                1, // Initial Global Frequency
                isbn10, // ISBN_10
                metadata.source || 'Unknown', // Source
                new Date().toISOString() // Timestamp
            ];
            
            console.log('Prepared row:', row);
            return row;
        }).filter(row => row !== null);

        if (rows.length === 0) {
            console.log('No valid books to add');
            return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
        }

        // Append new data
        console.log('Appending new data to sheet...');
        console.log('Number of rows to append:', rows.length);
        console.log('First row ISBN:', rows[0][0]);
        
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Books!A:U',
            valueInputOption: 'RAW',
            resource: { values: rows }
        });
        
        console.log('Sheet append response:', response.data);

        const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
        console.log('Successfully appended data to sheet:', sheetUrl);
        return sheetUrl;
    } catch (error) {
        console.error('Error in appendToSheet:', error);
        if (error.response) {
            console.error('API Error response:', error.response.status, error.response.data);
        }
        throw error;
    }
}

async function extractISBN(media, visionClient) {
    console.log('Starting ISBN extraction...');
    
    // Try Gemini Vision first with retry logic
    try {
        console.log('Trying Gemini Vision for ISBN...');
        const geminiResult = await retryWithBackoff(async () => {
            return await model.generateContent([
                "Extract the ISBN number from this image. Look for any 10 or 13 digit number that appears to be an ISBN. Only return the ISBN number, nothing else.",
                {
                    inlineData: {
                        mimeType: "image/jpeg",
                        data: media.toString('base64')
                    }
                }
            ]);
        });
        const geminiText = geminiResult.response.text();
        console.log('Gemini ISBN OCR result:', geminiText);
        
        // Try to find ISBN in various formats
        const isbnPatterns = [
            /ISBN[- ]*(?:10|13)*:*\s*(\d{10,13})/i,
            /(\d{10,13})/,
            /ISBN[- ]*(?:10|13)*:*\s*(\d{3}[- ]?\d{1,5}[- ]?\d{1,7}[- ]?\d{1,6}[- ]?\d{1})/i
        ];
        
        for (const pattern of isbnPatterns) {
            const isbnMatch = geminiText.match(pattern);
            if (isbnMatch) {
                const isbn = isbnMatch[1].replace(/[^0-9]/g, '');
                if (isbn.length === 10 || isbn.length === 13) {
                    console.log('Found valid ISBN with Gemini:', isbn);
                    return isbn;
                }
            }
        }
    } catch (error) {
        console.error('Gemini ISBN OCR error:', error);
    }
    
    // Try Google Vision as fallback with retry logic
    try {
        console.log('Trying Google Vision for ISBN...');
        const [result] = await retryWithBackoff(async () => {
            return await visionClient.textDetection({ image: { content: media } });
        });
        const isbnText = result.textAnnotations[0]?.description || '';
        console.log('Google Vision OCR result:', isbnText);
        
        // Try to find ISBN in various formats
        const isbnPatterns = [
            /ISBN[- ]*(?:10|13)*:*\s*(\d{10,13})/i,
            /(\d{10,13})/,
            /ISBN[- ]*(?:10|13)*:*\s*(\d{3}[- ]?\d{1,5}[- ]?\d{1,7}[- ]?\d{1,6}[- ]?\d{1})/i
        ];
        
        for (const pattern of isbnPatterns) {
            const isbnMatch = isbnText.match(pattern);
            if (isbnMatch) {
                const isbn = isbnMatch[1].replace(/[^0-9]/g, '');
                if (isbn.length === 10 || isbn.length === 13) {
                    console.log('Found valid ISBN with Google Vision:', isbn);
                    return isbn;
                }
            }
        }
    } catch (error) {
        console.error('Google Vision ISBN OCR error:', error);
    }
    
    console.log('No valid ISBN found in either OCR attempt');
    return null;
}

connectToWhatsApp(); 