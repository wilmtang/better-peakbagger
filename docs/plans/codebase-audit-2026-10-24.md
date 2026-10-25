# Repository audit and remediation — October 24, 2026

Status: **Implementation in progress**, independently rechecked against `4c57323f`.

The original draft mixed confirmed defects, intentional behavior and source-only
hypotheses. This corrected plan records the implementation scope authorized after
the review. Each independent fix gets its own commit and focused regression
checks. Browser, live-service and native-UI evidence remain distinct.

## Baseline and independent verification

- Baseline: `4c57323f`, version 4.0.2; 3,398 tests passed, no skips or failures.
- ESLint, 52-bundle build and packaged web-ext lint passed with eight owned warnings.
- The network-enabled reviewed dependency gate failed with five affected packages:
  `@devicefarmer/adbkit`, `fast-uri`, `node-forge`, `undici`, `web-ext`.
  The node-forge exception expired at October 24, 00:00 Los Angeles; new
  fast-uri/undici advisories also fail its exact-match policy. Expiry already has
  a deterministic boundary test; a passing unit suite never implied a clean audit.
- Focused probes reproduced the manual Garmin queue stall, provisional blank-tab
  handoff rejection, stale plain-mode draft, missing FIT file identity, compressed
  waypoint rejection and legacy account-evidence mismatch.
- Hidden Chrome 156.0.8078.4, light theme, 1100×850 and 390×844, HTTPS fixture:
  Inbox actions and following content shifted down 21 px when timestamp preferences
  arrived; cancelling Done left “Working…”; dismissal moved focus to body;
  waiting-to-error review status stayed stale. Storage and worker replies were
  mocked. No live Garmin writes or Peakbagger Saves were automated.

## Findings and acceptance checks

### F1 — Dependency gate and expiry diagnostics (P1)

`scripts/check-npm-audit.mjs`, `package-lock.json`,
`test/project/dependency-advisory.test.mjs`.

- Update compatible fast-uri and undici resolutions to patched releases.
- Recheck upstream node-forge/web-ext releases before narrowly renewing the existing
  development-only exception; do not accept new advisory identities or paths.
- Distinguish an exact, expired reviewed exception from genuinely unowned findings.
- Verify live audit, expiry/new-advisory tests, dependency ownership and shipped
  bundle exclusion. A reviewed exception is not a clean dependency graph.

### F2 — Durable Garmin handoff recovery and public errors (P1)

`src/background/background.js`, `src/garmin/garmin-imports.js`.

- Retain the durable intent before draft tabs can open. Recover or roll back only
  the matching intent when job/payload installation fails or expires, and preserve
  live draft/save-recovery evidence so retries cannot duplicate uncertain work.
- Preserve intentional PublicError/GarminError messages; keep arbitrary transport
  and storage errors private.
- Retries already pass the current message selection through beginDraftOpening;
  the original claim that retries use an empty existing.selectedIds was rejected.
- Cover failed installation, rolled-back opening, worker recreation, stale/closed
  source tabs, expired jobs and uncertain saves; run real-extension smoke checks.

### F3 — Garmin continuation, Undo, retention and identity (P1)

`src/garmin/garmin-imports.js`, `test/garmin/garmin-imports.test.mjs`.

- Finish an explicitly started paginated/preparation run in Manual only mode,
  without scheduling unrelated future discovery.
- Undo a waiting activity with a fresh revision and preparation membership.
- Preserve a resume request arriving during another check; Peakbagger visits
  already await the running check, and must remain preparation-only.
- Prune expired dismissed snapshots before background capacity checks.
- Preserve known numeric ownership when a matching stable subject temporarily
  has no activities; reject conflicting non-null ownership in connect/import.
- Test bounded continuation, coalescing, cancellation, tombstones and account guards.

### F4 — Settings import transaction and credential feedback (P2)

`src/background/settings-file-routes.js`, `options/settings-backup.js`,
`options/garmin.js`.

- Keep documented explicit-null removal and omitted-key preservation semantics.
- Protect the snapshot-to-write/rollback boundary from concurrent settings edits;
  credential verification precedes the settings snapshot, contrary to the draft.
- Include Garmin in import-result credential reporting and immediately refresh its
  Settings surface after a successful import.
- Test stale snapshots, partial rollback and explicit-null compatibility.

### F5 — Provider handoff navigation readiness (P1)

`src/background/gpx-handoff-routes.js`.

- Ignore a newly created tab's uncommitted empty/about:blank complete state.
- Still resolve a completed login or wrong-provider page into actionable recovery,
  rather than waiting forever for the expected import URL.
