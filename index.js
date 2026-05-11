/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         FAST CARE NURSING - WhatsApp AI Bot              ║
 * ║         Website : https://fastcarenursing.com            ║
 * ║         Email   : contact@fastcarenursing.com            ║
 * ║         Emergency: +94769830811                          ║
 * ║         Country : Sri Lanka 🇱🇰                          ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * GitHub Secrets Required:
 *   FIREBASE_URL  → Your Firebase Realtime Database URL
 *
 * HOW SESSION WORKS (IMPORTANT — READ THIS):
 *   1. First run: scan QR in GitHub Actions logs → session saved to Firebase
 *   2. All future runs: session loaded from Firebase → no QR needed
 *   3. If logged out: delete /session node in Firebase, re-run to get new QR
 *
 * Features:
 *   ✅ Patient / Caretaker booking flow
 *   ✅ Nurse / Job seeker application flow
 *   ✅ Hospital partner inquiry flow
 *   ✅ General chatbot mode
 *   ✅ Auto keyword detection
 *   ✅ Nurse matching by specialty & availability
 *   ✅ Firebase session persistence (survives GitHub Actions restarts)
 *   ✅ Firebase bookings & applications saved
 *   ✅ Emergency contact always available
 *   ✅ LKR pricing (Female: LKR 3,800/day | Male: LKR 4,200/day)
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode  = require('qrcode-terminal');
const pino    = require('pino');
const fs      = require('fs');
const path    = require('path');

// ─── FIREBASE URL FROM GITHUB SECRETS ─────────────────────────────────────────
const FIREBASE_URL = process.env.FIREBASE_URL;

// ─── SESSION STATE STORAGE ─────────────────────────────────────────────────────
const userStates = {};
const SESSION_DIR = path.join(__dirname, 'session_data');

// ─── PRICING CONSTANTS ─────────────────────────────────────────────────────────
const PRICING = {
    femalePatient: 3800,
    malePatient:   4200,
    currency:      'LKR'
};

// ─── CONTACT CONSTANTS ─────────────────────────────────────────────────────────
const CONTACT = {
    emergency: '+94769830811',
    email:     'contact@fastcarenursing.com',
    website:   'https://fastcarenursing.com'
};

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION PERSISTENCE — Save/Load session_data to/from Firebase
// This is what makes the bot survive GitHub Actions restarts without re-scanning QR
// ═══════════════════════════════════════════════════════════════════════════════

/** Load WhatsApp session files from Firebase into local session_data/ folder */
async function loadSessionFromFirebase() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/session.json`);
        const data = await res.json();
        if (!data) {
            console.log('ℹ️  No saved session in Firebase — will show QR on first run.');
            return;
        }
        if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
        for (const [filename, content] of Object.entries(data)) {
            const decoded = Buffer.from(content, 'base64').toString('utf-8');
            fs.writeFileSync(path.join(SESSION_DIR, filename), decoded, 'utf-8');
        }
        console.log(`✅ Session loaded from Firebase (${Object.keys(data).length} files)`);
    } catch (err) {
        console.log('⚠️  Could not load session from Firebase:', err.message);
    }
}

/** Save local session_data/ files to Firebase after login / credential update */
async function saveSessionToFirebase() {
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        const files   = fs.readdirSync(SESSION_DIR);
        const payload = {};
        for (const f of files) {
            const raw     = fs.readFileSync(path.join(SESSION_DIR, f), 'utf-8');
            payload[f]    = Buffer.from(raw, 'utf-8').toString('base64');
        }
        await fetch(`${FIREBASE_URL}/session.json`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload)
        });
        console.log('💾 Session saved to Firebase');
    } catch (err) {
        console.error('❌ Could not save session to Firebase:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIREBASE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getAvailableNurses() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/nurses.json`);
        const data = await res.json();
        if (!data) return [];
        return Object.keys(data).map(key => ({ id: key, ...data[key] }));
    } catch (err) {
        console.error('❌ Failed to fetch nurses:', err);
        return [];
    }
}

async function saveBooking(bookingData) {
    try {
        await fetch(`${FIREBASE_URL}/bookings.json`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                ...bookingData,
                status:    'Pending',
                source:    'WhatsApp Bot',
                timestamp: new Date().toISOString()
            })
        });
        return true;
    } catch (err) {
        console.error('❌ Firebase booking error:', err);
        return false;
    }
}

