<?php
/**
 * AIwritehuman — writehuman-detector bridge (CLI)
 *
 * New integration code written for the AIwritehuman project. It drives the
 * Turnitin PHP SDK vendored unmodified in ../writehuman-detector (upstream:
 * github.com/turnitin/moodle-plagiarism_turnitin, GPL-3.0, (c) iParadigms LLC).
 * Because this file links against GPL-3.0 code, it is distributed under
 * GPL-3.0 as well. See ../writehuman-detector/LICENSE and PROVENANCE.md.
 *
 * Protocol: reads one JSON object from stdin, writes one JSON object to stdout.
 *
 *   stdin  { "mode": "submit", "text": "..." }
 *   stdout { "status": "pending", "submissionId": ..., "classId": ..., "assignmentId": ... }
 *
 *   stdin  { "mode": "report", "submissionId": ... }
 *   stdout { "status": "ready", "similarityPct": N, "internetPct": N,
 *            "publicationsPct": N, "submittedDocumentsPct": N }
 *          or { "status": "pending" }   (report still generating)
 *
 * On any failure: { "status": "error", "message": "..." } and exit code 1.
 * Errors are reported VERBATIM from the SDK — this bridge never fabricates a
 * similarity score, and never claims success when the Turnitin call failed.
 *
 * Credentials come from environment variables (never hard-coded):
 *   WD_TII_ACCOUNT_ID      Turnitin account ID
 *   WD_TII_API_URL         e.g. https://api.turnitin.com or sandbox equivalent
 *   WD_TII_SECRET_KEY      integration secret key
 *   WD_TII_INTEGRATION_ID  integration identifier
 */

namespace AIwritehuman;

use Integrations\PhpSdk\TurnitinAPI;
use Integrations\PhpSdk\TiiClass;
use Integrations\PhpSdk\TiiAssignment;
use Integrations\PhpSdk\TiiSubmission;

error_reporting(E_ALL & ~E_DEPRECATED);

require __DIR__ . '/../writehuman-detector/vendor/autoload.php';

function fail(string $message): void {
    fwrite(STDOUT, json_encode(['status' => 'error', 'message' => $message]));
    exit(1);
}

function out(array $payload): void {
    fwrite(STDOUT, json_encode($payload));
    exit(0);
}

$raw = stream_get_contents(STDIN);
$input = json_decode($raw ?: '', true);
if (!is_array($input) || empty($input['mode'])) {
    fail('Bridge input must be JSON with a "mode" field (submit|report).');
}

$accountId     = getenv('WD_TII_ACCOUNT_ID')     ?: '';
$apiUrl        = getenv('WD_TII_API_URL')        ?: '';
$secretKey     = getenv('WD_TII_SECRET_KEY')     ?: '';
$integrationId = getenv('WD_TII_INTEGRATION_ID') ?: '';

if (!$accountId || !$apiUrl || !$secretKey || !$integrationId) {
    fail('Turnitin credentials not configured (WD_TII_ACCOUNT_ID, WD_TII_API_URL, '
       . 'WD_TII_SECRET_KEY, WD_TII_INTEGRATION_ID). A valid Turnitin account and '
       . 'integration agreement with Turnitin is required for similarity checking.');
}

$stateFile = __DIR__ . '/state.json';
$state = is_file($stateFile) ? (json_decode((string)file_get_contents($stateFile), true) ?: []) : [];

