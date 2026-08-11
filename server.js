require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const emailjs = require('@emailjs/nodejs'); 

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.get('/', (req, res) => res.send("OTracker Email Notification Server is Running!"));

app.get('/api/run-reminders', async (req, res) => {
    console.log('Cron triggered: Checking for document & license expiry reminders...');
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
        const todayObj = new Date(todayStr);

        // ==========================================
        // 1. CHECK VEHICLE DOCUMENTS
        // ==========================================
        const { data: documents, error: docError } = await supabase
            .from('documents')
            .select('*')
            .lte('expiry_date', maxDateStr);

        if (docError) throw docError;

        if (documents && documents.length > 0) {
            for (const doc of documents) {
                const expiryObj = new Date(doc.expiry_date);
                const diffDays = Math.round((expiryObj - todayObj) / (1000 * 60 * 60 * 24));
                
                if (diffDays % 5 !== 0) continue;

                const { data: car } = await supabase.from('cars').select('*').eq('id', doc.car_id).single();
                if (!car) continue;

                const { data: owner } = await supabase.from('users').select('*').eq('id', car.owner_id).single();
                if (!owner) continue;

                const userEmail = owner.email;
                if (!userEmail || userEmail.trim() === '') continue;

                let statusText = diffDays > 0 ? `Expires in ${diffDays} days` : (diffDays === 0 ? "EXPIRES TODAY" : `EXPIRED ${Math.abs(diffDays)} days ago!`);

                await emailjs.send(
                    process.env.EMAILJS_SERVICE_ID,
                    process.env.EMAILJS_TEMPLATE_ID,
                    {
                        user_name: owner.username || owner.name || owner.first_name || 'Valued User',
                        user_email: userEmail,
                        driver_email: "", // Leave blank for standard vehicle docs
                        vehicle_name: `${car.name} (${car.plate_number})`,
                        doc_type: doc.type,
                        expiry_date: doc.expiry_date,
                        days_remaining: statusText 
                    },
                    { publicKey: process.env.EMAILJS_PUBLIC_KEY, privateKey: process.env.EMAILJS_PRIVATE_KEY }
                );
                emailsSent++;
            }
        }

        // ==========================================
        // 2. CHECK DRIVER LICENSES
        // ==========================================
        const { data: drivers, error: driverError } = await supabase
            .from('drivers')
            .select('*')
            .lte('license_expiry', maxDateStr);

        if (driverError) throw driverError;

        if (drivers && drivers.length > 0) {
            for (const driver of drivers) {
                const expiryObj = new Date(driver.license_expiry);
                const diffDays = Math.round((expiryObj - todayObj) / (1000 * 60 * 60 * 24));
                
                if (diffDays % 5 !== 0) continue;

                const { data: owner } = await supabase.from('users').select('*').eq('id', driver.owner_id).single();
                if (!owner) continue;

                const userEmail = owner.email;
                if (!userEmail || userEmail.trim() === '') continue;

                let statusText = diffDays > 0 ? `Expires in ${diffDays} days` : (diffDays === 0 ? "EXPIRES TODAY" : `EXPIRED ${Math.abs(diffDays)} days ago!`);

                await emailjs.send(
                    process.env.EMAILJS_SERVICE_ID,
                    process.env.EMAILJS_TEMPLATE_ID,
                    {
                        user_name: owner.username || owner.name || owner.first_name || 'Valued User',
                        user_email: userEmail,
                        driver_email: driver.email || "", // THIS CC'S THE DRIVER!
                        vehicle_name: `Driver Roster: ${driver.name}`,
                        doc_type: "Driver's License",
                        expiry_date: driver.license_expiry,
                        days_remaining: statusText 
                    },
                    { publicKey: process.env.EMAILJS_PUBLIC_KEY, privateKey: process.env.EMAILJS_PRIVATE_KEY }
                );
                emailsSent++;
            }
        }
        
        console.log(`Job complete. Sent ${emailsSent} total email alerts.`);
        res.status(200).send(`OK. ${emailsSent} email alerts sent.`);
    } catch (err) {
        const errorDetails = err.text || err.message || JSON.stringify(err);
        console.error("Error during reminder execution:", errorDetails);
        res.status(500).send(`Server Error: ${errorDetails}`);
    }
});

app.listen(port, () => console.log(`OTracker Backend running on port ${port}`));