async function saveNurseApplication(appData) {
    try {
        await fetch(`${FIREBASE_URL}/nurse_applications.json`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                ...appData,
                status:    'Under Review',
                source:    'WhatsApp Bot',
                timestamp: new Date().toISOString()
            })
        });
        return true;
    } catch (err) {
        console.error('❌ Firebase nurse application error:', err);
        return false;
    }
}

async function savePartnerInquiry(inquiryData) {
    try {
        await fetch(`${FIREBASE_URL}/partner_inquiries.json`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                ...inquiryData,
                status:    'New',
                source:    'WhatsApp Bot',
                timestamp: new Date().toISOString()
            })
        });
        return true;
    } catch (err) {
        console.error('❌ Firebase inquiry error:', err);
        return false;
    }
}

async function findMatchingNurse(condition, shiftPreference) {
    const nurses   = await getAvailableNurses();
    if (!nurses.length) return null;
    const available = nurses.filter(n => n.available === true || n.available === 'true');
    if (!available.length) return null;
    const conditionLower = (condition || '').toLowerCase();
    const matched = available.find(n => {
        const specialties = (n.specializations || '').toLowerCase();
        if (conditionLower.includes('elderly') || conditionLower.includes('old'))
            return specialties.includes('geriatric') || specialties.includes('elderly');
        if (conditionLower.includes('surgery') || conditionLower.includes('post-op'))
            return specialties.includes('post-operative') || specialties.includes('surgery');
        if (conditionLower.includes('dementia') || conditionLower.includes('alzheimer'))
            return specialties.includes('dementia') || specialties.includes('palliative');
        if (conditionLower.includes('wound') || conditionLower.includes('dressing'))
            return specialties.includes('wound');
        if (conditionLower.includes('bedridden') || conditionLower.includes('paralysis'))
            return specialties.includes('home care') || specialties.includes('critical');
        return true;
    });
    return matched || available[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

const MSG = {

    welcome: () =>
`🏥 *Welcome to Fast Care Nursing!*
_Sri Lanka's Trusted Home Nursing Service_
🌐 ${CONTACT.website}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Please tell us who you are so we can assist you better:

┌─────────────────────────────────┐
│ 1️⃣  👤 *PATIENT / CARETAKER*    │
│     Need home nursing services  │
├─────────────────────────────────┤
│ 2️⃣  💼 *NURSE / JOB SEEKER*     │
│     Looking for healthcare jobs │
├─────────────────────────────────┤
│ 3️⃣  🏢 *HOSPITAL PARTNER*       │
│     Collaboration inquiries     │
├─────────────────────────────────┤
│ 4️⃣  💬 *GENERAL CHAT*           │
│     Explore / Ask questions     │
└─────────────────────────────────┘

_Type 1, 2, 3 or 4 to continue_
📞 Emergency: ${CONTACT.emergency}`,

    patientMenu: () =>
`✅ *You're in the right place!*

We provide 24/7 professional home nursing care across Sri Lanka 🇱🇰

┌─────────────────────────────────┐
│ 1️⃣  📝 Book a Nurse             │
│ 2️⃣  👩‍⚕️ View Available Nurses    │
│ 3️⃣  📋 Check Booking Status     │
│ 4️⃣  🚨 Emergency Assistance     │
│ 5️⃣  🙋 Speak to Human Support   │
└─────────────────────────────────┘

_Type a number to continue, or type *menu* anytime to return here_`,

    bookingStart: () =>
`📝 *New Booking Request*
_Let me gather a few details to find the best nurse for you_

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

👤 *Step 1 of 7 — Patient Full Name*
Please type the patient's full name:

_(Type "skip" for optional fields)_`,

    askAge: (name) =>
`✅ Got it — *${name}*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎂 *Step 2 of 7 — Age & Gender*

Please reply with age and gender, e.g.:
*65, Female* or *72, Male*`,

    askCondition: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🩺 *Step 3 of 7 — Medical Condition*

Please select the primary condition:

┌─────────────────────────────────┐
│ a) Elderly care (65+ years)     │
│ b) Post-surgery recovery        │
│ c) Bedridden / Paralysis        │
│ d) Dementia / Alzheimer's       │
│ e) Diabetes management          │
│ f) Wound care / Dressing        │
│ g) Palliative / Terminal care   │
│ h) Other (please describe)      │
└─────────────────────────────────┘

