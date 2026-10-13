# Repository bugs, engineering, and UX audit — 2026-10-12

Baseline: clean `main` at `19c00b5c`, version 4.0.0. This is a
documentation-only audit. Runtime code and regression tests were not changed.
Existing audit ledgers were reconciled against current source before reporting
new findings; their historical test results are not counted as current evidence.

## Findings

P1 is a data-preservation defect to address first. P2 is a reproduced functional
or usability defect suitable for a focused fix. P3 is a boundedness or maintenance
improvement without demonstrated immediate data loss or quota exhaustion.

| ID | Priority | Finding | Current evidence |
| --- | --- | --- | --- |
| F1 | P1 | An untouched report editor can erase newer draft work when it leaves the page. | Shipped editor bundle plus production draft mutation handlers; both blank and nonblank old editors reproduced. |
| F2 | P2 | Climber-card decoration can prevent ignored ascent reports from being hidden. | Full Firefox verifier failed; focused real-extension Firefox navigation and deterministic adapter probe reproduced the conflicting DOM contract. |
| F3 | P2 | Late settings reads revert the site theme and deliver obsolete map preferences. | Deferred-read probes of the shipped theme, Peak-map bridge, and BigMap bridge. |
| F4 | P2 | Sentinel “Try again” does not retry failed imagery and removes its warning. | Real unpacked Chrome extension with Leaflet 1.9.4; catalog requests increased, tile requests did not. |
| F5 | P2 | Sentinel tile warnings overlap the coverage text. | Real rendered Chrome screenshot and the shared metadata CSS/state transition. |
| F6 | P2 | Photos uploaded during report Save never acquire library report references. | Production photo service with IndexedDB fixture; inspection of report replacement and library status paths. |
| F7 | P3 | Report-draft deletion markers have no retention bound. | Production route probe retained 100 markers after 30 days and pruning. |
| F8 | P2 | A same-origin GPX redirect to another ascent is accepted and relabelled as the requested ascent. | Production request/source helpers and the Gaia worker route, with a controlled changed-identity response. |

### F1 — An old editor can replace or delete another editor's newer recovery copy

**Trigger and evidence.** Open an editor in Rich mode without changing its
report. A second editor for the same draft identity saves newer text. Closing,
navigating away from, or parking the first editor invokes `pagehide`. A bundled
probe seeded the second editor's newer record before that event. The old blank
editor replaced it with a deletion marker; the old nonblank editor replaced it
with `Old report`. No Save or Delete activation was involved. The event was
tested with `persisted: true`, so BFCache suspension is affected too.

**Root cause.** `src/reports/report-editor.js` (lines 746–749) persists on
every nonterminal `pagehide`. `saveDraftNow` has no unchanged-content guard,
uses persistence time as `savedAt`, and supplies no storage expectation for
either removal or writing (lines 804–831). The worker supports conditional
mutations, but these calls bypass them:
`src/background/report-draft-routes.js` (lines 123–167). A timestamp generated
while closing the old document makes old content appear newer. The local edit
revision only protects the status message, not the shared recovery record.

**Impact.** The recovery copy of newer unsaved work can disappear or become
obsolete. Another still-open editor may retain the text in memory, but recovery
after both pages close is no longer dependable.

**Smallest safe direction and acceptance.** Make unchanged lifecycle persistence
idempotent and retain the last confirmed draft generation/content ownership.
When a different writer wins, preserve that record and expose recovery for
the current editor's conflicting text instead of silently replacing it. Do not
weaken confirmed Save/Delete cleanup or stop flushing actual unsaved edits.
Extend `test/reports/report-editor-drafts.test.mjs` and
`test/background/report-draft-routes.test.mjs` with a shared store and two
editor lifetimes: blank/nonblank untouched close, dirty conflict, equal-time
generations, BFCache, and confirmed Save/Delete. Verify ordinary autosave and
local-photo recovery remain usable. Commit this data-preservation fix first.

### F2 — One extension feature invalidates another feature's report contract

