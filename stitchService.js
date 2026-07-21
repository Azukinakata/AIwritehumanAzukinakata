'use strict';
const crypto = require('crypto');

const STITCH_CLIENT_ID      = process.env.STITCH_CLIENT_ID;
const STITCH_CLIENT_SECRET  = process.env.STITCH_CLIENT_SECRET;
const STITCH_WEBHOOK_SECRET = process.env.STITCH_WEBHOOK_SECRET;
const STITCH_RETURN_URL     = process.env.STITCH_RETURN_URL  || 'http://localhost:5500/payment/success';
const STITCH_FAILURE_URL    = process.env.STITCH_FAILURE_URL || 'http://localhost:5500/payment/failed';

// Merchant bank account (provided by Stitch during go-live)
const BENEFICIARY = {
  name:          process.env.STITCH_BENEFICIARY_NAME           || 'AIwritehuman',
  bankId:        process.env.STITCH_BENEFICIARY_BANK_ID        || '',
  accountNumber: process.env.STITCH_BENEFICIARY_ACCOUNT_NUMBER || '',
  branchCode:    process.env.STITCH_BENEFICIARY_BRANCH_CODE    || '',
  accountType:   process.env.STITCH_BENEFICIARY_ACCOUNT_TYPE   || 'current',
};

const TOKEN_URL   = 'https://secure.stitch.money/connect/token';
const GRAPHQL_URL = 'https://api.stitch.money/graphql';

// ── Token cache ───────────────────────────────────────────────────────────────
let cachedToken  = null;
let tokenExpires = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpires - 30_000) return cachedToken;

  if (!STITCH_CLIENT_ID || !STITCH_CLIENT_SECRET) {
    throw new Error('Stitch credentials not configured. Set STITCH_CLIENT_ID and STITCH_CLIENT_SECRET.');
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     STITCH_CLIENT_ID,
      client_secret: STITCH_CLIENT_SECRET,
      audience:      'https://secure.stitch.money/connect/token',
      scope:         'client_paymentrequest',
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Stitch token error ${resp.status}: ${txt}`);
  }

  const { access_token, expires_in } = await resp.json();
  cachedToken  = access_token;
  tokenExpires = Date.now() + expires_in * 1000;
  return cachedToken;
}

// ── GraphQL helper ────────────────────────────────────────────────────────────
async function stitchQuery(query, variables = {}) {
  const token = await getAccessToken();
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) throw new Error(`Stitch GraphQL HTTP ${resp.status}`);
  const { data, errors } = await resp.json();
  if (errors?.length) throw new Error(`Stitch GQL: ${errors.map(e => e.message).join(', ')}`);
  return data;
}

// ── Create a one-time payment initiation (first charge or upgrade) ────────────
// Returns { id, url } — redirect the user to `url` to authorise.
async function createPaymentInitiation({ userId, planId, planName, amountCents, subscriptionId }) {
  const amountStr = (amountCents / 100).toFixed(2);

  const query = `
    mutation CreatePaymentInitiationRequest($input: ClientPaymentInitiationRequestInput!) {
      clientPaymentInitiationRequestCreate(input: $input) {
        paymentInitiationRequest {
          id
          url
        }
      }
    }
  `;

  const variables = {
    input: {
      amount:              { quantity: amountStr, currency: 'ZAR' },
      payerReference:      `AIW-${userId.slice(0, 8).toUpperCase()}`,
      beneficiaryReference: `AIW-${planId.toUpperCase()}`,
      externalReference:   `sub-${subscriptionId}`,
      merchant: {
        name:       'AIwritehuman',
        categories: ['SoftwareAsAService'],
      },
      beneficiary: {
        bankAccount: {
          name:          BENEFICIARY.name,
          bankId:        BENEFICIARY.bankId,
          accountNumber: BENEFICIARY.accountNumber,
          accountType:   BENEFICIARY.accountType,
          branchCode:    BENEFICIARY.branchCode,
        },
      },
      successUrl: `${STITCH_RETURN_URL}?sub=${subscriptionId}`,
      failureUrl: `${STITCH_FAILURE_URL}?sub=${subscriptionId}`,
    },
  };

  const data = await stitchQuery(query, variables);
  return data.clientPaymentInitiationRequestCreate.paymentInitiationRequest;
}

// ── Verify incoming webhook signature ────────────────────────────────────────
// Stitch signs webhooks with HMAC-SHA256 over the raw request body.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!STITCH_WEBHOOK_SECRET) return true; // skip verification in dev if not configured

  const sig = (signatureHeader || '').replace(/^sha256=/, '');
  const expected = crypto
    .createHmac('sha256', STITCH_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ── Refund helper (used on cancellation within billing window) ─────────────
async function refundPayment(paymentId) {
  const query = `
    mutation RefundPayment($paymentId: ID!) {
      clientPaymentRefundInitiate(paymentId: $paymentId) {
        refund { id status }
      }
    }
  `;
  return stitchQuery(query, { paymentId });
}

module.exports = {
  createPaymentInitiation,
  verifyWebhookSignature,
  refundPayment,
};
