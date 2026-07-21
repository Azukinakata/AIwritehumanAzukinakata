-- =============================================================================
-- AIwritehuman — Seed Data
-- Run after schema.sql.
-- Idempotent: ON CONFLICT DO UPDATE ensures re-runs are safe.
-- =============================================================================

INSERT INTO plans (id, name, price_cents, words_per_generation, requests_per_month)
VALUES
    ('free',  'Free',  0,    200,  1),
    ('basic', 'Basic', 500,  1000, 80),
    ('pro',   'Pro',   1200, 1500, 200),
    ('ultra', 'Ultra', 3500, 3000, NULL)  -- NULL = unlimited requests
ON CONFLICT (id) DO UPDATE
    SET name                 = EXCLUDED.name,
        price_cents          = EXCLUDED.price_cents,
        words_per_generation = EXCLUDED.words_per_generation,
        requests_per_month   = EXCLUDED.requests_per_month,
        updated_at           = NOW();
