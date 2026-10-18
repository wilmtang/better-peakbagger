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