_Type a letter (e.g., *a*) or describe freely_`,

    askService: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🕐 *Step 4 of 7 — Required Service Type*

┌─────────────────────────────────┐
│ 1) 24x7 Live-in Care            │
│ 2) Daytime (8 AM – 8 PM)        │
│ 3) Night Shift (8 PM – 8 AM)    │
│ 4) Hourly basis                 │
└─────────────────────────────────┘

_Type 1, 2, 3 or 4_`,

    askSchedule: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 *Step 5 of 7 — Preferred Schedule*

Please reply with:
• Start date (DD/MM/YYYY)
• Duration (e.g., 7 days / 2 weeks / 1 month)

_Example: 25/12/2025, 2 weeks_`,

    askAddress: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 *Step 6 of 7 — Home Address*

Please type the full home address for the nurse visit:

_(Or share your live location 📌)_`,

    askBudget: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *Step 7 of 7 — Patient Gender (for pricing)*

Our home nursing rates are:

┌─────────────────────────────────┐
│ 👩 Female Patient: LKR 3,800/day│
│ 👨 Male Patient:   LKR 4,200/day│
└─────────────────────────────────┘

⚠️ *Note:* The patient's family is required to arrange *daily meals* for the nurse.

Please confirm your patient's gender:
Type *female* or *male*`,

    bookingConfirm: (data, nurse) =>
`✅ *Booking Confirmed!*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *Booking Summary*

👤 Patient: *${data.patientName}*
🎂 Age/Gender: *${data.ageGender}*
🩺 Condition: *${data.condition}*
🕐 Service: *${data.service}*
📅 Schedule: *${data.schedule}*
📍 Address: *${data.address}*
💰 Rate: *LKR ${data.rate}/day*

🍽️ _Reminder: Please arrange daily meals for the nurse_

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${nurse
    ? `👩‍⚕️ *Nurse Assigned:* ${nurse.name}\n📞 Contact: ${nurse.phone || 'Will be provided shortly'}`
    : `👩‍⚕️ *Nurse Matching:* Our team will contact you shortly to confirm a nurse!`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 Support: ${CONTACT.emergency}
📧 Email: ${CONTACT.email}
🌐 ${CONTACT.website}

_Thank you for choosing Fast Care Nursing! 🏥_`,

    nurseMenu: () =>
`💼 *Nurse / Healthcare Job Seeker*

We connect qualified nurses with families across Sri Lanka 🇱🇰

┌─────────────────────────────────┐
│ 1️⃣  📝 Apply / Submit Profile   │
│ 2️⃣  📋 Check Application Status │
│ 3️⃣  💬 Talk to HR Team          │
└─────────────────────────────────┘

_Type 1, 2 or 3 to continue_`,

    nurseAppStart: () =>
`📝 *Nurse Application Form*
_Build your professional profile with us_

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Step 1 — Full Name*
Please type your full name:`,

    nurseAskPhone: (name) =>
`✅ *${name}*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 *Step 2 — Phone Number*
Please type your contact number (with country code):
_e.g., +94771234567_`,

    nurseAskQualification: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎓 *Step 3 — Nursing Qualification*

┌─────────────────────────────────┐
│ a) GNM (General Nursing)        │
│ b) B.Sc Nursing                 │
│ c) M.Sc Nursing                 │
│ d) ANM (Auxiliary Nurse)        │
│ e) Other Diploma / Certificate  │
└─────────────────────────────────┘

_Type a letter (e.g., *b*)_`,

    nurseAskExperience: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 *Step 4 — Experience*
How many years of nursing experience do you have?
_e.g., 3 years 6 months_`,

    nurseAskSpecialization: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏥 *Step 5 — Specializations*
Select all that apply (type letters separated by commas):

┌─────────────────────────────────┐
│ a) Geriatric / Elderly Care     │
│ b) Critical Care / ICU          │
│ c) Pediatric Nursing            │
│ d) Post-Operative Care          │
│ e) Wound Management             │
│ f) Palliative / Home Care       │
│ g) Dementia / Alzheimer's       │
│ h) Other                        │
└─────────────────────────────────┘

_e.g., a, d, f_`,

    nurseAskShift: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🕐 *Step 6 — Preferred Shift*

┌─────────────────────────────────┐
│ 1) Day shift (8 AM – 8 PM)      │
│ 2) Night shift (8 PM – 8 AM)    │
│ 3) 24x7 Live-in                 │
│ 4) Flexible                     │
└─────────────────────────────────┘

