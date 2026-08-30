# Code, performance, and UX audit plan — 2026-08-29

Status: **active audit; remediation not begun.** This is a documentation-only
plan. No runtime remediation has been implemented or approved by this file.

Baseline: clean local `main` at `452a394e`, 60 commits ahead of `origin/main`.
The completed [2026-08-19 code/performance/UX audit](../archive/codebase-audit-2026-08-19.md)
was reconciled before opening anything here. Its 14 findings remain closed
except where current source adds a new route outside a formerly closed
invariant. This pass found seven P1 findings, seven P2 findings, and three P3
findings.

## Scope and evidence

The review covered all 120 files under `src/`, 16 under `options/`, three under
`popup/`, five under `photos/`, 45 build/release files under `scripts/`, the
three GitHub workflow files, and 148 test files. It traced activity capture,
provider/Peakbagger page handoffs, GPX analysis and reduction, prepared drafts,
GitHub ascent/photo preservation, report editing and photo return, settings
bridging, Sun/Moon calculations, map/terrain lifecycle, storage/cache behavior,
and development-build publication.

Audit-time verification established this baseline:

- `npm test`: **1,640 passed, 0 failed** after rebuilding all 29 shipped
  bundles in `dist/`.
- `npm run lint`: passed ESLint, build, and `web-ext lint` with the eight
  repository-owned warnings already documented by the project: one
  cross-browser worker warning, five MapLibre warnings, one ProseMirror warning,
  and one TipTap warning.
- `npm run test:scale`: **6 passed, 0 failed** across the 4,145-row Rainier
  ascent table, 1,500 favorites, 20,000-point provider inputs, and 1,200-photo
  library. Those jsdom timings are not browser interaction budgets.
- `npm run audit:ci`: passed its exact two-advisory, development-only
  `image-size` allowance through 2026-09-21. `npm audit --omit=dev --json`
  reported zero production vulnerabilities.
- `npm run verify:browsers`: passed with the real unpacked `dist/` in hidden
  Chrome for Testing 151.0.7922.34 (new headless) and hidden Firefox 154.0.1 at
  1000×760. No window was shown or focused. This proved extension startup,
  bundle/manifest integration, and the verifier's covered flows; it did not
  exercise the adversarial orderings below.
- Focused current-module probes reproduced a missing Denver Moon interval, a
  fail-open ascent deletion after a settings read error, stale settings
  acknowledgement ordering, a touch resize that never commits, a capped map
  whose ARIA height disagrees with rendered geometry, a partially published
  Firefox development mirror, and terrain-index write amplification.
- Production-limit CPU probes observed roughly 2.0–2.3 seconds in adversarial
  track reduction and about 5.1 seconds matching 5,000 peaks against 20,000
  points on the audit machine. A zero-delay cancellation callback could not run
  until the synchronous work returned. These are local measurements, not a
  cross-device latency guarantee.
- Hidden Chromium probes measured a 183 ms animation-frame gap when constructing
  the current-equivalent 6,668-point, two-series Chart.js configuration, and a
  1200×600 route-explorer viewport where logical/inline/rendered heights were
  720/738/584 pixels. These focused probes were not full-surface visual approval.
- After browser work, no verifier browser process or disposable Better
  Peakbagger profile remained. The process inspection was scoped to verifier
  command lines and did not touch the user's browser.

Hidden checks cannot establish native focus rings, browser chrome, window
placement, touch feel on physical hardware, screen-reader speech, live
Garmin/Strava/Peakbagger/GitHub behavior, abrupt process loss, store acceptance,
or performance on slower devices. Those limits stay explicit in the execution
and closure requirements below.

## Priority summary

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | P1 | GitHub authorization | queued ascent mutations retain repository access captured before disconnect or repository replacement |
| F2 | P1 | ascent backup identity | a global peak/date fallback can attach one tab's exact report Markdown to another same-day ascent |
| F3 | P1 | deletion preservation | a settings read failure is interpreted as cleanup disabled and allows native Peakbagger deletion |
| F4 | P1 | photo return identity | return tokens bind to tab/frame but not the report document that launched the photo editor |
| F5 | P1 | provider cancellation | direct provider-side browser calls can outlive Cancel, source closure, and the capture generation |
| F6 | P1 | capture CPU | synchronous route analysis blocks Cancel and the nominal total deadline on accepted inputs |
| F7 | P1 | trusted actions | two report-toolbar actions create extension tabs from synthetic host-page clicks |
| F8 | P2 | settings consistency | an older write acknowledgement can overwrite a newer authoritative storage push |
| F9 | P2 | Moon correctness/UX | midpoint ownership can hide both Moon visibility windows for a civil date, and the interval has no text/accessibility equivalent |
| F10 | P2 | page lifecycle | unconditional `pagehide` disposal can leave back/forward-cache restorations without remount or resume |
| F11 | P2 | resize UX | touch media resizing never commits, while resize targets across three surfaces are materially undersized |
| F12 | P2 | route-explorer UX | short windows desynchronize stored height, rendered height, keyboard response, and ARIA copy |
| F13 | P2 | chart performance | legal 20,000-point tracks still create thousands of animated Chart.js points and main-thread stalls |
| F14 | P2 | form accessibility | report URL errors lack associated, actionable semantics and the GPX unit selector removes its focus outline without a replacement |
| F15 | P3 | Firefox development | the Firefox-specific watched source is mirrored in place rather than published as one failure-atomic generation |
| F16 | P3 | terrain persistence | every inserted terrain tile serializes and writes the complete LRU index |
| F17 | P3 | capture storage | narrow job-state changes rewrite every job's immutable serialized GPX payload through one global queue |

