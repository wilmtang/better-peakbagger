# Dependabot integration and 3.8 release preparation — 2026-09-29

## Findings

Both npm PRs had a native GitHub auto-merge request using merge commits. The
privileged queue workflow succeeded; required checks correctly prevented merge.

- [PR #32's run](https://github.com/wilmtang/better-peakbagger/actions/runs/36290128878)
  rejected MapLibre's reduced lint-warning count and failed the Chrome 128
  Buddy replacement retry. MapLibre 6.10 changes the scale label from
  `innerHTML` to `textContent`. Separately, Playwright 1.63 polls the immediate
  callback result: an async predicate's Promise is truthy even when it resolves
  to false. The retry check therefore returned `mirrorApplied: false` without
  awaiting the completed mutation.
- [PR #33's run](https://github.com/wilmtang/better-peakbagger/actions/runs/36290139064)
  stalled in Node tests until its 15-minute job timeout. Reproduction isolated
  the options cleanup hook: jsdom 30.1 retains `window.document` after close,
  but closed-window timers do not fire. The hook waited forever on that timer.
- Full-suite testing then exposed viewport focus restoration cancelling a
  Settings drag. Moving a focused grip changes viewport focus, and jsdom 30.1
  emits blur with the in-page grip as its related target. This must not be
  confused with leaving the browser window.
- A fresh dependency audit also found newly vulnerable `brace-expansion` and
  `undici` resolutions. The earlier passing PR audit was not current evidence.

## Fixed and verified

- Updated development-only brace-expansion to 1.1.21/5.0.12 and jsdom's undici
  to 8.11.2. Fresh install and the zero-advisory audit passed.
- Browser storage predicates now use an awaited driver poll. Regression
  coverage proves false async values keep polling and persistent false values
  time out. Hidden Chrome's real-extension verifier passed.
- Options cleanup yields through Node's event loop before closing pages.
  All 41 GitHub Settings tests passed under Node 24.21.0 with jsdom 30.1.0,
  including tests that explicitly close a device-flow page early.
- Settings drags ignore internal viewport focus transfers, still cancel on
  external blur, and stop updating if rendering cancels a drag. All 25 focused
  Settings tests passed. Hidden Chrome 153.0.8010.12 verified mouse, keyboard,
  simulated touch, reduced motion, and settings transfer. Standard and narrow
  screenshots were inspected; layout checks exercised 1000/760/430px widths. This was
  static HTML, with no WebGL; native window focus was not established.
- Preserved CodeMirror, tooling, and vendored dependency branches with real
  two-parent merges. Full tests passed: 2,097 tests. Full lint passed with seven
  reviewed warnings after reviewing the removed MapLibre scale warning.
- Chrome terrain passed on M3 Pro ANGLE Metal with 798×448 and 448×448 canvases.
  Firefox 155.0 terrain passed hidden at 1000×760 on M3 Pro ANGLE Metal,
  including resizing to 748×448. Neither check proves visible window behavior.

- Firefox 157's caption verifier now permits 0.01 CSS pixel of rectangle
  rounding. A scroll sweep reproduced a negative gap of only 1/65536 pixel;
  the hidden 1000×760 verifier and inspected caption screenshot passed with
  text, width, and placement assertions preserved.

- The first integration CI run stopped at Chrome current's Strava draft
  Preview. Local repetition exposed an extension-created helper at Chrome's
  `Privacy error` page: Playwright's per-page certificate policy could attach
  after initial navigation. The capture fixture now trusts only its disposable
  certificate's SPKI at browser launch. Three consecutive hidden Chrome 153
  runs passed all provider, draft, failure, and cancellation cases. Preview
  failures now report page titles and draft banners for remote diagnosis.

- Both minified 3.8.0 archives passed structural checks (85 entries each) and
  exact-package execution in hidden Chrome 153.0.8010.12 and Firefox 157.0 at
  1000×760. After the staging correction, both rebuilt 86-entry archives
  passed those same structural and browser checks again.
- A hosted Firefox GPU Control-drag timeout exposed a missing camera-settlement
  boundary after the preceding pitch gesture. Both pitch gestures now settle
  before the next operation, and failures report current camera state. Hidden
  Firefox 155.0 passed on M3 Pro ANGLE Metal after this change; fresh hosted
  evidence is still required.

- [Integration CI](https://github.com/wilmtang/better-peakbagger/actions/runs/36674688421)
  passed, and PR #34 merged as `e48cfa1`, preserving both Dependabot branches.
  Post-merge CI exposed a separate Chrome metric-header probe that retained a
  detached note across a resize render. It now resolves and measures the
  connected header in one browser callback. All 154 project tests and hidden
  Chrome 153 passed; 1000px and 430px screenshots were inspected.

- Multi-summit verification reproduced a native Chromium SIGSEGV when a newly
  created blank tab was navigated before its initial document completed. Waiting
  for browser readiness eliminated the crash without modifying the fixture's
  runtime or Save assertions. The worker now bounds that wait to ten seconds
  and checks the opening transaction on each poll. All 181 background tests
  passed, including stalled-tab rollback and cancellation coverage. The full
  2,100-test suite, hidden Chrome 153 and Firefox 157 verifiers, and two real
  multi-summit runs passed. The staging correction below supersedes the initial blank-tab wait.

- The lint warning baseline now uses upper limits: upstream warning removal
  passes, while unreviewed code/file pairs and excess occurrences fail. Reports
  show observed counts, including combined owners in the same bundle. Focused
  regression tests cover partial/complete removal and new warnings.

- The merged readiness wait still failed in main CI because Chromium can leave
  a new `about:blank` tab provisional without reporting completion. Draft tabs
  now load a packaged inert staging document before grouping and navigation;
  the ten-second bound and transaction cancellation remain enforced. All 2,101
  Node tests, full lint, hidden Chrome 153/Firefox 157 checks, and the
  unmodified multi-summit verifier passed after this correction.

- [Firefox Android validation](firefox-android-validation-2026-09-30.md) passed
  on hidden Android 15 ARM64 with Firefox 157, using the final 86-entry archive.
  Settings, worker startup, and the ascent analyzer were verified and rendered
  screenshots inspected. The desktop-width ascent layout remains a limitation.

## Intentionally not changed

- Keep required CI checks, signed single-commit Dependabot provenance,
  protected release tags, and the browser-stores reviewer gate. No permission,
  advisory policy, or production deadline was relaxed.
- The queue workflow needed no repair because it correctly queued both
  updates and respected failing required checks.
- Live Peakbagger Save remains manual. Automated provider and map-import
  fixtures do not establish current authenticated provider behavior.

## Changed but not fully proven

- Hosted CI and store acceptance must be recorded from their actual terminal
  runs; the local results above do not establish either.
- Live Chrome/Garmin evidence is recorded in
  [the capture validation ledger](capture-chrome-validation-2026-09-29.md).
  A fresh live desktop Firefox capture remains pending: the existing Firefox
  Marionette connection was refused, and its profile has no Garmin or Strava
  cookies. An authenticated provider session and controllable browser are
  needed. Hidden fixture and Android checks do not substitute for this check.
- The Chrome listing text is regenerated locally. Its dashboard metadata
  requires a separate update because the package-publishing API cannot edit it.