_Type 1, 2, 3 or 4_`,

    nurseAskLocation: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 *Step 7 — Preferred Work Location*
Which city or area in Sri Lanka are you available to work?
_e.g., Colombo, Kandy, Galle_`,

    nurseAskSalary: () =>
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *Step 8 — Expected Salary*
What is your expected salary?
_e.g., LKR 45,000/month or LKR 600/hour_`,

    nurseConfirm: (data) =>
`✅ *Application Submitted Successfully!*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *Your Profile Summary*

👤 Name: *${data.name}*
📞 Phone: *${data.phone}*
🎓 Qualification: *${data.qualification}*
📅 Experience: *${data.experience}*
🏥 Specializations: *${data.specializations}*
🕐 Preferred Shift: *${data.shift}*
📍 Location: *${data.location}*
💰 Expected Salary: *${data.salary}*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Our HR team will review your profile and contact you within *2–3 working days*.

📞 HR Direct: ${CONTACT.emergency}
📧 Email: ${CONTACT.email}
🌐 ${CONTACT.website}

_Thank you for joining Fast Care Nursing! 💚_`,

    partnerMenu: () =>
`🏢 *Hospital / Institution Partnership*

We collaborate with hospitals, clinics, and care homes across Sri Lanka 🇱🇰

Please describe your institution and the type of collaboration you're looking for.

_Or type *call* to have our team contact you directly._`,

    partnerConfirm: () =>
`✅ *Inquiry Received!*

Thank you for reaching out. Our partnership team will get in touch with you within *1–2 business days*.

📞 Direct Line: ${CONTACT.emergency}
📧 Email: ${CONTACT.email}
🌐 ${CONTACT.website}

_Fast Care Nursing — Your Healthcare Partner 🏥_`,

    generalChat: () =>
`💬 *General Information*

Here's what we offer at Fast Care Nursing:

🏥 *Services:*
• Professional home nursing (24/7)
• Post-operative & rehabilitation care
• Elderly & dementia care
• Wound dressing & medication management
• Palliative & critical home care

💰 *Rates:*
• Female Nurse: LKR 3,800/day
• Male Nurse:   LKR 4,200/day
• Meal arrangement: Patient's family

📞 *Emergency:* ${CONTACT.emergency}
📧 *Email:* ${CONTACT.email}
🌐 *Website:* ${CONTACT.website}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Type *menu* to return to the main menu.`,

    humanSupport: () =>
`🙋 *Human Support*

Our care coordinators are available 24/7.

📞 *Call / WhatsApp:* ${CONTACT.emergency}
📧 *Email:* ${CONTACT.email}
🌐 *Website:* ${CONTACT.website}

_A team member will respond within minutes during business hours._`,

    emergency: () =>
`🚨 *EMERGENCY ASSISTANCE*

Please call or WhatsApp immediately:

📞 *${CONTACT.emergency}*

We are available *24 hours, 7 days a week*.

If this is a life-threatening emergency, please also call:
🚑 *Ambulance: 110*

_Fast Care Nursing — Always here for you 🏥_`,

    fallback: () =>
`👋 I didn't quite catch that.