P1 means authorization, destructive-action, identity, or cancellation invariants
can fail. P2 is bounded but user-visible correctness, accessibility, or
interaction-performance debt. P3 is demonstrated engineering or resource debt
without current evidence of data loss. Severity is impact and urgency, not
implementation effort.

---

## F1 — Re-resolve GitHub authorization inside every queued mutation

**Broken invariant.** An external mutation must use the repository and
authorization current when its queued operation starts, not credentials captured
while it was merely waiting.

**Evidence.** Delete confirmation resolves a connected client before entering
the shared write queue in `src/background/github-routes.js` (lines 651–655).
Individual and profile backups do the same at lines 875–878 and 977–1010. The
queue deliberately delays callbacks behind prior work in
`src/github/github-write-queue.js` (lines 59–74). Disconnect advances persisted
auth state but cannot revoke an already captured GitHub token in
`src/github/github-auth.js` (lines 346–419). By contrast, root-file commits and
photo-library backup resolve access inside their queued callbacks in
`src/background/github-routes.js` (lines 737–756 and 1371–1377).

If another write holds the queue, Disconnect or repository replacement can
complete before the delayed callback starts, yet the callback still writes to
the former repository with the former client.

**Remediation.** Move `connectedGithubClient()` into every opaque queue callback
and bind the result to the current auth epoch/snapshot. Re-check feature enablement
and repository identity immediately before the mutation. If the epoch changed,
return a typed `superseded` result and do not retry against either repository.
Keep user copy outcome-aware: the queued action did not run, rather than claiming
an ambiguous remote failure.

**Regression proof.** Block the queue, enqueue delete, individual backup, and
profile backup separately, then disconnect or select a different repository
before releasing the queue. Assert that no request reaches the former
`/repos/<owner>/<repo>` path and that a later explicit action uses only the new
repository. Include worker restart and auth-read failure at queue entry; use
fake GitHub transports rather than destructive live writes.

## F2 — Correlate pre-ID save snapshots only to their originating save

**Broken invariant.** Before Peakbagger assigns an ascent ID, a save snapshot
must never be selected through an identity shared by another tab or ascent.

**Evidence.** Snapshots are stored with a source tab in
`src/background/github-routes.js` (lines 472–496), but `findSnapshotForPage()`
falls back from same-tab lookup to the newest global match at lines 824–844.
For new ascents that fallback is only `peakId + date`. A complete page payload
replaces ordinary ascent fields, while the merge intentionally prefers the
pending snapshot's exact report Markdown at lines 805–820. The selected snapshot
is then consumed after the write at lines 905–915.

Two new ascents of the same peak/date can therefore cross: backing up one from a
different tab consumes the other's pending snapshot, commits the wrong exact
report, and removes the freshness evidence its true owner needed. Existing
integration coverage keeps each snapshot in its original tab or varies the date
in `test/github/github-backup-integration.test.mjs` (lines 1460–1563), so it does
not exercise the collision.

**Remediation.** Allow cross-tab lookup only for a unique positive ascent ID.
For pre-ID saves, bind the snapshot to its originating tab plus save generation,
or carry a cryptographically unguessable save nonce through the valid
`ascentedit.aspx` → `ascent.aspx` navigation and consume it once. Do not require
the original document: a successful save necessarily replaces it. Ambiguous
matches must preserve every candidate and return `no-fresh-save` (or use the
independently read persisted page Markdown) rather than guessing.

**Regression proof.** Store two different reports with the same peak/date in
separate tabs, then request backup from each original tab and from a third tab.
Only the originating save may consume its snapshot. The third tab must use a
complete persisted read or decline, consume neither snapshot, and never expose
the other report. Cover reload, tab replacement, worker restart, expiry, and a
later positive-ID edit.

## F3 — Fail closed before a deletion that may require GitHub cleanup

**Broken invariant.** Failure to read a preservation setting cannot authorize
the destructive Peakbagger half of a coordinated deletion.

**Evidence.** `src/ascent/ascent-delete.js` uses fail-soft `Settings.get()` to
decide whether GitHub cleanup is disabled (lines 55–65), then allows the native
Delete submission. Its error path at lines 97–104 claims Peakbagger remains
unchanged, but a rejected sync-storage read never reaches that catch because
`src/settings/settings.js` converts the rejection into defaults at lines 45–56.
The same settings module explicitly reserves `requireCurrent()` for privacy and
preservation decisions at lines 30–35. The structural test currently allowlists
this call as a safe gate in `test/settings/settings-read-policy.test.mjs` (lines
4–25).

