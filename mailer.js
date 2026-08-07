// mailer.js — sends real email via SMTP (e.g. Gmail + an App Password) when configured,
// and falls back to "dev mode" (the caller returns the code directly in the API response
// instead of emailing it) when it isn't. Same fallback philosophy as the AI features:
// the feature must never block a demo just because an external service isn't set up.
//
// To send real email, set these environment variables before starting the server:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
// For Gmail specifically: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_USER=you@gmail.com,
// SMTP_PASS=<a 16-character Gmail App Password, not your normal password>, SMTP_FROM=you@gmail.com

const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
}

// Returns { sent: true } on real success, or { sent: false, reason } if it falls back.
// Callers are expected to include the code in their own API response when sent === false,
// so the frontend can display it in a clearly-labeled "dev mode" banner.
async function sendCodeEmail({ to, subject, code, purposeLabel }) {
  if (!isConfigured()) {
    return { sent: false, reason: 'SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS not set)' };
  }
  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: `Your ShopEase ${purposeLabel} code is: ${code}\n\nThis code expires in 15 minutes.`,
      html: `<p>Your ShopEase ${purposeLabel} code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>This code expires in 15 minutes.</p>`
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: 'SMTP send failed: ' + err.message };
  }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
}

module.exports = { sendCodeEmail, generateCode, isConfigured };