Type *menu* to see the main options, or:
📞 Call us directly: ${CONTACT.emergency}
📧 Email: ${CONTACT.email}`,
};

// ═══════════════════════════════════════════════════════════════════════════════
// OPTION MAPS
// ═══════════════════════════════════════════════════════════════════════════════

const CONDITION_MAP = {
    a: 'Elderly care (65+ years)', b: 'Post-surgery recovery',
    c: 'Bedridden / Paralysis',    d: 'Dementia / Alzheimer\'s',
    e: 'Diabetes management',      f: 'Wound care / Dressing',
    g: 'Palliative / Terminal care'
};

const SERVICE_MAP = {
    '1': '24x7 Live-in Care', '2': 'Daytime (8 AM – 8 PM)',
    '3': 'Night Shift (8 PM – 8 AM)', '4': 'Hourly basis'
};

const QUALIFICATION_MAP = {
    a: 'GNM (General Nursing)', b: 'B.Sc Nursing',
    c: 'M.Sc Nursing',          d: 'ANM (Auxiliary Nurse)',
    e: 'Other Diploma / Certificate'
};

const SPECIALIZATION_MAP = {
    a: 'Geriatric / Elderly Care', b: 'Critical Care / ICU',
    c: 'Pediatric Nursing',        d: 'Post-Operative Care',
    e: 'Wound Management',         f: 'Palliative / Home Care',
    g: 'Dementia / Alzheimer\'s',  h: 'Other'
};

const SHIFT_MAP = {
    '1': 'Day shift (8 AM – 8 PM)', '2': 'Night shift (8 PM – 8 AM)',
    '3': '24x7 Live-in',            '4': 'Flexible'
};

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMessage(sock, sender, text) {
    const lower = text.toLowerCase().trim();

    // ── Global shortcuts ──────────────────────────────────────────────────────
    if (['menu', 'start', 'hi', 'hello', 'help', '0', 'helo', 'hai'].includes(lower)) {
        userStates[sender] = {};
        return await sock.sendMessage(sender, { text: MSG.welcome() });
    }

    if (lower === 'emergency' || lower === 'ambulance') {
        return await sock.sendMessage(sender, { text: MSG.emergency() });
    }

    const state = userStates[sender] || {};

    // ── No state → detect intent or show welcome ──────────────────────────────
    if (!state.flow) {
        if (lower.includes('nurse') || lower.includes('job') || lower.includes('work'))
            return await sock.sendMessage(sender, { text: MSG.nurseMenu() });
        if (lower.includes('patient') || lower.includes('book') || lower.includes('nursing'))
            return await sock.sendMessage(sender, { text: MSG.patientMenu() });
        if (lower.includes('hospital') || lower.includes('partner') || lower.includes('clinic'))
            return await sock.sendMessage(sender, { text: MSG.partnerMenu() });

        if (text === '1') {
            userStates[sender] = { flow: 'patient', step: 'menu' };
            return await sock.sendMessage(sender, { text: MSG.patientMenu() });
        }
        if (text === '2') {
            userStates[sender] = { flow: 'nurse', step: 'menu' };
            return await sock.sendMessage(sender, { text: MSG.nurseMenu() });
        }
        if (text === '3') {
            userStates[sender] = { flow: 'partner', step: 'inquiry' };
            return await sock.sendMessage(sender, { text: MSG.partnerMenu() });
        }
        if (text === '4') {
            userStates[sender] = { flow: 'general' };
            return await sock.sendMessage(sender, { text: MSG.generalChat() });
        }

        return await sock.sendMessage(sender, { text: MSG.welcome() });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PATIENT FLOW
    // ═══════════════════════════════════════════════════════════════════════════
    if (state.flow === 'patient') {

        if (state.step === 'menu') {
            if (text === '1') {
                userStates[sender] = { flow: 'patient', step: 'name', data: {} };
                return await sock.sendMessage(sender, { text: MSG.bookingStart() });
            }
            if (text === '2') {
                const nurses = await getAvailableNurses();
                const available = nurses.filter(n => n.available === true || n.available === 'true');
                if (!available.length) {
                    return await sock.sendMessage(sender, { text: `👩‍⚕️ *Available Nurses*\n\nAll our nurses are currently assigned. Please contact us directly:\n📞 ${CONTACT.emergency}` });
                }
                const list = available.slice(0, 5).map((n, i) =>
                    `${i + 1}. *${n.name || 'Nurse'}* — ${n.specializations || 'General Care'} | ${n.shift || 'Flexible'} | ${n.location || 'Sri Lanka'}`
                ).join('\n');
                return await sock.sendMessage(sender, { text: `👩‍⚕️ *Available Nurses (${available.length} found)*\n\n${list}\n\n_Type *1* to book a nurse, or *menu* to go back._` });
            }
            if (text === '3') {
                return await sock.sendMessage(sender, { text: `📋 *Booking Status*\n\nPlease share your WhatsApp number used during booking.\nOur team will check and update you.\n\n📞 ${CONTACT.emergency}` });
            }
            if (text === '4') return await sock.sendMessage(sender, { text: MSG.emergency() });
            if (text === '5') return await sock.sendMessage(sender, { text: MSG.humanSupport() });
            return await sock.sendMessage(sender, { text: MSG.patientMenu() });
        }

        if (state.step === 'name') {
            userStates[sender].data.patientName = text;
            userStates[sender].step = 'age';
            return await sock.sendMessage(sender, { text: MSG.askAge(text) });
        }
        if (state.step === 'age') {
            userStates[sender].data.ageGender = text;
            userStates[sender].step = 'condition';
            return await sock.sendMessage(sender, { text: MSG.askCondition() });
        }
        if (state.step === 'condition') {
            userStates[sender].data.condition = CONDITION_MAP[lower] || text;
            userStates[sender].step = 'service';
            return await sock.sendMessage(sender, { text: MSG.askService() });
        }
        if (state.step === 'service') {
            userStates[sender].data.service = SERVICE_MAP[text] || text;
            userStates[sender].step = 'schedule';
            return await sock.sendMessage(sender, { text: MSG.askSchedule() });
        }
        if (state.step === 'schedule') {
            userStates[sender].data.schedule = text;
            userStates[sender].step = 'address';
            return await sock.sendMessage(sender, { text: MSG.askAddress() });
        }
        if (state.step === 'address') {
            userStates[sender].data.address = text;
            userStates[sender].step = 'gender';
            return await sock.sendMessage(sender, { text: MSG.askBudget() });
        }
        if (state.step === 'gender') {
            const isFemale = lower.includes('female') || lower === 'f';
            const rate     = isFemale ? PRICING.femalePatient : PRICING.malePatient;
            const bookingData = { ...userStates[sender].data, patientGender: isFemale ? 'Female' : 'Male', rate };
            const waNumber = sender.split('@')[0];
            const nurse = await findMatchingNurse(bookingData.condition, bookingData.service);

            await saveBooking({
                userId:              'whatsapp_' + waNumber,
                waNumber,
                ...bookingData,
                ratePerDay:          rate,
                currency:            'LKR',
                assignedNurseId:     nurse?.id || null,
                assignedNurseName:   nurse?.name || 'Pending Assignment',
                mealArrangement:     'Family to arrange meals for nurse',
            });

            userStates[sender] = {};
            return await sock.sendMessage(sender, { text: MSG.bookingConfirm(bookingData, nurse) });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NURSE / JOB SEEKER FLOW
    // ═══════════════════════════════════════════════════════════════════════════
    if (state.flow === 'nurse') {
        if (state.step === 'menu') {
            if (text === '1' || lower === 'apply') {
                userStates[sender] = { flow: 'nurse', step: 'app_name', data: {} };
                return await sock.sendMessage(sender, { text: MSG.nurseAppStart() });
            }
            if (text === '2') {
                return await sock.sendMessage(sender, { text: `📋 *Application Status*\n\nPlease share your registered phone number and our HR team will update you.\n\n📞 HR: ${CONTACT.emergency}\n📧 ${CONTACT.email}` });
            }
            if (text === '3') return await sock.sendMessage(sender, { text: MSG.humanSupport() });
            return await sock.sendMessage(sender, { text: MSG.nurseMenu() });
        }

        if (state.step === 'app_name') {
            userStates[sender].data.name = text;
            userStates[sender].step = 'app_phone';
            return await sock.sendMessage(sender, { text: MSG.nurseAskPhone(text) });
        }
        if (state.step === 'app_phone') {
            userStates[sender].data.phone = text;
            userStates[sender].step = 'app_qualification';
            return await sock.sendMessage(sender, { text: MSG.nurseAskQualification() });
        }
        if (state.step === 'app_qualification') {
            userStates[sender].data.qualification = QUALIFICATION_MAP[lower] || text;
            userStates[sender].step = 'app_experience';
            return await sock.sendMessage(sender, { text: MSG.nurseAskExperience() });
        }
        if (state.step === 'app_experience') {
            userStates[sender].data.experience = text;
            userStates[sender].step = 'app_specialization';
            return await sock.sendMessage(sender, { text: MSG.nurseAskSpecialization() });
        }
        if (state.step === 'app_specialization') {
            const letters = text.split(',').map(s => s.trim().toLowerCase());
            userStates[sender].data.specializations = letters.map(l => SPECIALIZATION_MAP[l] || l).join(', ');
            userStates[sender].step = 'app_shift';
            return await sock.sendMessage(sender, { text: MSG.nurseAskShift() });
        }
        if (state.step === 'app_shift') {
            userStates[sender].data.shift = SHIFT_MAP[text] || text;
            userStates[sender].step = 'app_location';
            return await sock.sendMessage(sender, { text: MSG.nurseAskLocation() });
        }
        if (state.step === 'app_location') {
            userStates[sender].data.location = text;
            userStates[sender].step = 'app_salary';
            return await sock.sendMessage(sender, { text: MSG.nurseAskSalary() });
        }
        if (state.step === 'app_salary') {
            userStates[sender].data.salary = text;
            const appData  = userStates[sender].data;
            const waNumber = sender.split('@')[0];
            await saveNurseApplication({ userId: 'whatsapp_' + waNumber, waNumber, ...appData });
            userStates[sender] = {};
            return await sock.sendMessage(sender, { text: MSG.nurseConfirm(appData) });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HOSPITAL PARTNER FLOW
    // ═══════════════════════════════════════════════════════════════════════════
    if (state.flow === 'partner') {
        if (state.step === 'inquiry') {
            if (lower === 'call') return await sock.sendMessage(sender, { text: MSG.humanSupport() });
            const waNumber = sender.split('@')[0];
            await savePartnerInquiry({ waNumber, message: text });
            userStates[sender] = {};
            return await sock.sendMessage(sender, { text: MSG.partnerConfirm() });
        }
    }

    // ── General / fallback ────────────────────────────────────────────────────
    return await sock.sendMessage(sender, { text: MSG.fallback() });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT STARTUP
// ═══════════════════════════════════════════════════════════════════════════════
async function startBot() {
    if (!FIREBASE_URL) {
        console.error('❌ ERROR: FIREBASE_URL environment variable is missing!');
        console.error('   → Add it as a GitHub Secret named FIREBASE_URL');
        process.exit(1);
    }

    // Load saved WhatsApp session from Firebase (skip QR on subsequent runs)
    await loadSessionFromFirebase();

    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth:             state,
        printQRInTerminal: false,
        logger:           pino({ level: 'silent' }),
        browser:          ['FastCareNursing', 'Chrome', '1.0.0']
    });

    // ── CONNECTION EVENTS ──────────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('\n╔══════════════════════════════════════════╗');
            console.log('║  FAST CARE NURSING — WhatsApp Bot QR     ║');
            console.log('║  Scan this QR code with WhatsApp         ║');
            console.log('║  → Actions tab → your workflow run       ║');
            console.log('║  → Click "View raw logs" if cut off      ║');
            console.log('╚══════════════════════════════════════════╝\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ FAST CARE NURSING BOT IS ONLINE! 🏥');
            console.log(`🌐 Website: ${CONTACT.website}`);
            console.log(`📞 Emergency: ${CONTACT.emergency}`);
            // Save fresh session so next run doesn't need QR
            await saveSessionToFirebase();
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️  Connection closed. Reason code: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting...');
                startBot();
            } else {
                console.log('🔴 Logged out. Delete /session in Firebase and re-run to get a new QR.');
                process.exit(0);
            }
        }
    });

    // Save credentials whenever they update (keeps Firebase session fresh)
    sock.ev.on('creds.update', async (creds) => {
        await saveCreds();
        await saveSessionToFirebase();
    });

    // ── INCOMING MESSAGE HANDLER ───────────────────────────────────────────────
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;
            if (msg.key.remoteJid === 'status@broadcast') return;
            if (msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const text   = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ''
            ).trim();

            if (!text) return;

            await handleMessage(sock, sender, text);

        } catch (err) {
            console.error('❌ Message handling error:', err);
        }
    });
}

// ─── START ─────────────────────────────────────────────────────────────────────
startBot().catch(err => {
    console.error('❌ Fatal startup error:', err);
    process.exit(1);
});
