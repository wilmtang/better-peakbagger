# New features and UI audit — 2026-10-10

Compared `v3.9.2` (`e12f351`) with `620929b`: 69 commits and 207 changed
files. The release baseline is the latest local version tag and the changelog's
last released section; GitHub's Release listing returned no Release objects.
Store publication/version was not independently established. The initial
working tree was clean. This is an audit, with no runtime remediation.

The review covered new climber cards and inline Buddy transactions, Sentinel-2
in native 2D and extension 3D maps, panel styling and popup sizing, Photo Topos
text/clipboard/library changes, Settings startup/theme/backup acknowledgements,
and queued summit draft preparation. Prior October 8–10 audit ledgers were
checked before reviewing the current source. Their historical test results
are not counted as evidence for this pass.

## Findings

### F1 — P2: a capture selected in 3D is reset after returning from 2D

**Trigger and reproduction.** Select a dated Sentinel capture in native 2D,
enter 3D, change its capture dropdown to Latest capture, then switch to 2D and
back to 3D. The dropdown and rendered capture return to the original dated
capture. This was reproduced with the real unpacked extension, actual Leaflet
1.9.4 and MapLibre, synthetic catalog/imagery/elevation, and the production
worker and cross-world bridge. The recorded state was dated → `latest` → dated.
No page reload was involved.

**Root cause.** `src/maps/sentinel-layer.js` (lines 110–114) emits
`onCaptureChange` for explicit capture selection. The 3D adapter in
`src/terrain/terrain-frame-runtime.js` (lines 1847–1849) supplies no callback.
Only the main basemap picker claims `userPickedBasemap` (lines 1835–1844).
Consequently, resume still considers the layer inherited and reapplies the
2D capture through `resolveBasemaps` and `swapBasemap` (lines 2183–2189).

**Impact.** A user comparing acquisition dates silently loses the date chosen
inside 3D. This affects a capture inherited from 2D; changing the main 3D
basemap picker first already establishes the preserved-choice path.

**Smallest safe direction.** Treat an explicit 3D capture selection as a
user-owned drape choice, including selecting Latest capture. Preserve that
choice through suspension/resume. Continue inheriting current native 2D
choices when the user has not made an explicit choice in 3D. Keep all current
validation, cancellation, provider consent, and scene-ownership boundaries.

**Acceptance.** Extend `test/terrain/terrain-map.test.mjs` with inherited
Sentinel → another dated capture and inherited dated → Latest capture, followed
by suspend/resume. Also retain the inverse case: an untouched inherited layer
must follow changes made in 2D. Reproduce these sequences through the real
bridge in a browser, and verify final dropdown identity and imagery, rather
than only the outgoing resume message. Keep this a focused independent fix.

### F2 — P2: climber-card cleanup can strand keyboard focus on BODY

**Triggers and reproductions.** Two hidden Chrome probes exercised the shipped
isolated-world bundle with focus on a card action:

- Hide two consecutive report containers for the same climber, with a third
  visible climber after them. The card closes, but focus becomes `BODY` despite
  the available visible successor.
- Replace the active climber-link container with another eligible link. Its
  new actions trigger is decorated, but cleanup detaches the old card and
  leaves focus on `BODY`.

The first probe drives the DOM hiding boundary used by report filtering;
it does not claim to have clicked Ignore on a live Peakbagger report. Existing
coverage exercises a single hidden container followed immediately by a visible
one, so the consecutive-hidden case is different.

**Root cause.** `src/favorites/climber-hover-card.js` (lines 124–130) considers
only `nextElementSibling` as a fallback and stops if that row is also hidden.
For removal/replacement, `removeRecord` (lines 184–193) calls `close()` without
fallback handling before the mutation cleanup loop (lines 378–382) can preserve
the user's position. Neither path searches for a surviving visible target.

**Impact.** After the report containing the action disappears, keyboard users
lose their position and may need to traverse the page again. This is DOM focus
loss; native macOS window focus was not tested or implicated.

**Smallest safe direction.** Share focus-preserving cleanup for hiding,
replacement, and removal. Find the next visible eligible row/action, then a
previous visible row or stable list control/empty state. Preserve the ordinary
link and only restore focus when it belonged to the disappearing card/trigger;
an asynchronous update must not steal focus from another surface.

**Acceptance.** Extend `test/favorites/climber-hover-card.test.mjs` for consecutive
hidden rows, same-identity replacement, removal, the last row, and focus moved
outside the card before cleanup. Add real-browser DOM focus assertions beside
`scripts/verify-climber-hover-card.mjs`. Preserve existing single-row hiding,
Escape, hover-without-focus, and explicit keyboard-opening behavior. Commit
this independently from F1.

## Verification performed

All browser checks were hidden and used disposable profiles. Peakbagger pages
were synthetic HTTPS fixtures on a real Peakbagger hostname. The real manifest
and built `dist/` were used for extension checks; no user browser was closed or
used for cleanup.

