'use strict';
const https   = require('https');
const path    = require('path');
const express = require('express');

const { supabase }          = require('./supabaseClient');
const { buildSystemPrompt } = require('./humanizer');
const {
  enforcePlan, recordUsage, countWords, authenticateUser, PLAN_LIMITS,
} = require('./planEnforcement');
const {
  verifyWebhookSignature, cancelSubscription,
} = require('./paddleService');

const app  = express();
const PORT = process.env.PORT || 5500;

// Price-ID → plan mapping, read from env so sandbox/live can differ without code changes
const PADDLE_PRICE_IDS = {
  basic: process.env.PADDLE_PRICE_BASIC || '',
  pro:   process.env.PADDLE_PRICE_PRO   || '',
  ultra: process.env.PADDLE_PRICE_ULTRA || '',
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('\n  ✗ ANTHROPIC_API_KEY is not set in .env\n');
  process.exit(1);
}

// ── Raw body capture for Paddle webhook HMAC ──────────────────────────────────
function captureRawBody(req, _res, buf) {
  if (req.path === '/api/webhooks/paddle') req.rawBody = buf.toString('utf8');
}

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(express.json({ verify: captureRawBody, limit: '4mb' }));

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Block direct requests to server-side source files
app.use((req, res, next) => {
  const blocked = ['.env', 'server.js', 'supabaseClient.js', 'paddleService.js',
                   'planEnforcement.js', 'humanizer.js', 'package.json'];
  const name = path.basename(req.path);
  if (blocked.includes(name) || req.path.startsWith('/supabase/') || req.path.startsWith('/node_modules/')) {
    return res.status(404).end();
  }
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/config  — public values the browser needs (never secrets)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl:      process.env.SUPABASE_URL      || '',
    supabaseAnonKey:  process.env.SUPABASE_ANON_KEY  || '',
    paddleClientToken: process.env.PADDLE_CLIENT_TOKEN || '',
    paddlePriceIds:   PADDLE_PRICE_IDS,
    aiDetectionEnabled: !!process.env.GPTZERO_API_KEY,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/me  — current user profile + active subscription + usage
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/me', async (req, res) => {
  try {
    const user = await authenticateUser(req);

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, email, full_name, created_at')
      .eq('id', user.id)
      .single();

    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*, plans(*)')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let usagePeriod = null;
    if (subscription) {
      const { data: up } = await supabase
        .from('usage_periods')
        .select('requests_used, words_generated, period_start, period_end')
        .eq('subscription_id', subscription.id)
        .eq('period_start', subscription.current_period_start)
        .maybeSingle();
      usagePeriod = up;
    }

    const plan   = subscription?.plans || null;
    const limits = plan ? (PLAN_LIMITS[plan.id] || PLAN_LIMITS.free) : PLAN_LIMITS.free;

    res.json({
      user: profile || { id: user.id, email: user.email },
      subscription: subscription ? {
        id:                    subscription.id,
        plan_id:               subscription.plan_id,
        plan_name:             plan?.name,
        status:                subscription.status,
        paddle_subscription_id: subscription.paddle_subscription_id,
        paddle_customer_id:    subscription.paddle_customer_id,
        current_period_end:    subscription.current_period_end,
        cancel_at_period_end:  subscription.cancel_at_period_end,
      } : null,
      plan: plan ? {
        id:                   plan.id,
        name:                 plan.name,
        price_cents:          plan.price_cents,
        words_per_generation: limits.words_per_generation,
        requests_per_month:   limits.requests_per_month,
      } : null,
      usage: usagePeriod ? {
        requests_used:   usagePeriod.requests_used,
        words_generated: usagePeriod.words_generated,
        requests_limit:  limits.requests_per_month,
        period_end:      usagePeriod.period_end,
      } : {
        requests_used: 0, words_generated: 0,
        requests_limit: limits.requests_per_month, period_end: null,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/plans  — list all available plans (public, used by pricing modal)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/plans', async (_req, res) => {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('price_cents');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/detect  — AI-content detection via GPTZero (login required)
// Returns overall AI percentage + per-sentence generated_prob for highlighting.
// ═══════════════════════════════════════════════════════════════════════════════
const GPTZERO_API_KEY = process.env.GPTZERO_API_KEY;

app.post('/api/detect', async (req, res) => {
  try {
    await authenticateUser(req); // gate behind login to protect the paid API
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message, code: err.code });
  }

  if (!GPTZERO_API_KEY) {
    return res.status(503).json({ error: 'AI detection is not configured yet.' });
  }

  const text = (req.body?.text || '').trim();
  if (text.length < 20) {
    return res.status(400).json({ error: 'Please provide at least a sentence or two to analyse.' });
  }

  try {
    const gz = await fetch('https://api.gptzero.me/v2/predict/text', {
      method: 'POST',
      headers: {
        'x-api-key':    GPTZERO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({ document: text }),
    });

    const json = await gz.json();
    if (!gz.ok) {
      console.error('[gptzero]', gz.status, JSON.stringify(json).slice(0, 200));
      return res.status(502).json({ error: 'Detection service error. Please try again.' });
    }

    const doc = json.documents?.[0] || {};
    const aiProb =
      doc.class_probabilities?.ai ??
      doc.completely_generated_prob ??
      doc.average_generated_prob ?? 0;

    const sentences = (doc.sentences || []).map(s => ({
      sentence: s.sentence,
      prob:     s.generated_prob ?? 0,
    }));

    res.json({
      aiPercentage:   Math.round(aiProb * 100),
      predictedClass: doc.predicted_class || null,
      sentences,
    });
  } catch (err) {
    console.error('[detect] error:', err.message);
    res.status(502).json({ error: 'Detection failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/subscribe  — cancel active Paddle subscription at period end
// ═══════════════════════════════════════════════════════════════════════════════
app.delete('/api/subscribe', async (req, res) => {
  try {
    const user = await authenticateUser(req);

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('id, plan_id, paddle_subscription_id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .neq('plan_id', 'free')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sub) return res.status(404).json({ error: 'No cancellable subscription found.' });

    if (!sub.paddle_subscription_id) {
      return res.status(409).json({ error: 'Subscription has no Paddle ID — cannot cancel via API.' });
    }

    // Cancel in Paddle (effective at next billing period)
    await cancelSubscription(sub.paddle_subscription_id);

    // Paddle will send a subscription.canceled webhook that updates the DB;
    // mark locally so the UI reflects it immediately
    await supabase
      .from('subscriptions')
      .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
      .eq('id', sub.id);

    res.json({ ok: true, message: 'Subscription will cancel at the end of the current period.' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/webhooks/paddle  — Paddle event handler
// Handles: subscription.activated, subscription.updated,
//          subscription.canceled, transaction.completed, transaction.payment_failed
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/webhooks/paddle', async (req, res) => {
  const sig = req.headers['paddle-signature'] || '';

  if (!verifyWebhookSignature(req.rawBody || JSON.stringify(req.body), sig)) {
    console.warn('[paddle-webhook] Invalid signature — rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { event_type, data } = req.body || {};
  console.log('[paddle-webhook]', event_type, data?.id);

  // Helper: look up Supabase user from Paddle customer_id or custom_data.userId
  async function resolveUserId() {
    const uid = data?.custom_data?.userId;
    if (uid) return uid;
    // Fallback: find by paddle_customer_id
    if (data?.customer_id) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('paddle_customer_id', data.customer_id)
        .limit(1)
        .maybeSingle();
      return sub?.user_id || null;
    }
    return null;
  }

  try {
    // ── subscription.activated → provision the subscription ───────────────────
    if (event_type === 'subscription.activated') {
      const userId = await resolveUserId();
      if (!userId) { console.warn('[paddle-webhook] No userId for', data?.id); return res.json({ received: true }); }

      const planId          = data?.custom_data?.planId || resolvePlanFromPriceId(data?.items?.[0]?.price?.id);
      const paddleSubId     = data?.id;
      const paddleCustomer  = data?.customer_id;
      const periodStart     = data?.current_billing_period?.starts_at || new Date().toISOString();
      const periodEnd       = data?.current_billing_period?.ends_at   || offsetMonth(periodStart);

      // Deactivate any previous paid subscription
      await supabase
        .from('subscriptions')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('status', 'active')
        .neq('plan_id', 'free');

      // Upsert the new active subscription
      await supabase.from('subscriptions').insert({
        user_id:                userId,
        plan_id:                planId,
        status:                 'active',
        paddle_subscription_id: paddleSubId,
        paddle_customer_id:     paddleCustomer,
        current_period_start:   periodStart,
        current_period_end:     periodEnd,
        cancel_at_period_end:   false,
      });
    }

    // ── subscription.updated → plan change or renewal ─────────────────────────
    if (event_type === 'subscription.updated') {
      const paddleSubId = data?.id;
      const periodStart = data?.current_billing_period?.starts_at;
      const periodEnd   = data?.current_billing_period?.ends_at;
      const newPlanId   = data?.custom_data?.planId || resolvePlanFromPriceId(data?.items?.[0]?.price?.id);
      const status      = data?.status === 'canceled' ? 'cancelled' : 'active';

      const update = { updated_at: new Date().toISOString(), status };
      if (periodStart) update.current_period_start = periodStart;
      if (periodEnd)   update.current_period_end   = periodEnd;
      if (newPlanId)   update.plan_id              = newPlanId;
      if (data?.scheduled_change?.action === 'cancel') update.cancel_at_period_end = true;

      await supabase
        .from('subscriptions')
        .update(update)
        .eq('paddle_subscription_id', paddleSubId);
    }

    // ── subscription.canceled → mark cancelled ────────────────────────────────
    if (event_type === 'subscription.canceled') {
      await supabase
        .from('subscriptions')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('paddle_subscription_id', data?.id);
    }

    // ── transaction.completed → record payment ────────────────────────────────
    if (event_type === 'transaction.completed') {
      const userId = await resolveUserId();
      if (!userId) return res.json({ received: true });

      // Idempotency: skip if already recorded
      const { data: existing } = await supabase
        .from('payment_history')
        .select('id')
        .eq('paddle_transaction_id', data?.id)
        .maybeSingle();
      if (existing) return res.json({ received: true });

      const amountCents = Math.round((parseFloat(data?.details?.totals?.total || '0')) * 100);
      const currency    = data?.currency_code || 'USD';

      await supabase.from('payment_history').insert({
        user_id:              userId,
        paddle_transaction_id: data?.id,
        amount_cents:         amountCents,
        currency,
        status:               'succeeded',
        paid_at:              data?.billed_at || new Date().toISOString(),
        description:          `${data?.custom_data?.planId || 'paid'} plan`,
      });
    }

    // ── transaction.payment_failed → mark past_due ────────────────────────────
    if (event_type === 'transaction.payment_failed') {
      const paddleSubId = data?.subscription_id;
      if (paddleSubId) {
        await supabase
          .from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('paddle_subscription_id', paddleSubId);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[paddle-webhook] Error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Derive plan from Paddle price ID env var mapping
function resolvePlanFromPriceId(priceId) {
  if (!priceId) return 'basic';
  for (const [planId, pid] of Object.entries(PADDLE_PRICE_IDS)) {
    if (pid === priceId) return planId;
  }
  return 'basic';
}

function offsetMonth(isoDate) {
  const d = new Date(isoDate);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/humanize  — AI text humanisation (plan-gated)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/humanize', enforcePlan, (req, res) => {
  const {
    text, selectedTone, intensity, british, hedging, variation, voiceSample,
  } = req.body;

  const { user, subscription, plan, usagePeriod, requestedWords, promptHash } = req;

  const systemPrompt = buildSystemPrompt({
    selectedTone: selectedTone || 'academic',
    intensity:    Number(intensity)  || 8,
    british:      Number(british)    || 9,
    hedging:      Number(hedging)    || 7,
    variation:    Number(variation)  || 8,
    voiceSample:  voiceSample || '',
  });

  const payload = JSON.stringify({
    model:      'claude-fable-5',
    max_tokens: 8192,
    stream:     true,
    fallbacks:  [{ model: 'claude-opus-4-8' }],
    system:     systemPrompt,
    messages:   [{ role: 'user', content: text }],
  });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (req.truncated) {
    res.setHeader('X-Truncated', 'true');
    res.setHeader('X-Word-Cap',  String(req.wordCap));
  }

  let fullText    = '';
  let isTextBlock = false;
  let sseBuf      = '';
  let streamOk    = false;

  const proxyReq = https.request(
    {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'server-side-fallback-2026-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(payload),
      },
    },
    (proxyRes) => {
      proxyRes.on('data', (chunk) => {
        res.write(chunk);
        sseBuf += chunk.toString('utf8');

        const lines = sseBuf.split('\n');
        sseBuf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'content_block_start')  isTextBlock = evt.content_block?.type === 'text';
            if (evt.type === 'content_block_stop')   isTextBlock = false;
            if (evt.type === 'content_block_delta' && isTextBlock && evt.delta?.type === 'text_delta')
              fullText += evt.delta.text;
            if (evt.type === 'message_stop')         streamOk = true;
          } catch {}
        }
      });

      proxyRes.on('end', async () => {
        res.end();
        await recordUsage({
          userId:         user.id,
          subscriptionId: subscription.id,
          usagePeriodId:  usagePeriod.id,
          planId:         plan.id,
          wordsRequested: requestedWords,
          wordsDelivered: countWords(fullText),
          promptHash,
          success:        streamOk && fullText.length > 0,
        });
      });
    },
  );

  proxyReq.on('error', async (err) => {
    console.error('Anthropic proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Upstream error: ' + err.message });
    else res.end();
    await recordUsage({
      userId: user.id, subscriptionId: subscription.id, usagePeriodId: usagePeriod.id,
      planId: plan.id, wordsRequested: requestedWords, wordsDelivered: 0,
      promptHash, success: false, errorReason: err.message,
    });
  });

  proxyReq.write(payload);
  proxyReq.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Static files
// ═══════════════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname), { index: 'index.html' }));
app.get('*', (req, res) => {
  if (!req.path.includes('.')) res.sendFile(path.join(__dirname, 'index.html'));
  else res.status(404).end();
});

app.listen(PORT, () => {
  console.log(`\n  AIwritehuman  →  http://localhost:${PORT}\n`);
});
