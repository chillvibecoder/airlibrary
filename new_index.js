require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const vision = require('@google-cloud/vision');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const P = require('pino');

// Constants
const AUTH_DIR = 'auth_info';
const ADMIN_NUMBER = '85292853890@s.whatsapp.net';
const APPROVED_SENDERS = new Set([ADMIN_NUMBER]); // Initialize with admin number
let isShuttingDown = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let readyMessageSent = false;

// Book management variables
let userBooks = {};
let sheetIds = {};
let bookData = {};

// Load existing data
try {
    if (fs.existsSync('user_books.json')) {
        userBooks = JSON.parse(fs.readFileSync('user_books.json', 'utf8'));
    }
    if (fs.existsSync('sheet_ids.json')) {
        sheetIds = JSON.parse(fs.readFileSync('sheet_ids.json', 'utf8'));
    }
    if (fs.existsSync('book_data.json')) {
        bookData = JSON.parse(fs.readFileSync('book_data.json', 'utf8'));
    }
} catch (error) {
    logger.error('Error loading saved data:', error);
}

// Initialize logger
const logger = P({
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    level: 'info'
});

// Initialize Google services
async function initializeGoogleServices() {
    try {
        // Initialize Vision client
        const visionClient = new vision.ImageAnnotatorClient({ 
            credentials: require('./service-account.json')
        });
        logger.info('Vision client initialized successfully');

        // Load service account
        const serviceAccount = require('./service-account.json');
        if (!serviceAccount || !serviceAccount.client_email) {
            throw new Error('Invalid service account configuration');
        }
        logger.info('Service account loaded:', serviceAccount.client_email);

        // Initialize Google Auth
        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccount,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
        });

        // Initialize Google Sheets
        const sheets = google.sheets({ version: 'v4', auth });
        logger.info('Google Sheets client initialized successfully');

        // Initialize Google Drive
        const drive = google.drive({ version: 'v3', auth });
        logger.info('Google Drive client initialized successfully');

        return { visionClient, sheets, drive };
    } catch (error) {
        logger.error('Error initializing Google services:', error);
        throw error;
    }
}