A deterministic rejected-read probe produced one allowed native Delete
submission, no GitHub deletion intent, and no user alert. Successful default-off
behavior is valid; an unreadable preference is not equivalent to default-off.

**Remediation.** Use `Settings.requireCurrent()` before deciding cleanup is
disabled. On read failure, keep the native form prevented and present one
actionable recovery path. Worker deletion phases must also use authoritative
settings/auth state or retain a durable pending intent; they may not translate
storage failure into “disabled.”

**Regression proof.** Reject sync-storage reads before confirmation and at each
worker phase. Assert no native submission, no fabricated intent, and clear
recovery. Preserve the successful explicit-off path, confirmed deletion after a
complete Peakbagger list, retry after reload, and the rule that unknown remote
outcome is reconciled rather than blindly retried.

## F4 — Bind photo return to the exact report document and identity

**Broken invariant.** A selected photo may be inserted only into the report
document and ascent identity that launched the editor.

**Evidence.** Photo context creation stores tab, frame, and report identity but
not the sender document in `src/background/photo-routes.js` (lines 157–218).
Delivery targets the tab/frame and sends insertion fields at lines 242–302;
navigation in `src/background/background.js` (lines 2833–2841) does not invalidate
photo contexts. The receiver in `src/reports/report-editor.js` (lines 1289–1349)
accepts any not-yet-seen token from the extension and never compares the current
`cid`/`aid`/`pid` with the stored context.

If the source tab reloads or navigates to a different report within the token's
two-hour life, the message reaches the new content-script document and inserts
into the wrong `JournalText`. The worker returns stored identity only after the
new receiver has acknowledged mutation.

**Remediation.** Store the source `documentId`, canonical URL, and normalized
report identity when opening the photo editor. Deliver to that exact document
where the browser API supports it, include the expected identity, and require a
receiver-side URL/identity match before insertion. Invalidate on navigation,
document replacement, source closure, or token expiry. Any ambiguity leaves the
photo available in the library and changes no report.

**Regression proof.** Cover report A→B navigation in one tab/frame, same-URL
reload with a new document, wrong frame, wrong identity, worker restart, replay,
expiry, and unchanged report A. Only the unchanged originating document may
acknowledge and autosave exactly one insertion.

## F5 — Bound every provider-side browser dispatch

**Broken invariant.** Cancel, source-tab closure, and generation replacement
must promptly abandon a capture even when a provider renderer or browser API
call never settles.

**Evidence.** Provider injection, ownership inspection, capture, and page-side
cancel directly await `scripting.executeScript()` in
`src/background/background.js` (lines 834–891). `processCapture()` awaits those
calls without racing its signal at lines 1061–1089 and 1138–1143, while Cancel
itself awaits another unbounded injection at lines 1400–1427. Existing tests
exhaustively stall Peakbagger helper phases, not these provider phases, in
`test/background/background-capture.test.mjs` (lines 1666–1705 and 1863–1901).

**Remediation.** Route every provider injection, ownership read, capture, and
cancel through the same generation-owned browser-operation primitive already
used for temporary Peakbagger-page work: explicit monotonic deadline, abort
race, late-result suppression, and typed public failure. Page-side cancellation
is best-effort cleanup and must never delay the Cancel response. Preserve the
provider ownership and raw-GPX privacy boundaries.

**Regression proof.** Stall before and after every provider dispatch and prove
Cancel, source closure, expiry, and retry settle within a stated latency bound.
Assert no late-generation resurrection, no unhandled rejection, and no awaited
cleanup dependency in the Cancel route. Run the actual unpacked MV3 worker in
hidden Chrome and Firefox after the deterministic harness.

## F6 — Bound and cooperatively cancel synchronous capture analysis

**Broken invariant.** Accepted GPX and peak inputs must not monopolize the MV3
worker long enough to defeat the transaction deadline, Cancel, or unrelated
extension messages.

**Evidence.** After summit fetch, `findEncounters()` scans every route edge for
every peak and `scoreEncounter()` rescans the segment in
`src/capture/capture-core.js` (lines 310–445 and 492–503). Reduction and
per-match draft derivation add repeated passes at lines 585–646 and 828–850.
Current limits permit 20,000 points, 50 segments, one MiB of peak XML, and 64
corridor boxes without a peak-count or CPU budget in
`src/capture/capture-resource-limits.js` (lines 9–22). The nominal deadline
advances through a timer in `src/net/request-deadline.js` (lines 39–68), which
cannot fire while synchronous analysis blocks the worker event loop.

Production-limit probes took roughly 2.0–2.3 seconds for adversarial reduction
and about 5.1 seconds to match 5,000 peaks against 20,000 points on the audit
machine. A zero-delay cancellation proxy ran only after the synchronous phase
returned. Slower devices and denser valid peak responses remain unbounded.

