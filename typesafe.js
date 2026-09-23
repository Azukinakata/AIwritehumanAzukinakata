'use strict';

// ── TypeSafe (System One / Jev) client ──────────────────────────────────────
// Typed judgments only — Choice / Noul / Score. NOT a text generator; this
// module never produces or edits humanised text, only scores/routes around it.
// Docs: https://docs.typesafe.ai/llms.txt
//
// Fails soft everywhere: any error, timeout, or missing key returns `null`
// instead of throwing. A judgment-layer outage must never block or delay
// /api/humanize — Anthropic's output is the paid product; TypeSafe is a
// diagnostic/routing layer around it.

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const TYPESAFE_TIMEOUT_MS = 15000;

let warnedMissingKey = false;

/**
 * Ask one or more typed questions about `state`.
 * @param {object|string} state - the content being judged.
 * @param {object} questions - map of questionId -> { type: 'noul'|'choice'|'score', instructions, criteria? }.
 * @returns {Promise<object|null>} the `answers` map from TypeSafe, or null on any failure.
 */
async function askTypeSafe(state, questions) {
  if (!TYPESAFE_API_KEY) {
    if (!warnedMissingKey) {
      console.warn('[typesafe] TYPESAFE_API_KEY not set — skipping judgment calls (humanisation is unaffected).');
      warnedMissingKey = true;
    }
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TYPESAFE_TIMEOUT_MS);

  try {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TYPESAFE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: 'jev-latest', questions }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[typesafe] API returned ${res.status} — skipping judgment for this call.`);
      return null;
    }

    const body = await res.json();
    return body.answers || null;
  } catch (err) {
    console.warn('[typesafe] request failed, continuing without judgment:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { askTypeSafe };