**Trigger and evidence.** An ignored climber's saved report contains a link
to another climber. The hover-card bundle decorates that prose link before the
ignored-report bundle identifies the report. The broad Firefox 157.0.1 verifier
failed at `Firefox ignored detail`. A focused run using the real Firefox
manifest navigated to the same synthetic HTTPS detail fixture three times:
the first navigation concealed it; the next two left its row visible, with no
visibility tools and its `srcdoc` player retained. The DOM contained the
extension's climber-actions button inside the report. A separate pure probe
identified the raw fixture, added that same extension-owned button, and received
`null` from the adapter.

**Root cause.** `src/favorites/report-adapters.js` (lines 43–59) rejects any
report cell containing a button. `src/favorites/climber-hover-card.js`
(lines 196–206) intentionally inserts buttons beside eligible report links.
`src/ascent/ascent-report-visibility.js` (lines 25–28) permanently stops its
observer when that adapter returns no target. Correctness therefore depends
on cross-bundle startup ordering. The isolated Firefox failures demonstrate
that the current manifest does not establish the assumed order.

**Smallest safe direction and acceptance.** Keep strict author, table, map,
and native-form validation while admitting the narrowly identified controls
the extension itself owns. Do not remove the form/input ambiguity guard or rely
on Firefox becoming faster. Extend `test/favorites/report-adapters.test.mjs`
and `test/ascent/ascent-report-visibility.test.mjs` for decoration before
identification and the inverse order; genuine embedded forms/buttons and
ambiguous authors must still be rejected. Add a combined-bundle fixture and
repeat the actual Chrome/Firefox navigation, hide/reveal, media suspension,
and BFCache cases. Repair the runtime contract before treating the failed
Firefox check as a timing issue. Commit independently from F1.

### F3 — Three settings consumers accept an obsolete read after a newer push

**Trigger and evidence.** Hold an initial settings read containing light theme;
deliver a storage change to dark theme; release the old read. The shipped
site-theme bundle painted dark, then light, while storage remained dark.
It also wrote light into the synchronous page mirror. Equivalent probes of
both read-only map bridges delivered `{enable3dMap:false, theme:dark}` followed
by the stale `{enable3dMap:true, theme:light}`.

**Root cause.** `src/theme/theme.js` (lines 80–83) applies both the read and
subscription without revision ownership. `src/maps/peak-map-bridge.js`
(lines 19–26) and `src/maps/big-map-bridge.js` (lines 25–32) likewise await
`get()` and publish its result even if a newer subscription update already
arrived. The GPX settings bridge already has ordered delivery; these separate
read-only surfaces do not.

**Impact and limit.** A live theme choice can revert, and the stale mirror can
affect the next page's first paint. Map surfaces can receive obsolete theme,
feature, route-style, and cache preferences. These probes establish stale
delivery; they do not establish unauthorized provider traffic, because worker
activation and current-settings checks are separate gates.

**Smallest safe direction and acceptance.** Guard pending reads against newer
notifications and newer read requests, or attach a narrow transport revision
that consumers enforce. Preserve the settings schema, existing allowlists,
failed-read recovery, and synchronous stylesheet/mirror ordering. Add deferred
read regressions beside `test/theme/theme-inject.test.mjs` and the map tests;
cover concurrent reads, disable while pending, OS theme changes, failed reads,
and BFCache revalidation. Run the real-manifest browser checks because these
are load-time content-script dependencies. Treat this as one focused ownership
fix, without creating a second settings schema or refactoring unrelated panels.

### F4 — Explicit Sentinel retry clears an error without fetching imagery again

**Trigger and evidence.** Let the catalog load successfully while every image
tile returns 503. Restore the tile service, then click Try again without moving
the map. Hidden Chrome 153.0.8010.12, the real extension, and actual Leaflet 1.9.4
reported catalog requests **1 → 2**, tile requests **20 → 20**, unchanged layer
identity, and no loaded satellite image at the center. Nevertheless the warning
became hidden and the control displayed `Coverage 100% · Clouds 4%`. The native
basemap and route remained intact. This is a runtime network-request probe,
not an injected tile-error event. Screenshots before and after were inspected
at 1000 × 700.

