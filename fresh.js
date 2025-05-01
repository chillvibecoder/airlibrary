const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const AUTH_FOLDER = './auth_info_baileys';

async function startWhatsApp() {
    // Create auth folder if it doesn't exist
    if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    // Get auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    console.log('Got auth state');

    // Create WhatsApp connection
    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        browser: ['Chrome (Linux)', '', '']
    });
    console.log('Created socket');

    // Save credentials whenever updated
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
}

// Start WhatsApp
startWhatsApp(); 