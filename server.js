require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase & Twilio
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Initialize Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

// Schedule task to run every day at 8:00 AM
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

    // Fetch documents expiring today or in exactly 30 days
    const { data: documents, error } = await supabase
        .from('documents')
        .select(`*, vehicles(make, model, license_plate, user_id)`)
        .or(`expiry_date.eq.${todayStr},expiry_date.eq.${nextMonthStr}`);

    if (error) {
        console.error("Error fetching documents:", error);
        return;
    }

    if (!documents || documents.length === 0) {
        console.log("No documents expiring today.");
        return;
    }

    for (const doc of documents) {
        // In a real app, you would fetch the user's phone/email from a users table.
        // For testing, we send to your verified Twilio number and your email.
        const vehicleName = `${doc.vehicles.make} ${doc.vehicles.model} (${doc.vehicles.license_plate})`;
        const messageText = `⚠️ OTracker Alert: The ${doc.document_type} for your ${vehicleName} expires on ${doc.expiry_date}.`;

        // 1. Send WhatsApp
        try {
            await twilioClient.messages.create({
                body: messageText,
                from: 'whatsapp:+14155238886', // Replace with your Twilio Sandbox number
                to: 'whatsapp:+2348000000000'   // Replace with your verified WhatsApp number
            });
            console.log(`WhatsApp sent for ${vehicleName}`);
        } catch (twError) {
            console.error("WhatsApp Error:", twError.message);
        }

        // 2. Send Email
        try {
            await transporter.sendMail({
                from: `"OTracker Alerts" <${process.env.EMAIL_USER}>`,
                to: process.env.EMAIL_USER, // Sending to yourself for testing
                subject: `Document Expiry Alert: ${vehicleName}`,
                text: messageText,
            });
            console.log(`Email sent for ${vehicleName}`);
        } catch (emailError) {
            console.error("Email Error:", emailError.message);
        }
    }
});

// A manual trigger so you don't have to wait until 8 AM to test!
app.get('/api/test-reminders', (req, res) => {
    console.log("Manual trigger hit! Check terminal for logs.");
    res.send("Triggered manual check. Check your phone and email in a few seconds!");
    // You can temporarily copy the logic from inside the cron job here to test instantly.
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});