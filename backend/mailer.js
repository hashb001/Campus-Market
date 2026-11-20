const nodemailer = require('nodemailer');

// If SMTP isn't configured (e.g. local development), codes are printed to the
// server console instead of being emailed.
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = smtpConfigured
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    : null;

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendVerificationCode(to, name, code) {
    if (!transporter) {
        console.log(`[DEV] Verification code for ${to}: ${code} (SMTP not configured, email not sent)`);
        return;
    }
    await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to,
        subject: 'Your Campus Market verification code',
        text: `Hi ${name},\n\nYour Campus Market verification code is: ${code}\n\nIt expires in 15 minutes. If you didn't sign up, you can ignore this email.`,
        html: `<p>Hi ${escapeHtml(name)},</p>
               <p>Your Campus Market verification code is:</p>
               <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
               <p>It expires in 15 minutes. If you didn't sign up, you can ignore this email.</p>`
    });
}

module.exports = { sendVerificationCode, smtpConfigured };
