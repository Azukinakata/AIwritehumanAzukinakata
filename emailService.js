'use strict';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Must be an address on a domain verified in Resend, or their shared test
// sender (onboarding@resend.dev) which only delivers to your own Resend
// account email until a domain is verified.
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'AIwritehuman <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Resend ${res.status}: ${body.message || JSON.stringify(body)}`);
  }
}

async function sendPasswordResetEmail(to, resetLink) {
  await sendEmail({
    to,
    subject: 'Reset your AIwritehuman password',
    html: `
      <p>We received a request to reset your AIwritehuman password.</p>
      <p><a href="${resetLink}">Click here to set a new password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
    `,
  });
}

module.exports = { sendPasswordResetEmail };
