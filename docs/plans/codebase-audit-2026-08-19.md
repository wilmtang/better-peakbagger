# Code, performance, and UX audit — 2026-08-19

Status: **active remediation plan.** This audit found four P1 findings, five P2
findings, and five P3 findings. It is a source-grounded plan, not an
implementation: no runtime, build, manifest, dependency, or product-copy change
was made as part of the audit.

Baseline: clean local `main` at `35e4b868`, 12 commits ahead of `origin/main`.
This pass reconciled the current tree with the completed
[2026-08-12 code/performance/UX audit](../archive/codebase-audit-2026-08-12.md)
and the [2026-08-08 UX/engineering audit](../archive/ux-engineering-audit-2026-08-08.md).
Previously closed findings stay closed unless current source or a deterministic
probe below disproves the archived invariant.

## Scope and evidence

The review covered all 110 files under `src/`, 16 under `options/`, three under
`popup/`, five under `photos/`, 44 build/release files under `scripts/`, the four
GitHub workflow files, and 141 test files. It traced activity capture, temporary
Peakbagger page transport, local-GPX processing, prepared-draft application,
GPX/timezone analysis, terrain messaging and caching, ascent filtering, GitHub
ascent and photo recovery, Photo Topos editing, options-page status, watch
builds, dependency policy, and Firefox reviewer metadata.

Current-turn verification established this baseline:

- `npm test`: **1,519 passed, 0 failed** after rebuilding all 28 shipped
  bundles in `dist/`.
- `npm run lint`: passed with the eight repository-owned warnings: one
  cross-browser service-worker warning, five MapLibre warnings, one
  ProseMirror warning, and one TipTap warning.
- `npm run test:scale`: **6 passed, 0 failed** across the 4,145-row Rainier
  ascent table, 1,500 favorites, a 20,000-point provider track and contract+1
  rejection, and a 1,200-photo library. The ascent-table case asserts
  completeness but has no interaction-performance budget.
- `npm run audit:ci`: passed only because it accepts the two exact high
  `image-size` advisories in the development-only `web-ext`/`addons-linter`
  path through 2026-08-21. `npm audit --omit=dev --json` reported zero
  production vulnerabilities; this is not a clean full dependency graph.
- A 1,600,000-byte recovery document expands to a 2,133,370-byte GitHub JSON
  blob response, deterministically exceeding the current 2,097,152-byte
  transport ceiling.
- Controlled built-bundle and harness probes reproduced untrusted DOM events
  reaching tab creation and GitHub writes, cancellation leaving a page bridge
  pending, activate-then-leave helper-tab deletion, stale draft form mutation,
  wrong-origin terrain-frame replies, a trailhead/summit timezone mismatch,
  duplicate concurrent DEM fetches, native text Undo interception, and 4,220
  style writes for one threshold input on the scale fixture.

No browser window was launched. Unit, lint, scale, and deterministic harness
evidence do not prove native modifier/focus behavior, visible layout, browser
chrome, screen-reader speech, touch, physical devices, live
Garmin/Strava/Peakbagger/GitHub/ImgBB/OpenFreeMap/Mapterhorn behavior, abrupt
process loss, AMO review, legal sufficiency, or store acceptance.

## Priority summary

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | P1 | trusted actions | host-page scripts can synthesize extension UI actions that create tabs or commit ascent backups to GitHub |
| F2 | P1 | capture lifecycle | page-bridge setup is unbounded, cancellation can leave work pending, and helper-tab adoption is inferred only from final active state |
| F3 | P1 | prepared drafts | a stale draft fills fields and attaches GPX before the worker grants the final preview claim |
| F4 | P1 | photo recovery | valid photo libraries become unreadable far below the advertised 8 MiB recovery limit |
| F5 | P2 | local-GPX privacy | file name and browser metadata cross to the worker and persist despite the public analysis-only contract |
| F6 | P2 | terrain trust | the terrain bridge accepts same-window replies from the wrong frame origin |
| F7 | P2 | mountain time | a partial-timestamp track can choose the first timed point's timezone instead of the trailhead's |
| F8 | P2 | Photo Topos UX | Cmd/Ctrl+Z in text fields mutates annotation history instead of preserving native text Undo |
| F9 | P2 | backup status UX | returning from My Ascents can leave the Settings backup count stale indefinitely |
| F10 | P3 | backup progress UX | the slow-operation notice starts only after up to two bounded Peakbagger reads |
| F11 | P3 | terrain performance | concurrent identical DEM consumers download and validate the same tile independently |
| F12 | P3 | filter performance | every threshold keystroke rewrites every ascent row and year section, including unchanged states |
| F13 | P3 | watch engineering | failed watch generations can leave a mixed on-disk `dist/` despite withholding the reload signal |
| F14 | P3 | AMO metadata | Firefox reviewer notes omit the authored `photos/` runtime source root |