**Remediation.** Cap and validate peak structure, spatially index route edges,
compute shared/prefix metrics once, and replace repeated reduction rescans with
a bounded simplifier. Chunk remaining CPU work and yield between chunks with
abort and monotonic-deadline checks. Preserve detection, ambiguity, reduction,
draft-field, and privacy semantics exactly; performance work cannot silently
change which peaks are selected or what GPX is uploaded.

**Regression proof.** Add a production-scale full-analysis benchmark with a
20,000-point adversarial route, dense peak response, multiple visible matches,
and cancellation injected throughout. Assert result equivalence, peak/point
resource rejection, maximum event-loop gap, and bounded cancellation—not merely
parser completion. Exercise concurrent popup/status messages in the real hidden
Chrome and Firefox worker.

## F7 — Extend trusted-action capabilities to every report tab-opening action

**Broken invariant.** Peakbagger's host page can alter shared DOM, but synthetic
events from that DOM must not become extension tab creation or return-context
creation.

**Evidence.** “Manage TR drafts” calls its message sender without receiving the
activation event in `src/reports/report-editor.js` (lines 489–510). “Upload a
photo…” does the same at lines 1041–1066 and 1141. Their worker routes create a
draft-manager tab in `src/background/background.js` (lines 2556–2570) or a photo
return context/tab in `src/background/photo-routes.js` (lines 157–223). The
trusted-action registry currently covers only ascent backup, profile backup,
and beta settings in `src/background/trusted-actions.js` (lines 17–23). Existing
tests use synthetic `.click()` and expect these messages, so they encode the
missing boundary.

This partially reopens the authorization invariant from the archived 2026-08-19
F1, but only for report actions added outside its closed three-action set.

**Remediation.** Register separate one-use actions for draft-manager and
photo-editor navigation. Pass the actual activation event through
`src/ui/trusted-action.js`, bind capability issuance/consumption to tab, frame,
document, action, and generation, and create neither a tab nor photo context
until consumption succeeds. Preserve keyboard activation and honest
foreground/background semantics where applicable.

**Regression proof.** Synthetic `.click()`, dispatched click/keyboard events,
host-page event loops, replay, expiry, wrong action, and wrong document must
create no tab or photo context. Genuine pointer and keyboard activation opens
exactly once in hidden Chrome and Firefox. Visible browser-chrome and focus
behavior remains a manual release check.

## F8 — Order settings snapshots across acknowledgements and external pushes

**Broken invariant.** Confirmed MAIN-world settings must advance monotonically
with authoritative storage changes.

**Evidence.** `src/settings/page-settings-client.js` assigns both successful
`setResult` acknowledgements and generic pushes directly to `confirmed` (lines
74–110). `src/settings/bridge.js` sends neither source with ordering metadata
(lines 37–80). Thus an external storage push can deliver a newer snapshot, then
a delayed acknowledgement from an older local write can replace it. The current
request-ID logic orders local requests only.

A deterministic sequence—start at metric, request imperial, receive an
authoritative auto push, then receive the older imperial success—left the page
at imperial while storage was auto.

**Remediation.** Stamp snapshots at the authoritative acquisition/mutation
boundary, or maintain a bridge transport generation that pending requests
record when issued. This is protocol metadata only: it must not become a
`bpbSettings` field, schema/default key, transfer/export value, or page-writable
setting. Acknowledgements older than a later storage push may settle their
request but must not replace confirmed state. Keep still-newer optimistic local
patches layered above the latest confirmed snapshot.

**Regression proof.** Pin the exact push-before-old-ack sequence, a push caused
by the same write, multiple pending local writes, rejection, timeout, late
success, bridge disposal, and worker restart. Assert subscriber change sets and
the final analyzer controls match storage in every ordering.

## F9 — Model and explain Moon visibility without midpoint gaps

**Broken invariant.** The selected civil date/time must never claim Moon event
data is unavailable when valid rise/set intervals overlap that date, and the
meaning conveyed by the gray band must have an equivalent for nonvisual users.

**Evidence.** `calculateMoonEvents()` pairs crossings, then retains a pair only
when its midpoint belongs to the selected local date in
`src/sun/sun-position.js` (lines 100–164). The test at
`test/sun/sun-position.test.mjs` (lines 112–132) explicitly pins midpoint
ownership. Denver on 2026-08-26 has one visibility window from 18:38 on the 25th
to 04:40 on the 26th and another from 19:05 on the 26th to 05:45 on the 27th;
their midpoints fall on the adjacent dates, so the current result is
`moonVisibilityState: 'unavailable'` for the entire 26th. Daily event caching in
`src/sun/sun-state.js` (lines 68–76) cannot switch cycles with the selected
minute.

The Moon band is inside a compass hidden from the accessibility tree in
`src/sun/sun-calculator.js` (lines 221–256). Visible/live text reports Moon
phase and instantaneous position plus Sun rise/set, but never Moon rise/set, at
lines 604–661. Sighted first-time users also receive no legend for the smaller
gray arc.

