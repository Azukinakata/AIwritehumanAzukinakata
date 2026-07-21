-- =============================================================================
-- AIwritehuman — Supabase Schema
-- Target: Supabase Postgres 15+
-- Safe to re-run: uses IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Utility function: keep updated_at current on every UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


-- =============================================================================
-- TABLE: plans
-- Reference / lookup data. Publicly readable; writes via service role only.
-- =============================================================================
CREATE TABLE IF NOT EXISTS plans (
    id                    TEXT        PRIMARY KEY,
    name                  TEXT        NOT NULL,
    price_cents           INT         NOT NULL DEFAULT 0
                              CHECK (price_cents >= 0),
    words_per_generation  INT         NOT NULL
                              CHECK (words_per_generation > 0),
    requests_per_month    INT                  -- NULL = unlimited
                              CHECK (requests_per_month IS NULL OR requests_per_month > 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_plans_updated_at ON plans;
CREATE TRIGGER trg_plans_updated_at
    BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS: everyone (incl. anon) may SELECT; no client INSERT/UPDATE/DELETE
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plans_select_all" ON plans;
CREATE POLICY "plans_select_all" ON plans
    FOR SELECT
    USING (true);


-- =============================================================================
-- TABLE: user_profiles
-- One row per auth.users record, created automatically by handle_new_user().
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_profiles (
    id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT,
    full_name   TEXT,
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER trg_user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS: users can read and update only their own row
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_profiles_select_own" ON user_profiles;
CREATE POLICY "user_profiles_select_own" ON user_profiles
    FOR SELECT
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "user_profiles_update_own" ON user_profiles;
CREATE POLICY "user_profiles_update_own" ON user_profiles
    FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);


-- =============================================================================
-- TABLE: subscriptions
-- One active subscription per user; upgraded/downgraded by the server only.
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    plan_id                 TEXT        NOT NULL REFERENCES plans(id),
    status                  TEXT        NOT NULL
                                CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled', 'expired')),
    paddle_subscription_id  TEXT        UNIQUE,
    paddle_customer_id      TEXT,
    current_period_start    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end      TIMESTAMPTZ NOT NULL,
    cancel_at_period_end    BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
    ON subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
    ON subscriptions (status);

-- Partial index: webhook lookups by Paddle subscription ID
CREATE INDEX IF NOT EXISTS idx_subscriptions_paddle_subscription_id
    ON subscriptions (paddle_subscription_id)
    WHERE paddle_subscription_id IS NOT NULL;

-- Composite: most common server query — "find the active sub for user X"
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active
    ON subscriptions (user_id, status)
    WHERE status = 'active';

-- RLS: clients may SELECT and INSERT their own rows; UPDATE only via service role
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_select_own" ON subscriptions;
CREATE POLICY "subscriptions_select_own" ON subscriptions
    FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "subscriptions_insert_own" ON subscriptions;
CREATE POLICY "subscriptions_insert_own" ON subscriptions
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);


-- =============================================================================
-- TABLE: usage_periods
-- Tracks cumulative counters for a subscription within a billing window.
-- =============================================================================
CREATE TABLE IF NOT EXISTS usage_periods (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    subscription_id  UUID        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    period_start     TIMESTAMPTZ NOT NULL,
    period_end       TIMESTAMPTZ NOT NULL,
    requests_used    INT         NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
    words_generated  INT         NOT NULL DEFAULT 0 CHECK (words_generated >= 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_usage_periods_subscription_period_start
        UNIQUE (subscription_id, period_start)
);

DROP TRIGGER IF EXISTS trg_usage_periods_updated_at ON usage_periods;
CREATE TRIGGER trg_usage_periods_updated_at
    BEFORE UPDATE ON usage_periods
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_usage_periods_subscription_id
    ON usage_periods (subscription_id);

CREATE INDEX IF NOT EXISTS idx_usage_periods_user_id
    ON usage_periods (user_id);

-- Range lookup: "find the period that contains now()" — used on every request
CREATE INDEX IF NOT EXISTS idx_usage_periods_active_window
    ON usage_periods (subscription_id, period_start, period_end);

-- RLS: clients may only SELECT their own rows; counters are written server-side
ALTER TABLE usage_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "usage_periods_select_own" ON usage_periods;
CREATE POLICY "usage_periods_select_own" ON usage_periods
    FOR SELECT
    USING (auth.uid() = user_id);


-- =============================================================================
-- TABLE: generation_requests
-- Immutable audit log. Raw prompts are NEVER stored — only a SHA-256 hash.
-- =============================================================================
CREATE TABLE IF NOT EXISTS generation_requests (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    subscription_id  UUID        NOT NULL REFERENCES subscriptions(id),
    usage_period_id  UUID        NOT NULL REFERENCES usage_periods(id),
    plan_id          TEXT        NOT NULL REFERENCES plans(id),
    words_requested  INT         NOT NULL CHECK (words_requested > 0),
    words_delivered  INT                  CHECK (words_delivered IS NULL OR words_delivered >= 0),
    prompt_hash      TEXT,                -- SHA-256 of original prompt; raw prompt never stored
    success          BOOLEAN     NOT NULL,
    error_reason     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- No updated_at: this table is append-only
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_generation_requests_user_id
    ON generation_requests (user_id);

CREATE INDEX IF NOT EXISTS idx_generation_requests_usage_period_id
    ON generation_requests (usage_period_id);

CREATE INDEX IF NOT EXISTS idx_generation_requests_subscription_id
    ON generation_requests (subscription_id);

-- Dashboard / history pagination
CREATE INDEX IF NOT EXISTS idx_generation_requests_user_created_at
    ON generation_requests (user_id, created_at DESC);

-- RLS: clients may SELECT their own rows only
ALTER TABLE generation_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "generation_requests_select_own" ON generation_requests;
CREATE POLICY "generation_requests_select_own" ON generation_requests
    FOR SELECT
    USING (auth.uid() = user_id);


-- =============================================================================
-- TABLE: payment_history
-- Paddle transaction webhook events.
-- =============================================================================
CREATE TABLE IF NOT EXISTS payment_history (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    subscription_id        UUID                 REFERENCES subscriptions(id),
    paddle_transaction_id  TEXT,
    amount_cents           INT         NOT NULL CHECK (amount_cents >= 0),
    currency               TEXT        NOT NULL DEFAULT 'USD',
    status                 TEXT        NOT NULL
                               CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
    description            TEXT,
    paid_at                TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- No updated_at: payment records are effectively immutable; status changes
    -- are appended as new rows by the webhook handler.
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payment_history_user_id
    ON payment_history (user_id);

CREATE INDEX IF NOT EXISTS idx_payment_history_subscription_id
    ON payment_history (subscription_id);

-- Webhook deduplication / idempotency lookup
CREATE INDEX IF NOT EXISTS idx_payment_history_paddle_transaction_id
    ON payment_history (paddle_transaction_id)
    WHERE paddle_transaction_id IS NOT NULL;

-- Billing history pagination
CREATE INDEX IF NOT EXISTS idx_payment_history_user_created_at
    ON payment_history (user_id, created_at DESC);

-- RLS: clients may SELECT their own rows only
ALTER TABLE payment_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_history_select_own" ON payment_history;
CREATE POLICY "payment_history_select_own" ON payment_history
    FOR SELECT
    USING (auth.uid() = user_id);


-- =============================================================================
-- GRANTS
-- RLS is the true security gate; table-level GRANTs allow roles to attempt
-- queries at all (required in Supabase projects created after 2023).
-- =============================================================================

-- anon: pricing page works without login
GRANT SELECT ON TABLE plans TO anon;

-- authenticated: row-filtered by RLS policies above
GRANT SELECT        ON TABLE plans               TO authenticated;
GRANT SELECT, UPDATE ON TABLE user_profiles      TO authenticated;
GRANT SELECT, INSERT ON TABLE subscriptions      TO authenticated;
GRANT SELECT        ON TABLE usage_periods       TO authenticated;
GRANT SELECT        ON TABLE generation_requests TO authenticated;
GRANT SELECT        ON TABLE payment_history     TO authenticated;

-- service_role: full access for backend / webhook handlers
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;


-- =============================================================================
-- FUNCTION: handle_new_user()
-- Trigger: fires AFTER INSERT on auth.users.
-- Creates a public profile and provisions a permanent free subscription.
-- =============================================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Mirror the auth record into the public profile table
    INSERT INTO public.user_profiles (id, email, full_name, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data ->> 'full_name',
        NEW.raw_user_meta_data ->> 'avatar_url'
    )
    ON CONFLICT (id) DO NOTHING;

    -- 2. Provision a free subscription that effectively never expires
    INSERT INTO public.subscriptions (
        user_id,
        plan_id,
        status,
        current_period_start,
        current_period_end,
        cancel_at_period_end
    )
    VALUES (
        NEW.id,
        'free',
        'active',
        NOW(),
        NOW() + INTERVAL '100 years',
        FALSE
    );

    RETURN NEW;
END;
$$;

-- Attach trigger (idempotent: drop first)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- =============================================================================
-- FUNCTION: increment_usage(p_usage_period_id, p_requests, p_words)
-- Atomically bumps request and word counters on a usage_periods row.
-- SECURITY DEFINER so the server can bypass RLS without the service-role key
-- being embedded in client code. Restricted to service_role callers only.
-- =============================================================================
CREATE OR REPLACE FUNCTION increment_usage(
    p_usage_period_id  UUID,
    p_requests         INT DEFAULT 1,
    p_words            INT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.usage_periods
    SET
        requests_used   = requests_used   + p_requests,
        words_generated = words_generated + p_words,
        updated_at      = NOW()
    WHERE id = p_usage_period_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'increment_usage: usage_period % not found', p_usage_period_id
            USING ERRCODE = 'no_data_found';
    END IF;
END;
$$;

-- Lock down to service_role; clients must call via the trusted server API
REVOKE EXECUTE ON FUNCTION increment_usage(UUID, INT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION increment_usage(UUID, INT, INT) TO service_role;