P1 means a material authorization, recovery, cancellation, or form-mutation
invariant is broken. P2 is bounded but user-visible correctness, privacy, trust,
or interaction debt. P3 is performance, feedback, or release-engineering debt
without demonstrated data loss. Severity measures impact and urgency, not
implementation effort.

---

## F1 — Require trusted activation for host-page actions with external effects

**Broken invariant.** Peakbagger's page scripts may observe and alter the shared
DOM, but they must not be able to turn synthetic DOM events into extension tab
creation or GitHub mutations. Native link modifiers must also retain their
expected foreground/background behavior.

**Evidence.** The individual ascent-backup button calls `runBackup()` without
checking the event at `src/ascent/ascent-backup.js` (lines 39–45 and 68–71), and
the manual path reaches `GITHUB_BACKUP_ASCENT` at lines 134–153. The profile
surface uses the same event-blind button helper and starts one or many GitHub
batches in `src/profile/profile-backup.js` (lines 31–33, 69–87, and 418–452).
The worker checks the Peakbagger sender and payload identities, but not a user
activation, in `src/background/github-routes.js` (lines 863–902 and 944–994).

This is not theoretical test-only behavior. `test/ascent/ascent-backup.test.mjs`
(lines 107–131) dispatches an untrusted `Event('click')` and reaches the backup
route. `test/profile/profile-backup.test.mjs` (lines 376–415) calls `.click()`
and commits a profile batch. Because the listener executes in the isolated
content-script world, the resulting runtime message appears to come from the
extension even though the shared-DOM stimulus came from the host page.

The new Has beta Settings link repeats the confused-deputy pattern.
`src/ascent/ascent-filter.js` (lines 981–997) accepts synthetic click and
middle-click events, prevents their native default, discards modifier intent,
and sends `OPEN_BETA_SETTINGS`. `src/background/background.js` (lines
2318–2334) creates a fresh active tab every time. Two programmatic clicks
produced two worker messages; Ctrl/Cmd/middle activation was also prevented and
relabelled as the same foreground action.

**Remediation.** Create one reusable trusted-action boundary modeled on the
terrain activation capability. The isolated-world listener must require
`event.isTrusted`, mint a short-lived, one-use capability tied to tab, action,
and generation, and the worker must consume that capability before a manual
GitHub write or browser-side navigation. Keep automatic ascent backup separate:
it is already explicit opt-in and must remain gated by a fresh save snapshot,
not by a fabricated click.

For Settings navigation, carry the user's foreground/background/new-window
intent, and make the worker reuse or focus the exact existing options tab
instead of creating duplicates. If native link semantics cannot be preserved
through messaging in both browsers, expose a button with honest behavior rather
than a link that contradicts the browser convention.

**Regression proof.** Synthetic `.click()`, dispatched click/auxclick, and host
page event loops must create no tab and no GitHub mutation. Cover trusted
keyboard and pointer activation, token expiry/replay, tab navigation, worker
restart, rapid double activation, automatic backup after a fresh save, profile
refresh confirmation, and cancellation. In hidden Chrome and Firefox, verify
primary, Ctrl/Cmd, Shift, and middle activation plus exact Settings-tab reuse.
Native focus and browser-chrome behavior remain visible/manual proof.

## F2 — Make temporary Peakbagger page access a bounded, durable lease

**Broken invariant.** Cancel must settle every owned capture operation promptly,
and a temporary tab the user ever adopts must never later be closed as extension
scratch space.

**Evidence.** `ensurePeakbaggerPage()` and `readFreshPeakbaggerAccount()` await
`scripting.executeScript()` directly in `src/background/background.js` (lines
285–332). The request bridge at lines 428–489 races an in-page request against
explicit cancellation, but its injection/probe/account-evidence setup has no
equivalent cancellation race or operation deadline. The page fetch has its own
15-second bound; that bound cannot help if execution never starts or the target
renderer never returns the script result.

