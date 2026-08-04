# Codebase audit remediation — 2026-08-03

Status: **ten source-grounded defects were fixed in ten focused commits.** The
full unit, lint, scale, packaged-browser, and terrain gates pass. This is not a
claim that every risk found during the audit was removed: broader transaction,
storage-concurrency, and live-service gaps remain explicit in the closure
ledger.

The audit started from local `main` at `d6c53ab`. Its baseline was clean and
`npm test` passed 1,179 tests before any remediation.

## Reassessed findings and disposition

| ID | Finding | Disposition |
| --- | --- | --- |
| F1 | GPX metrics bridge across separate track segments | Fixed in `343af6c` |
| F2 | a descending timestamp can bypass jump-speed rejection | Fixed in `c1b6a24` |
| F3 | chart sampling reconnects separate GPX segments | Fixed in `cad2b76` |
| F4 | missing elevation can truncate route distance and elapsed time | Fixed in `d5eb2d2` |
| F5 | transient chart hover and map lifecycle events erase the persistent keyboard selection | Fixed in `108b8ed` |
| F6 | stale photo autosaves can overwrite newer editor state | Fixed in `5bfadd0` |
| F7 | an in-flight GitHub device poll can restore credentials after cancel or disconnect | Fixed in `e7a1efd` |
| F8 | an immediate capture cancellation can lose the admission race | Fixed in `31cb147` |
| F9 | provider capture can continue after a single-page app navigates to another activity | Fixed in `1906925` |
| F10 | report-photo delivery consumes its one-shot context before the receiver acknowledges insertion | Fixed in `01f43b4` |

## Closure ledger

### Fixed and verified

- **F1 — segment-aware metrics:** track points retain their source segment
  identity. Distance and elevation gain no longer invent an edge between
  separate `trkseg` elements.
- **F2 — reversed-time speed checks:** jump filtering now uses the magnitude of
  the adjacent elapsed interval. Reversing two timestamps cannot turn an
  implausible jump into an unchecked negative-duration edge.
- **F3 — chart segment breaks:** chart sampling preserves every segment endpoint
  and inserts a `null` break for Chart.js instead of drawing a line across the
  gap.
- **F4 — route/elevation separation:** coordinate validity owns route distance
  and elapsed time; finite elevation runs own gain and elevation-derived
  series. Partial or absent elevation no longer erases valid geometry or time.
  Mountain-local time now starts from the earliest chronological point rather
  than whichever point happened to be first in the file.
- **F5 — stable selection:** a keyboard-selected GPX point survives hover exit,
  MasterMap-frame updates, and 2D/3D lifecycle changes. Keyboard navigation
  follows the active time series chronologically and keeps the selected marker
  associated with its source series.
- **F6 — editor-owned autosaves:** photo draft writes are serialized and guarded
  by an editor revision. An older asynchronous completion cannot overwrite a
  newer edit. Lifecycle handlers request a final best-effort flush.
- **F7 — GitHub device-flow invalidation:** cancel, disconnect, and replacement
  flows advance a shared epoch. Pending device state is claimed before
  credentials, and stale polls cannot repopulate cleared authorization.
- **F8 — capture admission cancellation:** cancellation is serialized with
  admission and checked after every admission await. If cancellation wins, a
  newly created job is removed before provider access begins.
- **F9 — activity identity:** the clicked provider and activity identity follow
  the complete capture transaction. The worker rechecks it after Peakbagger
  login and the page checks it before and after reading the GPX body, failing
  closed if SPA navigation changed the activity.
- **F10 — acknowledged photo delivery:** a return context is only consumed after
  `{ ok: true }`. Rejection or a negative acknowledgement releases it for
  another attempt, and the report editor ignores repeat deliveries of the same
  return token within that editor lifetime.

Focused regression suites passed after their owning commits, including 20 GPX
selection tests, 23 photo-editor tests, 40 GitHub integration tests, 42 capture
tests, 62 provider/worker tests, and 26 report-photo delivery tests.

Final verification:

- `npm test`: **1,192 passed, 0 failed**.
- `npm run lint:js`: passed.
- `npm run lint`: passed with the existing six owned manifest/vendor warnings:
  one Firefox service-worker compatibility warning and five generated
  MapLibre/ProseMirror/TipTap unsafe-assignment warnings.
