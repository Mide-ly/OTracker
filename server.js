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

        const todayStr = addDays(0);

        // 1. Generate target dates for 30, 25, 20, 15, 10, 5, and 0 days out
        const intervalDays = [0, 5, 10, 15, 20, 25, 30];
        const targetDates = intervalDays.map((days) => addDays(days));

        // 2. Query documents matching any of these exact 5-day interval dates
        const { data: documents, error } = await supabase
            .from('documents')
            .select('*')
            .in('expiry_date', targetDates);

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
                
                // ADDED THIS: Dynamically grabs the name based on your database column
                const userName = owner.username || owner.name || owner.first_name || 'Valued User';
                
                const vehicleName = `${car.name} (${car.plate_number})`;

                // Calculate exact days remaining for the email template
                const expiryObj = new Date(doc.expiry_date);
                const todayObj = new Date(todayStr);
                const daysRemaining = Math.round((expiryObj - todayObj) / (1000 * 60 * 60 * 24));

                if (userEmail && userEmail.trim() !== '') {
                    
                    // Parameters matching your EmailJS template
                    const templateParams = {
                        user_name: userName, // <-- ADDED THIS!
                        user_email: userEmail,
                        vehicle_name: vehicleName,
                        doc_type: doc.type,
                        expiry_date: doc.expiry_date,
                        days_remaining: daysRemaining === 0 ? "TODAY" : `${daysRemaining} days`
                    };

                    // Send email via EmailJS
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
        // EXPOSING THE HIDDEN EMAILJS ERROR
        const errorDetails = err.text || err.message || JSON.stringify(err);
        console.error("Error during reminder execution:", errorDetails);
        res.status(500).send(`Server Error: ${errorDetails}`);
    }
});

app.listen(port, () => console.log(`OTracker Backend running on port ${port}`));