**Root cause.** The retry button only reruns catalog `load()`:
`src/maps/sentinel-layer.js` (line 184). `renderCapture` skips `replaceScenes`
when scene IDs/bounds match and hides the warning anyway (lines 85–99).
That optimization correctly prevents camera-refresh flicker, but leaves
Leaflet's failed tiles in the existing layer. The actual tile-layer replacement
belongs to `src/maps/sentinel-map.js` (lines 49–63).

**Smallest safe direction and acceptance.** Preserve unchanged-scene reuse
for camera/catalog refreshes while making an explicit imagery retry refresh
failed resources. Keep the error actionable until imagery loading actually
recovers; catalog success alone cannot establish tile success. Extend
`test/maps/sentinel.test.mjs` and `scripts/verify-sentinel-map.mjs` with actual
503 tile replies followed by successful replies for the identical catalog.
Assert new tile requests, decoded imagery at the center, and continued ownership
of native layers. Preserve no-fade dragging, ordinary missing coverage, and
known 429 cooldowns. Evaluate the shared 3D adapter separately; the current
browser reproduction proves the native Leaflet path only.

### F5 — Sentinel warnings and coverage are rendered in the same grid cell

**Trigger and evidence.** After a successful catalog, a tile error makes the
warning visible while `Coverage 100% · Clouds 4%` remains populated. The real
Chrome screenshot shows both texts drawn on top of each other. It is harder
to read the recovery instruction precisely when the imagery is unavailable.

**Root cause.** `src/maps/sentinel.css` (lines 27–29) places every metadata
paragraph at `grid-area: 1 / 1`. The compact layout assumes one paragraph is
visible, but `tileError` and `showLimit` in `src/maps/sentinel-layer.js`
(lines 60–67 and 205–211) reveal the summary without clearing or hiding the
coverage paragraph. Catalog loading already clears it; tile failure does not.

**Smallest safe direction and acceptance.** Enforce mutually exclusive status
and coverage presentation, or provide separate nonoverlapping rows only when
both are useful. Retain the compact success state and honest distinction
between footprint coverage and loaded imagery. Add state-transition coverage
for ordinary tile errors and confirmed tile limits after catalog success.
Visually inspect both adapters in light/dark at 375px and desktop widths,
including multi-line warnings. Keep this a separate focused UI change from
F4's resource-retry behavior.

### F6 — Report-save uploads remain labelled “Not inserted” in Photo Library

**Trigger and evidence.** Paste a photo, then complete the upload-on-Save flow.
The production photo-service probe produced an uploaded catalog record whose
`references` remained `[]`. The report controller replaces the reserved local
URL with the hosted URL and resumes the user's native submission, but sends
no reference acknowledgement:
`src/reports/report-local-photos.js` (lines 192–225). The worker upload path
also never adds a reference:
`src/background/report-photo-service.js` (lines 88–144).

**Impact.** `photos/photos.js` (lines 2639–2649) labels every such uploaded
record `Not inserted`, even after its URL is in the report. Usage details and
the backed-up catalog also omit that relationship. Ordinary photo-editor
insertion has a reference-finalization path; upload-on-Save bypasses it. This
is catalog/usage accuracy, not evidence that the photo upload or ascent Save
failed. The service/DOM contract was inspected; a rendered library badge for
this exact workflow was not independently captured in this pass.

**Smallest safe direction and acceptance.** Record a bounded, idempotent
reference after the report acknowledges hosted-URL replacement, with exact
sender/report ownership. Do not equate upload acceptance with insertion or
invent a saved ascent identity before Peakbagger confirms it. Extend
`test/photos/report-photo-service.test.mjs` and
`test/reports/report-local-photos.test.mjs` for successful replacement, failed
multi-photo batches, interrupted saves, repeat use of confirmed uploads,
duplicate acknowledgements, and reference persistence failure. Verify the
library label and backup payload after a fixture-based successful flow; never
retry the upload just to repair reference bookkeeping.

### F7 — Draft tombstones accumulate outside the advertised draft bound

**Trigger and evidence.** A production-route probe removed 100 different
editor draft keys, advanced the clock by 30 days, and invoked pruning. All
100 deletion markers remained. The ordinary editor empty-content/removal path
can create these markers even when no recoverable draft existed.