- `npm run test:scale`: **5 passed**, covering the full Rainier table, 1,500
  favorites, a 20,000-point provider track, and a 1,200-photo library.
- `npm run verify:browsers`: passed with the real unpacked `dist/` in hidden
  Chrome for Testing new-headless and hidden Firefox 153.0.1 at 1000×760. It
  covered the MV3 worker, storage, settings bridge, options and popup, capture
  and drafts, photo library/editor and pagination, GPX analyzer, 2D/3D
  controls, Peakbagger page surfaces, and the report editor.
- `npm run terrain:verify`: passed hidden on the hardware `ANGLE Metal Renderer:
  Apple M3 Pro` at 798×448 and 448×448. Progressive coverage, pending drape,
  non-flat DEM, resize, route, peaks, fallback, and context-loss probes passed.
- `npm run terrain:verify:firefox`: passed hidden in Firefox 151.0 at 1000×760
  on the reported hardware renderer. Terrain, basemap, route, peaks, pointer
  interactions, and resize passed.
- Teardown inspection found no surviving verification browser or disposable
  profile. The verifier's temporary screenshot directory was removed.

### Intentionally not changed

- **Arbitrary timestamp permutations and zero-duration edges:** the strict
  descending-edge bypass is fixed, but deciding whether a deeply reordered GPX
  should be sorted, split, or rejected is a product/data-contract decision.
  Zero-duration edges also need an explicit policy rather than another
  threshold heuristic.
- **Draft-tab opening transaction:** clearing a capture or losing its source tab
  can still race draft-tab creation and leave an orphan tab or draft. A safe fix
  needs one per-source transaction owner spanning validation, tab creation,
  cleanup, and session storage; a local guard would only move the race.
- **Capture request cancellation and total budget:** cancellation prevents stale
  capture results from being accepted, but it does not abort every in-flight
  corridor fetch or impose a global query-box/time budget. That requires an
  abort signal and budget propagated through the lookup owner.
- **Cross-owner photo writes:** serializing the editor fixes its own stale
  autosaves, but whole-record writes by other surfaces can still erase newer
  metadata or recreate a deleted photo. Store-level revisions or optimistic
  concurrency are required across every writer.
- **Photo upload atomicity and recovery:** uploading state and the operation
  journal are still separate writes. Repository changes do not seed automatic
  backups for existing photos, transient thumbnail failures can mark a photo
  unreachable, and a changed photo does not reset every retry counter. These
  need a coordinated storage/recovery design rather than unrelated local
  patches.
- **Report-draft clearing:** clearing a restored report draft before Peakbagger
  confirms Save remains the existing owner-reviewed recovery contract. It was
  not changed during this audit.
- **Page-world settings projection:** the MAIN-world bridge still receives the
  cleaned non-secret settings snapshot. Narrowing it safely requires a
  maintained inventory of all analyzer consumers; privileged credentials and
  extension messaging remain outside this bridge.
- **Unproven ordering or URL speculation:** no reachable newest-first or sort-URL
  failure was established from the current tree. No behavior was changed
  without a broken invariant and regression case.

### Changed but not fully proven

- The photo editor requests a final queued save during page teardown, but browser
  shutdown can terminate IndexedDB work. The queue proves ordering while the
  page is alive, not guaranteed persistence after an abrupt close.
- Provider identity and capture cancellation passed pure, bundled, and packaged
  fixture checks. No authenticated live Garmin or Strava activity was captured,
  and live provider DOM/export behavior remains a release-manual check.
- Photo insertion retry and in-editor deduplication are covered, but a real tab
  crash or reload between receiver mutation and acknowledgement was not induced.
  The dedupe token is intentionally not durable across an editor reload.
- Terrain verification uses synthetic DEM, basemap, route, and Peakbagger feed
  fixtures. Withheld fine-grained tiles exercised the coarser-level fallback;
  it does not prove live Mapterhorn or drape-provider availability.
- All browser verification was hidden and isolated. It does not prove native
  focus, browser-window placement, toolbar `activeTab` grants, permission
  prompts, touch input, or screen-reader output.
- `npm run audit:ci` could not refresh npm advisory metadata in the sandbox, and
  authorization to submit the dependency metadata to npm's network service was
  not granted. Dependency-vulnerability status is therefore a proof gap, not a
  pass.
