# Release hardening — 2026-09-30

Status: implementation complete; main CI, the read-only rehearsal, and tagged
package gates passed. Version 3.8.0 was submitted to both stores on 2026-10-01;
store approval and live desktop Firefox capture remain unproven.

## Findings

The 3.8 integration exposed separate product and verification defects. Required
checks correctly prevented publication; auto-merge was queued correctly.
The worker's delayed readiness timer required a runtime correction. The exact
lint count, async storage predicates, closed-jsdom timers, stale geometry, TLS
attachment, page-load waits, and camera settlement were verification defects.
Their corrections and evidence are recorded in
[the integration ledger](dependabot-integration-2026-09-29.md).

PR #37 passed all jobs and merged as `26a6898`. Its
[main run](https://github.com/wilmtang/better-peakbagger/actions/runs/36809788736)
failed only the Chrome GPU probe: a paused raster request was already observed,
but an immediate assertion required its separate Network event to arrive too.

## Work and verification

1. Gate the pending-raster regression on its authoritative Fetch interception.
   Exercise delayed Network delivery and absent interception in regression
   tests, then run the hidden hardware-GPU verifier.
2. Compute the disposable certificate SPKI once in the shared fixture helper.
   Apply launch-time trust to Chrome fixture checks, including extension-created
   tabs. Keep trust scoped to the generated certificate. Verify the real browser
   and capture flows, and test certificate cleanup and fingerprint generation.
3. Retain useful, bounded browser failure evidence in CI, with failures still
   failing the job. Include screenshots, current page state, and logs where the
   verifier supports them; exclude credentials and provider payloads.
4. Add a read-only release rehearsal that uses the release package gates before
   a tag triggers publication. Validate listing metadata early, build packages
   once, preserve their identity, and keep store jobs exclusive to release tags.
5. Run focused checks before each commit. Follow the authorized PR and main CI
   runs to terminal success, then continue the 3.8 release checklist.

## Fixed and verified

- The prior independent corrections are recorded in the integration ledger.
- PR #37's actual merge has two parents and preserves its full source name.
- The pending-raster probe uses a fresh Fetch interception after navigation,
  instead of requiring immediate delivery of a separate Network event. The
  delayed-Network regression fails against the previous probe and passes with
  the correction; absent interception still fails. All five focused tests and
  focused ESLint passed. Hidden Chrome terrain passed on M3 Pro ANGLE Metal at
  798×448 and 448×448, including pending drape and twelve canvas resizes.

- Disposable certificate trust is computed once and applied at Chrome launch,
  scoped to that certificate's public key. Ten fixture consumers use the shared
  helper. Certificate generation, fingerprint failure, and cleanup regressions
  passed; all 160 project tests and focused ESLint passed. Nine hidden browser
  checks passed: desktop Chrome and Firefox, capture readiness, toolbar capture,
  multi-summit drafts, GPX handoffs, report photos, backup lifecycle, and Chrome
  terrain on M3 Pro ANGLE Metal. The separate LOD and showcase renderers were
  structurally checked but not separately rendered for this change.

- Browser CI retains failure logs and Chrome terrain screenshots for seven
  days. Chrome records bounded fixture requests, structural page state, and
  at most three screenshots with form fields masked; Firefox records its current
  fixture's structural state. Diagnostics preserve the original failure and run
  before teardown. All 51 focused tests, focused ESLint, and YAML parsing passed.
  An intentional hidden Chrome 153 failure at 1280×720 retained the original
  error and a screenshot; visual inspection confirmed form values were masked.

- The release workflow now supports a read-only manual rehearsal with the
  same package and current/floor browser gates. Listing metadata is validated
  early; protected-main tag validation remains mandatory on publication. Both
  store jobs are skipped on every manual dispatch, including dispatches on tags.
  Version/commit/SHA-256 identity accompanies the verified archives and is
  checked after each download. Firefox checks the exact AMO version is unused
  before submission. Recovery resolves the preserved run attempt and retains
  the historical artifact format explicitly. All 68 focused tests, focused
  ESLint, metadata generation, real archive identity checks, and actionlint
  1.7.12 on all three changed workflows passed.

- [PR #38 CI](https://github.com/wilmtang/better-peakbagger/actions/runs/36816697144)
  passed all jobs on `10412f7`. Its real two-parent merge `2177420` preserves
  `codex/release-hardening` in the subject. The
  [main run](https://github.com/wilmtang/better-peakbagger/actions/runs/36817144694)
  then passed every job, including both GPU checks and all capture flows.
  Local verification passed 2,118 tests, 14 scale tests, full lint with seven
  reviewed warnings, the zero-advisory audit, and all 14 immutable changelog
  sections.

- The actual
  [read-only rehearsal](https://github.com/wilmtang/better-peakbagger/actions/runs/36817205927)
  passed on `2177420b7aa55a270ac9b22aa2ddef6d9506772f`. It built and executed
  the production archives in hidden Chrome for Testing 153.0.8010.12 and
  Firefox 157.0, then executed the preserved archives at the Chrome
  128.0.6613.137 and Firefox 152.0 floors. Both store jobs were skipped.
  Downloaded artifact `browser-extension-v3.8.0-1` passed the identity verifier
  for that version and full source commit. Its Firefox ZIP has SHA-256
  `d0c7aace8e9b63d3e72bd5aecb2bae7f46696c9c5de01890406593a69f1be153`;
  all 86 entry contents match the Android-tested archive recorded in the
  [Android ledger](firefox-android-validation-2026-09-30.md).

- Tag `v3.8.0` points to `2177420b7aa55a270ac9b22aa2ddef6d9506772f`.
  The [tagged release run](https://github.com/wilmtang/better-peakbagger/actions/runs/36821357389)
  passed source, test, audit, listing, packaged-browser, and browser-floor gates.
  Firefox submission succeeded and produced
  [AMO version 6530485](https://addons.mozilla.org/en-US/developers/addon/better-peakbagger/versions/6530485),
  awaiting approval. Chrome stopped before upload because its rejected 3.7.2
  revision was still present. The first attempt therefore failed; its Chrome
  job is not evidence of a 3.8 upload.

- Chrome's dashboard identified excessive description keywords (Yellow Argon)
  in the old service-name disclaimer. The source listing now uses a concise
  independence statement. The regenerated 3.8 description was saved in the
  signed-in Chrome dashboard. The exact tag-run Chrome ZIP was uploaded,
  the draft version was confirmed as 3.8.0, and submission returned
  "Your extension was submitted for review." The
  [dashboard](https://chrome.google.com/webstore/devconsole/77aee95a-922b-40c1-a3cd-fe17c47d77fe/kndjohodnpdoejmjkiiakejfehoodedn/edit/status)
  then showed Pending review; automatic publication after approval is enabled.
  Downloaded artifact `browser-extension-v3.8.0-1` passed identity verification
  against the tag commit. Its Chrome ZIP SHA-256 is
  `3602d72f492e6408d9103b0d232868a96758fdd26a011099d8762714993c3706`;
  its Firefox ZIP SHA-256 is
  `8fdddda4287b4d0fc3f423393b1a66fb0b0f6434d1d6076ce51e633929697f1f`.
  No package was rebuilt, tag moved, or successful Firefox submission retried.

- After dashboard submission, only the failed Chrome job was rerun with the
  normal browser-stores reviewer approval. It reused the attempt-one artifact,
  verified the original package identity, and reconciled the existing 3.8.0
  submitted revision. The publisher's matched-version preflight returns before
  either upload or publish, so this recovery did not replay the mutation.
  [Release attempt two](https://github.com/wilmtang/better-peakbagger/actions/runs/36821357389/attempts/2)
  finished successfully, with every release job successful and the Firefox
  submission's original completion time preserved. The original failed
  [attempt one](https://github.com/wilmtang/better-peakbagger/actions/runs/36821357389/attempts/1)
  remains available as the rejection evidence.

## Intentionally not changed

- Required checks, zero-advisory policy, GPU renderer assertions, runtime
  deadlines, release-tag protection, and store reviewer protection remain.
- Store mutations are not retried automatically after ambiguous outcomes.
- Live authenticated browser checks remain separate from fixture evidence.

## Changed but not fully proven

- Live authenticated desktop Firefox capture remains pending. The authorized
  main-profile restart restored tabs, Garmin ownership was visible, and the
  production candidate was installed temporarily. With separately authorized
  browser-UI debugging, the actual toolbar action opened the extension popup;
  summit results, draft filling, and GPX Preview were not established. A fresh
  run of the exact tag-run package reached "Couldn’t connect to Peakbagger";
  its Open Peakbagger recovery opened the real site at Cloudflare's
  "Performing security verification" page. Provider access cannot proceed
  until the user's existing Firefox session clears that challenge.
- Both submissions await store approval. Accepted submission is not evidence
  that 3.8 is publicly available. Chrome's rejection recovery was completed
  manually through the dashboard; the original failed attempt is retained and
  the Chrome-only reconciliation brought the release workflow to success.