**Root cause.** `src/background/report-draft-routes.js` (lines 148–167) stores
markers for removal. Pruning selects only `ReportDrafts.validRecord` entries
(lines 301–315), so neither the 14-day TTL nor the 30-draft limit applies to
markers. Exact finalization exists for the manager's Undo timer (lines
271–298), but the editor's ordinary removal path never invokes it; interrupted
manager lifetimes can retain markers too.

**Impact and direction.** Small identity/time records and `get(null)` scan
cost grow with all previously removed identities. The probe did not demonstrate
storage exhaustion; this is P3, not an imminent quota incident. Define a safe
marker retention/compaction policy after F1 establishes writer ownership.
Preserve stale-write suppression, Undo generations, active editors, and
unrelated extension storage. Add expiry/count and worker-restart cases in
`test/background/report-draft-routes.test.mjs`. Do not simply delete all
markers and reopen stale-write resurrection. Commit independently after F1.

### F8 — Final GPX response identity is weaker than requested-link identity

**Trigger and evidence.** Request the saved download for ascent 42 and return
a successful same-origin response whose final URL is
`GPXFile.aspx?aid=43&sep=1`, containing a valid different track. A probe using
the production Peakbagger request helper and `readSourceGpx` accepted that
response, labelled it `peakbagger-42.gpx`, and passed the different bytes to
the production Gaia route's script-injection boundary. Provider injection was
stubbed; no actual Gaia import or live redirect was induced.

**Root cause.** `src/gpx/saved-gpx-source.js` (lines 54–60) verifies the
requested link's exact ascent identity but checks only the response origin.
It then replaces the transport identity with the original page identity and
filename (lines 70–74). The shared worker handoff guard only sees those
regenerated fields, so it cannot recover the mismatch:
`src/background/gpx-handoff-routes.js` (lines 16–22). The shared source feeds
Gaia, onX, AllTrails, and CalTopo. Existing redirect tests reject a foreign
origin, but do not exercise a changed ascent on the same origin.

**Impact and limit.** If Peakbagger unexpectedly redirects a valid request
to another ascent's GPX endpoint, the wrong route can be prepared under the
requested ascent's filename. This violates the exact-saved-export contract;
the controlled probe does not establish that the live service currently emits
such redirects. No GPX persistence or automatic destination Save is involved.

**Smallest safe direction and acceptance.** Reuse the existing strict
`storedTrackLink` validation for the final response URL and expected ascent,
before accepting or returning any GPX bytes. Keep harmless case/query
normalization for the same endpoint/ascent, and retain actionable login/error
classification instead of indiscriminately disabling redirects. Extend
`test/gpx/saved-gpx-source.test.mjs` with another ascent, duplicate `aid`,
non-download path, URL credentials, foreign origin, and a benign same-ascent
redirect. Exercise the real request helper as well as a direct source stub,
and assert that rejected responses never reach any provider route. Commit this
identity fix independently, with ordinary exact-byte handoff coverage retained.

### O1 — Optional P3: make profile-backup preparation cancelable

The shipped preparation panel contains only “Preparing backup…” and a sentence
about reading the complete ascent list/repository:
`src/profile/profile-backup.js` (lines 114–119). A held-list-response bundle
probe found zero action buttons during this phase, then completed normally
after the response was released. The running producer/consumer already has
Pause/Cancel behavior; the preparation phase precedes those controls.

Consider exposing Cancel while the full-list and repository preflight are
pending. This is a product/UX opportunity, not a claim that an existing Cancel
button fails or that preparation waits indefinitely. If implemented, cancel
must invalidate the preparation's generation, abort retractable reads, and
prevent its late reply from starting a runner or borrowing a newer workflow.
Add pending-list and pending-repository tests beside
`test/profile/profile-backup.test.mjs` and inspect the resulting control/focus
states in Chrome/Firefox. Keep a GitHub batch that already crossed its write
boundary subject to the existing “stop after this batch” rule.

## Existing open work, kept separate

The [October 10 UI audit](new-features-ui-audit-2026-10-10.md) already owns two
P2 findings. Their problematic current source remains present:

- A 3D Sentinel capture choice is still not connected to `userPickedBasemap`:
  `src/terrain/terrain-frame-runtime.js` (lines 1865–1867 and 2220–2226).
  Resume can reapply the inherited 2D capture. This is distinct from F4.