**Remediation.** Return ordered Moon-above-horizon intervals that overlap the
mountain-local civil day, including adjacent-day endpoints and explicit
always-up/always-down/unavailable states. Select the interval containing the
chosen instant when one exists; define a deterministic truthful presentation
for the below-horizon gap and for dates with two partial intervals. Do not use a
midpoint as ownership. Render concise, zone-aware Moon rise/set text, include it
in the live announcement, and label the restrained gray-band visual without
erasing the instantaneous hollow below-horizon marker.

**Regression proof.** Add the Denver 2026-08-26 gap, ordinary same-day and
overnight cycles, two-overlap dates, polar always-up/down, DST label changes,
longitude-estimate fallback, and international-date-line vectors. At early and
late selected minutes, assert the correct interval and band. Inspect light/dark,
narrow/wide, 200% text zoom, and accessibility snapshots in real hidden Chrome
and Firefox; screen-reader speech remains manual evidence.

## F10 — Treat back/forward-cache suspension differently from final teardown

**Broken invariant.** A document restored from the browser's back/forward cache
must resume the same extension-owned surface or remount it; it cannot remain a
partially dismantled page.

**Evidence.** The GPX analyzer unconditionally disposes settings, Sun, overlay,
and frame lifecycle on its one-shot `pagehide` listener in
`src/gpx/gpx-analyzer.js` (lines 908–917). Peak Map and Big Map similarly tear
down on every `pagehide` in `src/maps/peak-map.js` (lines 315–319) and
`src/maps/big-map.js` (lines 805–810). GPX upload restores the native input and
removes its enhancement in `src/ascent/ascent-upload.js` (lines 673–689). None
has a `pageshow` resume/remount path. Current tests dispatch a generic
`pagehide` and assert destruction, including `test/gpx/gpx-analyzer.test.mjs`
(lines 1823–1833), so they do not distinguish `event.persisted`.

The Photo Topos page already demonstrates the intended split: suspend/flush on
`pagehide`, resume on `pageshow`, and terminal cleanup on `beforeunload` in
`photos/photos.js` (lines 2883–2911). Browser eligibility of every live
Peakbagger page was not proven during this hidden audit, but the current handler
is deterministically wrong for any persisted `pagehide`.

**Remediation.** Introduce a small lifecycle owner shared by these page surfaces.
On persisted `pagehide`, pause transient work without deleting UI or disposing
subscriptions; on `pageshow`, revalidate frame/document identity and resume.
Perform terminal disposal only for a non-persisted teardown. Add explicit
`dispose()` ownership for `MapViewport`'s window listener and `ResizeObserver`
in `src/gpx/map-viewport.js` (lines 224–241) as part of the same lifecycle.

**Regression proof.** Unit-test persisted and non-persisted
`PageTransitionEvent` sequences, repeated history traversal, replaced map
iframes, pending terrain/capture work, and ordinary close. Then use HTTPS
Peakbagger-host fixtures with the real extension in hidden Chrome and Firefox,
navigate away/back, and assert restored Sun, map, analyzer, upload enhancement,
settings updates, and exactly one set of listeners. Record pages that browsers
exclude from back/forward cache rather than treating exclusion as a pass.

## F11 — Own resize gestures through completion and enlarge their hit targets

**Broken invariant.** A resize must commit what remains visible when touch or
pointer input ends, and users must not need pixel-level precision to acquire the
control.

**Evidence.** Report images, videos, and YouTube embeds delegate resizing to
TipTap's `ResizableNodeView` in `src/reports/report-rich-editor.js` (lines
146–185 and 320–360). The lockfile pins TipTap core 3.30.1 in
`package-lock.json` (lines 1507–1509); its installed implementation registers
touch start/move but completes only on mouseup. Existing tests cover mouse and
keyboard in `test/reports/report-editor-media.test.mjs` (lines 371–495). A touch
probe visibly changed an 800×450 video to 600×337.5, but `touchend` left the
serialized report at 800×450 and the node in resize state.

The media handle is 14×14 pixels in `src/reports/report-editor.css` (lines
596–615), the map handle is 24×18 and lacks `touch-action` in
`src/gpx/map-viewport.js` (lines 143–163), and the ascent-table divider exposes
only 13 pixels of width in `src/ascent/ascent-layout.css` (lines 5–39). The
visual glyph can remain restrained; the interactive target need not.

**Remediation.** First verify whether a dependency update fixes the complete
gesture lifecycle without regressions. Otherwise own resizing with Pointer
Events and handle `pointerup`, `pointercancel`, and `lostpointercapture`,
committing exactly once and grouping one Undo transaction. Separate each small
visual glyph from an approximately 44-pixel transparent hit target, add
`touch-action: none` to pointer-owned drag surfaces, and prevent target overlap
with adjacent native controls. Never patch generated `node_modules`.

