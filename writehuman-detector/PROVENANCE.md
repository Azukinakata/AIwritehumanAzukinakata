# writehuman-detector — Provenance and Licensing

This directory contains a **vendored, unmodified copy** of the Turnitin
plagiarism plugin for Moodle, redistributed under the terms of its license.

## Upstream

- **Project:** Turnitin Plagiarism plugin for Moodle
- **Source:** https://github.com/turnitin/moodle-plagiarism_turnitin.git
- **License:** GNU General Public License v3.0 or later (see `LICENSE`)
- **Copyright:** © 2012 iParadigms LLC (Turnitin), and contributors.
  See individual file headers for per-file copyright notices.

## What was changed

**Nothing in the upstream source code.** The PHP sources, language files,
templates, assets, tests, and version metadata are exactly as published
upstream, including all copyright headers and the GPL license notice.

The only change is this directory's name: the upstream component
`plagiarism_turnitin` is vendored here as `writehuman-detector` for
organisation within the AIwritehuman project. The Moodle component
identifier (`plagiarism_turnitin`), class names, language-string keys, and
`version.php` metadata are intentionally left intact, because Moodle resolves
plugins by those identifiers and renaming them would break the plugin.

## New code written for AIwritehuman (also GPL-3.0)

- `../writehuman-detector-bridge/check.php` — a CLI bridge that drives the
  Turnitin PHP SDK bundled in this repo (`vendor/Integrations/phpsdk-package`)
  to submit text and fetch similarity reports.
- `../writehuman-detector-bridge/php.ini` — PHP runtime configuration for the
  bridge (enables the openssl/curl/soap extensions the SDK requires).
- `../writehumanDetectorService.js` — the Node-side integration layer that
  invokes the bridge.

Because this new code links against GPL-3.0 code, it is distributed under
GPL-3.0 as well.

## What this is (and is not)

- This is a **Moodle plugin**. It integrates Turnitin similarity checking
  into Moodle courses (assignments, workshops, forums). It is written in PHP
  against the Moodle plugin API and Moodle 4.1+ is required to run it.
- It is **not** a standalone similarity-detection service, and vendoring it
  does not grant access to the Turnitin service itself — a valid Turnitin
  account/API agreement with Turnitin (iParadigms LLC) is required for any
  actual checking to occur.
- AIwritehuman drives the Turnitin PHP SDK bundled in this repo
  (`vendor/Integrations/phpsdk-package`) through the bridge in
  `../writehuman-detector-bridge/check.php` (requires PHP 7.4 — the SDK is
  not compatible with PHP 8.x SoapClient signatures). The Node layer reports
  honestly when Turnitin credentials are not configured and never fabricates
  similarity scores. Submissions are made with SubmitPapersTo=0, so checked
  text is NOT deposited into Turnitin's student-paper repository.

## Trademark note

"Turnitin" is a trademark of iParadigms LLC. This project does not present
itself as Turnitin, nor as endorsed by or affiliated with Turnitin. The name
appears here only to accurately attribute the origin of this GPL-licensed
code, as the license requires.

## Compliance summary (GPL-3.0)

- License text preserved: `LICENSE`
- Copyright notices preserved: all source file headers
- Source availability: this directory is the complete corresponding source
- Derivative terms: any redistribution or modification remains GPL-3.0