- Climber-card cleanup still searches only the immediate next row and closes
  without replacement/removal focus recovery:
  `src/favorites/climber-hover-card.js` (lines 123–132 and 185–194).
  The earlier audit owns the consecutive-hidden-row and replacement evidence.

These are carried findings, not eight additional new defects or fresh full
reproductions. Keep their acceptance criteria and independent commits in the
existing plan rather than duplicating the execution ledger.

The [October 3 CI ledger](ci-ux-maintainability-audit-2026-10-03.md) retains the
dependency and historical-tag recovery work. Current strict npm audit still
rejects exactly `@devicefarmer/adbkit`, `node-forge`, and `web-ext`. The existing
explicit reviewed exception passes and expires **2026-10-17 00:00 PDT**
(`2026-10-17T07:00:00Z`). It was neither expanded nor renewed. Production-only
npm audit reports zero advisories; many shipped libraries are declared as dev
dependencies, so that result alone is not a shipped-bundle security proof.

## Scope and verification performed

The review inventoried runtime, UI, test, build, and workflow surfaces across
the repo and inspected their architecture/contracts and selected critical
implementations. It is a risk-based repository review, not a claim to have
manually proved every branch in every file.

| Area | Review/coverage in this pass |
| --- | --- |
| Manifest and bundle assembly | Execution worlds, script order, permissions, worker entry, copied assets, atomic build publication; current real Chrome and attempted Firefox manifests. |
| Capture and GPX | Worker admission/cancellation, generation-scoped storage, provider ownership, bounded analysis, draft identity/Preview, saved-GPX handoffs; current unit and scale suite. |
| Reports and photos | Serialization/recovery, terminal Save/Delete, local-photo gate, upload journal/CAS, return ownership, library references/retention; targeted F1/F6/F7 probes. |
| Settings, theme, and climber lists | Mutation queues, transfer rollback, subscriptions, read-only bridges, report adapters, hover-card decoration/focus; targeted F2/F3 probes. |
| Maps, weather, time, and astronomy | Terrain lifecycle/consent, Sentinel scene ownership/errors, recent weather state/keyboard ledgers, shared settings/time/metrics; current tests, Chrome smoke, real Leaflet failure rendering. |
| GitHub/profile backup | Auth snapshot ownership, write queue, settings import transaction, report snapshot and page-owned profile transport; source and current tests. |
| CI/release/dependencies | Workflow source, production archive validation contracts, existing advisory policy and expiry; local audit only, no hosted job dispatched or remote CI success claimed. |

| Check actually run | Result |
| --- | --- |
| `npm test` | Built current `dist/`; **2,681 passed, zero failed**. |
| `npx eslint src options popup photos scripts test` | Passed. |
| `node scripts/check-web-ext-lint.mjs` | Passed with six existing owned manifest/vendor warnings. |
| `node --test --test-concurrency=1 'test/scale/**/*.scale.mjs'` | **14 passed, zero failed**, against the same fresh build. |
| `npm run audit:ci` with registry access | Failed on the three known development-tool-chain findings. An earlier sandboxed attempt lacked usable registry metadata; it is not vulnerability evidence. |
| `npm run audit:ci -- --allow-reviewed-development-advisory` | Passed with the existing exact expiring exception; graph still has three high findings. |
| `npm audit --omit=dev --json` | Zero production-dependency findings, with the bundled-dev-dependency limitation above. |
| `node scripts/verify-extension.mjs` | Passed, real unpacked Chrome 153.0.8010.12, hidden, base 1000 × 760, including BFCache and teardown. |
| `node scripts/verify-firefox-extension.mjs` | **Failed**, Firefox 157.0.1, hidden, timeout on ignored detail; investigated as F2, not discarded. |
| Focused Firefox detail probe | Three navigations, one concealed and two incorrectly visible; real derived manifest, requested outer size 1000 × 760, measured content viewport 1000 × 675; teardown passed. |
| Focused Sentinel browser probe | Chrome 153.0.8010.12, actual Leaflet 1.9.4, hidden HTTPS fixture at 1000 × 700; F4/F5 reproduced and screenshots inspected; teardown passed. |
| Temporary bundle/pure/IndexedDB probes | F1/F3/F6/F7 and the F2 adapter/F4 scene-reuse paths reproduced; these are audit probes, not checked-in regression tests. |
| Continuation: profile, saved-GPX source, four provider routes, GitHub auth/write queue | **99 passed, zero failed**, using the existing fresh bundles. No runtime change required a rebuild. |
| Continuation: changed-identity redirect and preparation probes | F8 reached the worker injection boundary with the wrong GPX; O1's preparation had no action controls. All data and replies were synthetic. |

