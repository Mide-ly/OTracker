require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
// 1. Import the lightweight Baileys library
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
});

let whatsappSocket;

// 2. Initialize the WhatsApp Socket Connection
async function connectToWhatsApp() {
    // Saves your session so you don't have to scan the QR code on every restart
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    whatsappSocket = makeWASocket({
        auth: state,
        printQRInTerminal: true // Automatically prints the QR code to your Render logs!
    });

    whatsappSocket.ev.on('creds.update', saveCreds);

    whatsappSocket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Web Client is ready and connected!');
        }
    });
}

// Start the connection
connectToWhatsApp();

// THE TRIGGER ENDPOINT
app.get('/api/run-reminders', async (req, res) => {
    console.log('Reminders triggered by cron-job.org...');
    let alertsSent = 0;

    try {
        const today = new Date();
        const addDays = (days) => {
            const d = new Date(today);
            d.setDate(d.getDate() + days);
            return d.toISOString().split('T')[0];
        };

        const todayStr = addDays(0);
        const nextMonthStr = addDays(30);

        const { data: documents, error } = await supabase
            .from('documents')
            .select('*')
            .or(`expiry_date.eq.${todayStr},expiry_date.eq.${nextMonthStr}`);

        if (error) throw error;

        if (documents && documents.length > 0) {
            for (const doc of documents) {
                const { data: car } = await supabase.from('cars').select('*').eq('id', doc.car_id).single();
                if (!car) continue;

                const { data: owner } = await supabase.from('users').select('*').eq('id', car.owner_id).single();
                if (!owner) continue;

                const userEmail = owner.email;
                let userPhone = owner.phone_number;
                const vehicleName = `${car.name} (${car.plate_number})`;
                const messageText = `⚠️ OTracker Alert: The ${doc.type} for your ${vehicleName} expires on ${doc.expiry_date}.`;

                // 3. Send the message via your linked WhatsApp account
                if (userPhone && userPhone.trim() !== '') {
                    // Baileys requires the format: 2348000000000@s.whatsapp.net
                    let cleanPhone = userPhone.replace(/[^0-9]/g, '') + "@s.whatsapp.net"; 
                    if (whatsappSocket) {
                        await whatsappSocket.sendMessage(cleanPhone, { text: messageText });
                        alertsSent++;
                    }
                }

                if (userEmail && userEmail.trim() !== '') {
                    await transporter.sendMail({
                        from: `"OTracker Alerts" <${process.env.EMAIL_USER}>`,
                        to: userEmail,
                        subject: `Document Expiry Alert: ${vehicleName}`,
                        text: messageText,
                    });
                    alertsSent++;
                }
            }
        }
        
        res.status(200).send(`OK. ${alertsSent} alerts sent.`);
    } catch (err) {
        console.error("Alert Loop Error:", err.message);
        res.status(500).send("Error.");
    }
});

app.listen(port, () => console.log(`OTracker Backend is running on port ${port}`));