| Check | Current evidence |
| --- | --- |
| `npm test` | 2,432 passed, zero failed; rebuilt shipped bundles. |
| `npx eslint src options popup photos scripts test` | Passed. This is ESLint, not a claim that the complete web-ext/package lint gate ran. |
| `scripts/verify-extension.mjs` | Chrome for Testing 153.0.8010.12; real manifest, worker/bridges, settings/navigation, reports, drafts, membership/card actions and BFCache; teardown passed. Base 1000×760; card states at 1000, 480, 360 and 320px widths, light/dark. |
| `scripts/verify-firefox-extension.mjs` | Firefox 157.0.1; real Firefox manifest, worker/bridges and corresponding UI checks; BFCache and teardown passed. Same base/card sizes and themes. |
| `scripts/verify-inline-buddies.mjs` | Hidden Chrome; inline/native add and remove, confirmed favorites reconciliation and cross-tab race protection; six synthetic Buddy POSTs, teardown passed. 1000×760 light and 320×760 dark. |
| Additional Firefox Buddy probe | Firefox 157.0.1 at 1000×760; supported inline and native form add/remove, shared worker and favorites reconciliation; four synthetic POSTs, teardown passed. |
| `scripts/verify-capture-popup.mjs` | Real Chrome action sizing at source-tab zoom 100%/200%; shipped-asset layouts in Chrome 153.0.8010.12 and Playwright Firefox 155.0 at 390×600, DPR 1/2, explicit and OS themes, dense/long-name ready/opening/opened and error states. Passed. |
| `scripts/verify-multi-summit.mjs` | Chrome 153.0.8010.12 at 1000×760; Strava/upload fixtures each completed three manual synthetic saves with a/b/c suffixes, complete GPX and one local-date trip. Passed. |
| `scripts/verify-photo-editor.mjs` | Chrome 153.0.8010.12, hardware ANGLE Metal / Apple M3 Pro; placement, automatic text width, typing focus, clipboard/Undo and route-point editing. Seven sizes from 320×800 to 1440×1100, including 390×760, 520×800 and 1000×760. Passed. |
| `scripts/verify-climber-list-ui.mjs` | Chrome 153.0.8010.12; Settings/list controls, disclosure, focus/Undo and empty/loading/offline/review states at 1024×900 and 390×844, light/dark, with a DPR 2 check. Synthetic GitHub replies; passed. |
| Additional native 2D Sentinel probe | Chrome, real Leaflet 1.9.4 and the manifest-loaded MAIN-world adapter; no request before selection, native handler/layers preserved, dated selection, no-results, service error, retry and cleanup. Layouts at 1000×760, 480×425 and 320×300, light/dark; no page errors. |
| Additional 3D Sentinel probe | Real extension frame, bridge and MapLibre with synthetic DEM/imagery; hardware ANGLE Metal / Apple M3 Pro. Capture handoff and actual 2D/3D toggles reproduced F1. Layouts at 1000×760 and 320×760, light/dark; no page errors, teardown passed. |
| Bounded live Sentinel contract check | The production search adapter returned 15 usable captures for a small public sample area; one selected imagery tile returned HTTP 200, image/png and CORS `*`. No private route was supplied. |

Representative screenshots were visually inspected for popup ready/opening,
climber card available/ignored/long-name/Buddy states, desktop and narrow
Settings, narrow/desktop photo text editing, and Sentinel controls in 2D/3D.
Controls fit the inspected sizes. Visual inspection does not close F1/F2.
Final process command-line inspection found no matching owned browser/verifier,
and the exact disposable profile prefixes were absent from both temporary
directory roots. Documentation link tests passed 3/3; diff whitespace checks
passed.

Temporary probes and logs are under `/tmp/bpb-feature-audit`; these are audit
artifacts, not checked-in regression coverage. The first 3D probe incorrectly
waited for exactly 100% geographic coverage. The pitched view correctly showed
55%; the probe was corrected to wait for settled coverage metadata after resize.
That failure was in the temporary check, not a product failure or flaky pass.

## Retained limits and ledger

### Fixed and verified

- **F1:** an explicit 3D Sentinel capture choice now claims drape ownership,
  including Latest. Untouched inherited choices still follow 2D. Build and
  44 terrain/Sentinel tests passed. Chrome 153.0.8010.12 real-extension/Leaflet
  1.9.4/MapLibre bridge and Firefox 155.0 hardware fixtures exercised actual
  toggles and capture source identity. Both ran hidden on ANGLE Metal / Apple
  M3 Pro. Base terrain viewport 1000×760; Firefox warning renders also used
  375×760, light/dark. Affected ESLint passed.
  Chrome's pixel assertions wait for settled metadata and distinguish saturated
  fixture imagery from the terrain fallback; failed-tile retry repaints the
  expected capture with new requests. Final steady screenshots were inspected.
- **F2:** cleanup now preserves owned focus through consecutive hidden rows,
  same-identity replacement, removal, and last/empty-row cases. It searches
  surviving next/previous controls and a stable scope, keeps the closed card
  attached to the document, and leaves external focus alone. Build, 109 related
  tests and affected ESLint passed. Hidden real Chrome 153.0.8010.12 and Firefox
  157.0.1 manifest verifiers passed the shared native-input DOM focus probes.
  Base viewport 1000×760; existing card checks cover 1000, 480, 360 and 320px
  in light/dark. These results prove DOM focus, not native window focus.

### Intentionally not changed

- Existing privacy/ownership/fail-closed gates, shared schema,
  manual final Save, and source/bundle ownership.
- Prior audit decisions and the separate active October 3 dependency/release
  ledger. No security exception was reviewed, expanded, or renewed here.
- No live Peakbagger Buddy mutation, upload, GitHub write, push, tag, release,
  merge, or store submission.

### Changed but not fully proven

The runtime change and repeatable Sentinel browser coverage are recorded above.
This pass does not establish native browser menus/window placement or focus,
screen-reader speech, physical touch behavior, store acceptance, hosted CI,
declared minimum browser versions, live Garmin/Strava/export behavior, live
Peakbagger Buddy form transactions. Sentinel provider longevity and every geography/date are not
established by the bounded live sample.

Sentinel now has explicit repeatable Chrome real-manifest and Firefox hardware
fixture cases. The Firefox fixture uses instrumented authorization and storage;
its result is distinct from real Firefox manifest/worker integration. Native
focus/window placement and live provider longevity remain outside these checks.