- Test provisional navigation, redirected pages, timeouts and zero injection before
  readiness. Native/live provider navigation remains separate release evidence.

### F6 — Plain-mode report photo recovery draft (P1)

`src/reports/report-editor.js`, `test/reports/report-local-photos.test.mjs`.

- Persist final hosted URLs after pending photos are uploaded in Plain mode,
  preserving the existing draft version/deletion/conflict protections.
- PHOTO_REPORT_INSERTED records references; it does not delete local photo blobs.
- Prove a failed/native-unconfirmed submission can recover the hosted URLs.

### F7 — Photo Topos report edit boundaries and text state (P2)

`photos/photos.js`, `src/background/report-photo-service.js`.

- Verify replacement-parent ownership/existence for child versions as well as
  same-ID edits. Preserve single-photo replacement context rather than silently
  turning a replacement into a different report insertion.
- Make incompatible Library/file actions unavailable or explain the replacement
  context before users invest work in an impossible Save and return.
- Avoid caption persistence when the supplied caption equals the loaded caption.
- Allow clearing text without leaving the previous canvas text visible.
- Cover parent ownership/deletion, no-op caption, empty text, and rendered controls.

### F8 — FIT identity, waypoints and cancellation (P2)

`src/garmin/fit-activity.js`, `test/garmin/fit-activity.test.mjs`.

- Accept compressed-timestamp waypoint messages while retaining only lat/lon/name.
- Require an activity file_id before accepting decoded geometry.
- Reject stream cancellation with the AbortSignal reason rather than corruption;
  the actual decoder uses JSZip internalStream, not the draft's nonexistent reader.
- Test valid framing/CRC, missing identity, compressed waypoints and mid-inflate abort.

### F9 — Legacy account evidence consistency (P2)

`src/peakbagger/peakbagger-account.js`, account/page tests.

- Accept the recognized mode=profile Edit Account link in fresh evidence while
  preserving strict origin, label/path, duplicate-key and corroboration guards.
- Keep invalid/conflicting evidence fail closed.

### F10 — Native/terrain lifecycle and SNOTEL replay (P2)

`src/maps/map-layers.js`, `src/terrain/terrain-map.js`,
`src/terrain/terrain-frame-runtime.js`.

- Dispose native adapters while entering 3D and recreate them on return to 2D;
  avoid rebinding from incidental frame lifecycle notifications during 3D.
- Clear transient route popups/notices when parking the renderer.
- Re-evaluate coverage for a resumed view without trusting previous-region DEM
  counters. Preserve intentional basemap selections and render-generation guards.
- Preserve SNOTEL occlusions in the latest pending snapshot. Loaded replay is
  intentional because authorization can drop earlier messages; keep that guarantee.
- Run lifecycle tests, true-extension smoke and hardware-rendered terrain checks.

### F11 — Settings/Inbox interaction and layout (P2)

`options/inbox.js`, `options/garmin.js`, `options/favorites.html`,
`options/options.js`, `options/climber-files.js`, `options/backup-review.js`,
`options/ignored-backup.js`, `options/ignored.js`.

- Repair ignored-list backup deep linking and keyboard tab hashes.
- Confirm before entering busy state; move focus to a surviving control when a
  review closes; preserve busy/availability guards after refresh.
- Resolve timestamp visibility before revealing a review, protect against stale
  preference promises, refresh phase/error status, and reconcile history Undo.
- Focus inline confirmation controls and revalidate stale list snapshots on accept.
  Do not add document-wide Escape handling where focus entry solves ownership.
- Clear obsolete Undo records. Refresh already preserves the normal restored
  status; that original allegation is rejected.
- Verify slow, error, retry, cancel and repeated states in Chrome/Firefox, desktop/
  narrow, themes and enlarged text; compare controls, following content and scroll.

### F12 — Weather, astronomy, GPX and ascent correctness (P2)

Independent commits for the affected owning surface:

- Summit reset: refresh an expired/day-stale cached result while preserving usable
  weather through failure/cooldown (`src/weather/peak-weather.js`).
- Hourly location labels: use the selected location's reference and local clock
  (`src/weather/peak-weather-hourly.js`).
- Moon intervals: reproduce full-local-day/high-latitude and distant date labels
  before changing semantics; do not replace civil-day geometry with a UTC-day flag.
- GPX unit changes: update the selected coordinate announcement without erasing
  meaningful copy/error feedback (`src/gpx/gpx-analyzer.js`).
- Ascent date sort: hide native section rows when the served grouping cannot
  describe the newly sorted records (`src/ascent/ascent-filter.js`).
