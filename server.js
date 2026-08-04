require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
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

// THE NEW TRIGGER ENDPOINT
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
                const userPhone = owner.phone_number;
                const vehicleName = `${car.name} (${car.plate_number})`;
                const messageText = `⚠️ OTracker Alert: The ${doc.type} for your ${vehicleName} expires on ${doc.expiry_date}.`;

                if (userPhone && userPhone.trim() !== '') {
                    await twilioClient.messages.create({
                        body: messageText,
                        from: 'whatsapp:+14155238886', // Make sure this matches your Twilio WhatsApp sender
                        to: `whatsapp:${userPhone}` 
                    });
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
        
        // This tiny response prevents the "Output too large" error!
        res.status(200).send(`OK. ${alertsSent} alerts sent.`);
    } catch (err) {
        console.error("Alert Loop Error:", err.message);
        res.status(500).send("Error.");
    }
});

app.listen(port, () => console.log(`OTracker Backend is running on port ${port}`));