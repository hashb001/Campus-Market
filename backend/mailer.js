const nodemailer = require('nodemailer');

// How verification emails are sent, in order of preference:
//   1. Brevo HTTP API (BREVO_API_KEY) - works on hosts that block SMTP, like Render's free plan
//   2. SMTP (SMTP_HOST/SMTP_USER/SMTP_PASS) - e.g. Gmail with an App Password
//   3. Nothing configured - the code is printed to the server console (local development)

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const SEND_TIMEOUT_MS = 15000;

const transporter = !BREVO_API_KEY && smtpConfigured
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        // Fail fast instead of hanging for minutes if the host blocks SMTP
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS
    })
    : null;

const mailMode = BREVO_API_KEY ? 'brevo' : transporter ? 'smtp' : 'console';
console.log(`Email delivery: ${mailMode === 'console' ? 'not configured (codes are printed to this console)' : mailMode.toUpperCase()}`);

// "Campus Market <someone@gmail.com>" -> { name: 'Campus Market', email: 'someone@gmail.com' }
function parseFrom(value) {
    const raw = (value || process.env.SMTP_USER || '').trim();
    const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim() || 'Campus Market', email: m[2].trim() };
    return { name: 'Campus Market', email: raw };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PURPOSES = {
    verify: {
        subject: 'Your Campus Market verification code',
        intro: 'Your Campus Market verification code is:',
        ignore: "If you didn't sign up, you can ignore this email."
    },
    reset: {
        subject: 'Reset your Campus Market password',
        intro: 'Use this code to reset your Campus Market password:',
        ignore: "If you didn't ask to reset your password, you can ignore this email. Your password won't change."
    }
};

function buildMessage(name, code, purpose = 'verify') {
    const p = PURPOSES[purpose] || PURPOSES.verify;
    return {
        subject: p.subject,
        text: `Hi ${name},\n\n${p.intro} ${code}\n\nIt expires in 15 minutes. ${p.ignore}`,
        html: `<p>Hi ${escapeHtml(name)},</p>
               <p>${p.intro}</p>
               <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
               <p>It expires in 15 minutes. ${escapeHtml(p.ignore)}</p>`
    };
}

async function sendViaBrevo(to, name, msg) {
    const sender = parseFrom(process.env.MAIL_FROM);
    if (!sender.email) throw new Error('MAIL_FROM must be set to a sender address verified in Brevo');

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
            sender,
            to: [{ email: to, name }],
            subject: msg.subject,
            textContent: msg.text,
            htmlContent: msg.html
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Brevo responded ${res.status}: ${body.slice(0, 300)}`);
    }
}

async function sendCode(to, name, code, purpose = 'verify') {
    const msg = buildMessage(name, code, purpose);
    if (mailMode === 'brevo') return sendViaBrevo(to, name, msg);
    if (mailMode === 'smtp') {
        return transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, ...msg });
    }
    const label = purpose === 'reset' ? 'Password reset code' : 'Verification code';
    console.log(`[DEV] ${label} for ${to}: ${code} (email not configured, not sent)`);
}

const sendVerificationCode = (to, name, code) => sendCode(to, name, code, 'verify');

module.exports = { sendCode, sendVerificationCode, mailMode };
