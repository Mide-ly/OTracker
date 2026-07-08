require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const moment = require('moment');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase and Twilio clients via environment variables
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Standard health check route for cloud hosting platforms
app.get('/', (req, res) => {
    res.send('Car Reminder Engine is active and running.');
});

// The Reminder Logic Engine
async function checkExpirations() {
    console.log('Running daily expiration verification check...');
    
    const today = moment().startOf('day');
    const oneMonthFromNow = moment().add(30, 'days').startOf('day');

    try {
        // Fetch documents joined with car information
        const { data: documents, error } = await supabase
            .from('documents')
            .select(`
                id,
                type,
                expiry_date,
                cars ( name, plate_number )
            `);

        if (error) throw error;

        for (const doc of documents) {
            const expiry = moment(doc.expiry_date).startOf('day');
            const carName = doc.cars?.name || 'Unknown Vehicle';
            const plate = doc.cars?.plate_number || '';
            
            let messageType = null;

            if (expiry.isSame(oneMonthFromNow)) {
                messageType = 'expires in exactly 1 month';
            } else if (expiry.isSame(today)) {
                messageType = 'expires TODAY';
            }

            if (messageType) {
                const messageBody = `🚗 *Car Document Reminder* 🚗\n\nThe *${doc.type}* for your vehicle *${carName}* (${plate}) ${messageType} [${expiry.format('YYYY-MM-DD')}].\n\nPlease log into your dashboard to renew and upload the updated copy.`;
                
                await twilioClient.messages.create({
                    body: messageBody,
                    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
                    to: `whatsapp:${process.env.YOUR_PERSONAL_PHONE}`
                });
                
                console.log(`Notification dispatched successfully for ${carName} - ${doc.type}`);
            }
        }
    } catch (err) {
        console.error('Error executing expiration engine routine:', err.message);
    }
}

// Schedule the task to execute every single day at 08:00 AM
cron.schedule('0 8 * * *', () => {
    checkExpirations();
});

app.listen(PORT, () => {
    console.log(`Server listening effectively on port ${PORT}`);
});