**Regression proof.** Cover mouse, touch/pointer, cancellation, capture loss,
keyboard, one Undo, autosave, and cleared gesture state for image/video/YouTube,
map, and table split. Assert computed hit rectangles and no adjacent activation
or page scroll at desktop/tablet sizes in hidden Chrome and Firefox. Physical
touch feel remains a release proof gap.

## F12 — Use one effective route-explorer height for geometry and semantics

**Broken invariant.** The first resize gesture must visibly change the map, and
the accessible value must describe the geometry the user can see.

**Evidence.** Side layout caps the viewport wrapper at
`calc(100vh - 16px)` in `src/gpx/gpx-panel-css.js` (lines 73–82), while schema
allows a stored 720-pixel height in `src/settings/settings-schema.js` (lines
25–31). `src/gpx/map-viewport.js` keeps that uncapped value as `current`, writes
it inline, announces it, and uses it as the vertical drag/keyboard baseline
(lines 28–48, 67–75, and 177–221).

At a hidden 1200×600 Chromium viewport, stored/logical height 720 yielded a
584-pixel rendered wrapper. ArrowUp changed hidden logical values through 710,
700, and 600 with no visible resize; the label continued announcing the
unrendered height.

**Remediation.** Define one effective height derived from the rendered viewport
and current window constraint for ARIA, drag start, and keyboard changes. A
separate preferred height may be retained for later window growth, but direct
interaction must start from the effective value and update preference
deliberately. Keep map-content height separate from the resize rail so copy and
math name the same dimension.

**Regression proof.** Load minimum/default/maximum preferences at short and tall
viewports. Assert the first ArrowUp/Down and first drag pixel change rendered map
content, the label matches measured content height, and window growth restores
only the intended preference. Verify Leaflet invalidation, sticky/stacked
layout, 3D control positioning, storage write coalescing, and Chrome/Firefox CSS
at narrow and wide widths.

## F13 — Bound chart work by display resolution, not GPX point count

**Broken invariant.** A legal GPX should not freeze chart interaction merely
because its source contains more samples than the canvas can display.

**Evidence.** `sampledPointSet()` keeps every third point regardless of canvas
resolution in `src/gpx/gpx-metrics.js` (lines 392–404), producing at least 6,668
points for a 20,000-point track before group endpoints. Rendering rebuilds mapped
arrays and destroys the chart in `src/gpx/gpx-analyzer.js` (lines 1181–1225),
then enables fills, tension, point callbacks, and default Chart.js animation at
lines 1236–1281 and 1425–1496. Unit, theme, and default-series changes repeat the
full build at lines 1518–1557.

The focused hidden Chromium probe observed 188 ms construction, a 183 ms maximum
frame gap, and roughly 1.2 seconds of animation for the current-equivalent
6,668-point two-series configuration. It was a synthetic Chart probe rather than
the complete extension surface, but the production sample count is exact.

**Remediation.** Sample to a canvas/pixel budget while retaining endpoints,
group boundaries, extrema required for truthful shape, and the selected point.
Disable or shorten animation for large data and rebuilds. Pin the invariants
before using Chart.js fast paths such as `parsing: false` and `normalized: true`.
Update theme/colors/visibility in place when data is unchanged.

**Regression proof.** Exercise an actual 20,000-point analyzer fixture at narrow
and wide viewports. Assert plotted-point bounds, retained semantic points,
selection/copy/map/Sun synchronization, result equivalence within a documented
visual tolerance, and maximum frame/interaction latency for initial render,
units, theme, and series changes. Run `npm run test:scale` plus hidden real
Chrome and Firefox; do not substitute jsdom parse time for browser evidence.

## F14 — Give compact form controls visible focus and programmatic errors

**Broken invariant.** Keyboard focus must remain visibly perceivable, and a
validation failure must be programmatically identified and explain how to
recover.

**Evidence.** Link, image, and video popovers create labelled inputs but no error
nodes in `src/reports/report-editor.js` (lines 323–400). Rejection only adds
`bpb-re-invalid` and focuses the field at lines 1004–1011 and 1068–1099. CSS
adds a red border and outline in `src/reports/report-editor.css` (lines 247–261),
but there is no associated error text or invalid-state ARIA; tests assert only
the class. Separately, the GPX unit selector sets inline `outline: none` in
`src/gpx/gpx-analyzer.js` (lines 186–200), while
the replacement `:focus-visible` rule in `src/gpx/gpx-panel-css.js` (lines
204–221) covers adjacent controls but not the selector.

**Remediation.** Add per-popover concise error text that distinguishes empty,
unsafe protocol, and unsupported video/embed cases without guessing whether an
extensionless or signed HTTPS image URL is “direct.” Set and clear
`aria-invalid` plus `aria-errormessage` or `aria-describedby`, announce the
change, and retain focus. Remove the unit selector's outline suppression or give
it the same high-contrast `:focus-visible` treatment as the other analyzer
controls. Do not add persistent explanatory clutter when the field is valid.

