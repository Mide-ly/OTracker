require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse incoming JSON requests (Crucial for the delete-account route)
app.use(express.json());

// Initialize Supabase (Using Service Role Key to bypass RLS for admin tasks)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Initialize Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Initialize Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

// Schedule task to run every day at 8:00 AM UTC
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

    // Fetch documents, the vehicle they belong to, and the owner's profile
    const { data: documents, error } = await supabase
        .from('documents')
        .select(`*, vehicles(*, profiles(email, whatsapp_number))`)
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
        // Dynamically grab the specific user's contact details from the database
        const userEmail = doc.vehicles?.profiles?.email;
        const userPhone = doc.vehicles?.profiles?.whatsapp_number;
        const vehicleName = `${doc.vehicles?.make} ${doc.vehicles?.model} (${doc.vehicles?.license_plate})`;
        const messageText = `⚠️ OTracker Alert: The ${doc.document_type} for your ${vehicleName} expires on ${doc.expiry_date}.`;

        // 1. Send WhatsApp dynamically (Only if the user provided a number)
        if (userPhone && userPhone.trim() !== '') {
            try {
                await twilioClient.messages.create({
                    body: messageText,
                    from: 'whatsapp:+14155238886', // Replace with your Twilio Sandbox number if different
                    to: `whatsapp:${userPhone}` 
                });
                console.log(`WhatsApp sent to ${userPhone} for ${vehicleName}`);
            } catch (twError) {
                console.error(`WhatsApp Error for ${userPhone}:`, twError.message);
            }
        } else {
            console.log(`Skipped WhatsApp for ${vehicleName} (No number on profile)`);
        }

        // 2. Send Email dynamically (Only if the user has an email)
        if (userEmail) {
            try {
                await transporter.sendMail({
                    from: `"OTracker Alerts" <${process.env.EMAIL_USER}>`,
                    to: userEmail,
                    subject: `Document Expiry Alert: ${vehicleName}`,
                    text: messageText,
                });
                console.log(`Email sent to ${userEmail} for ${vehicleName}`);
            } catch (emailError) {
                console.error(`Email Error for ${userEmail}:`, emailError.message);
            }
        }
    }
});

// Secure Account Deletion Endpoint
app.post('/api/delete-account', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    // Uses the Admin Service Key to completely obliterate the auth user
    // Due to the "on delete cascade" rule in SQL, this also wipes their profiles, cars, and documents.
    const { data, error } = await supabase.auth.admin.deleteUser(userId);

    if (error) {
        console.error("Delete User Error:", error.message);
        return res.status(500).json({ error: error.message });
    }

    console.log(`Successfully deleted user account: ${userId}`);
    res.json({ message: "Account completely deleted." });
});

// Manual Trigger Endpoint for testing
app.get('/api/test-reminders', async (req, res) => {
    console.log("Manual trigger hit! Forcing an alert right now...");

    // Sending a test WhatsApp
    try {
        await twilioClient.messages.create({
            body: "⚠️ OTracker TEST: This is a manual test to confirm your backend is working!",
            from: 'whatsapp:+14155238886', // Keep your Twilio Sandbox number here
            to: 'whatsapp:+2348000000000'   // REPLACE WITH YOUR ACTUAL NUMBER FOR TESTING
        });
        console.log("Test WhatsApp sent!");
    } catch (error) {
        console.error("WhatsApp Error:", error.message);
    }

    // Sending a test Email
    try {
        await transporter.sendMail({
            from: `"OTracker Alerts" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER, // Sends to yourself for the test
            subject: `OTracker: Manual Backend Test`,
            text: "Success! Your Node.js server successfully sent this email via Render.",
        });
        console.log("Test Email sent!");
    } catch (error) {
        console.error("Email Error:", error.message);
    }

    res.send("<h1>Test fired!</h1><p>Check your WhatsApp and Email.</p>");
});

app.listen(port, () => {
    console.log(`OTracker Multi-User Backend is running on port ${port}`);
});