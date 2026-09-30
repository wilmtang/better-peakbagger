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
  exact owned warnings after reviewing the removed MapLibre scale warning.
- Chrome terrain passed on M3 Pro ANGLE Metal with 798×448 and 448×448 canvases.
  Firefox 155.0 terrain passed hidden at 1000×760 on M3 Pro ANGLE Metal,
  including resizing to 748×448. Neither check proves visible window behavior.

## Intentionally not changed

- Keep required CI checks, signed single-commit Dependabot provenance,
  protected release tags, and the browser-stores reviewer gate. No permission,
  test assertion, advisory policy, or production deadline was relaxed.
- Warning disappearance still requires review; exact-count lint enforcement
  remains. The queue workflow needed no repair because it correctly queued
  both updates and respected failing required checks.
- Live Peakbagger Save remains manual. Automated provider and map-import
  fixtures do not establish current authenticated provider behavior.

## Changed but not fully proven

- Hosted CI and store acceptance must be recorded from their actual terminal
  runs; the local results above do not establish either.
- Live Chrome/Garmin evidence is recorded in
  [the capture validation ledger](capture-chrome-validation-2026-09-29.md).
  A fresh live Firefox capture and Firefox Android device run remain pending:
  the existing Firefox Marionette connection was refused, and no Android
  device or Android debugging tools were found. Desktop hidden checks cannot
  substitute for either check.
- The Chrome listing text is regenerated locally. Its dashboard metadata
  requires a separate update because the package-publishing API cannot edit it.
