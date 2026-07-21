'use strict';
const crypto = require('crypto');
const { supabase } = require('./supabaseClient');

// Mirrors the plans table — authoritative source of enforcement limits.
const PLAN_LIMITS = {
  free:  { words_per_generation: 200,  requests_per_month: 1    },
  basic: { words_per_generation: 1000, requests_per_month: 80   },
  pro:   { words_per_generation: 1500, requests_per_month: 200  },
  ultra: { words_per_generation: 3000, requests_per_month: null }, // null = unlimited
};

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function hashPrompt(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ── Authenticate user from Bearer token ───────────────────────────────────────
async function authenticateUser(req) {
  const header = (req.headers.authorization || '').trim();
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    const err = new Error('Authentication required. Please sign in.');
    err.status = 401; err.code = 'AUTH_REQUIRED';
    throw err;
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    const err = new Error('Invalid or expired session. Please sign in again.');
    err.status = 401; err.code = 'AUTH_INVALID';
    throw err;
  }
  return user;
}

// ── Get or create the usage period for a subscription billing cycle ───────────
async function getOrCreateUsagePeriod(subscriptionId, userId, periodStart, periodEnd) {
  const { data: existing } = await supabase
    .from('usage_periods')
    .select('*')
    .eq('subscription_id', subscriptionId)
    .eq('period_start', periodStart)
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await supabase
    .from('usage_periods')
    .insert({
      user_id:         userId,
      subscription_id: subscriptionId,
      period_start:    periodStart,
      period_end:      periodEnd,
      requests_used:   0,
      words_generated: 0,
    })
    .select()
    .single();

  if (error) throw new Error('Could not initialise usage period: ' + error.message);
  return data;
}

// ── Express middleware: enforce plan before every generation ─────────────────
async function enforcePlan(req, res, next) {
  try {
    const user = await authenticateUser(req);

    // Fetch active subscription + joined plan row
    const { data: subscription, error: subErr } = await supabase
      .from('subscriptions')
      .select(`*, plans(*)`)
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subErr || !subscription) {
      return res.status(403).json({
        error: 'No active subscription found.',
        code:  'NO_SUBSCRIPTION',
      });
    }

    const plan   = subscription.plans;
    const limits = PLAN_LIMITS[plan.id] || PLAN_LIMITS.free;

    // Initialise / fetch the current billing-period usage row
    const usagePeriod = await getOrCreateUsagePeriod(
      subscription.id,
      user.id,
      subscription.current_period_start,
      subscription.current_period_end,
    );

    // ── Hard quota check ──────────────────────────────────────────────────────
    if (limits.requests_per_month !== null) {
      if (usagePeriod.requests_used >= limits.requests_per_month) {
        return res.status(429).json({
          error: `You have used all ${limits.requests_per_month} request${limits.requests_per_month === 1 ? '' : 's'} on your ${plan.name} plan this month.`,
          code:  'QUOTA_EXCEEDED',
          plan:  plan.id,
          used:  usagePeriod.requests_used,
          limit: limits.requests_per_month,
        });
      }
    }

    // ── Word-cap enforcement ──────────────────────────────────────────────────
    const rawText    = (req.body?.text || '').trim();
    const inputWords = countWords(rawText);
    const wordCap    = limits.words_per_generation;

    let processedText = rawText;
    let truncated     = false;

    if (inputWords > wordCap) {
      processedText = rawText.split(/\s+/).slice(0, wordCap).join(' ');
      truncated     = true;
    }

    // Attach to request for the route handler
    req.user           = user;
    req.subscription   = subscription;
    req.plan           = plan;
    req.usagePeriod    = usagePeriod;
    req.body.text      = processedText;
    req.requestedWords = Math.min(inputWords, wordCap);
    req.truncated      = truncated;
    req.wordCap        = wordCap;
    req.promptHash     = hashPrompt(rawText);

    next();
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message, code: err.code });
  }
}

// ── Record usage after a generation completes ─────────────────────────────────
async function recordUsage({
  userId, subscriptionId, usagePeriodId, planId,
  wordsRequested, wordsDelivered, promptHash,
  success, errorReason,
}) {
  const tasks = [];

  // Atomically increment usage counters via SECURITY DEFINER function
  if (success) {
    tasks.push(
      supabase.rpc('increment_usage', {
        p_usage_period_id: usagePeriodId,
        p_requests:        1,
        p_words:           wordsDelivered,
      })
    );
  }

  // Append audit record
  tasks.push(
    supabase.from('generation_requests').insert({
      user_id:         userId,
      subscription_id: subscriptionId,
      usage_period_id: usagePeriodId,
      plan_id:         planId,
      words_requested: wordsRequested,
      words_delivered: wordsDelivered,
      prompt_hash:     promptHash,
      success,
      error_reason:    errorReason || null,
    })
  );

  await Promise.allSettled(tasks);
}

module.exports = {
  enforcePlan,
  recordUsage,
  countWords,
  hashPrompt,
  authenticateUser,
  PLAN_LIMITS,
};