**Regression proof.** Cover invalid→corrected lifecycle, Enter/click paths,
every supported/unsupported URL type, accessible names/relations, repeated
errors, Escape, and no stale error after reopening. Tab through the analyzer
and editor in light/dark and 200% text zoom; assert a non-color focus indicator
and inspect narrow wrapping in hidden Chrome/Firefox. Screen-reader speech and
native select focus remain visible/manual evidence.

## F15 — Publish the Firefox development source as one generation

**Broken invariant.** An unchanged reload token must identify the exact last
complete Firefox development tree, even if the next sync fails.

**Evidence.** The primary watcher publishes `dist/` through the rollback-capable
directory swap implemented in `scripts/build.mjs` (lines 170–196 and invoked at
lines 256–280), then calls the Firefox sync from
`scripts/run-development.mjs` (lines 47–54). That sync removes stale
entries and copies new ones into the live directory one by one before
transforming the manifest and advancing the token in `scripts/run-firefox.mjs`
(lines 32–76). Current fault-injection tests protect primary `dist/`; Firefox
coverage proves only successful mirrors in `test/project/development.test.mjs`
(lines 122–169 and 214–270).

A deterministic copy failure left a newly copied file and removed stale content
while preserving the old reload token. The browser therefore still sees a mixed
tree even though no reload was signalled.

**Remediation.** Build the complete Firefox-specific tree—including transformed
manifest and the intended token—in a sibling staging directory. Validate it,
then publish it with the same rollback-capable directory swap as `dist/`. Keep
the old generation and token byte-for-byte intact on any failure.

**Regression proof.** Inject failures during stale removal, nested copy,
manifest parse/write, validation, publication, rollback, and token writing.
Every failed generation must preserve old hashes and token; every success must
remove stale outputs atomically. Exercise watcher shutdown and disposable-tree
cleanup on macOS, Linux, and Windows CI paths.

## F16 — Coalesce terrain-index persistence and keep incremental totals

**Broken invariant.** Cache metadata work should scale with the final index and
user-visible cache activity, not with the square of tiles inserted in one
navigation burst.

**Evidence.** The terrain cache stores its whole LRU index as one object in
`src/terrain/terrain-cache.js` (lines 219–222). Cache hits use a one-second
coalesced save at lines 283–304, but every insertion serially performs
`cache.put`, mutates/trims the index, and immediately saves the full object at
lines 313–336. `trim()` also recomputes total size from every entry and sorts the
whole index at lines 229–240. The default cache is 512 MiB and the validated
maximum is 2 GiB in `src/settings/settings-schema.js` (lines 26–31, 76–80, and
153–158).

A fake CacheStorage/storage probe inserting 1,000 valid unique tiny WebPs
observed 1,001 storage writes and 37.23 MiB of cumulative index JSON for a final
76.07 KiB index. This is separate from the archived duplicate-network-fetch
finding; current in-flight sharing remains intact.

**Remediation.** Mark metadata dirty and coalesce insert/hit bursts through one
owned persistence scheduler. Maintain total bytes and eviction order
incrementally, flush at a bounded idle/close checkpoint, and preserve best-effort
behavior under quota eviction or index-write failure. Ensure `close()` cannot
silently discard the last dirty generation.

**Regression proof.** A 1,000-tile burst must perform a bounded number of index
writes and serialize bytes proportional to the final index, while preserving
read freshness, LRU eviction, quota/corruption recovery, close/flush, concurrent
consumers, and zero-cache mode. Run the terrain unit suite and hidden hardware-
GPU terrain verifiers; assert the renderer is not software fallback.

## F17 — Separate immutable capture payloads from mutable job metadata

**Broken invariant.** Changing a few selected IDs or a lifecycle phase should
not serialize and rewrite every open job's large immutable GPX payload.

**Evidence.** Every `mutateMap()` operation reads and writes the complete map in
`src/background/background.js` (lines 131–150). Ready jobs embed `uploadGpx` at
lines 1210–1224 and 2054–2064. Updating only `selectedIds` still routes through
the same whole-map write at lines 1449–1474. One global mutation queue also
serializes unrelated job/draft lifecycle maps.

Current legal serialization probes produced approximately 363 KiB for 3,000
trackpoints and approximately 806 KiB for two trackpoints plus 2,998 maximally
named waypoints. Multiple open jobs multiply that work for every narrow state
change.

**Remediation.** Store immutable GPX payloads under generation-specific session
keys and keep the job map limited to bounded metadata and a payload reference.
Create/delete payloads transactionally with job admission, expiry, consumption,
cancel, source closure, and worker-restart cleanup. Narrow independent mutation
queues only where ownership and ordering remain explicit; do not trade write
amplification for stale-job resurrection.

**Regression proof.** Instrument the storage adapter and assert selection/phase
changes write only bounded metadata for multiple near-limit jobs. Cover payload
creation failure, metadata failure after payload creation, cancel/expiry,
consumption, missing/orphaned payloads, worker restart, and concurrent tabs.
Measure serialized bytes and operation latency, not only final logical state.

---

## Implementation sequence and commit boundaries