// Add delay between connection attempts
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// WhatsApp connection function
async function connectToWhatsApp() {
    if (isShuttingDown) return;
    
    logger.info('Script starting...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        logger.info('Auth state loaded');
        
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
        logger.info('WhatsApp socket created');

        client.ev.on('creds.update', saveCreds);

        client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            logger.info('Connection update:', JSON.stringify(update, null, 2));

            if (qr) {
                logger.info('\n=== NEW QR CODE RECEIVED ===\n');
                qrcode.generate(qr, { small: true });
                logger.info('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                logger.info('Connection closed:', error);
                
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    logger.info('Maximum reconnection attempts reached. Please restart the bot manually.');
                    return;
                }
                
                if (statusCode === 401) {
                    logger.info('401 detected, forcing re-authentication...');
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    if (!isShuttingDown) {
                        reconnectAttempts++;
                        setTimeout(connectToWhatsApp, 15000);
                    }
                } else if (statusCode === 440) {
                    logger.info('Stream conflict detected, reconnecting...');
                    if (!isShuttingDown) {
                        reconnectAttempts++;
                        setTimeout(connectToWhatsApp, 15000);
                    }
                } else if (statusCode !== DisconnectReason.loggedOut && !isShuttingDown) {
                    reconnectAttempts++;
                    setTimeout(connectToWhatsApp, 15000);
                }
            }

            if (connection === 'open') {
                logger.info('WhatsApp connected successfully!');
                reconnectAttempts = 0;
                if (!readyMessageSent) {
                    const sendReadyMessage = async () => {
                        await delay(15000);
                        try {
                            logger.info('Sending ready message to admin...');
                            await client.sendMessage(ADMIN_NUMBER, { text: 'Bot is ready and connected! Send a test message to verify.' });
                            logger.info('Ready message sent successfully');
                            readyMessageSent = true;
                        } catch (error) {
                            logger.error('Error sending ready message:', error);
                        }
                    };
                    setTimeout(sendReadyMessage, 10000);
                }
            }
        });

        // Handle messages
        client.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        logger.info('Received message:', JSON.stringify(msg, null, 2));
                        
                        const sender = msg.key.remoteJid;
                        logger.info('Message from:', sender);
                        
                        // Handle text messages
                        if (msg.message.conversation) {
                            const text = msg.message.conversation.toLowerCase();
                            logger.info('Received text message:', text);
                            
                            // Check if sender is admin
                            if (sender === ADMIN_NUMBER) {
                                // Handle admin commands
                                if (text.startsWith('approve')) {
                                    const numberToApprove = text.split(' ')[1].replace(/[+\s]/g, '');
                                    if (numberToApprove) {
                                        const formattedNumber = `${numberToApprove}@s.whatsapp.net`;
                                        APPROVED_SENDERS.add(formattedNumber);
                                        await client.sendMessage(ADMIN_NUMBER, { 
                                            text: `Number ${numberToApprove} has been approved. Current approved numbers:\n${Array.from(APPROVED_SENDERS).map(num => num.replace('@s.whatsapp.net', '')).join('\n')}` 
                                        });
                                        logger.info(`Added ${formattedNumber} to approved senders`);
                                    }
                                } else if (text === 'list approved') {
                                    const approvedList = Array.from(APPROVED_SENDERS)
                                        .map(num => num.replace('@s.whatsapp.net', ''))
                                        .join('\n');
                                    await client.sendMessage(ADMIN_NUMBER, { 
                                        text: `Approved numbers:\n${approvedList}` 
                                    });
                                }
                            }
                            
                            // Handle user commands
                            if (APPROVED_SENDERS.has(sender)) {
                                if (text === 'help') {
                                    await client.sendMessage(sender, { 
                                        text: 'Available commands:\n' +
                                              '1. Send a book image to add it to your library\n' +
                                              '2. "search <title>" - Search your books\n' +
                                              '3. "list" - List all your books\n' +
                                              '4. "delete <title>" - Remove a book\n' +
                                              '5. "help" - Show this message'
                                    });
                                } else if (text.startsWith('search')) {
                                    const searchTerm = text.split(' ').slice(1).join(' ').toLowerCase();
                                    const userBookList = userBooks[sender] || [];
                                    const matches = userBookList.filter(book => 
                                        book.title.toLowerCase().includes(searchTerm) ||
                                        book.author.toLowerCase().includes(searchTerm)
                                    );
                                    
                                    if (matches.length > 0) {
                                        const response = matches.map(book => 
                                            `📚 ${book.title} by ${book.author}`
                                        ).join('\n');
                                        await client.sendMessage(sender, { text: response });
                                    } else {
                                        await client.sendMessage(sender, { text: 'No books found matching your search.' });
                                    }
                                } else if (text === 'list') {
                                    const userBookList = userBooks[sender] || [];
                                    if (userBookList.length > 0) {
                                        const response = userBookList.map(book => 
                                            `📚 ${book.title} by ${book.author}`
                                        ).join('\n');
                                        await client.sendMessage(sender, { text: response });
                                    } else {
                                        await client.sendMessage(sender, { text: 'Your library is empty. Send a book image to add books!' });
                                    }
                                } else if (text.startsWith('delete')) {
                                    const titleToDelete = text.split(' ').slice(1).join(' ');
                                    const userBookList = userBooks[sender] || [];
                                    const initialLength = userBookList.length;
                                    userBooks[sender] = userBookList.filter(book => 
                                        book.title.toLowerCase() !== titleToDelete.toLowerCase()
                                    );
                                    
                                    if (userBooks[sender].length < initialLength) {
                                        await client.sendMessage(sender, { text: `Book "${titleToDelete}" has been removed from your library.` });
                                        fs.writeFileSync('user_books.json', JSON.stringify(userBooks, null, 2));
                                    } else {
                                        await client.sendMessage(sender, { text: 'Book not found in your library.' });
                                    }
                                }
                            } else {
                                await client.sendMessage(sender, { 
                                    text: 'Sorry, you are not an approved sender. Please contact the admin for approval.' 
                                });
                                // Notify admin about unauthorized attempt
                                await client.sendMessage(ADMIN_NUMBER, { 
                                    text: `Unauthorized message attempt from: ${sender.replace('@s.whatsapp.net', '')}` 
                                });
                            }
                        }
                        
                        // Handle image messages
                        if (msg.message.imageMessage) {
                            logger.info('Received image message');
                            if (APPROVED_SENDERS.has(sender)) {
                                try {
                                    const imageBuffer = await downloadMediaMessage(msg, 'buffer');
                                    const [result] = await visionClient.textDetection(imageBuffer);
                                    const text = result.fullTextAnnotation.text;
                                    
                                    // Process the text to extract book information
                                    const bookInfo = processBookText(text);
                                    if (bookInfo) {
                                        // Initialize user's book list if it doesn't exist
                                        if (!userBooks[sender]) {
                                            userBooks[sender] = [];
                                        }
                                        
                                        // Add the book to user's library
                                        userBooks[sender].push(bookInfo);
                                        
                                        // Save to file
                                        fs.writeFileSync('user_books.json', JSON.stringify(userBooks, null, 2));
                                        
                                        await client.sendMessage(sender, { 
                                            text: `Book added to your library:\n📚 ${bookInfo.title}\n✍️ ${bookInfo.author}`
                                        });
                                    } else {
                                        await client.sendMessage(sender, { 
                                            text: 'Sorry, I couldn\'t extract book information from this image. Please try another image or send the book details manually.'
                                        });
                                    }
                                } catch (error) {
                                    logger.error('Error processing image:', error);
                                    await client.sendMessage(sender, { 
                                        text: 'Sorry, there was an error processing your image. Please try again.'
                                    });
                                }
                            } else {
                                await client.sendMessage(sender, { 
                                    text: 'Sorry, you are not an approved sender. Please contact the admin for approval.' 
                                });
                                // Notify admin about unauthorized attempt
                                await client.sendMessage(ADMIN_NUMBER, { 
                                    text: `Unauthorized image attempt from: ${sender.replace('@s.whatsapp.net', '')}` 
                                });
                            }
                        }
                    }
                }
            }
        });

        // Handle process termination
        process.on('SIGINT', async () => {
            isShuttingDown = true;
            logger.info('Shutting down...');
            await client.logout();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            isShuttingDown = true;
            logger.info('Shutting down...');
            await client.logout();
            process.exit(0);
        });

        return client;
    } catch (error) {
        logger.error('Error in connectToWhatsApp:', error);
        throw error;
    }
}

// Initialize services and start WhatsApp
async function start() {
    try {
        // Initialize Google services first
        const googleServices = await initializeGoogleServices();
        
        // Then connect to WhatsApp
        const whatsappClient = await connectToWhatsApp();
        
        // Store the clients for later use
        global.googleServices = googleServices;
        global.whatsappClient = whatsappClient;
        
        logger.info('All services initialized successfully');
    } catch (error) {
        logger.error('Failed to start services:', error);
        process.exit(1);
    }
}

// Start the application
start();

// Helper function to process book text
function processBookText(text) {
    // Basic book information extraction
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    
    // Look for title and author patterns
    let title = '';
    let author = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip empty lines and common headers/footers
        if (!line || line.includes('page') || line.includes('chapter')) continue;
        
        // First non-empty line is usually the title
        if (!title && line.length > 3) {
            title = line;
            continue;
        }
        
        // Look for author indicators
        if (line.toLowerCase().includes('by') || line.toLowerCase().includes('author')) {
            author = line.replace(/by|author/i, '').trim();
            break;
        }
    }
    
    if (title && author) {
        return { title, author };
    }
    
    return null;
} 