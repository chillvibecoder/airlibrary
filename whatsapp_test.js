const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

async function startWhatsApp() {
    try {
        // Create auth folder if it doesn't exist
        if (!fs.existsSync('auth_info')) {
            fs.mkdirSync('auth_info');
        }

        // Get auth state
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        console.log('Auth state loaded');

        // Create WhatsApp connection
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['Chrome', 'Desktop', '1.0.0'],
            generateHighQualityLinkPreview: true,
        });
        console.log('Socket created');

        // Handle auth updates
        sock.ev.on('creds.update', saveCreds);

        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n=== QR CODE RECEIVED ===\n');
                qrcode.generate(qr, { small: true });
                console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed due to:', lastDisconnect?.error);
                if (shouldReconnect) {
                    startWhatsApp();
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connection opened!');
            }
        });

        // Handle messages
        sock.ev.on('messages.upsert', async (m) => {
            console.log('Got message:', m);
        });

    } catch (err) {
        console.error('Error in WhatsApp connection:', err);
    }
}

// Start WhatsApp
startWhatsApp(); 