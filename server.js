require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// ============================================
// CLIENTS
// ============================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
});

// ============================================
// WHATSAPP (Meta Cloud API)
// Env vars needed:
//   WA_ACCESS_TOKEN     -> from Meta App Dashboard > WhatsApp > API Setup
//   WA_PHONE_NUMBER_ID  -> same page (this is the ID, NOT the phone number itself)
//   WA_TEMPLATE_NAME    -> your approved template name (default below)
// ============================================
const WA_API_URL = `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
const WA_TEMPLATE_NAME = process.env.WA_TEMPLATE_NAME || 'document_expiry_alert';

/**
 * Normalizes Nigerian phone numbers to Cloud API format.
 * "0803 123 4567"  -> "2348031234567"
 * "+2348031234567" -> "2348031234567"
 * Returns null if the number looks unusable.
 */
function normalizePhone(raw) {
    if (!raw) return null;
    let digits = raw.replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = '234' + digits.slice(1);
    if (digits.length < 10) return null;
    return digits;
}

/**
 * Sends one expiry alert via WhatsApp template message.
 * Template body expected: "⚠️ OTracker Alert: The {{1}} for your {{2}} expires {{3}}. ..."
 * ({{3}} receives a phrase like "in 5 days (2026-09-09)" or "TODAY (2026-08-10)")
 */
async function sendWhatsAppAlert(phone, docType, vehicleName, expiryPhrase) {
    const to = normalizePhone(phone);
    if (!to) return false;

    const response = await fetch(WA_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: to,
            type: 'template',
            template: {
                name: WA_TEMPLATE_NAME,
                language: { code: 'en' },
                components: [{
                    type: 'body',
                    parameters: [
                        { type: 'text', text: docType },
                        { type: 'text', text: vehicleName },
                        { type: 'text', text: expiryPhrase }
                    ]
                }]
            }
        })
    });

    const result = await response.json();
    if (!response.ok) {
        console.error('WhatsApp send failed:', JSON.stringify(result.error || result));
        return false;
    }
    return true;
}

// ============================================
// KEEP-AWAKE ROUTE (pinged by cron-job.org to avoid Render cold starts)
// ============================================
app.get('/', (req, res) => {
    res.send('OTracker Server is Awake!');
});

// ============================================
// THE TRIGGER ENDPOINT
// ============================================
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

        // Fetch everything expiring within the next 30 days (inclusive)
        const { data: documents, error } = await supabase
            .from('documents')
            .select('*')
            .gte('expiry_date', todayStr)
            .lte('expiry_date', nextMonthStr);

        if (error) throw error;

        /**
         * Tiered alert schedule (cron runs once daily):
         *   30 down to 15 days left -> every 5 days  (30, 25, 20, 15)
         *   14 down to  8 days left -> every 2 days  (14, 12, 10, 8)
         *    7 down to  0 days left -> every day     (7, 6, 5, 4, 3, 2, 1, 0)
         */
        const shouldAlert = (daysLeft) => {
            if (daysLeft < 0) return false;
            if (daysLeft <= 7) return true;
            if (daysLeft <= 14) return daysLeft % 2 === 0;
            if (daysLeft <= 30) return daysLeft % 5 === 0;
            return false;
        };

        const daysUntil = (expiryStr) => {
            const expiry = new Date(expiryStr + 'T00:00:00');
            const now = new Date(todayStr + 'T00:00:00');
            return Math.round((expiry - now) / (1000 * 60 * 60 * 24));
        };

        if (documents && documents.length > 0) {
            for (const doc of documents) {
                const daysLeft = daysUntil(doc.expiry_date);
                if (!shouldAlert(daysLeft)) continue;

                const { data: car } = await supabase.from('cars').select('*').eq('id', doc.car_id).single();
                if (!car) continue;

                const { data: owner } = await supabase.from('users').select('*').eq('id', car.owner_id).single();
                if (!owner) continue;

                const vehicleName = `${car.name} (${car.plate_number})`;
                const expiryPhrase = daysLeft === 0
                    ? `TODAY (${doc.expiry_date})`
                    : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${doc.expiry_date})`;
                const messageText = `⚠️ OTracker Alert: The ${doc.type} for your ${vehicleName} expires ${expiryPhrase}. Please renew it to stay road-legal.`;

                // --- WhatsApp (Meta Cloud API) ---
                if (owner.phone_number && owner.phone_number.trim() !== '') {
                    const ok = await sendWhatsAppAlert(owner.phone_number, doc.type, vehicleName, expiryPhrase);
                    if (ok) alertsSent++;
                }

                // --- Email ---
                if (owner.email && owner.email.trim() !== '') {
                    await transporter.sendMail({
                        from: `"OTracker Alerts" <${process.env.EMAIL_USER}>`,
                        to: owner.email,
                        subject: `Document Expiry Alert: ${vehicleName}`,
                        text: messageText,
                    });
                    alertsSent++;
                }
            }
        }

        res.status(200).send(`OK. ${alertsSent} alerts sent.`);
    } catch (err) {
        console.error('Alert Loop Error:', err.message);
        res.status(500).send('Error.');
    }
});

// ============================================
// TEST ENDPOINT — send yourself one WhatsApp message to verify setup.
// Usage: /api/test-whatsapp?to=2348031234567
// Remove or protect this route before going to production.
// ============================================
app.get('/api/test-whatsapp', async (req, res) => {
    const to = req.query.to;
    if (!to) return res.status(400).send('Add ?to=234XXXXXXXXXX to the URL.');

    const ok = await sendWhatsAppAlert(to, 'Insurance', 'Test Car (ABC-123-XY)', 'in 30 days (2026-09-09)');
    res.status(ok ? 200 : 500).send(ok ? 'WhatsApp test sent! Check your phone.' : 'Failed — check Render logs for the error from Meta.');
});

// ============================================
// DEBUG — shows exactly what the reminder logic sees. Remove before production.
// ============================================
app.get('/api/debug-reminders', async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const d = new Date(); d.setDate(d.getDate() + 30);
        const nextMonthStr = d.toISOString().split('T')[0];

        const { data: documents, error } = await supabase
            .from('documents').select('*')
            .gte('expiry_date', todayStr).lte('expiry_date', nextMonthStr);
        if (error) throw error;

        const report = { today: todayStr, window_end: nextMonthStr, docs_in_window: documents.length, docs: [] };

        for (const doc of documents) {
            const daysLeft = Math.round((new Date(doc.expiry_date + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / 86400000);
            const wouldAlert = daysLeft <= 7 ? true : daysLeft <= 14 ? daysLeft % 2 === 0 : daysLeft % 5 === 0;
            const { data: car } = await supabase.from('cars').select('*').eq('id', doc.car_id).single();
            const { data: owner } = car ? await supabase.from('users').select('email, phone_number').eq('id', car.owner_id).single() : { data: null };
            report.docs.push({
                type: doc.type, expiry_date: doc.expiry_date, daysLeft, wouldAlert,
                car_found: !!car, owner_found: !!owner,
                owner_email: owner?.email || null, owner_phone: owner?.phone_number || null
            });
        }
        res.json(report);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.listen(port, () => console.log(`OTracker Backend is running on port ${port}`));