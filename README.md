# AIwritehuman

AIwritehuman is an AI text humaniser built for the B2B and professional market. It refines AI-generated content into natural, human-sounding writing — removing the telltale patterns (formulaic phrasing, robotic cadence, generic vocabulary) that flag text as machine-written.

Live: **https://aiwritehuman.com**

## How it works

The product is a two-pass humanisation engine driven by Claude, governed by a detailed system prompt built on the **August 2026 revision of Wikipedia's "Signs of AI writing" field guide** (WP:AISIGNS), merged with the Stop-Slop pattern catalog and academic-humanizer rules.

- **54 pattern classes** are audited and removed: significance inflation, canned notability claims, superficial `-ing` analyses, AI vocabulary (with per-model-era word lists), copula avoidance, negative parallelisms, rule-of-three, em-dash overuse, model-internal citation artifacts, placeholder residue, and more.
- **Draft → measured audit → final** loop, including a detector-perspective pass that re-reads the draft the way an AI detector would.
- **Fidelity guardrail**: output stays within ±10% of the source length and every claim must trace to the input. The engine restructures — it never invents facts.
- **Voice calibration**: optional writing samples let the output match a specific person's style.
- Tones: Standard, Professional, Academic, Blog, Casual, Creative, Scientific, Technical. English and Chinese output.

Benchmarks: outputs verified at **0.0% AI probability** on the Hello-SimpleAI/chatgpt-detector-roberta classifier (raw source measured at 5.9%, with 26 tell-phrases reduced to 0).

## Architecture

| Component | Purpose |
|---|---|
| `index.html` | Single-file frontend (markup, CSS, JS) |
| `server.js` | Express routes, SSE streaming proxy, auth, plan gating |
| `humanizer.js` | System-prompt builder (EN + ZH) |
| `planEnforcement.js` | Plan limits, usage tracking, authentication |
| `paddleService.js` | Paddle subscriptions + webhooks |
| `stitchService.js` | Stitch payments (ZAR) |
| `emailService.js` | Password-reset email via Resend |
| `supabaseClient.js` | Supabase auth + database |
| `writehumanDetectorService.js` | Similarity-detection integration layer |
| `writehuman-detector/` | Vendored GPL plagiarism-detection plugin (see below) |
| `writehuman-detector-bridge/` | PHP bridge driving the vendored detection SDK |
| `scripts/benchmark-winston.js` | Before/after detector benchmark (Winston AI) |

## writehuman-detector (similarity checking)

The repository vendors an **unmodified copy** of the Turnitin plagiarism plugin for Moodle (upstream: `github.com/turnitin/moodle-plagiarism_turnitin`, **GPL-3.0**, © iParadigms LLC) as `writehuman-detector/`. Attribution, license text, and copyright headers are preserved — see `writehuman-detector/PROVENANCE.md`.

AIwritehuman drives the Turnitin PHP SDK bundled in that repo through a PHP bridge (`writehuman-detector-bridge/check.php`) and exposes it as:

- `POST /api/detect-plagiarism` — submit text (auth required)
- `GET /api/detect-plagiarism/report/:submissionId` — poll the report

Design principles: honest degradation (503 when credentials are absent), no fabricated scores, and submissions use `SubmitPapersTo=0` so checked text is never deposited into a shared paper repository. The frontend advertises the feature only when `plagiarismDetectionEnabled` is true in `/api/config`.

> Note: the vendored plugin is the reference Moodle integration. The bridge requires **PHP 7.4** (the SDK is incompatible with PHP 8.x SoapClient signatures) and a valid Turnitin account/integration agreement. Without credentials the endpoints report "not configured" — by design.

## Environment

```
ANTHROPIC_API_KEY        Claude API key (humanisation engine)
SUPABASE_URL             Supabase project URL
SUPABASE_ANON_KEY        Supabase anon key (public)
SUPABASE_SERVICE_ROLE_KEY  Supabase service key (server-side)
PADDLE_*                 Paddle payments (prices, tokens, webhook secret)
STITCH_*                 Stitch payments (optional)
RESEND_API_KEY           Email delivery
WINSTON_API_KEY          Winston AI detection (optional)
SITE_URL                 Public site URL

# Similarity detection (writehuman-detector) — all required for the feature to activate
WD_TII_ACCOUNT_ID
WD_TII_API_URL
WD_TII_SECRET_KEY
WD_TII_INTEGRATION_ID
WRITEHUMAN_PHP_BIN       Optional: explicit PHP 7.4 binary path
```

## Development

```bash
npm install
npm run dev        # nodemon, loads .env automatically
```

## Production

Node ≥ 22, deployed from the `main` branch. The server streams Claude responses over SSE through `/api/humanize` with plan-based word caps and monthly request limits.

## Licensing

- AIwritehuman application code: proprietary, © writehuman (Pty) Ltd.
- `writehuman-detector/` and `writehuman-detector-bridge/`: GPL-3.0 (derived from and linking GPL-licensed upstream code). See `writehuman-detector/LICENSE` and `PROVENANCE.md`.
- "Turnitin" is a trademark of iParadigms LLC; this project is not affiliated with or endorsed by Turnitin.