Each numbered item is an independently verified commit unless implementation
reveals an inseparable invariant. Do not bundle opportunistic refactors.

1. Close the newly exposed trusted-action routes (F7), then bind photo return to
   exact document identity (F4). Both use document identity, but tab-creation
   authorization and insertion delivery remain separate commits.
2. Move GitHub access resolution into queued callbacks (F1), then fix pre-ID
   snapshot correlation (F2), then make deletion settings reads fail closed
   (F3). Run the full GitHub/ascent adversarial matrix after each commit.
3. Bound provider browser calls (F5) before optimizing/chunking analysis with
   exact equivalence and responsiveness tests (F6).
4. Add monotonic settings reconciliation (F8) before touching analyzer UX that
   writes settings.
5. Correct the Moon interval model and tests, then add the textual/accessibility
   presentation in the owning Sun & Moon surface (F9).
6. Add persisted-page lifecycle ownership and real back/forward-cache proof
   (F10).
7. Fix media gesture completion before enlarging/reconciling resize targets
   (F11), then unify effective route-explorer geometry (F12).
8. Bound chart sampling/render work (F13), followed by compact-control focus and
   validation feedback (F14).
9. Publish the Firefox development mirror atomically (F15), coalesce terrain
   metadata writes (F16), and separate immutable capture payloads (F17) as three
   independent engineering commits.
10. After every finding is dispositioned, update the maintained subsystem docs,
    complete the closure ledger below, move this plan to `docs/archive/`, and
    remove its active index entry in the same documentation commit.

## Verification matrix

Every implementation commit runs the nearest focused tests plus `npm test` and
`npm run lint`. The following checks are additional, not substitutes:

| Findings | Required proof |
| --- | --- |
| F1–F4, F7 | deterministic interleaving/identity harnesses; no destructive live GitHub writes |
| F5–F6, F17 | `npm run test:scale`, browser-call and CPU cancellation budgets, storage-byte instrumentation, hidden real MV3 worker in both browsers |
| F8 | bridge ordering permutations and a real cross-tab settings update in Chrome/Firefox |
| F9 | astronomy vectors, DST/IDL/polar cases, accessibility snapshots, light/dark/narrow/200% visual inspection |
| F10 | persisted/non-persisted lifecycle unit tests plus real HTTPS history traversal with the unpacked extension |
| F11–F14 | focused interaction tests and hidden Chrome/Firefox visual inspection at relevant page sizes; physical touch and screen-reader speech remain manual gaps |
| F15 | injected filesystem failures, rollback hashes, cleanup, and platform CI |
| F16 | operation/byte-count assertions plus `npm run terrain:verify` and `npm run terrain:verify:firefox` on an asserted hardware renderer |
| manifest/build/worker/load changes | `npm run verify:browsers` with exact hidden browser versions, viewport, and teardown process evidence |

Do not claim native focus, physical touch, screen-reader speech, live-provider
compatibility, remote GitHub outcome, or store acceptance from a hidden DOM
assertion. Record those as proof gaps until the corresponding evidence exists.

## Investigated and not reopened

- The archived ascent-filter write-amplification fix still frame-coalesces and
  updates changed rows only; no current counterexample was found.
- Terrain in-flight ownership still prevents duplicate concurrent DEM fetches.
  F16 concerns persistence amplification, not network duplication.
- Primary `dist/` publication remains rollback-capable and covered. F15 is only
  the separate Firefox-specific development mirror.
- Peakbagger helper-page operations retain their bounded lease/cancellation
  wrapper. F5 is the still-direct provider side; F6 is synchronous CPU work.
- Prepared-draft claim/rollback, photo-library CAS/journaling, bounded recovery
  readers, terrain origin validation, and raw-provider-GPX narrowing still match
  their archived closure contracts.
- The popup's selection lock, ascent-filter defaults/reordering, split-resizer
  capture-loss hypothesis, toolbar roving tabindex, and Firefox-only terrain
  hypothesis were inspected without a reproducible regression.
- Fixed Sun-card geometry and narrow layout passed the current default-zoom
  hidden verifier. That does not prove 200% text zoom; F9/F14 explicitly require
  that proof where new text or focus treatment changes the surface.
- The two development-only `image-size` advisories remain an explicit, dated CI
  policy rather than a new finding. Production audit is currently clean; the
  allowance must still expire or be renewed deliberately by 2026-09-21.

## Closure ledger

Preserve these categories while implementing and when archiving. A finding is
not “fixed and verified” merely because its unit tests are green.

### Fixed and verified

None. This audit changed documentation only; F1–F17 remain open.

### Intentionally not changed

- No runtime, manifest, dependency, build, or test behavior changed while
  producing this plan.
- Previously archived findings listed above remain closed because current source
  and focused probes did not disprove their remediation.

### Changed but not fully proven

None yet. During implementation, put any landed change with missing browser,
hardware, live-service, accessibility, platform, or remote-outcome evidence
here until that evidence exists. Do not move it into “Fixed and verified” by
wording alone.
