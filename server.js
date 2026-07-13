require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase & Twilio
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Schedule task to run every day at 8:00 AM
cron.schedule('0 8 * * *', async () => {
    console.log('Running daily expiry check...');

    const today = new Date();
    const addDays = (days) => {
        const d = new Date(today);
        d.setDate(d.getDate() + days);
        return d.toISOString().split('T')[0];
    };

    const targetDates = [addDays(30), addDays(15), addDays(3)];

    try {
        const { data: expiringDocs, error } = await supabase
            .from('documents')
            .select(`
                id, type, expiry_date,
                cars ( name, plate_number, users ( name, phone_number ) )
            `)
            .in('expiry_date', targetDates);

        if (error) throw error;
        if (!expiringDocs || expiringDocs.length === 0) return console.log('No expiring documents today.');

        for (const doc of expiringDocs) {
            const car = doc.cars;
            const user = car.users;
            
            const message = `OTracker Alert: Hello ${user.name}, the ${doc.type} for your vehicle ${car.name} (${car.plate_number}) expires on ${doc.expiry_date}. Please renew it soon.`;

            await twilioClient.messages.create({
                body: message,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: user.phone_number
            });
            console.log(`Alert sent to ${user.phone_number}`);
        }
    } catch (err) {
        console.error('Error during cron job:', err.message);
    }
});

app.listen(port, () => {
    console.log(`OTracker Node backend running on port ${port}`);
});