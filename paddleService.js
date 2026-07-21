'use strict';
const crypto = require('crypto');

const PADDLE_API_KEY        = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const PADDLE_API_BASE       = 'https://api.paddle.com';

// ── Generic Paddle REST helper ────────────────────────────────────────────────
async function paddleRequest(method, path, body) {
  if (!PADDLE_API_KEY) throw new Error('PADDLE_API_KEY not set in .env');
  const res = await fetch(`${PADDLE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Paddle API ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ── Webhook HMAC-SHA256 verification ─────────────────────────────────────────
// Paddle-Signature header format: ts=<unix_ts>;h1=<hex_hmac>
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!PADDLE_WEBHOOK_SECRET) return true; // skip in dev if not set

  const parts = {};
  for (const part of (signatureHeader || '').split(';')) {
    const [k, v] = part.split('=', 2);
    if (k && v) parts[k.trim()] = v.trim();
  }

  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const expected = crypto
    .createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(`${ts}:${rawBody}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(h1, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ── Cancel a Paddle subscription at the end of the current period ─────────────
async function cancelSubscription(paddleSubscriptionId) {
  return paddleRequest('POST', `/subscriptions/${paddleSubscriptionId}/cancel`, {
    effective_at: 'next_billing_period',
  });
}

// ── Fetch Paddle's live IP allowlist ─────────────────────────────────────────
// Returns an array of CIDR strings, e.g. ["34.232.58.13/32", ...]
// Source of truth: https://api.paddle.com/ips
async function fetchPaddleIPs() {
  const res = await fetch('https://api.paddle.com/ips');
  const { data } = await res.json();
  return data?.ipv4_cidrs || [];
}

module.exports = {
  verifyWebhookSignature,
  cancelSubscription,
  paddleRequest,
  fetchPaddleIPs,
};
