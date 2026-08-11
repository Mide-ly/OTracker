require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const emailjs = require('@emailjs/nodejs'); 

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Initialize Supabase Client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Keep-Awake / Health Check Route
app.get('/', (req, res) => {
    res.send("OTracker Email Notification Server is Running!");
});

// THE TRIGGER ENDPOINT (Pinged by cron-job.org)
app.get('/api/run-reminders', async (req, res) => {
    console.log('Cron triggered: Checking for document expiry reminders...');
    let emailsSent = 0;

    try {
        const today = new Date();
        const addDays = (days) => {
            const d = new Date(today);
            d.setDate(d.getDate() + days);
            return d.toISOString().split('T')[0];
        };

        // Check for documents expiring today or exactly in 30 days
        const todayStr = addDays(0);
        const nextMonthStr = addDays(30);

        const { data: documents, error } = await supabase
            .from('documents')
            .select('*')
            .or(`expiry_date.eq.${todayStr},expiry_date.eq.${nextMonthStr}`);

        if (error) throw error;

        if (documents && documents.length > 0) {
            for (const doc of documents) {
                // Get Car details
                const { data: car } = await supabase
                    .from('cars')
                    .select('*')
                    .eq('id', doc.car_id)
                    .single();
                if (!car) continue;

                // Get Owner details
                const { data: owner } = await supabase
                    .from('users')
                    .select('*')
                    .eq('id', car.owner_id)
                    .single();
                if (!owner) continue;

                const userEmail = owner.email;
                const vehicleName = `${car.name} (${car.plate_number})`;

                if (userEmail && userEmail.trim() !== '') {
                    
                    // 1. Define the parameters matching your EmailJS dashboard template
                    const templateParams = {
                        user_email: userEmail,
                        vehicle_name: vehicleName,
                        doc_type: doc.type,
                        expiry_date: doc.expiry_date
                    };

                    // 2. Fire the email via EmailJS
                    await emailjs.send(
                        process.env.EMAILJS_SERVICE_ID,
                        process.env.EMAILJS_TEMPLATE_ID,
                        templateParams,
                        {
                            publicKey: process.env.EMAILJS_PUBLIC_KEY,
                            privateKey: process.env.EMAILJS_PRIVATE_KEY 
                        }
                    );
                    emailsSent++;
                }
            }
        }
        
        console.log(`Job complete. Sent ${emailsSent} email alerts.`);
        res.status(200).send(`OK. ${emailsSent} email alerts sent.`);
    } catch (err) {
        console.error("Error during reminder execution:", err.message);
        res.status(500).send("Server Error.");
    }
});

app.listen(port, () => console.log(`OTracker Backend running on port ${port}`));