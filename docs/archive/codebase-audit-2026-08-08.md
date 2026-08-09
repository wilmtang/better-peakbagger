# Codebase audit — 2026-08-08

Status: **remediated and archived.** Each of the ten P1 findings, ten P2
findings, and one P3 guardrail gap has a focused source/test disposition in the
[closure ledger](#closure-ledger). The combined tree passed the repository's
unit, lint, scale, packaged-browser, archive, and hardware-terrain gates. This
is not a claim that every release risk is fully proven: legal review, live
providers, native browser UI, screen-reader speech, touch/device behavior, and
store review remain explicit evidence gaps below.

Baseline: clean local `main` at `140b4c4`, five commits ahead of
`origin/main` and the `v3.4.0` tag. Those five commits are the MapLibre 6 and
bundled-timezone packaging changes. The audit reconciled the current tree with
the [2026-08-03 closure ledger](codebase-audit-remediation-2026-08-03.md)
so closed findings are not reopened without current evidence.

## Scope and evidence

This pass covered 109 JavaScript runtime-source files under `src/`, `options/`,
`popup/`, and `photos/`; 108 test and scale-test files; 50 Markdown documents;
the manifest/build/package/release pipeline; activity capture and prepared
drafts; GPX parsing and derived metrics; report and Photo Topo persistence;
settings and credential import; terrain consent and cross-world messaging; and
keyboard/screen-reader access to the two canvas-heavy surfaces.

Current-turn checks established the following baseline:

- `npm test`: **1,220 passed, 0 failed**; the command rebuilt the 27 shipped
  bundles in `dist/`.
- `npm run lint:js`: passed.
- `npm run audit:ci`: passed its exact, expiring acceptance for two high
  `image-size` advisories in the development-only `web-ext` lint path through
  2026-08-21. This is not a clean advisory graph.
- `npm run verify:browsers`: passed against the real unpacked `dist/` in hidden
  Chrome for Testing new-headless and hidden Firefox 153.0.3 at 1000×760.
- Focused source probes reproduced the GPX draft-quality divergence, a 6,369 m
  draft gain for a track the analyzer measures at 1,747.89 m, a Strong match
  from a one-billion-metre elevation, a 4,020 minute timezone offset from an
  invalid longitude, duplicate/fake descendant GPX points, a 4,503-box corridor
  query from a syntactically valid 20,000-point route, the changelog/release-bump
  failure, and acceptance of an extra nested source map by the archive verifier.

The hidden browser pass did not prove native toolbar `activeTab` grants,
permission prompts, focus or window placement, touch, or screen-reader output.
The hardware terrain suites, scale suite, live providers, and fresh packaged
archives were not rerun in this audit and remain explicit proof gaps.

## Priority summary

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | P1 | release history | post-tag work rewrote the released 3.4.0 changelog and removed the next release's required `Unreleased` section |
| F2 | P1 | distribution compliance | shipped editor dependencies lack complete packaged copyright/license notices |
| F3 | P1 | release archive | archive verification accepts arbitrary nested files under allowed top-level directories |
| F4 | P1 | GPX integrity | draft metrics diverge from the analyzer, bridge missing measurements, and accept impossible elevations as authoritative |
| F5 | P1 | terrain privacy | forgeable page messages and the directly embeddable terrain frame bypass the explicit-interaction boundary |
| F6 | P1 | draft transaction | unguarded preview, selection, opening, and cleanup interleavings can mutate a replacement job or leave orphan state/tabs |
| F7 | P1 | capture availability | GPX inputs and corridor lookup have no coherent byte, point, request, cancellation, or total-time budget |
| F8 | P1 | photo consistency | whole-record writes from different surfaces can lose newer metadata or resurrect a deleted photo |
| F9 | P1 | upload recovery | upload state and the recovery journal begin in separate IndexedDB writes |
| F10 | P1 | report recovery | a local report draft is deleted when Save starts, before Peakbagger confirms success |
| F11 | P2 | report integrity | lossy Rich/Markdown import is documented but not surfaced before an unrelated edit rewrites the report |
| F12 | P2 | local GPX time | timezone selection trusts coordinates and offsets that route validation later rejects |
| F13 | P2 | settings import | rollback can overwrite a concurrent settings, API-key, or GitHub-connection change |
| F14 | P2 | photo catalog | a transient thumbnail render error permanently marks an uploaded photo unreachable |
| F15 | P2 | verifier reliability | browser/terrain verifiers can leak owned resources on setup or cleanup failure and one readiness check uses a fixed sleep |
| F16 | P2 | Photo Topos accessibility | annotations cannot be placed or selected without a pointer |
| F17 | P2 | GPX accessibility | chart values and legend controls remain canvas-only for keyboard and screen-reader users |
| F18 | P2 | maintained metadata | AMO lifecycle copy, audit documentation, terrain source pointers, and a Dependabot group have drifted from runtime truth |
| F19 | P3 | fixture privacy | encoded/compressed GPX fixtures bypass the repository privacy scanner |
| F20 | P2 | provider identity | Garmin's supported same-activity redirect alias is rejected before the worker's canonical identity check |
| F21 | P2 | GPX ownership | descendant searches admit extension-owned fake points and duplicate nested track segments |

Severity reflects impact and urgency, not implementation effort. P1 means a
release-integrity, privacy, material data-correctness, or recovery invariant is
broken. P2 is bounded but user-visible correctness, accessibility, or
reliability debt. P3 is a guardrail or maintained-document defect.

---

## F1 — Restore immutable release history

**Evidence.** `CHANGELOG.md` (lines 3–8) puts the MapLibre 6 migration under 3.4.0, but
`v3.4.0` shipped MapLibre 5.24 and does not contain that entry. The current tree
still reports package version 3.4.0 while containing MapLibre 6.2 and four other
post-tag commits. There is no `## Unreleased`; `scripts/release-bump.mjs`
(lines 40–48)
therefore refuses the documented next-release workflow. Conversely,
`scripts/release-check.mjs` accepts `v3.4.0` from this five-commits-ahead tree
because it does not bind the tag to `HEAD`.

**Remediation.** Reconstruct every post-tag user-visible change under a restored
`## Unreleased` heading, preserving the project's older-change-first ordering,
and leave the tagged 3.4.0 section byte-faithful to the tag. Extract changelog
stamping into a pure operation. A bump should stamp the populated section and
leave a fresh empty `Unreleased` section for subsequent work. Add a final
release check that resolves the proposed tag and requires it to point to
`HEAD`; retain the existing pre-tag metadata validator as a separate operation.

**Regression proof.** Cover missing/empty/populated `Unreleased`, multiple
released sections, preservation of released text, post-release entries, dirty
or detached tag/HEAD mismatches, and repeated execution. Add a CI guard that
compares a released section with its tag so later commits cannot silently edit
published history.

## F2 — Generate complete notices from the shipped dependency graph

**Evidence.** `content/ascent-editor.js` bundles CodeMirror/Lezer and
TipTap/ProseMirror through `src/reports/report-md-editor.js` and
`src/reports/report-rich-editor.js`. `scripts/build.mjs` sets
`legalComments: 'none'`; `scripts/build-config.mjs` copies notices only for five
other runtime packages. `ACKNOWLEDGEMENTS.md` labels CodeMirror and TipTap MIT
without retaining their copyright and permission notices, and generated AMO
metadata omits these dependency families. The complete, distinct notices are
present in their installed packages but absent from `dist/`.

**Remediation.** Generate a deterministic `THIRD_PARTY_NOTICES.txt` from the
esbuild metafiles plus separately copied runtime inputs. Normalize packages to
their owning package root, record version and license source, retain the full
required notice text, package the artifact, and reference it from
`ACKNOWLEDGEMENTS.md` and AMO reviewer metadata. Fail closed when a shipped npm
package has no resolved notice. Keep an explicit reviewed override only for
non-package generated assets.

**Regression proof.** Build the real graph and assert one notice record per
runtime package root, including transitive editor packages, copied MapLibre
artifacts, and worker/shared chunks. Archive tests must require the notice file
and verify that dependency or notice-hash drift cannot silently remove an
entry. The technical gap is confirmed; owner/legal review must still judge
legal sufficiency before release.

## F3 — Verify the exact recursive release archive

**Evidence.** `scripts/verify-release-archive.mjs` (lines 17–49) requires known files
but accepts any entry whose first path component is recognized. The test suite
rejects only an extra top-level `test/` entry. A synthetic otherwise-valid
archive containing `content/private-source.map` passed verification. This is a
verifier defect; no current published archive leak was established.

**Remediation.** Derive the expected recursive file set from the same build
configuration that produces `dist/`: bundle entries, copied files, vendor
artifacts, and enumerated copied directories. Compare normalized archive paths
exactly, reject extra non-directory entries, source maps, duplicate/conflicting
paths, traversal, and platform metadata, and keep manifest-specific Chrome and
Firefox expectations explicit.

**Regression proof.** Add adversarial archives with an extra file under every
allowed directory, `.map` files, duplicate paths, mixed separators, and
file/directory conflicts. Build fresh Chrome and Firefox packages and prove
their complete recursive sets match the clean `dist/` input.

## F4 — Make prepared-draft metrics obey the shared GPX contract

**Evidence.** Capture has a second metric implementation that does not share
the analyzer's segment sequencing, continuity, smoothing, or plausible-elevation
policy:

- `src/capture/capture-core.js` (lines 685–713) filters non-finite elevations out before
  calculating each half-route, bridging across missing samples, and coerces
  absent duration to zero. A probe with elevations `[100, null, 200, 210]` and
  no timestamps produced 110 m of gain and two zero durations; the analyzer
  classified the same elevation as partial and did not claim that gain.
- On the committed four-segment Capitol fixture, the prepared-draft path
  produced 6,369 m gain while `src/gpx/gpx-metrics.js` produced 1,747.89 m for
  the same 2,911 points. Draft distance also differed by about 10.5 m.
- Capture accepts every finite elevation. `[100, 1_000_000_000, 100]` yielded a
  Strong 100 match, `upGainM: 999999900`, and serialized the impossible value;
  the analyzer's maintained range is −1,000…10,000 m.

`src/ascent/ascent-draft.js` writes the capture values into Peakbagger. These
results contradict the single-owner architecture and `docs/gpx-data-quality.md`.

**Remediation.** Put ascent derivation in `src/gpx/gpx-metrics.js`, including
plausible-elevation admission, segment sequencing/continuity, smoothing, and
contiguous-run gain. Use a separate stable working copy for chronological or
metric sequencing; preserve GPX source order for serialized route geometry and
encounter-order semantics. Return nullable values with explicit quality and
completeness. Only fill a Peakbagger field when its required measurements are
complete; otherwise preserve the existing/blank value. Do not substitute zero,
bridge a missing run, silently reorder the route, or present terrain-derived
values as recorded.

**Regression proof.** Add unavailable, partial, gapped, all-equal-time,
reversed/partial-time, impossible-elevation boundary, and complete fixtures to
capture and draft tests. Assert that null results do not overwrite fields and
that suspect elevations do not affect matching, gain, or serialized GPX. Add a
cross-module Capitol parity regression while separately asserting serialized
route/encounter order remains source order.

## F5 — Authenticate terrain activation, not just terrain payloads

**Evidence.** `src/terrain/terrain-map.js` (lines 360–401) accepts the public
`__bpbTerrain` tag from any same-window Peakbagger page script. When the setting
is already enabled, a forged `init` creates the frame and a forged `prefetch`
can warm external tiles without a trusted hover/focus/open action. More
seriously, `manifest.json` (lines 289–299) exposes `terrain/terrain.html` directly to
Peakbagger. The frame accepts any Peakbagger parent with the known
`__bpbTerrainFrame` tag (`src/terrain/terrain-frame-runtime.js`, lines 2046–2055) and
does not recheck the setting or an activation capability before constructing a
MapLibre map backed by Mapterhorn tiles. Chrome's published extension ID is
public in the repository. The direct init can also supply public-HTTPS basemap
templates accepted by `resolveBasemaps()`, turning the frame into an
extension-origin requester for page-chosen providers. The consent button itself
correctly rejects untrusted clicks, but that does not protect these later/direct
entry paths.

This violates `PRIVACY.md` (lines 251–263), which says the feature is off until consent
and prefetch occurs only after explicit hover/focus interaction, never merely
because a map page loaded.

**Remediation.** Make the isolated extension world own a short-lived, one-use
activation capability issued only after a trusted extension-control click or
keyboard action. Bind it to the tab/frame and intended action (`init` or
bounded prefetch), pass it to the extension frame over a private channel, and
reject missing, expired, reused, or mismatched capabilities. The frame must
fail closed on direct embedding and independently verify the feature setting;
known tags, origins, DOM IDs, and payload validation are not authorization.
Remove page-forgeable prefetch or gate it through the same trusted activation.
Bind any page-derived basemap descriptor to that private authorized session and
retain its strict public-HTTPS/schema bounds.

**Regression proof.** In real packaged Chrome and Firefox fixtures, have host
page script forge `requestConsent`, `init`, `prefetch`, and frame messages while
the feature is disabled and enabled; directly embed the web-accessible frame;
call `.click()` synthetically; and replay/expire a captured token. Assert zero
tile/cache/network activity. Then prove trusted keyboard and pointer actions
open the frame once and preserve normal re-entry. Re-run the hardware terrain
suites after the boundary changes.

## F6 — Give the capture/draft lifecycle one generation owner

**Evidence.** Three interleavings share the same missing generation owner:

- `draftOpeningQueues` serializes open operations, but `clearCapture`, alarm
  expiry, and source-tab cleanup delete the same job/drafts outside that queue.
  An open operation can return success with orphan tabs or records.
- `draftReady()` snapshots an old job, awaits multiple draft writes, then calls
  unguarded `updateJob(sourceTabId, { phase: 'previewed', uploadGpx: null })`.
  If a new activity replaced the source-tab job meanwhile, the old GPS Preview
  completion can erase the replacement job's GPX. A job-ID-aware helper already
  exists but is not used there.
- Opening snapshots selected matches before asynchronous tab creation, while
  `applySelection` still accepts writes and popup checkboxes remain enabled.
  Opened tabs can therefore disagree with the stored locked selection.

The 2026-08-03 ledger explicitly deferred the broader open/clear transaction;
its earlier admission and exactly-once fixes did not close these paths.

**Remediation.** Establish one per-source lifecycle queue/generation spanning
selection, Preview completion, validation, tab creation/navigation, draft
registration, clear, source close, tab removal, job replacement, and alarm
expiry. Use job-ID-guarded mutation after every await and revalidate draft
identity inside each mutation. Enter an atomic `opening` phase and disable
selection immediately. Rollback may close/delete only tabs and records created
by that generation and must never restore or mutate newer state.

**Regression proof.** Use controllable barriers at every await to interleave an
old Preview completion with a replacement activity, selection with tab
creation, and clear/source-close/expiry with opening. Assert job ID, phase, GPX,
drafts, selection, and opened tabs stay generation-consistent; no cancelled
generation reports success; no orphan survives; and cleanup is idempotent.

## F7 — Bound and cancel the complete GPX/corridor transaction

**Evidence.** Local upload reads an entire file before parsing; provider capture
reads an entire response body; `src/gpx/gpx-parse.js` feeds the whole string to
`DOMParser` and retains all admitted points. Peakbagger response readers have a
deadline but no kind-specific body cap. Corridor lookup uses four workers and
two attempts per box, but has no hard box/request/total-time budget or caller
abort signal. A valid 20,000-point probe yielded 4,503 boxes: up to 9,006
requests, with a theoretical multi-hour timeout envelope. Cancel prevents late
acceptance but does not abort the background network work.

**Remediation.** Define one documented resource contract for local and provider
GPX byte size, decoded text, parsed points/segments/waypoints, Peakbagger
response size, corridor boxes, concurrent/total requests, and total wall-clock
time. Choose limits from real fixtures and product needs, not arbitrary test
convenience. Enforce byte limits before `DOMParser`, propagate an
`AbortController` from the capture job through every lookup attempt and body
read, and make cancellation/expiry abort the owner immediately. Reject with
actionable copy; do not silently truncate geometry or fabricate a partial
summit result.

**Regression proof.** Test exact limits and limit+1, misleading `Content-Length`,
streaming bodies, decompression expansion, huge point counts, thousands of
boxes, timeout during body read, retry exhaustion, and cancellation at every
stage. Preserve the existing 20,000-point scale intent only if the selected
contract can process it within a bounded request plan.

## F8 — Add store-level concurrency for every photo writer

**Evidence.** `src/photos/photo-store.js` writes whole cleaned photo/bundle
records without an expected revision. The editor's `draftRevision` guards its
own asynchronous queue only. Library deletion/restoration, upload/reference
updates, and backup writers can race that queue, so a stale completion can
erase newer metadata or recreate a record another surface deleted.

**Remediation.** Add a monotonic record revision and compare-and-swap or narrow
command mutations inside one IndexedDB transaction. Represent deletion with a
tombstone/generation that only explicit restore can supersede. Every writer
must declare the revision it observed and surface a conflict instead of using
last-writer-wins; merge only fields with a documented independent owner.

**Regression proof.** Drive two store instances/tabs through delete versus
autosave, reference versus backup-state update, restore versus edit, upload
commit versus metadata edit, and retry after conflict. Assert deletion cannot
be resurrected and independent updates are either preserved or explicitly
rejected.

## F9 — Begin upload state and recovery journal atomically

**Evidence.** `photos/photos.js` first writes a photo with
`remote.state = "uploading"`, then separately writes its operation journal. A
crash between those writes leaves a permanently uploading photo with no
operation for `recoverOperations()` to inspect.

**Remediation.** Add a store-owned `beginUploadOperation()` transaction that
writes the immutable upload snapshot, state transition, and journal together
before network activity. Make every later journal/catalog transition atomic
where they share an invariant. Add a one-time legacy recovery scan for
orphaned `uploading` records; only classify an outcome as unknown when a
request may actually have escaped.

**Regression proof.** Inject failure or abrupt close between every IndexedDB
step and reload. Prove pre-request failures return to a retryable draft,
post-request ambiguity stays explicit, committed uploads stay uploaded, and
recovery is idempotent.

## F10 — Retain report drafts until Peakbagger confirms Save

**Evidence.** `src/reports/report-editor.js` (lines 681–705) sets terminal state and
calls `clearDraft()` on a Save click or submit, before navigation or a server
response. A Peakbagger validation failure or failed navigation can therefore
remove the only recovery copy even though the ascent was not saved. The prior
closure ledger preserved this owner-reviewed behavior as unresolved; it did
not prove it safe.

**Remediation.** Replace terminal deletion with a pending-save record bound to
the ascent identity and source tab. Preserve/refresh it when Peakbagger returns
the edit form with validation errors. Consume it only after the saved-ascent
surface confirms the expected Add/Edit identity through the existing
worker/page handshake. Keep final review and both Save controls entirely
user-owned.

**Regression proof.** Cover server validation round-trips, navigation/network
failure, pagehide before response, duplicate postbacks, Add and Edit success,
identity mismatch, and a user intentionally discarding the draft.

## F11 — Guard lossy report-mode conversion

**Evidence.** `docs/trip-report-editor.md` (lines 256–273) records that unsupported
bracket markup is omitted, unwrapped, or neutralized in Rich/Markdown. Dirty
flags preserve an untouched report, but the first unrelated edit serializes the
entire converted representation. The parser returns no structured diagnostics,
so the UI cannot distinguish a safe normalization from destructive import.

**Remediation.** Extend the bracket parser to return explicit drop/unwrap/
neutralize diagnostics beside the AST. Start lossy reports in Plain, explain
the specific unsupported constructs concisely, and require an explicit
“Convert anyway” action before Rich or Markdown. Do not detect loss by string
comparison; supported aliases and whitespace normalization are intentional.

**Regression proof.** Cover unsupported tags/attributes/nesting, safe legacy
aliases, whitespace-only normalization, mode switching, edit/undo, draft
restore, and an intentional conversion. Visually inspect the guard at narrow
and wide ascent-editor widths.

## F12 — Derive local time only from shared-valid coordinates

**Evidence.** `src/ascent/ascent-upload.js` (lines 71–84) selects the first merely
finite latitude/longitude before route sanitation and derives an unbounded
longitude fallback. The worker/core accept any finite explicit offset in some
paths. A leading longitude of 999 generated a 4,020-minute offset even though
the route sanitizer later removed that point, shifting ascent dates by days.

**Remediation.** Resolve timezone from the first coordinate admitted by the
shared sanitizer and use a trustworthy timed point for the DST reference.
Validate every offset at the worker/core boundary to the civil-time range
`[-14h, +14h]`; on failure use the documented labelled longitude estimate from
a valid point, never the rejected coordinate.

**Regression proof.** Test leading/trailing invalid coordinates, invalid
timestamp locations, antimeridian and ±14-hour boundaries, DST transitions,
all-invalid tracks, and both explicit and parsed out-of-range offsets.

## F13 — Make settings-file import rollback conflict-safe

**Evidence.** `src/background/settings-file-routes.js` (lines 155–225) snapshots three
stores, writes them sequentially, then restores the full old snapshots on
failure. Individual settings writes are queued, but the multi-store import is
not. A normal settings patch or credential change can land after the import's
first write and before its rollback; the rollback then overwrites that newer
user action while reporting that nothing changed.

**Remediation.** Serialize imports as one owner operation and add revisions or
compare-and-swap to settings, ImgBB key, and GitHub auth stores. Roll back a
value only when it still equals the value installed by this import. If a newer
writer won, preserve it and return a truthful rollback-conflict/partial-state
result with recovery guidance; never claim “Nothing was changed.”

**Regression proof.** Interleave ordinary patches, key replacement,
disconnect/reconnect, two imports, validation failure, and rollback failure at
each write boundary. Assert newer state survives and the response describes
the exact committed/rolled-back/conflicted stores.

## F14 — Keep thumbnail rendering failure out of catalog truth

**Evidence.** `photos/photos.js` (lines 1920–1940) handles an `<img>` error for an
uploaded thumbnail by persisting `Library.markUnreachable(item)`. Offline mode,
CSP, a transient CDN error, or one corrupt cached response can therefore make a
temporary rendering failure a durable remote-state/backup change.

**Remediation.** Treat thumbnail error as local, retryable presentation state.
Do not mutate catalog reachability from the browser image element. If remote
health is needed, use an explicit bounded probe with clear status semantics and
keep provider deletion, unknown outcome, and preview unavailability distinct.

**Regression proof.** Simulate offline, CSP refusal, timeout, transient 5xx,
successful retry, and repeated rerender. Assert no catalog or backup mutation
from presentation failure alone.

## F15 — Make every verifier resource failure-safe

**Evidence.** Browser profiles, certificate directories, servers, and child
processes are acquired before outer cleanup scopes in several verifier scripts;
sequential finalizers let one cleanup rejection skip later cleanup. Raw terrain
children lack an immediate error boundary. `scripts/verify-extension.mjs` also
uses a fixed two-second delay before an analyzer readiness snapshot.

**Remediation.** Introduce a shared LIFO resource stack. Register cleanup
immediately after each successful acquisition, run all finalizers independently
while preserving the primary error, attach process error handlers before any
await, and wait for server/process closure before removing owned paths. Replace
fixed sleeps with bounded polling for the final user-visible condition and
report the live value on timeout.

**Regression proof.** Fault-inject invalid browser/OpenSSL paths, certificate
read failure, listen failure, spawn error, assertion failure, hanging process,
and one rejecting finalizer. Delay the analyzer beyond two seconds and prove
the condition-based check passes. After every case, inspect exact owned temp
paths and process command lines and assert none survive.

## F16 — Make Photo Topo editing keyboard-operable

**Evidence.** The viewport is focusable, but rendered annotation groups have no
roles, names, or focusability. Placement and object/vertex selection are
pointer-only; Delete and arrow-key nudging work only after pointer selection.
Existing keyboard tests first create/select the object with a pointer.

**Remediation.** Add a semantic, focusable annotation list synchronized with
canvas selection, a keyboard “Add at center” path followed by existing nudge
controls, and focusable route-vertex controls or an accessible point editor.
Preserve focus and selected state across rerenders without duplicating the
canvas as noisy accessibility content.

**Regression proof.** Exercise keyboard-only add, select, reorder, vertex edit,
nudge, duplicate, and delete, including imported annotations and focus after
undo/rerender. Perform screen-reader and visible keyboard review at the
documented editor viewports.

## F17 — Expose GPX chart data and controls outside the canvas

**Evidence.** The chart canvas advertises only Left/Right navigation and its
live announcement contains point position/coordinates. Elevation, distance,
grade, and clock values live only in the visual tooltip; Chart.js legend
clicks are the only series toggles. Current tests prove traversal/map sync, not
access to the graphed values or dataset controls.

**Remediation.** Render an HTML legend with real buttons and `aria-pressed`.
Use the tooltip's formatting owner to announce active-series values for the
selected point. Provide an expandable semantic data table if point-by-point
equivalence cannot be expressed without overwhelming the live region.

**Regression proof.** Tab/Enter-toggle every series; traverse complete,
partial, coordinate-only, and gapped tracks; assert only trustworthy active
values are announced. Review with a screen reader and keyboard at desktop and
narrow ascent-page widths.

## F18 — Reconcile generated metadata and maintained ownership pointers

This unit contains one reviewer-contract defect and three low-risk drifts that
should be one focused commit after their runtime owners are stable:

- `scripts/create-amo-metadata.mjs` says returning to 2D destroys the renderer;
  runtime and `PRIVACY.md` correctly say it is parked idle for up to five
  minutes. Generate accurate reviewer copy and pin it to the lifecycle
  constant/contract.
- `docs/releasing.md` and a release-workflow comment say `audit:ci` accepts no
  advisories while the script has two exact, expiring dev-only acceptances.
  Defer the prose to generated audit status or structurally test it.
- Maintained terrain documents still assign the renderer implementation to the
  small `src/terrain/terrain-frame.js` entry instead of the new
  `terrain-frame-runtime.js` owner. Update ownership links after F5.
- `.github/dependabot.yml` groups bundled `tz-lookup` as a copied runtime.
  Move it to `bundled-runtime` and test known dependency membership against the
  build configuration.

Do not weaken the exact audit acceptance. If the `image-size` advisories remain
unfixed at expiry, the gate must fail and require a new evidence-based owner
decision.

## F19 — Decode every fixture before privacy scanning

**Evidence.** `test/project/fixtures-privacy.test.mjs` scans only Markdown and
HTML text. The repository also contains a base64-encoded gzip GPX fixture.
Manual decoding found no current banned identifier, so this is a future
regression gap rather than a confirmed leak.

**Remediation and proof.** Maintain a fixture manifest with format and decoder,
decode and scan GPX/XML/encoded fixtures, reject unregistered extensions, and
assert removal of author/creator metadata, track names, disallowed waypoints,
and known personal identifiers. Keep the human sanitation record in the fixture
README, but make executable scanning the release gate.

## F20 — Compare provider identity before comparing URL spelling

**Evidence.** `src/capture/provider-url.js` intentionally canonicalizes Garmin
`/modern/activity/:id` and `/app/activity/:id` as the same activity. The first
worker check in `src/background/background.js` (lines 399–420) instead requires the
current URL string to equal the clicked URL before the later canonical identity
check runs. A normal Garmin redirect between those aliases, or a harmless
query/fragment change, therefore fails `page-changed` even though the provider
and activity ID are unchanged.

**Remediation and proof.** Use the same parsed provider/activity identity at
the first and later worker checks; keep exact scheme/host admission in the
provider URL owner and continue rejecting a different activity ID. Add worker
regressions for both Garmin aliases, query/fragment changes, a different ID,
unsupported host/scheme, and SPA navigation before and after the GPX read.

## F21 — Parse only direct GPX-owned children

**Evidence.** `src/gpx/gpx-parse.js` (lines 13–107) uses descendant searches globally
for `trkseg` and again inside each segment for `trkpt`. A `trkpt` placed inside
`extensions` is admitted as route geometry; a nested `trkseg` point is admitted
once through the parent and again through the nested segment. That can invent
or duplicate lookup boxes, matches, metrics, and draft geometry.

**Remediation.** Traverse the GPX ownership tree directly—root `gpx` to direct
`trk`, direct `trkseg`, and direct `trkpt`, plus direct-root `wpt`—while matching
`localName` for namespace compatibility. Ignore point-like descendants owned by
extensions or unrelated elements. Do not “deduplicate” after broad collection;
that would hide malformed ownership and could erase legitimate repeated points.

**Regression proof.** Add default/prefixed namespace fixtures, extension-owned
fake points, nested segments, wrong-root elements, repeated legitimate points,
multiple tracks, and waypoints in both valid and invalid locations. Assert the
capture, analyzer, and serialized draft all see the same owned geometry.

## Execution order and commit boundaries

Each numbered item below is an independent, verified commit unless a failing
test proves that two owners cannot safely be separated. Do not start the next
unit with a knowingly incomplete previous one.

1. **Repair release truth (F1).** Restore `Unreleased`, add immutable-section and
   tag/HEAD tests, and prove a dry-run bump without creating a tag.
2. **Close distribution gaps (F2, then F3).** Generate/package notices first;
   then make the archive verifier consume the resulting exact build inventory.
   Obtain owner/legal sign-off on the notice artifact before release.
3. **Restore GPX truth (F21, F4, then F12).** Fix structural ownership first,
   then land shared quality-aware draft metrics and timezone validation so one
   parity matrix owns every admitted point and derived field.
4. **Close terrain authorization (F5).** Treat this as a privacy-boundary change;
   run unit, packaged-browser, and both hardware terrain suites before moving on.
5. **Repair provider/lifecycle transactions (F20, F6, F7).** Canonicalize the
   clicked identity, give capture/drafts one abortable generation owner, then
   impose measured resource budgets through that owner.
6. **Repair photo persistence (F8, F9, F14).** Add store revisions/tombstones,
   make upload start atomic on that model, then remove presentation-driven
   catalog mutation.
7. **Repair report/settings recovery (F10, F11, F13).** Retain drafts through
   confirmation, add lossy-conversion diagnostics, and make multi-store import
   conflict-safe.
8. **Complete keyboard equivalents (F16, F17).** Keep behavior and visual/
   assistive-technology verification separate and explicit.
9. **Harden verification and maintenance (F15, F18, F19).** Fault-test cleanup,
   then update generated metadata/docs/dependency grouping and fixture scanning.
10. **Release rehearsal.** Run all gates below from a clean tree, inspect fresh
    packages and notice inventory, and do not tag until every release blocker is
    fixed and fully proven or explicitly waived by the owner.

## Final verification matrix

The closeout required the following checks and explicit gap classification:

- focused tests beside every changed owner, then `npm test`, `npm run lint:js`,
  `npm run lint`, `npm run audit:ci`, and `npm run test:scale`;
- `npm run verify:browsers` hidden against the real unpacked extension;
- `npm run terrain:verify` and `npm run terrain:verify:firefox` hidden on a
  reported hardware renderer, including forged-message/direct-frame negatives;
- visible isolated-profile keyboard and screen-reader checks for F11, F16, and
  F17 at the maintained narrow and wide viewports, without disturbing the
  user's normal browser;
- fresh Chrome and Firefox packages, exact recursive archive verification,
  packaged execution, generated notice inspection, and AMO metadata review;
- live, minimal, read-only Garmin/Strava and Peakbagger checks where credentials
  are available, plus explicit confirmation that cancellation stops in-flight
  lookup work; and
- teardown inspection of exact disposable profile/certificate paths and
  process command lines after success and injected failure.

No hidden or fixture check can establish native permission-prompt appearance,
toolbar focus, touch behavior, physical-device behavior, live provider
availability, or store acceptance. Keep those as proof gaps unless they are
actually exercised.

## Closure ledger

### Fixed and verified

- **F1 — immutable release history (`8dbc3d3`):** `CHANGELOG.md`, the release
  bump/check scripts, and release CI now keep tagged sections byte-faithful,
  maintain `Unreleased`, and bind a final tag to `HEAD`. The 24 focused release
  tests, `release:check-history` over nine sections, a 3.5.0 dry run,
  `lint:js`, and `git diff --check` passed.
- **F2 — complete notices (`447e6a8`):** the release build now derives
  `THIRD_PARTY_NOTICES.txt` from esbuild metafiles and copied runtime inputs,
  packages it, hashes it, and fails closed on missing package metadata or
  notice text. `build:release`, 27 focused release tests, `lint:js`, and
  `git diff --check` passed.
- **F3 — exact recursive archives (`bd537d6`):** the archive owner now compares
  the complete normalized file set and validates ZIP records before extraction.
  Twenty-nine focused release tests and `lint:js` passed; fresh Chrome and
  Firefox archives each passed exact verification at 66 entries.
- **F4 — shared prepared-draft metrics (`2c6ef50`):** `gpx-metrics`, capture,
  reduction, serialization, and draft filling now share plausible-elevation,
  continuity, quality, and nullable-completeness rules while preserving source
  order. `npm test` passed 1,238 tests, the five-test scale suite passed, and
  hidden Chrome/Firefox packaged-browser verification passed.
- **F5 — authenticated terrain activation (`67f8bb7`):** the isolated bridge,
  worker, and frame runtime now require a short-lived one-use capability and an
  independent feature-gate check. Forged, replayed, expired, mismatched,
  synthetic-click, and direct-frame regressions passed in 1,247 unit tests,
  hidden Chrome/Firefox, hidden Metal Chrome terrain, hidden Firefox terrain,
  and the hidden terrain LOD suite.
- **F6 — generation-owned draft lifecycle (`9e56946`):** the background owner
  and popup now serialize selection, opening, Preview completion, replacement,
  cleanup, expiry, and rollback under one source-tab generation. Barrier and
  identity regressions passed in 1,260 unit tests, `lint`, and hidden Chrome and
  Firefox extension verification.
- **F7 — bounded, cancelable capture (`b28efec`):** provider/local GPX,
  parsing, Peakbagger bodies, corridor work, retries, requests, and wall time
  now obey one resource contract with generation-owned abort signals. Exact
  limit, limit+1, streaming, retry, timeout, and cancellation regressions passed
  in 1,276 unit tests, six scale tests, `lint`, and hidden Chrome/Firefox.
- **F8 — photo-store concurrency (`4b14458`):** the photo store and every writer
  now use monotonic revisions, transactional compare-and-swap mutations, and
  tombstone generations. Cross-store delete/edit, restore/edit, upload/edit,
  reference/backup, and retry conflicts passed in 1,280 unit tests and 48 final
  affected photo tests; `lint:js` and `git diff --check` passed.
- **F9 — atomic upload journal (`d7c63a2`):** upload start, catalog state, and
  recovery operation are one IndexedDB transaction; provider-result commit and
  definite pre-response recovery are likewise atomic. Failure-boundary,
  ambiguous-result, legacy repair, and idempotence cases passed in 1,282 unit
  tests, 48 focused photo tests, `lint:js`, and `git diff --check`.
- **F10 — confirmed report-draft consumption (`2ff4a6f`):** report Save now
  creates a tab/identity-bound pending intent, and only the saved-ascent surface
  can consume the matching attempt. Validation, navigation, identity,
  replacement-draft, discard, and Delete regressions passed in 1,294 unit tests
  and hidden Chrome verification; `lint:js` passed.
- **F11 — guarded lossy conversion (`70a6c47`):** bracket parsing now returns
  structured diagnostics, affected reports remain Plain, and Rich/Markdown
  require an explicit **Convert anyway** action. Unsupported/safe markup,
  restore, conversion, and wide/narrow layout cases passed in 1,299 unit tests
  and hidden Chrome; 440 px and wide element screenshots were inspected.
- **F12 — valid local-time inputs (`b420622`):** ascent upload and shared
  metrics now resolve timezones only from admitted coordinates/timestamps and
  enforce the civil ±14-hour boundary at every handoff. Invalid leading and
  trailing points, DST, antimeridian, parsed offsets, and all-invalid cases
  passed in 1,243 unit tests, `lint`, hidden Chrome, and hidden Firefox.
- **F13 — conflict-safe settings rollback (`124baa8`):** settings-file imports
  now serialize through one owner and use queued compare-and-swap restoration
  across settings, ImgBB credentials, and GitHub auth with truthful per-store
  results. Interleaved patch/key/auth/import and rollback-failure cases passed
  in 1,310 unit tests, `lint`, and hidden Chrome.
- **F14 — transient thumbnail presentation (`aae51df`):** image-render failure
  now stays card-local and cannot rewrite catalog reachability or enqueue a
  backup. Offline/CSP/timeout/provider/retry/rerender cases passed in 135 photo
  tests plus the repeated-error regression; `lint:js` and `git diff --check`
  passed.
- **F15 — failure-safe verifiers (`5a98bd6`):** verifier certificates, servers,
  profiles, browsers, children, and directories now use a timeout-bounded LIFO
  resource stack whose finalizers run independently. The analyzer waits on its
  final condition. Forty-eight resource/release/showcase tests, 1,325 total
  tests, delayed-analyzer Chrome, Firefox, Chrome terrain, terrain LOD, Firefox
  terrain, and invalid-browser fault injection passed with no owned residue.
- **F16 — keyboard-operable Photo Topos (`e69e4e4`):** the photo editor now owns
  a semantic annotation list, focusable route points, center placement, and
  rerender-stable selection/focus. Keyboard-only behavior passed in 1,313 unit
  tests, 69 focused photo tests, `lint`, and hidden Chrome at desktop and 520 px;
  both screenshots were inspected.
- **F17 — semantic GPX chart controls (`35a5319`):** the analyzer now renders
  pressed HTML series buttons and announces trustworthy active values through
  the shared tooltip formatter. Complete, partial, coordinate-only, gapped,
  toggle, and stale-selection cases passed in 1,315 unit tests, 39 focused
  GPX/contrast tests, `lint`, and hidden Chrome at 800 px and 440 px; both
  screenshots were inspected.
- **F18 — maintained metadata (`cb14f3a`):** terrain keep-alive now has one
  runtime/reviewer-metadata constant; maintained owner pointers and exact audit
  acceptance prose match source; Dependabot grouping is checked against the
  build graph. Eighty-six focused project/terrain tests, 1,328 total tests,
  `lint:js`, `audit:ci`, hidden Chrome/Firefox, and `git diff --check` passed.
- **F19 — decoded fixture privacy (`12fad26`):** every supported fixture suffix
  now has an explicit format and decoder; the scanner examines decoded content
  and rejects unregistered formats, malformed encoding, identity metadata,
  track names, routes, and waypoints. Seven focused privacy tests, 1,329 total
  tests, `lint:js`, and `git diff --check` passed.
- **F20 — canonical provider identity (`8891125`):** the shared provider URL
  owner now compares HTTPS provider/activity identity before URL spelling, so
  Garmin aliases and harmless decoration work while hostile or changed
  activities fail closed. Seventy-one provider/page/worker tests, `build`, and
  `lint:js` passed.
- **F21 — direct GPX ownership (`bee3314`):** the parser now walks direct
  local-name children, preserving valid namespaces, tracks, segments, repeated
  points, and source order while excluding extension-owned or misplaced
  geometry. Thirty-two parser/provider tests, 68 focused upload/analyzer tests,
  `build`, `lint:js`, and `git diff --check` passed.

Final combined-tree verification recorded before archival:

- `npm test`: **1,329 passed, 0 failed**; `npm run lint:js` passed.
- `npm run lint`: passed with the eight exact owner-reviewed warnings; no new
  error, notice, warning kind, file, or count was accepted.
- `npm run audit:ci`: passed only the two exact high `image-size` advisories in
  the development-only `web-ext`/`addons-linter` path through 2026-08-21.
- `npm run test:scale`: **6 passed**, including the bounded 20,000-point case,
  its contract+1 rejection, 1,500 favorites, and 1,200 photos.
- `npm run verify:browsers`: passed against the real unpacked extension in
  hidden Chrome for Testing new-headless and hidden Firefox 153.0.3 at
  1000×760. `npm run verify:packages` then passed both fresh minified archives.
- `npm run terrain:verify`: passed hidden at 798×448 and 448×448 on `ANGLE
  Metal Renderer: Apple M3 Pro`; `npm run terrain:verify:firefox` passed hidden
  at 1000×760 on its reported Apple hardware renderer.
- Fresh Chrome and Firefox archives each passed exact recursive verification at
  66 entries, including the generated notice inventory. Nine immutable
  changelog sections passed `release:check-history`.
- Final process/profile inspection found no verifier-owned process or disposable
  profile; the generated terrain screenshot directory was removed after review.

### Intentionally not changed

- The two exact dev-only `image-size` advisories remain accepted only through
  2026-08-21. The script still fails every other finding and will fail closed
  when the acceptance expires; this remediation did not widen or renew it.
- Final Peakbagger review and both Save controls remain user-owned. No extension
  or verifier path clicks Save merely to prove report-draft consumption.
- No version bump, release tag, store submission, push, or Dependabot policy
  expansion was performed. `Unreleased` remains the source for the eventual
  next version, and MapLibre still requires the documented hardware release
  rehearsal even when its update is otherwise auto-merge eligible.
- Deeply arbitrary timestamp permutations remain governed by the documented
  source-order/quality contract rather than silent global sorting. Missing,
  reversed, or non-progressing time now degrades derived fields honestly.
- The cleaned non-secret page-world settings projection was not narrowed; the
  privileged credential and extension-messaging boundary remains unchanged.

### Changed but not fully proven

- **F2:** the generated inventory proves packaged dependency coverage and
  retained notice text, not legal sufficiency. Owner or counsel review remains
  required before release.
- **F5, F7, F14, and F20:** synthetic fixtures and isolated browsers proved
  authorization, cancellation, failure, and provider-identity behavior. No
  authenticated live Garmin/Strava capture, live Peakbagger corridor run, or
  live tile/CDN outage was exercised.
- **F6, F8, and F9:** controllable interleavings and real IndexedDB transactions
  prove the owned generation/revision/atomicity contracts while the browser is
  running. An actual browser or OS crash at each persistence boundary was not
  induced, so storage durability under abrupt shutdown remains outside this
  evidence.
- **F10:** failure and confirmation handshakes are covered, but an actual
  Peakbagger Save was deliberately not automated. Live Add/Edit validation and
  success remain release-manual checks.
- **F11, F16, and F17:** semantic DOM, keyboard interaction, live-region values,
  focus, contrast, and narrow/wide screenshots passed. Native screen-reader
  speech, touch, switch control, and physical-device behavior were not tested.
- The terrain suites used hardware renderers with synthetic DEM, basemap,
  route, and Peakbagger responses. They do not establish live Mapterhorn/drape
  availability or every physical GPU/driver combination.
- All browser runs were hidden and isolated. They do not prove native toolbar
  `activeTab` grant UI, permission prompts, browser chrome, focus, window
  placement, or visible challenge handling.
- Fresh unsigned packages booted and matched the exact source inventory. AMO,
  Chrome Web Store, signature, reviewer, and post-publication behavior remain
  untested because no release or store submission was authorized.

## Reconciled non-findings and accepted risks

- The ten issues in the 2026-08-03 ledger remain closed by current source and
  tests. F6 through F10 include broader risks that ledger explicitly left
  unresolved; F6 also records newly established replacement-job and selection
  interleavings. They are not regressions attributed to the earlier fixes.
- Manifest permissions, execution worlds, separately loaded script order, the
  shared Chrome/Firefox worker bundle, and the local MapLibre module/worker
  layout matched their maintained build configuration and structural tests.
- The release workflow remains SHA-pinned and scopes store credentials to the
  release jobs. No untrusted Dependabot PR checkout was found in the privileged
  auto-merge workflow.
- `audit:ci` currently accepts exactly two high advisories on one dev-only path,
  with pinned identities/versions/path and expiry. The stale prose is F18; the
  bounded implementation is not weakened by this plan.
- MapLibre remains eligible for verified auto-merge while required CI does not
  render its native frame. The maintained release process treats hardware
  terrain rehearsal as the final gate. If the owner wants every green `main` to
  prove renderer boot, add an offline native module/worker smoke or remove
  MapLibre from unattended merging; do not claim the current CI proves it.