The cancellation route removes the job and reports success at
`src/background/background.js` (lines 1178–1205), even when capture remains
stuck in one of those earlier awaits. A controlled stalled account-evidence
probe returned a successful Cancel response while the start promise and helper
tab remained pending.

Temporary-tab ownership is an in-memory `Set` at line 70. Cleanup at lines
335–349 closes the tab whenever it is inactive *at release time*. Its comment
says selecting the helper transfers ownership, but a probe that selected the
helper and then returned to the activity tab finished with the helper removed.
The existing test at `test/background/background-capture.test.mjs` (lines
916–930) covers only a helper that remains active through cleanup.

**Remediation.** Wrap every probe, injection, account-evidence call, and page
request in one owned operation primitive with an explicit deadline, caller
abort race, late-result suppression, and typed public failure. Cancellation
must invalidate the generation, stop awaiting the browser operation, request
best-effort in-page cancellation when an ID exists, and release or transfer the
helper lease without waiting for a hung script result.

Persist a narrow helper lease in `storage.session`: tab ID, capture generation,
creation time, expected canonical URL, and an `adopted` bit. Observe
`tabs.onActivated` and relevant navigation events; once adopted or navigated,
the lease may never delete that tab. On worker restart, clean only expired,
unadopted, exact-match leases. Any ambiguity fails open by leaving the tab.

**Regression proof.** Stall each executeScript phase before and after dispatch,
then cancel, close the source tab, retry, expire the job, and restart the worker.
Assert prompt settlement, no late job resurrection, no unhandled rejection, and
bounded cleanup. Exercise never-selected, selected-and-still-active,
selected-then-left, navigated, closed, ID-reused, and restart-recovered helper
tabs. A real hidden-browser check must use the actual MV3 worker and unpacked
extension; it still cannot prove visible focus.

## F3 — Claim prepared drafts before mutating the Peakbagger form

**Broken invariant.** A draft that is cleared, expired, superseded, or no longer
first in sequence must not change any host form field or selected upload file.

**Evidence.** `DRAFT_READY` returns the apply payload from
`src/background/background.js` (lines 2107–2142), but no exclusive apply lease
is committed. The page then fills fields and attaches the reduced GPX in
`src/ascent/ascent-draft.js` (lines 339–357) before sending
`DRAFT_PREVIEW_STARTED`. Only that later message rechecks freshness, ordering,
identity, and exactly-once state in `src/background/background.js` (lines
2153–2171).

A controlled acknowledgment `{ok:false}` left the date and suffix filled and
one GPX file attached, even though preview did not start. The archived worker
serialization fix prevents stale state transitions inside the worker; it does
not make the preceding page mutation transactional.

**Remediation.** Replace the one-way ready/ack sequence with a short-lived,
generation-owned apply lease. The page must snapshot every field/file it may
change, obtain the lease immediately before mutation, and confirm completion
before GPS Preview. Clear, expiry, source replacement, or ordering changes must
invalidate the lease and notify the page. On rejection or invalidation, restore
only values still owned by that lease so newer user edits are never overwritten.
If the page disappears after claiming, the lease must expire and allow safe
recovery. Preserve the hard rule that the extension never clicks Save.

**Regression proof.** Add barriers after ready, before claim, after claim, after
each field group, after GPX attachment, and before Preview. At every boundary,
clear, expire, replace, close, edit manually, or advance another draft. Prove
either one complete owned apply followed by exactly one Preview, or exact
rollback with no Save and no clobbered user edit. Include worker restart and a
content-script teardown between lease and confirmation.

## F4 — Make the 8 MiB photo-recovery limit reachable end to end

**Broken invariant.** Every photo-recovery document accepted by the canonical
8 MiB writer must be readable by update, preview, and restore paths.

**Evidence.** `src/photos/photo-backup.js` (lines 9–12 and 155–171) allows a
canonical `photo-library.json` through 8 MiB. Semantic conflict-safe updates
read the current root blob through `readBlobText()` in
`src/github/github-client.js` (lines 248–255 and 583–603). The transport assigns
special limits only to tree and Contents endpoints; `/git/blobs/{sha}` receives
the 2 MiB default JSON ceiling in `src/github/github-api.js` (lines 17–22 and
176–200). Base64 expansion makes a 1,600,000-byte source produce a
2,133,370-byte response, so a valid library already fails before merge.

