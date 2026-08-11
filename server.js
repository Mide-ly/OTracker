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
        const maxDateStr = addDays(30);

        // 1. Fetch ALL documents expiring in 30 days OR LESS (this includes all past expired documents)
        const { data: documents, error } = await supabase
            .from('documents')
            .select('*')
            .lte('expiry_date', maxDateStr);

        if (error) throw error;

        if (documents && documents.length > 0) {
            for (const doc of documents) {
                
                const expiryObj = new Date(doc.expiry_date);
                const todayObj = new Date(todayStr);
                
                // Calculates exact days remaining (Negative numbers = days already expired)
                const diffDays = Math.round((expiryObj - todayObj) / (1000 * 60 * 60 * 24));

                // 2. THE MAGIC FILTER: Only alert if it is exactly a multiple of 5 days
                // This cleanly catches 30, 25, 20... 0... -5, -10, -15... forever!
                if (diffDays % 5 !== 0) continue;

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
                const userName = owner.username || owner.name || owner.first_name || 'Valued User';
                const vehicleName = `${car.name} (${car.plate_number})`;

                // 3. Dynamic formatting for past vs future alerts
                let statusText = "";
                if (diffDays > 0) {
                    statusText = `Expires in ${diffDays} days`;
                } else if (diffDays === 0) {
                    statusText = "EXPIRES TODAY";
                } else {
                    statusText = `EXPIRED ${Math.abs(diffDays)} days ago!`;
                }

                if (userEmail && userEmail.trim() !== '') {
                    
                    const templateParams = {
                        user_name: userName,
                        user_email: userEmail,
                        vehicle_name: vehicleName,
                        doc_type: doc.type,
                        expiry_date: doc.expiry_date,
                        days_remaining: statusText 
                    };

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