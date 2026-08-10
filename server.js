require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
// 1. Import the WhatsApp Web and QR libraries
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
});

// 2. Initialize the WhatsApp Web Client
// LocalAuth saves your session so you don't have to scan the QR code every time the server restarts
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Required for running on cloud servers like Render
    }
});

// 3. Generate the QR code in your terminal
whatsappClient.on('qr', (qr) => {
    console.log('Scan this QR code with your WhatsApp to link your server:');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    console.log('WhatsApp Web Client is ready and connected!');
});

// Start the WhatsApp Client
whatsappClient.initialize();

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

                // 4. Send the message via your personal WhatsApp
                if (userPhone && userPhone.trim() !== '') {
                    // whatsapp-web.js requires the exact format: 2348000000000@c.us
                    let cleanPhone = userPhone.replace(/[^0-9]/g, '') + "@c.us"; 
                    await whatsappClient.sendMessage(cleanPhone, messageText);
                    alertsSent++;
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