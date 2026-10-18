# Dependency integration — 2026-10-17

## Findings

All three npm PRs (#50, #51, #52) had native GitHub auto-merge requests using
merge commits. The privileged workflow queued them successfully. The active
main ruleset requires Node tests/lint, scale, Chrome smoke and Firefox smoke,
and requires branches to be current with main. Preserve these gates.

[Vendored PR #51's run](https://github.com/wilmtang/better-peakbagger/actions/runs/39091663015)
failed two assertions and the toolbar-to-draft capture verifier:

- MapLibre 6.13 bundles its shared code into the renderer and worker. The test
  incorrectly required a shared-module import even when no import was needed.
- The release-metadata negative test used Marked 18.1.0 as its fake mismatched
  version. That became the actual proposed version, invalidating the test.
- The first toolbar popup did not appear within five seconds. The verifier
  discovered a provider target but never explicitly selected it. Chromium's
  action command uses the target to identify a window and executes the action
  for that window's selected tab. No original job diagnostic established which
  tab was selected when the empty-popup timeout occurred.

## Fixed and verified

- Parse module imports with esbuild, including inline statements, re-exports
  and literal dynamic imports. Permit a self-contained MapLibre entry or its
  packaged shared sibling; continue rejecting other dependency locations.
- Derive the fake Marked version from the locked major version, so it always
  differs from the real release. All 75 manifest/release tests passed with
  both the previous and upgraded vendored lockfiles.
- Select the CDP toolbar target and await its visible, loaded document. Provider
  URLs remain inaccessible to the extension until activeTab is granted. Wait
  for prior popup teardown and report tabs/targets if popup opening fails.
- A disposable copy of the old verifier, starting with another tab selected,
  failed because no capture job started. The repaired verifier exercises that
  same setup and passed all provider success/failure, cancellation, reopen,
  exactly-once Preview, no Save and deletion cases in hidden Chrome for Testing
  156.0.8078.4 at 1000×760. All 11 fixture-helper tests and scoped ESLint passed.
- Preserve all three full bot branch names in real two-parent merge commits.
  Combined versions: CodeMirror language 6.13.1, MapLibre 6.13.0, Marked 18.1.0,
  Playwright 1.64.0 and Selenium WebDriver 4.51.0. Overlapping root lockfile and
  manifest declarations retain every upgrade.
- Fresh npm ci, all 2,849 Node tests, full lint (six reviewed warnings), and the
  explicitly opted-in reviewed-development-advisory audit gate passed before
  the toolbar helper change. The helper change passed its focused checks.
  All 176 report/editor tests also passed with the CodeMirror update.
- All 14 scale checks and the real unpacked-extension verifier passed. The
  latter used hidden Chrome for Testing 156.0.8078.4 at 1000×760.
- Additional hidden hardware-GPU verification reproduced a false scroll failure:
  zoom increased from 13.38 to 14.25 while the quantized scale label stayed at
  500 m. The assertion now requires increasing camera zoom plus a visible scale
  text or width change. It also waits for a settled exposed canvas and retains
  final camera diagnostics. The new assertion fails against the old verifier;
  all 13 focused tests pass, including rejection of stationary cameras and
  unchanged scale geometry. Full terrain verification passed in hidden Chrome
  156.0.8078.36 on Apple M3 Pro ANGLE Metal with 798×448 and 448×448 canvases;
  light/dark screenshots were inspected.

- [Final-head hosted package verification](https://github.com/wilmtang/better-peakbagger/actions/runs/39093299148)
  then exposed a Firefox 158 macOS context-switch race: trusted Enter events
  arrived with `document.hasFocus() === false`, so no native button click or
  Settings navigation followed. The Firefox verifier now requests and awaits
  visible document focus before its repeated Settings activation probes. The
  native click, modifier, destination and tab-topology assertions remain. All
  16 verifier infrastructure tests and scoped lint passed; the full unpacked
  extension verifier passed in hidden Firefox 158 at 1000×760 with teardown.
- The final integration tree before that Firefox-only verifier correction
  passed all 2,851 Node tests and full lint locally.

## Intentionally not changed

- Keep the four required checks, strict base freshness, signed single-commit
  bot provenance, npm-only auto-merge, cooldown and manual Actions review.
- Keep the exact development-only node-forge exception and its expiry at
  2026-10-24 07:00 UTC (after October 23 Pacific). Registry inspection still
  reports node-forge 1.4.0 and adbkit 3.3.9; web-ext 10.8.0 still depends on that
  adbkit. Raw audit retains three high findings. This is not a clean graph,
  and updates after expiry must supply a patched chain or owner decision.
- Preserve the 16 unpublished local main commits and the user's active feature
  work. Remote integration starts at origin/main rather than publishing them.

## Changed but not fully proven

- The inactive-tab failure is reproduced and corrected, but the exact hosted
  timing behind the original empty-popup timeout is not reconstructed. Hosted
  required checks remain necessary; a local pass alone does not close it.
- Hidden protocol checks do not prove native focus/window placement, browser
  chrome or visible toolbar behavior. Provider/network responses are fixtures;
  no authenticated provider activity or Peakbagger Save was exercised.

## Post-merge follow-up

The original integration passed all protected checks in
[run 39093906791](https://github.com/wilmtang/better-peakbagger/actions/runs/39093906791)
and merged as `34e927fb`; bot PRs #50, #51 and #52 are confirmed merged with
their original ancestry. Local main preserved its 16 unpublished commits and
passed all 2,883 tests plus full lint after integration.

The [post-merge main run](https://github.com/wilmtang/better-peakbagger/actions/runs/39094725986)
then failed Chrome 128's Buddy fallback. The trace showed creation of an
inactive `about:blank`, an immediate update to the extension redirect, and only
loading events afterward. No helper report request or content-script read
occurred before the eight-second product deadline. Later Favorites assertions
were consequences of that failed import. Every other underlying job passed.

### Fixed and verified

- Start the inactive tab at the packaged Buddy redirect directly, eliminating
  the competing provisional-blank update. Immediately read that exact helper
  after create returns to reconcile early completion/cache notifications.
- A focused regression models the stranded navigation and an early helper
  response. It fails against the old bundle with the visible Buddy timeout,
  then passes with the fix. All 43 Favorites tests and all 2,852 Node tests
  passed; full lint retained the same six reviewed warnings.
- Real-extension checks passed in hidden Chrome for Testing 128.0.6613.137 and
  Firefox 158.0 at 1000×760, including bfcache and teardown assertions. The
  390px recovered-state and 1000px challenged-state renders were inspected.
  Existing pending/error action-geometry assertions passed.

### Intentionally not changed

- Preserve the eight-second recovery deadline, exact helper tab/URL, fresh
  owner-validated cache, first-party host selection, and cleanup. Keep unrelated
  cache updates and another report unable to satisfy recovery.
- Keep required checks, strict branch freshness and the advisory expiry.

### Changed but not fully proven

- The original implementation passed the local Chrome 128 baseline run. The
  scheduling failure is intermittent; the focused fixture reproduces its
  observed stalled-navigation state, not the exact hosted browser scheduler.
  Hosted CI remains required evidence for the follow-up.
- Hidden checks do not prove native onscreen focus or window placement, and
  fixture challenge pages do not prove live Cloudflare clearance behavior.

## Post-schedule CI follow-up

The [post-merge run for PR #56](https://github.com/wilmtang/better-peakbagger/actions/runs/39102391138)
failed the Chrome 156 Analyzer dark-focus assertion: the ring was focus-visible
and 3px wide, but its color was the light palette's `rgb(23, 105, 170)` instead
of the dark palette's `rgb(121, 184, 255)`. Every other underlying job passed.
The schedule commit changed only Dependabot configuration and this repository's
development guide; it did not change the theme or verifier implementation.

### Fixed and verified

- Route live theme changes in the Chrome verifier through `SETTINGS_PATCH`,
  the same serialized worker queue as pending Analyzer map and units writes.
  The old direct sync-storage read/replace bypassed that queue. A deterministic
  concurrency regression holds a map write after its read, changes the theme,
  then releases the old write: the old verifier restores light, while the
  worker-routed verifier preserves both the dark theme and new map width.
- Wait for the rendered dark focus ring, including the active canvas,
  `:focus-visible`, solid 3px outline and the exact dark palette color. A
  transient dark data attribute no longer substitutes for those postconditions.
  Permanent wrong color, missing focus, wrong theme and missing outline still
  fail with the last observed state in the timeout diagnostic.
- All 14 fixture-helper tests and scoped ESLint passed. The concurrency test
  failed against a disposable copy of the old raw-storage implementation on
  the light-theme overwrite assertion, then passed with the worker queue.
- The full minified-extension verifier passed in hidden Chrome for Testing
  156.0.8078.4 at 1000×760, including BFCache and teardown. The dark Analyzer
  render was inspected. Exact disposable-profile process inspection found no
  remaining task-owned browser processes.

### Intentionally not changed

- Preserve both biweekly Dependabot schedules, npm-only auto-merge, manual
  Actions review, cooldowns and every required CI check.
- Preserve unrelated local main commits and current user-owned edits. The
  repair is isolated on top of the GitHub default branch.

### Changed but not fully proven

- The unmodified Chrome verifier passed locally. The hosted failure retained
  the wrong color but no page/theme history, so its exact write ordering cannot
  be reconstructed. The deterministic test proves the concrete competing-write
  defect; it does not prove that ordering caused the original hosted failure.
- Hidden fixture checks do not prove native window focus or placement, or live
  provider behavior. Remote PR and post-merge CI remain required evidence.