Browser pages used synthetic HTTPS fixtures on a real Peakbagger hostname and
disposable profiles. Sentinel responses were intercepted; only pinned Leaflet
test assets were downloaded. The user's existing browser was not used or
closed. The Sentinel visual is Leaflet image/DOM rendering, not a hardware
MapLibre/WebGL verification. No GPU terrain verifier or store-package rehearsal
was run in this pass. The first photo-service probe used an incomplete synthetic
success object; its fixture was corrected to the production/test response shape
before the successful evidence above.

Final process-command inspection found no audit-owned browser or helper. The
exact extension, Firefox, and Sentinel disposable profile prefixes were absent
from the temporary directory. Compact diagnostics and the two Sentinel
screenshots are retained with this chat's managed audit artifacts.

The continuation followed the initial audit-record commit `27c70232` and
reviewed capture draft opening/order, GitHub authorization claims and queued
access, profile producer/consumer cancellation, photo upload recovery, and all
four destination adapters. It added F8 and O1, without promoting unproven
browser-API stalls or already-covered active-runner cancellation to defects.
The initial preparation probe assumed a Cancel button existed; source and the
corrected probe showed that it does not, so the issue is recorded as an optional
control rather than a broken cancellation implementation. No new browser was
launched for the continuation.

## Execution order and closure ledger

Implement F1 first, then F2, F8, F3, F4, F5, F6, and F7. Each independent completed
unit needs its own focused commit after appropriate checks. The two carried
UI findings retain their existing independent acceptance checks. Extend tests
to exercise the failing boundary rather than merely checking internal state:
shared-editor lifetimes, actual coexisting bundles, late notifications, and real
failed-tile recovery. Avoid broad coordinator/editor rewrites justified only
by file size.

### Fixed and verified

- **O1:** preparation now exposes Cancel, aborts complete-list reads, and
  invalidates its owner generation before returning to the entry action.
  Late list/preflight replies cannot start or borrow a newer runner. Pagehide
  also cancels preparation. Worker preflight already dispatched may complete
  read-only; its result is discarded. Running batch stop semantics are unchanged.
  The panel is constrained to the viewport rather than the native page's wide
  minimum. Build, 28 profile/runner tests plus 12 project/documentation checks
  and affected ESLint passed. Hidden real Chrome 153.0.8010.12 and Firefox
  157.0.1 verified actual list transport abort, focus return, and rendered
  1000×760 light / 375×760 dark states with geometry checks and inspection.

- **F7:** lazy pruning now expires markers after 14 days and bounds older
  markers to 60, preserving the active key and a one-minute Undo protection
  window. Physical key retirement first advances one durable deletion epoch;
  CAS writers that observed absence before retirement cannot resurrect a draft
  after compaction. A failed epoch write retains the marker. Existing live
  generations remain authoritative across unrelated cleanup.
  Build, 239 report/draft/manager tests, affected ESLint and documentation
  checks passed. Hidden Chrome 153.0.8010.12 two-tab verification passed at
  1000×760 and 375×760. Cleanup remains lazy, with no background expiry timer.

- **F6:** report-owned hosted-URL replacement now acknowledges insertion to the
  worker. It checks owner, photo ID and accepted URL, then records an idempotent,
  bounded `ascent-draft` reference with optimistic store conflict retries. An
  accepted upload alone adds no reference. Incomplete batches and interruption
  do not acknowledge insertion; a failed reference write retries bookkeeping
  without another upload. Hidden Chrome 153.0.8010.12 verified one upload, one
  fixture form POST and the visible In report library card (1280×900); report
  interactions also ran at 720×900. No live upload or server Save was performed.
  Build, 494 related photo/report/worker tests and affected ESLint passed.