try {
    $api = new TurnitinAPI($accountId, $apiUrl, $secretKey, $integrationId);

    // ── SUBMIT: class + assignment (cached) then submit the text ─────────────
    if ($input['mode'] === 'submit') {
        $text = trim((string)($input['text'] ?? ''));
        if (mb_strlen($text) < 200) {
            fail('Submission text must be at least 200 characters.');
        }

        // Reuse one class + assignment for all checks unless the cache is stale
        // or Turnitin no longer accepts them, in which case we recreate.
        $classId      = $state['classId']      ?? null;
        $assignmentId = $state['assignmentId'] ?? null;

        if (!$classId) {
            $class = new TiiClass();
            $class->setTitle('AIwritehuman Similarity Checks');
            $classResp = $api->createClass($class);
            if ($classResp->getStatus() !== 'success') {
                fail('Could not create Turnitin class: ' . $classResp->getStatus());
            }
            $classId = $classResp->getClass()->getClassId();
        }

        if (!$assignmentId) {
            $assignment = new TiiAssignment();
            $assignment->setClassId($classId);
            $assignment->setTitle('AIwritehuman Checks');
            $assignment->setStartDate(gmdate('Y-m-d\TH:i:s\Z', time() - 86400));
            $assignment->setDueDate(gmdate('Y-m-d\TH:i:s\Z', time() + 10 * 365 * 86400));
            $assignment->setInternetCheck(1);
            $assignment->setPublicationsCheck(1);
            $assignment->setSubmittedDocumentsCheck(1);
            // ETHICAL DEFAULT: do NOT deposit user text into Turnitin's student
            // paper repository. Checks run against the corpora without the
            // user's document being stored for other users' comparisons.
            $assignment->setSubmitPapersTo(0);
            $assignment->setLateSubmissionsAllowed(1);
            $assignResp = $api->createAssignment($assignment);
            if ($assignResp->getStatus() !== 'success') {
                fail('Could not create Turnitin assignment: ' . $assignResp->getStatus());
            }
            $assignmentId = $assignResp->getAssignment()->getAssignmentId();
        }

        $submission = new TiiSubmission();
        $submission->setAssignmentId($assignmentId);
        $submission->setTitle('AIwritehuman check ' . gmdate('Ymd-His'));
        $submission->setSubmissionDataText($text);
        $subResp = $api->createSubmission($submission);
        if ($subResp->getStatus() !== 'success') {
            fail('Turnitin rejected the submission: ' . $subResp->getStatus());
        }
        $submissionId = $subResp->getSubmission()->getSubmissionId();

        $state['classId'] = $classId;
        $state['assignmentId'] = $assignmentId;
        file_put_contents($stateFile, json_encode($state));

        out([
            'status'       => 'pending',
            'submissionId' => $submissionId,
            'classId'      => $classId,
            'assignmentId' => $assignmentId,
        ]);
    }

    // ── REPORT: poll readSubmission until similarity figures are present ─────
    if ($input['mode'] === 'report') {
        $submissionId = (string)($input['submissionId'] ?? '');
        if ($submissionId === '') {
            fail('report mode requires a submissionId.');
        }

        $submission = new TiiSubmission();
        $submission->setSubmissionId($submissionId);
        $resp = $api->readSubmission($submission);

        if ($resp->getStatus() !== 'success') {
            fail('Could not read submission from Turnitin: ' . $resp->getStatus());
        }

        $tii = $resp->getSubmission();
        $overall = $tii->getOverallSimilarity();

        if ($overall === null || $overall === '' || $overall === false) {
            // Report still generating — honest "pending", not a guessed score.
            out(['status' => 'pending', 'submissionId' => $submissionId]);
        }

        out([
            'status'                => 'ready',
            'submissionId'          => $submissionId,
            'similarityPct'         => (int)$overall,
            'internetPct'           => (int)$tii->getInternetSimilarity(),
            'publicationsPct'       => (int)$tii->getPublicationsSimilarity(),
            'submittedDocumentsPct' => (int)$tii->getSubmittedDocumentsSimilarity(),
        ]);
    }

    fail('Unknown mode: ' . $input['mode']);
} catch (\Integrations\PhpSdk\TurnitinApiException $e) {
    // Report the SDK's own error verbatim — e.g. auth failure, quota, outage.
    fail('Turnitin API error: ' . $e->getMessage());
} catch (\Integrations\PhpSdk\TurnitinSDKException $e) {
    fail('Turnitin SDK error: ' . $e->getMessage());
} catch (\Throwable $e) {
    fail('Bridge error: ' . get_class($e) . ': ' . $e->getMessage());
}