Preview and restore instead call the Contents endpoint through
`src/github/github-client.js` (lines 487–499) and
`src/background/github-routes.js` (lines 1514–1523 and 1551–1564). GitHub's
[repository Contents contract](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content)
supports the ordinary representation only through 1 MiB; 1–100 MiB files
require raw or object media, and object media does not carry the content inline.
The [Git blobs contract](https://docs.github.com/en/rest/git/blobs?apiVersion=2022-11-28#get-a-blob)
supports raw blob media and documents a 100 MiB endpoint maximum.

**Remediation.** Give recovery root files one transport contract. Resolve the
root blob SHA, request raw blob media, stream through an 8 MiB decoded-byte and
UTF-8 character ceiling, and parse only after the bound succeeds. If JSON
base64 remains supported as a compatibility fallback, give it an explicit
encoded-envelope budget derived from the same decoded limit and verify the
declared GitHub `size`; do not silently raise the global API limit. Use this
same reader for merge retries, preview, and restore.

**Regression proof.** Exercise all three operations at 1 MiB, 1 MiB+1,
1.6 MiB, exactly 8 MiB, and 8 MiB+1. Cover raw media, JSON base64, object media
with `encoding: "none"`, dishonest size/length, malformed UTF-8, stalled and
oversized streams, branch movement, conflict-retry rereads, and restore
signature change. A live authenticated GitHub test is a separate, explicitly
authorized remote read/write check.

## F5 — Keep local file metadata on the page

**Broken invariant.** The local-GPX worker boundary may receive only the
allowlisted analysis fields promised publicly; local filenames and browser file
metadata are not analysis inputs and must remain on the page.

**Evidence.** `src/ascent/ascent-upload.js` (lines 145–170) derives the selected
file's name, size, modification time, and media type and includes them in every
selection message, including the processing request at lines 490–516.
`src/background/background.js` (lines 1687–1744 and 1777–1793) validates and
persists that object in the 30-minute session job. Tests intentionally assert
persisted names in `test/background/background-gpx-process.test.mjs` (lines
420–505).

`PRIVACY.md` (lines 99–115) says raw XML remains on the page and only
trackpoints, allowlisted waypoints, and the optional track name reach the
worker. A filename can contain a person's name, route, date, or local folder
convention, so this is a substantive contract mismatch even though the raw
file bytes remain page-owned.

**Remediation.** Replace `fileIdentity` with a random opaque selection nonce
generated per page selection. Bind worker state and replies to the existing
page-session ID, monotonic selection generation, and nonce; keep filename,
size, modification time, and media type solely in page memory for local UX.
Worker restart reconstruction must preserve only the opaque binding, not invent
a need for file metadata.

**Regression proof.** Select files whose names and metadata contain unique
sentinels; inspect every runtime message, `storage.session` record, public
response, log, and drafted payload and prove the sentinels never cross. Retain
all current A/B selection, invalidation, cancellation, restart, re-pick, drop,
and stale-result tests using opaque nonces.

## F6 — Authenticate every terrain-frame reply by source and origin

**Broken invariant.** Only the packaged terrain document may drive terrain
lifecycle, camera, peaks, exit, or error state.

**Evidence.** `src/terrain/terrain-map.js` (lines 114–121) derives the exact
extension frame origin and claims replies are pinned to it. The actual reply
guard at lines 480–481 checks only `event.source === frame.contentWindow`, the
message tag, and direction. It never checks `event.origin`. WindowProxy identity
survives iframe navigation, so source equality does not identify the current
document. A forged same-window `loaded` reply from another origin made the
frame interactive and relayed loaded metrics through lines 488–507.

Outbound init/resume messages still use the exact extension target origin, so
this finding does not show route disclosure and does not reopen the archived
outbound privacy fix. It does let a navigated document corrupt the 2D/3D state
machine or make itself the interactive overlay.

**Remediation.** Require `event.origin === frameOrigin()` before processing any
frame reply, and bind replies to the current frame generation as well as the
WindowProxy. Treat unexpected navigation/origin as an invalid frame: ignore it
until the bounded boot deadline restores 2D, or tear it down immediately. Never
forward an unvalidated error reason, camera, bounds, or layout metric.

**Regression proof.** From the same `contentWindow`, send wrong-origin `ready`,
`loaded`, `camera`, `metrics`, `view`, `peaksRequest`, `exit`, and `error`
messages. None may alter frame styles, hide 2D, contact Peakbagger, or reach the
page coordinator. Correct-origin messages for the current generation must
continue to work; stale messages from a replaced frame must not.

## F7 — Derive mountain time from the route start even when it is untimed

**Broken invariant.** Timestamp availability determines which clock data can be
shown; it must not change which coordinate owns the trip's civil timezone.

**Evidence.** `docs/mountain-local-time.md` (lines 12–33) deliberately assigns
timezone ownership to the track's starting coordinate, including the Everest
Nepal/China border example. `src/gpx/gpx-analyzer.js` (lines 1501–1519) instead
selects `metrics.timePoints[0]` whenever usable timing exists. In partial timing,
`src/gpx/gpx-metrics.js` (lines 355–389 and 543–584) omits an untimed first
route point from `timePoints` while still classifying later progressing
timestamps as usable.

An untimed Nepal-side route start followed by two timed China-side points
rendered GMT+8 instead of Asia/Kathmandu/GMT+5:45, shifting displayed clock time
by 2 hours 15 minutes. Current partial-time tests remove a middle timestamp;
they do not cover an untimed trailhead in another zone.

**Remediation.** Select the timezone coordinate from the first point of the
safely sequenced route, independent of `timeState`. Preserve whole-segment
chronological sequencing for genuinely reversed complete GPX segments, map
source order, the offline `tz-lookup` boundary, and the labelled longitude
fallback.

**Regression proof.** Cover a missing and invalid first timestamp in one zone
with the first valid timestamp in another. Assert timezone label, start/summit/
return clocks, day boundaries, and camping inference. Retain reversed complete
multi-segment coverage and add a border case where segment sequencing, not
individual-point sorting, owns the route start.

## F8 — Preserve native Undo in Photo Topos text controls

**Broken invariant.** Editor-wide shortcuts must not override native editing
semantics while focus is in an editable control.

**Evidence.** `photos/photos.js` (lines 2826–2840) computes whether the target is
an input, textarea, or select, but handles Cmd/Ctrl+Z first. The handler prevents
the event and calls annotation `undo()` or `redo()` before reaching the editing
guard. Title, alternative text, and annotation text therefore lose native text
Undo and can unexpectedly change the topo drawing.

**Remediation.** Resolve the composed event target first and return for input,
textarea, select, or contenteditable descendants before any editor-wide
shortcut. Keep annotation Undo/Redo active from the canvas and non-editable
chrome, including platform-specific Cmd/Ctrl+Shift+Z behavior.

**Regression proof.** Dispatch cancelable Mod+Z and Mod+Shift+Z from title, alt,
inspector text, select, range, and a nested/contenteditable target. Assert the
event remains available to the native control and annotation history is
unchanged. From the canvas and toolbar, prove one exact annotation Undo/Redo and
no browser command leakage.

## F9 — Refresh the ascent-backup summary after the workflow it describes

**Broken invariant.** Returning from the recommended My Ascents bulk-backup
workflow must eventually show a current repository-backed count without making
every ordinary focus event flash or call GitHub.

**Evidence.** `options/github.js` (lines 59–69) gives the summary a 60-second
TTL, but that freshness check runs only during panel rendering at lines
380–389. `openMyAscents()` at lines 335–355 opens Peakbagger without arming a
return refresh. The focus listener at lines 627–638 is intentionally restricted
to GitHub authorization/repository trips. As a result, the existing test at
`test/options/options-github.test.mjs` (lines 1174–1210) proves repeated focus
leaves “No ascents backed up yet,” while `docs/github-ascent-backup.md` (lines
321–325) promises refresh on return.

**Remediation.** Arm a distinct one-shot Peakbagger-return refresh after My
Ascents opens successfully. Also refresh an expired summary when the connected
panel becomes visible, with one in-flight owner and revision guard. Keep the old
count visible with a restrained updating state instead of replacing it with a
blank “Checking…” flash. Ordinary focus within the TTL must remain free.

**Regression proof.** Cover immediate and delayed return from My Ascents,
focus/visibility before and after TTL, repeated focus, two Settings tabs,
repository change, disconnect, in-flight deduplication, late response after a
rerender, and read failure with retry. Assert no stale response overwrites a
newer repository or count.

## F10 — Start slow-backup feedback at the start of the operation

**Broken invariant.** “Taking longer than usual” must measure the user-visible
operation, not only its final worker phase.

**Evidence.** `runBackup()` renders “Backing up to GitHub…” and then awaits
`readCurrentBackup()` before arming its 20-second timer in
`src/ascent/ascent-backup.js` (lines 134–157). That read performs the owner edit
form and, when present, stored GPX sequentially at lines 81–108. Each request
has a 15-second bound through `src/peakbagger/peakbagger-request.js` (lines
18 and 73–104), so the ordinary progress claim can remain unchanged for roughly
30 seconds before the slow timer even starts.

**Remediation.** Arm one generation-owned operation timer before the first
persisted read. Prefer phase-specific restrained copy—reading the saved ascent,
reading the GPS track, waiting for GitHub—without exposing implementation
details. Clear or supersede the timer on every success, error, retry, auto-mode
fallback, reconciliation, and teardown so a stale timer cannot overwrite a
newer result.

**Regression proof.** Stall the edit read, GPX read, worker preflight, GitHub
write, and timeout reconciliation independently. Advance a fake clock across
the threshold and prove truthful copy plus cleanup. Cover retry and two rapid
starts so only the newest generation may paint.

## F11 — Deduplicate in-flight DEM loads without breaking cancellation

**Broken invariant.** Consumers requesting the same immutable DEM URL at the
same time should share one bounded network/validation operation.

**Evidence.** `src/terrain/terrain-cache.js` (lines 336–368) checks CacheStorage
and then starts a network fetch with no per-URL in-flight owner. The tilt warmer
uses the same loader in `src/terrain/terrain-frame-runtime.js` (lines
1578–1643) while MapLibre concurrently calls it through the custom protocol at
lines 1822–1833. Two simultaneous requests for one URL produced two fetches and
two validations. Existing reuse coverage in `test/terrain/terrain-cache.test.mjs`
(lines 116–138) is sequential; its concurrent test at lines 362–380 uses four
different URLs.

**Remediation.** Add a bounded per-URL in-flight registry whose shared owner
holds the fetch, byte bound, format validation, and store write. Give each
consumer an independent result buffer and cancellation subscription. One
consumer abort must not cancel work another still needs; when the final
consumer leaves, abort the transport. Clear ownership on success, missing tile,
failure, timeout, and cache teardown.

**Regression proof.** Simultaneous identical loads fetch once and return equal
but independently owned buffers. Cover one cancel, all cancel, late join, 404,
validation failure, deadline, cache disabled, write failure, retry after
settlement, and distinct-URL concurrency. Use hidden hardware-GPU terrain to
confirm request counts; do not substitute SwiftShader.

## F12 — Coalesce threshold input and skip unchanged table writes

**Broken invariant.** High-frequency input on a supported production-scale
table must not synchronously rewrite the entire table for each keystroke.

**Evidence.** `src/ascent/ascent-filter.js` (lines 936–952) saves state and calls
`render()` on every numeric input event. The render loop at lines 1023–1044
assigns `style.display` for every data row and every year section even if the
computed visibility did not change. On the 4,145-row/75-section fixture, one
input caused exactly 4,220 display assignments. The scale test in
`test/scale/ascent/ascent-filter.scale.mjs` (lines 28–54) verifies counts and
sort completeness, but neither threshold typing nor mutation/latency bounds.

**Remediation.** Coalesce a typing burst to one render at an appropriate frame
or short debounce boundary, while keeping immediate accessible control state.
Cache each row and section's previous visibility and write only changes. Avoid
pagination or a new setting; the existing continuous host table and Show all
escape hatch should remain.

**Regression proof.** Instrument visibility writes deterministically. A burst
`1 → 10 → 100` must produce at most one render batch, a no-op value zero row
writes, and a filter transition only the rows/sections whose visibility changes.
After deterministic guards exist, measure the real hidden-browser fixture and
set a generous stable interaction budget based on repeated data rather than
jsdom wall time.

## F13 — Publish watch generations atomically to `dist/`

**Broken invariant.** A failed watch generation must leave the complete last-good
runtime tree on disk, not merely withhold the browser reload signal.

**Evidence.** Each esbuild context writes directly to its final `dist/` output
in `scripts/build.mjs` (lines 98–118). Watch mode rebuilds all contexts
concurrently, then writes notices, copies assets, and finally advances the
reload token at lines 141–180. If one context or later asset step fails after
another bundle succeeds, the token remains old and the already-loaded browser
does not reload, but on-disk `dist/` is a mixed generation. The log says it is
keeping the loaded extension; it does not preserve the directory another
verifier, packager, or later process can inspect.

Current development coverage in `test/project/development.test.mjs` (lines
115–199) pins the completed-build signal and Firefox mirroring but does not
inject a failed bundle or asset copy and compare last-good hashes.

**Remediation.** Build each generation into a versioned staging tree, generate
notices and copy every asset there, validate the required inventory, then
publish the complete tree as one swap before advancing the reload signal.
Retain the prior tree until the swap succeeds; clean abandoned staging trees on
startup and teardown. Keep the rule that only one watch/build owns a worktree.

**Regression proof.** Inject one bundle failure, notice-generation failure,
asset-copy failure, and publish failure after other outputs changed. Every
last-good runtime hash and reload token must remain unchanged. The next
successful generation must publish once, remove stale outputs, mirror Firefox
only after publication, and leave no staging artifacts after shutdown.

## F14 — Derive AMO authored source roots from the build graph

**Broken invariant.** Reviewer metadata must identify every authored runtime
source root used to reproduce the submitted extension.

**Evidence.** `scripts/create-amo-metadata.mjs` (lines 60–78) tells Firefox
reviewers that runtime source lives under `src/`, `options/`, and `popup/`.
`scripts/build-config.mjs` (lines 26–39 and 83–87) also resolves
`photos/photos.js` and `photos/guide.js` from the authored `photos/` root and
ships both bundles. `test/project/release.test.mjs` (lines 343–390) checks
dependency versions, licensing, terrain notes, and listing copy, but not source
root completeness.

**Remediation.** Export or derive the authored root set from the build
configuration used by both build and metadata generation. Render the sorted set
in approval notes so adding another page-local root cannot silently drift.
Avoid a second hand-maintained directory list.

**Regression proof.** Assert every entry source resolves under one declared
authored root or an explicitly named npm/vendor input; fail on an undeclared
root. Generate AMO metadata from the locked tree, inspect the resulting source
archive/instructions, and run the existing release and package-verification
gates. Actual AMO reviewer acceptance remains external evidence.

---

## Dated dependency decision before 2026-08-22

This is an intentional release guardrail, not a newly introduced runtime
finding. `scripts/check-npm-audit.mjs` (lines 11–33 and 48–104) accepts exactly
two high `image-size` advisories in the development-only `web-ext` path through
2026-08-21 and deliberately fails afterward. Both test and release workflows
run the gate. The production graph is currently clean under
`npm audit --omit=dev`, and the current registry did not offer a patched
`image-size` release during this audit.

Before the expiry, the owner must either replace or patch the tooling path, or
record a fresh narrowly scoped review with a new short expiry and the same exact
advisory/path match. Do not call the full graph clean, accept a broad range, or
blindly take npm's proposed old `web-ext` downgrade without browser/build
compatibility proof.

## Implementation sequence

Keep each independently verified unit in a focused commit. Shared foundations
may land first, but do not bundle unrelated fixes merely because they appear in
one audit.

1. **Immediate authorization and mutation safety — F1 and F3.** Land a reusable
   trusted-action capability, then migrate manual ascent backup, profile backup,
   and Settings navigation in independently testable commits. Separately make
   draft apply a leased, reversible transaction before touching other draft UX.
2. **Capture lifecycle and privacy — F2 and F5.** First make every page-bridge
   phase deadline/cancellation-owned, then persist helper leases and adoption.
   Replace local filename metadata with opaque selection identity after the
   lifecycle tests can reliably stop stale work.
3. **Recovery reachability — F4.** Add the bounded raw root-file reader and
   endpoint tests before routing photo update, preview, and restore through it.
   Do not change the 8 MiB product limit without a separate capacity decision.
4. **Terrain and mountain correctness — F6, F7, and F11.** Origin-authenticate
   frame replies first. Fix route-start timezone ownership independently. Add
   DEM in-flight ownership only after cancellation semantics are pinned.
5. **Interaction truth and performance — F8, F9, F10, and F12.** These have
   separate owners and should remain separate commits. Batch hidden browser and
   visual inspection after focused behavior tests are green.
6. **Build and review assurance — F13 and F14.** Make failed-generation
   preservation testable before changing watch publication. Derive AMO source
   roots from the build graph without changing release credentials or stores.
7. **Dependency decision.** Resolve or explicitly renew the dated advisory
   acceptance before the first CI/release run on or after 2026-08-22.

## Verification matrix for remediation

`npm test` rebuilds `dist/`; directly testing a shipped surface without a fresh
build can exercise stale output.

| Gate | Findings | What it establishes | What it does not establish |
| --- | --- | --- | --- |
| focused unit and fault-injection tests | all | tokens, leases, generation ownership, byte/origin bounds, rollback, cancellation, and stale-result rejection | real manifest lifecycle, native UI, live providers |
| `npm run lint` and `npm test` | all | source/build hygiene and bundled behavior in the repository harness | browser interpretation, focus, store/provider state |
| `npm run test:scale` with mutation instrumentation | F4, F12 | recovery-size boundaries and deterministic table-write bounds | real layout/paint or low-memory devices |
| hidden `npm run verify:browsers` | F1–F3, F5, F8–F10 and load-boundary changes | real unpacked manifests, worker/content startup, DOM interaction in isolated profiles | visible focus, browser chrome, screen readers, touch |
| hidden hardware-GPU terrain verification | F6, F11 | correct-origin frame lifecycle, request counts, MapLibre behavior, renderer identity | live future provider behavior or other physical GPU/driver combinations |
| hidden real-browser GPX fixture | F7, F12 | timezone copy/day grouping and actual table interaction at production scale | every border/raster case or assistive technology |
| watch failure-injection harness | F13 | last-good hashes, staging cleanup, one atomic publication/reload | OS crash at every filesystem boundary |
| release metadata/package checks | F14 and dependency decision | complete authored-root notes, locked dependency metadata, reproducible package inventory | AMO acceptance or store publication |
| separately authorized minimal live checks | F1, F4, F9 | GitHub read/write reconciliation and returned backup count against a controlled repository | every account, outage, or rate-limit state |

Before handoff, inspect exact disposable browser profiles, certificates,
archives, and helper processes and remove only confirmed test artifacts. Report
browser, version, renderer, viewport, hidden/visible state, and every remaining
native/live proof gap.

## Investigated and not reopened

- The 2026-08-12 photo freshness, reconciliation, capacity-preflight, completion,
  terrain-style, remote-body, settings-import, profile-stop, and Chrome
  publication fixes remain present and covered. F4 is a distinct remote-reader
  mismatch beyond the local capacity preflight.
- The 2026-08-08 direct-owned GPX parsing, route/time-series separation, report
  recovery, GitHub authorization generation, release provenance/history,
  browser-floor, and first-use ascent-row fixes remain closed.
- Popup selection persistence resubmits selected IDs when opening drafts, and
  the worker owns the final lock; no main-path selection loss was reproduced.
- The ascent table can remain hidden if a browser storage promise never settles,
  but current supported storage APIs reveal it on rejection/finally. Without a
  supported-browser hang reproduction, this remains a theoretical proof gap.
- Chart reconstruction on settings changes remains bounded by the GPX point
  budget; no current stale-result or latency failure was reproduced.
- The production npm dependency graph is currently clean. The two full-graph
  advisories remain an explicit, expiring development-tool exception rather
  than a runtime vulnerability.
- No version bump, tag, push, release, store mutation, live GitHub write, or
  provider write was performed.

## Closure ledger

### Fixed and verified

- None. This audit created and indexed the plan only; runtime remediation has
  not started.

### Intentionally not changed

- The canonical 8 MiB photo-recovery limit remains an owner-approved capacity
  boundary. F4 makes all readers honor it; changing the capacity is out of scope.
- Automatic ascent backup after a fresh saved-page snapshot remains valid
  opt-in behavior. F1 requires trusted activation only for manual actions and
  browser-side navigation.
- A page-owned browser operation may not be physically abortable after dispatch.
  F2 requires the product to stop awaiting it, invalidate late results, and
  clean up safely rather than claim the browser call itself was retracted.
- The two exact development-only advisories remain accepted only through
  2026-08-21 pending the dated owner decision above.
- Previously archived findings remain closed absent new contrary evidence.

### Changed but not fully proven

- The repository now contains this documentation-only plan and active-plan index
  entry. No runtime behavior changed.
- Deterministic probes establish the listed broken invariants, but no visible
  browser, hardware-GPU, live provider, authenticated GitHub recovery, abrupt
  process-loss, assistive-technology, legal, AMO-review, or store-publication
  proof was performed in this audit turn.