- GPX cancel/failure: retain a usable Process action for the still-selected file
  while invalidating old processing authority (`src/ascent/ascent-upload.js`).
- Historical model availability: keep labels idempotent and scoped to the date
  that was requested (`src/ascent/ascent-weather.js`).
- Shared-client cancellation is intentionally single-owner per page; no competing
  production owner was demonstrated, so no reference-counting redesign is planned.

### F13 — Drag transactions, report controls and bounded DOM work (P3)

Independent commits for drag ownership and report/observer surfaces:

- Cancelled column resize restores its starting width; capture failure still gets
  terminal pointer events (`src/ui/column-resize.js`).
- Respect card drop tolerance in split layouts; bound self-observer work without
  dropping other features' mutations (`src/ui/peak-card-layout.js`).
- Stop unused report observers/listeners; preserve focused save actions with guarded
  aria-disabled; hide empty report feedback and fix pluralization.
- Measure and eliminate redundant inline-color observer work and snow-table churn
  only where the changed code preserves host-mutation observation and accessibility.
- Shared profile feedback already guards busy Retry. Clamping a negative timeGapMs
  cannot change its positive isolation-threshold decision; neither is a runtime fix.

## Closure ledger

### Fixed and verified

- F1: fast-uri 3.1.9 and undici 7.30.1 / 8.12.3 installed. Dependency and
  documentation tests passed; bundle exclusion scan found no node-forge/adbkit.
  Reviewed live gate passed; production audit has zero vulnerabilities. The same
  exact development-only node-forge exception expires October 31 at 07:00 UTC.

- F8: activity file identity is mandatory, compressed waypoint timestamps are
  ignored safely, and ZIP cancellation preserves its reason. All three new
  regressions failed against the prior implementation; 31 FIT/CSP tests and
  focused ESLint passed after the fix.

- F9: strict fresh-page evidence accepts legacy mode=profile while still
  rejecting extra/duplicate keys, off-canonical origins and conflicting identities.
  The new regression failed before the fix; 10 account/page tests, focused
  ESLint and hidden real-extension Chrome verification passed.

- F5: provisional blank tabs no longer authorize injection; completed login
  redirects still return recovery. The blank-tab regression failed before the
  fix; 19 provider route tests, focused ESLint and hidden Chrome extension
  verification passed. Live provider navigation remains unproven.

- F6: local-photo submission explicitly flushes hosted URLs into Plain-mode
  recovery drafts through the existing guarded persistence queue. The new stale-URL
  test failed before the fix; report-photo/draft tests, build and focused ESLint
  passed after it. Native Peakbagger POST behavior remains a live proof limit.

- F3 continuation/retention: explicit Manual-only work completes in bounded
  passes, Undo advances revision and schedules preparation, headless pruning
  preserves tombstones, and late resume intent runs after an active check. Four
  regressions failed before the fix; 27 import tests, 226 bundled-worker tests,
  build, focused ESLint and hidden Chrome extension verification passed.

- F3 identity: reconnect/import/check share stable-subject and non-null owner
  validation; empty account responses preserve known ownership. Regression failed
  before the fix; 33 Garmin import/API tests, build and focused ESLint passed.

- F2: durable pre-opening reservations recover after payload failure/restart;
  opening reservations remain authoritative, current selections retry after
  rollback, and earlier uncertain saves cannot be replaced. Public recovery errors
  survive the Garmin boundary while raw storage errors remain private. Three
  regressions failed before the fix; 259 worker/import tests, focused ESLint and
  hidden real-extension Chrome verification passed. Legacy/expired handoffs that
  may have opened forms retain their lock and manual review/Done recovery.

- F4 transaction: the settings write now compares its reviewed snapshot before
  committing, preserving a newer edit and conditionally rolling back other stores.
  Garmin-only imports report changed credentials. Both new regressions failed
  before the fix; settings transfer/worker tests, build and focused ESLint passed.
  Explicit-null key removal remains intentional.

### Intentionally not changed

- Explicit-null credential deletion; single-owner weather cancellation; busy Retry
  guard; signed GPX time-gap comparisons.
- The rejected initial claims about climber-list network lock scope, durable pending
  journals, climber-file kind validation, photo backup signatureVersion and BOM model
  update domains remain rejected.
- Manual Peakbagger Save, provider ownership, raw-data privacy and narrow permissions.

### Changed but not fully proven

- Audit corrections only. Runtime items above remain open until their focused
  regression checks pass; source inspection alone is not UI or live-service proof.
- Live Garmin/ImgBB/GitHub/provider operations, native browser chrome/focus, assistive
  technology and stores are separate proof limits and must survive archival.
