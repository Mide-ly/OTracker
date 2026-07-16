require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
});

cron.schedule('0 8 * * *', async () => {
    console.log('Running daily expiry check...');

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

    if (error || !documents || documents.length === 0) return;

    for (const doc of documents) {
        try {
            // Fetch the car linked to the document
            const { data: car } = await supabase.from('cars').select('*').eq('id', doc.car_id).single();
            if (!car) continue;

            // Fetch the specific user who owns the car
            const { data: owner } = await supabase.from('users').select('*').eq('id', car.owner_id).single();
            if (!owner) continue;

            const userEmail = owner.email;
            const userPhone = owner.phone_number;
            const vehicleName = `${car.name} (${car.plate_number})`;
            const messageText = `⚠️ OTracker Alert: The ${doc.type} for your ${vehicleName} expires on ${doc.expiry_date}.`;

            if (userPhone && userPhone.trim() !== '') {
                await twilioClient.messages.create({
                    body: messageText,
                    from: 'whatsapp:+14155238886', 
                    to: `whatsapp:${userPhone}` 
                });
            }

            if (userEmail && userEmail.trim() !== '') {
                await transporter.sendMail({
                    from: `"OTracker Alerts" <${process.env.EMAIL_USER}>`,
                    to: userEmail,
                    subject: `Document Expiry Alert: ${vehicleName}`,
                    text: messageText,
                });
            }
        } catch (err) {
            console.error("Alert Loop Error:", err.message);
        }
    }
});

app.get('/api/test-reminders', async (req, res) => {
    res.send("<h1>Backend Running!</h1><p>Automated reminders are active.</p>");
});

app.listen(port, () => console.log(`OTracker Backend is running on port ${port}`));