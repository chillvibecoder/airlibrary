require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// Admin configuration
const ADMIN_NUMBER = '85292853890@s.whatsapp.net';

async function connectToWhatsApp() {
    console.log('Starting WhatsApp connection...');
    
    try {
        // Remove any existing auth state
        if (fs.existsSync('.wwebjs_auth')) {
            fs.rmSync('.wwebjs_auth', { recursive: true, force: true });
        }
        if (fs.existsSync('auth_info.json')) {
            fs.rmSync('auth_info.json', { force: true });
        }

        // Get authentication state
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        
        // Initialize the store
        const store = makeInMemoryStore({});
        
        // Initialize the socket with proper authentication
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['Chrome', 'Desktop', '1.0.0'],
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            qrTimeout: 60000,
            maxRetries: 5,
            version: [2, 3000, 1019707846]
        });
        console.log('WhatsApp socket created');

        // Bind store to socket
        store.bind(sock.ev);

        // Handle connection events
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n\n=== QR CODE RECEIVED ===\n');
                qrcode.generate(qr, { small: true });
                console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== 401);
                console.log('Connection closed due to', lastDisconnect?.error, ', reconnecting', shouldReconnect);
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log('Connected to WhatsApp!');
                // Send a test message to admin
                await sock.sendMessage(ADMIN_NUMBER, { text: 'Bot is now connected!' });
            }
        });

        // Save credentials whenever updated
        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('Error in connectToWhatsApp:', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Start the connection
connectToWhatsApp(); 