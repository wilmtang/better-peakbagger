# Dependabot integration and recurrence investigation — 2026-09-08

## Evidence and cause

Auto-merge was enabled on both open npm PRs. The four-check main ruleset
correctly blocked failing checks; the queue itself was working. Tooling PR #21
was merged by `github-actions` on September 6.

- [Editor PR #19](https://github.com/wilmtang/better-peakbagger/actions/runs/34008062466)
  failed `npm ci` with `ERESOLVE`: TipTap 3.30.6 was mixed with 3.31.3 siblings
  requiring exact peers. Two manifest ranges still admitted newer versions.
  The [updater job](https://github.com/wilmtang/better-peakbagger/actions/runs/34007935413)
  was a `recreate` using former `editor`/`vendored` groups and a null requirements
  update strategy, despite the default branch already having renamed groups
  and `versioning-strategy: increase`. Recreating an old PR retained its old
  job configuration. Current YAML alone did not explain that recurrence.
- [MapLibre PR #20](https://github.com/wilmtang/better-peakbagger/actions/runs/34007976080)
  passed ordinary checks but failed both GPU jobs. New diagnostics in
  [the integration run](https://github.com/wilmtang/better-peakbagger/actions/runs/34292334802)
  exposed obsolete settings replies in analyzer showcases: missing revision
  and request acknowledgement fields made the production client reject them.
  The hosted light system theme therefore defeated the dark-theme assertion;
  a locally dark system concealed the mismatch. The fixture also silently
  used the default map width instead of its requested wide width.
- Firefox additionally polled transient `map.loaded()` dirty flags and used a
  resize threshold that was already true before resizing. After those checks
  were corrected, bounded lifecycle traces exposed a separate startup failure:
  the frame became ready in under a second but timeout handling did not run
  until about 38 seconds on hosted ARM and 49 seconds on hosted Intel. Twelve
  DEM requests started, but no basemap or peak requests followed. Switching
  CPU architecture did not repair it.
- Playwright's locked Firefox 153 used native macOS OpenGL. Playwright 1.63
  supplies Firefox 155 with a selectable ANGLE Metal backend. The revised
  hidden check reports and requires that backend on macOS. The
  [successful hosted run](https://github.com/wilmtang/better-peakbagger/actions/runs/34294343657)
  reports `ANGLE Metal Renderer: Apple Paravirtual device` and completes the
  Firefox terrain assertions about nine seconds after its renderer probe.
  This proves the newer browser plus Metal configuration resolves the hosted
  failure; it does not isolate every upstream browser change from the backend
  change. Production startup deadlines were not raised.

## Fixed and verified

- `ce80d68` merged `origin/main`, including the tooling update, preserving the
  18 pre-existing local commits. `339c5f2` and `e511bad` are real two-parent
  merges preserving the full names and ancestry of
  `dependabot/npm_and_yarn/editor-a5f38f0bb7` and
  `dependabot/npm_and_yarn/vendored-d2e2e9d766`.
- Every direct TipTap dependency is pinned to 3.30.6. A regression checks
  every nested and top-level resolution against the same pin. CodeMirror
  updates and MapLibre 6.6.0 are included; fresh `npm ci` passed.
- Analyzer showcases now load the production settings bridge over narrowly
  stubbed extension APIs. A real-bridge regression covers settings reads,
  acknowledged writes, and rejection of page-owned theme changes.
- Terrain diagnostics retain bounded lifecycle reasons without route payloads.
  Firefox waits for visible markers and loaded sources, settles gestures, and
  proves a real canvas-width change. The unsanitized renderer is checked before
  loading terrain. Playwright's default unsafe SwiftShader opt-in is removed
  from the Chrome extension verifier.
- GPU gates now also run for Playwright/core upgrades, source and script edits,
  manifest changes, and test-workflow edits. They no longer wait for the next
  copied-library update to expose a broken verifier. Thirteen impact and
  dependency-policy tests, focused lint, and the impact CLI passed.
- js-yaml is patched to 4.3.2. The remaining adm-zip advisory has no patched
  published release at review time. Source review and an installed-web-ext
  regression establish that its XPI/proxy installation copies bytes or writes
  a path, without invoking firefox-profile's vulnerable extraction methods.
  `audit:ci` now permits only the reviewed, pinned dev-only advisory graph
  through September 21; new advisories, paths, versions, severity changes,
  or expiry still fail closed.

Local combined verification at `fea2139` passed 1,828 unit tests, focused lint,
`audit:ci`, hidden Chrome 153 extension smoke, and hidden Firefox 155 terrain.
Earlier integration checks passed all 14 scale tests and full lint (eight
owned web-ext warnings). The hosted run linked above validates Node 24,
Chrome 128/current, Firefox 152/latest, both GPU checks, scale, lint, and audit.
The final PR head must pass the same gates before merging via
[PR #22](https://github.com/wilmtang/better-peakbagger/pull/22).

Local Firefox used Apple M3 Pro ANGLE Metal at a 1000×760 viewport and proved
an actual 748×448 resized canvas. Hosted Firefox used the same viewport and
size on Apple Paravirtual Metal. Chrome terrain additionally checks narrow and
dark surfaces. All browser runs were hidden and used disposable profiles.

## Intentionally not changed

- The four stable required checks, strict current-base requirement, signed bot
  provenance checks, and privileged auto-merge workflow remain enforced. There
  is no admin bypass, relaxed peer resolution, or production timeout increase.
- The adm-zip vulnerability is not patched by the bounded acceptance. Existing
  image-size exceptions also remain. These development-tool advisories require
  a patched upstream release or another explicit review by September 21.
- The concurrent report-image layout commit `3a4a081` is preserved locally and
  excluded from PR #22. No store release or tag is part of this integration.

## Changed but not fully proven

- A fresh scheduled Dependabot job must demonstrate the current grouping and
  update strategy; an old recreation is not that evidence. Exact TipTap pins
  and regression checks prevent silent version drift, but cannot prove every
  future updater run succeeds.
- The Metal terrain fixture proves browser rendering and interaction. It does
  not prove native focus/window placement, real extension storage/worker
  lifecycle, live provider behavior, or the native-OpenGL terrain path on
  older Firefox. Separate real-extension checks cover the manifest and worker.
- The final PR and subsequent mainline run are recorded by GitHub. This ledger
  cites the successful implementation run rather than predicting their result.
