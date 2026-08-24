'use strict';
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── writehuman-detector integration layer ────────────────────────────────────
// REAL IMPLEMENTATION: drives the vendored Turnitin Moodle plugin's PHP SDK
// (writehuman-detector/, upstream github.com/turnitin/moodle-plagiarism_turnitin,
// GPL-3.0, unmodified) through the PHP bridge in writehuman-detector-bridge/.
//
// Honesty rules baked in:
//  • isConfigured() is true ONLY when Turnitin credentials are present AND a
//    PHP runtime is available AND the bridge exists. Otherwise the API reports
//    503 — the frontend must use the /api/config flag, never claim the feature.
//  • We never fabricate similarity scores. A result is the Turnitin API's real
//    response, "pending" while the report generates, or an error — nothing else.
//  • The bridge submits with SubmitPapersTo=0, so user text is checked but NOT
//    deposited into Turnitin's student-paper repository.

const BRIDGE_DIR = path.join(__dirname, 'writehuman-detector-bridge');
const BRIDGE_PHP = path.join(BRIDGE_DIR, 'check.php');
const BRIDGE_INI = path.join(BRIDGE_DIR, 'php.ini');
const MIN_CHARS  = 200; // Turnitin rejects anything shorter as meaningless

// ── Locate a PHP runtime ─────────────────────────────────────────────────────
// Priority: explicit env override → Scoop PHP 7.4 (SDK-compatible; PHP 8.x
// SoapClient signatures break the vendored SDK) → any PHP on PATH.
function findPhp() {
  if (process.env.WRITEHUMAN_PHP_BIN) return process.env.WRITEHUMAN_PHP_BIN;
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'php74', 'current', 'php.exe'),
    'C:\\Users\\tmodumo\\scoop\\apps\\php74\\current\\php.exe',
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return 'php'; // assume on PATH (Linux hosts, Render, CI)
}

function hasCredentials() {
  return Boolean(
    process.env.WD_TII_ACCOUNT_ID && process.env.WD_TII_API_URL &&
    process.env.WD_TII_SECRET_KEY && process.env.WD_TII_INTEGRATION_ID,
  );
}

function isConfigured() {
  return hasCredentials() && fs.existsSync(BRIDGE_PHP);
}

// ── Run the PHP bridge once ──────────────────────────────────────────────────
// Returns the bridge's parsed JSON. Throws with the bridge's own error message
// on status:"error" or non-zero exit — errors are passed through verbatim.
function runBridge(payload, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const php = findPhp();
    const args = fs.existsSync(BRIDGE_INI) ? ['-c', BRIDGE_INI, BRIDGE_PHP] : [BRIDGE_PHP];
    const child = spawn(php, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Detection timed out.'));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run PHP bridge (${e.message}). Is PHP installed?`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout.trim()); } catch {}
      if (json && json.status === 'error') {
        return reject(Object.assign(new Error(json.message), { status: 502 }));
      }
      if (code !== 0 || !json) {
        const detail = (json && json.message) || stderr.trim().slice(0, 300) || `bridge exited ${code}`;
        return reject(Object.assign(new Error(`Detection bridge failed: ${detail}`), { status: 502 }));
      }
      resolve(json);
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ── submit(text) → { status:'pending', submissionId, classId, assignmentId } ─
async function submit(text) {
  if (!isConfigured()) {
    const err = new Error('Plagiarism detection is not configured. Turnitin account credentials are required.');
    err.code = 'DETECTOR_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }
  const clean = String(text || '').trim();
  if (clean.length < MIN_CHARS) {
    const err = new Error(`Please provide at least ${MIN_CHARS} characters to check.`);
    err.status = 400;
    throw err;
  }
  return runBridge({ mode: 'submit', text: clean });
}

// ── report(submissionId) → { status:'pending' } | { status:'ready', ...% } ──
// Turnitin generates reports asynchronously; callers poll until ready.
async function report(submissionId) {
  if (!isConfigured()) {
    const err = new Error('Plagiarism detection is not configured.');
    err.code = 'DETECTOR_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }
  if (!submissionId) {
    const err = new Error('A submissionId is required.');
    err.status = 400;
    throw err;
  }
  return runBridge({ mode: 'report', submissionId: String(submissionId) }, 60_000);
}

module.exports = { submit, report, isConfigured, hasCredentials, MIN_CHARS };