- **F5:** visible Sentinel metadata paragraphs now occupy separate grid rows.
  Normal/loading states retain their compact single visible row. Hidden real
  Leaflet geometry checks and screenshot inspection confirmed warning/coverage
  separation at 1000×700 and 375×700 in light and dark themes. Build, 16 Sentinel
  tests and verifier ESLint passed. Shared CSS also serves the MapLibre control;
  final terrain rendering remains a separate gate.
  Firefox 155.0 hardware MapLibre warning geometry and inspected screenshots
  subsequently passed at 1000×760 and 375×760, light/dark (ANGLE Metal / M3 Pro).

- **F4:** explicit retry remounts failed imagery even when scene identity is
  unchanged. Camera refresh preserves the failure until imagery is retried;
  healthy scene reuse, catalog-only retry and cooldown gates remain intact.
  Build, 16 Sentinel tests and affected ESLint passed. Hidden Chrome
  153.0.8010.12 with real Leaflet 1.9.4 passed at 1000×700 and 375×700, including
  new tile requests and repainted center pixels, with zero healthy-scene fades.
  MapLibre integration is retained for the final hardware terrain check.
  That gate subsequently passed: real Chrome MapLibre on ANGLE Metal / Apple
  M3 Pro retried failed tiles and repainted the expected capture at 1000×760.

- **F3:** theme reconciliation and both read-only map bridges discard reads
  superseded by subscriptions, newer requests, or pagehide; BFCache restore
  starts a fresh read. The stylesheet/mirror order and message allowlists remain
  unchanged. Build, 129 theme/settings/map tests and affected ESLint passed;
  the final real-manifest browser run remains an integration gate.

- **F8:** the saved-GPX helper now checks the final response against the same
  exact download-path, origin, credentials, and ascent-ID rules as the request.
  Another ascent, duplicate IDs, credentials, and non-download paths fail closed;
  harmless case/query normalization retains the original GPX bytes.
  Build, 42 source/provider/worker-route tests, affected ESLint and diff checks
  passed. Live destination-provider imports remain outside this evidence.

- **F1:** editor snapshots now use worker-checked record/deletion versions,
  serialize their own writes, and skip unchanged lifecycle flushes. Conflicting
  edits preserve the stored recovery copy and expose the existing copy action.
  The related report/draft/delete suite passed 196 tests. Hidden real Chrome
  153.0.8010.12 extension verification passed at 1000×760, including BFCache.
  The checked-in two-tab browser regression passed; the conflict surface was
  rendered at 1000×760 light and 375×760 dark.
- **F2:** detail-report validation now accepts the extension's marked climber
  actions while retaining native control, form, input, and map ambiguity gates.
  Validation also recognizes the resizable report-column wrapper, a second
  integration defect found during remediation. Combined hover/layout/report
  bundles and both hover/report orders are covered; 118 related tests passed.
  Hidden Chrome 153.0.8010.12 extension verification passed at 1000×760.
  Firefox 157.0.1 passed the formerly failing detail reproduction on all three
  navigations (actual page viewport 1000×675); broader Firefox rerun remains
  part of final integration verification.

### Intentionally not changed

- Existing privacy/consent/ownership and schema boundaries,
  raw-provider GPX containment, optional host permissions, and manual final Save.
- Previous accepted design decisions, exact advisory scope/expiry, historical
  recovery constraints, and separate active plan ledgers.
- No live Buddy mutation, upload, GitHub write, push, tag, release, store
  submission, or merge was performed.

### Changed but not fully proven

The remaining findings are open until their implementation checks complete.
Hidden fixture results do not
establish native focus/window placement, browser chrome/permission prompts,
screen-reader speech, physical touch behavior, live provider DOM/export,
live Peakbagger layouts, store acceptance, or hosted CI. Chrome smoke success
does not cancel the Firefox failure. F3's latency was controlled; F6's exact
library badge still needs rendered end-to-end proof. Minimum supported browsers,
Firefox Android, packaged production artifacts, and hardware 3D rendering were
not reverified here.
F8's changed-identity transport was controlled; live redirect behavior and the
destination providers were not exercised by that probe.
