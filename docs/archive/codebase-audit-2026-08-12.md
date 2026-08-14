# Code, performance, and UX audit — 2026-08-12

Status: **remediation completed and archived on 2026-08-14.** The audit found
three P1 findings, seven P2 findings, and two P3 findings. Each item below
records the original broken invariant, source evidence, remediation boundary,
and adversarial regression proof; the closure ledger records what changed and
what the available checks still cannot prove.

Baseline: clean local `main` at `b6736ef1`, 23 commits ahead of `origin/main`.
This pass reconciled the current tree with the remediated and archived
[2026-08-08 codebase audit](../archive/codebase-audit-2026-08-08.md) and
[2026-08-08 UX/engineering audit](../archive/ux-engineering-audit-2026-08-08.md).
Closed items are not reopened without new source evidence or a deterministic
probe that disproves the archived invariant.

## Scope and evidence

The review covered all 108 files under `src/`, 16 under `options/`, three under
`popup/`, five under `photos/`, 44 build/release files under `scripts/`, and 140
test files. It traced activity capture and prepared drafts, GPX and map
surfaces, settings import/export, GitHub authentication and backup, Photo Topos
editing/storage/recovery, terrain resources, profile backup, runtime messaging,
and store publication. It also checked the maintained architecture, privacy,
development, and focused feature documents against the implementation.

Current-turn evidence established this baseline:

- The first `npm test` run: **1,435 passed, 0 failed** after rebuilding all 27
  shipped bundles in `dist/`. The post-documentation rerun rebuilt the same
  runtime tree but finished **1,434 passed, 1 failed** because the photo-backup
  test observed its success toast before the later status refresh completed.
  The source ordering deterministically permits that race; it is F12, not a
  green gate and not something this audit hid with a selective rerun.
- `npm run lint`: passed with the eight repository-owned warnings: one
  cross-browser background-worker warning, five MapLibre warnings, one
  ProseMirror warning, and one TipTap warning.
- `npm run audit:ci`: passed its exact, expiring exception for two high
  `image-size` advisories in the development-only `web-ext` path through
  2026-08-21. This is not a clean advisory graph.
- `npm run test:scale`: **6 passed, 0 failed** across the Rainier ascent filter,
  1,500 favorites, a 20,000-point GPX, and a 1,200-photo catalog.
- A pure photo-record probe started with a record stamped `current`, added a
  report reference, then deleted it. Both resulting records still claimed
  `current`, reproducing F1 without browser APIs.
- The Chrome publication review was checked against the official Chrome Web
  Store [upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload)
  and [fetchStatus](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus)
  contracts. An in-progress upload may omit `crxVersion`; submitted revision
  channels are the later remote evidence of the published version.

No browser window was launched. Unit, lint, scale, and source-level evidence do
not prove native focus or browser chrome, screen-reader speech, touch, physical
devices, live Garmin/Strava/Peakbagger/OpenFreeMap/GitHub/ImgBB behavior, abrupt
process loss, legal sufficiency, store acceptance, or a published store
revision. Those proof gaps remain explicit below.

## Priority summary

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | P1 | photo recovery | recovery-changing mutations can retain a stale “Backed up” stamp, and a lost fire-and-forget notification can prevent automatic backup indefinitely |
| F2 | P1 | terrain privacy and reliability | a remotely fetched style can redirect nested resources to unreviewed origins and a partial graft is not rolled back transactionally |
| F3 | P1 | Chrome publication | requests have no local deadline/body cap and the publisher does not terminally prove the expected submitted store revision |
| F4 | P2 | response budgets | several runtime clients retain complete remote bodies before imposing any byte or structural bound |
| F5 | P2 | settings import | the options page and worker read, clone, and parse an arbitrarily large manual import before validating its schema |
| F6 | P2 | photo editor lifecycle | rapid “Edit as new version” actions can create duplicate children, and the thumbnail fallback leaks its decoded `ImageBitmap` |
| F7 | P2 | photo backup scale | backup reconciliation opens one simultaneous read-write IndexedDB transaction per photo |
| F8 | P2 | Recently Deleted | maintenance prunes at most one 20-record batch per page lifetime and ignores the returned remainder |
| F9 | P2 | photo backup capacity | the 8 MiB limit is enforced only after repeated full serialization and remote reconciliation, then reported as a generic failure |
| F10 | P2 | draft recovery UX | “Copy Markdown” has no selectable fallback, so a clipboard denial leaves the full saved draft inaccessible from the manager |
| F11 | P3 | profile backup UX | Pause and Cancel are not immediately visible and cancellable reads/backoffs can make the controls appear inert |
| F12 | P3 | backup completion UX/test | the photo page announces backup success before its authoritative status refresh, creating contradictory feedback and a flaky full-suite assertion |

P1 means a material recovery, privacy, or release-assurance invariant is
broken. P2 is bounded but user-visible correctness, resource, scale, or
reliability debt. P3 is a truthful-feedback or verification-guardrail gap with
no demonstrated data loss.
Severity measures impact and urgency, not implementation effort.

---

## F1 — Make photo-backup freshness durable and generation-owned

**Broken invariant.** Every local mutation that changes the GitHub recovery
document must atomically invalidate the confirmed backup identity. When
automatic backup is enabled, that durable dirty state must eventually schedule
work even if the mutating page or service worker disappears between the local
commit and a runtime message.

**Evidence.** `src/photos/photo-library.js` (lines 253–316) marks a completed
upload pending, but `markUnreachable`, `addReference`, `markDeleted`, and
`restoreDeleted` change recovery fields without changing the backup stamp.
`updateAssets` also changes `updatedAt` despite editing assets being local-only,
so the current record timestamp cannot safely stand in for recovery freshness.
The controlled probe described above left a changed reference and deletion
stamped `current`.

The UI commits these mutations and then calls `notifyBackupChanged()` in
`photos/photos.js` (lines 2054–2074 and 2238–2293). That helper is a discarded
runtime-message promise at line 249, while `src/ui/runtime-message.js`
(lines 7–12) converts a messaging failure to `null`. The background creates a
trailing one-minute alarm only after receiving that message in
`src/background/github-routes.js` (lines 1538–1544). Its settings-change path
explicitly avoids scanning IndexedDB except on the disabled-to-enabled edge at
lines 1632–1640. A page close, worker restart, or transient extension-context
failure can therefore leave enabled automatic backup dirty but unscheduled.

The presentation compounds the defect. `photos/photos.js` (lines 2016–2026)
renders `backup.state === 'current'` as “Backed up”, and `options/photos.js`
(lines 79–84) can say the library is “Stored as photo-library.json” when a
connected repository has no confirmed backup state. These claims are stronger
than the stored evidence. `docs/photo-topo-editor.md` (lines 404–407) promises
that any local catalog change arms the alarm.

**Remediation.** Add a store-owned catalog generation, or equivalent durable
dirty identity, and update it in the same IndexedDB transaction as every
recovery-relevant mutation. A successful remote commit must journal the
confirmed generation before local reconciliation and record which photo
revisions it included. Keep asset-retention cleanup outside that recovery
identity so pruning local editing pixels does not invent a remote conflict.

While automatic backup is enabled, maintain a recurring worker watchdog that
checks the durable generation and rearms itself until the confirmed generation
catches up. The existing mutation message may still provide the fast
trailing-edge schedule, but losing it may only delay backup, never suppress it.
Either acknowledge and retry that notification or centralize mutation
scheduling; do not make correctness depend on a best-effort message.

Render “Backed up” only when the catalog generation equals the confirmed remote
generation. A connected but never-backed-up library should say “Ready to back
up”; a changed one should become “Backup pending” immediately from durable
state.

**Regression proof.** Start from a confirmed catalog and exercise reference,
delete, restore, unreachable/reachable, upload, and editing-asset cleanup.
Reject the runtime notification, close the page, restart the worker, make no
further mutation, and prove automatic backup eventually runs. Cover two tabs,
mutations during a remote write, a remote success followed by reconciliation
failure, worker restart between those phases, and a later local generation.
Assert that only recovery-relevant changes dirty the document and that no UI
claims “Stored” or “Backed up” without matching remote evidence.

## F2 — Constrain and transactionally install the remote terrain style

**Broken invariant.** Enabling the optional vector basemap may contact only the
reviewed provider origins disclosed by the product, and a failed style install
must leave no partial sources, layers, sprite, or glyph configuration behind.

**Evidence.** `src/terrain/terrain-style.js` (lines 25–60) checks only that the
remote value has version 8, a sources object, and a layers array. It calls
`response.json()` with no byte limit, does not validate the final response URL,
and does not constrain source/layer counts, identifiers, sprite/glyph URLs,
inline tile templates, or nested TileJSON resources.

`src/terrain/terrain-frame-runtime.js` (lines 865–895) copies the style's glyphs,
sprite, every source, and every layer directly into the live map. Cleanup at
lines 897–918 wraps all removals in one `try`; the first removal failure skips
the rest before the tracking arrays are cleared. The activation catch at lines
934–948 changes the picker and notice but does not roll back resources already
added before a later `addSource` or `addLayer` throws.

The maintained provider review states that the vector path should use one
OpenFreeMap origin in `docs/archive/3d-vector-basemap-investigation.md`
(lines 42–61 and 161–174). `PRIVACY.md` (lines 261–265 and 371–375) names
OpenFreeMap as the party receiving map coordinates. A valid remote style that
points glyphs, sprites, a source URL, or TileJSON tiles elsewhere violates that
disclosure even though the top-level style fetch used the expected URL.

**Remediation.** Read the style through the shared bounded-text primitive with
a reviewed compressed-response character/byte ceiling, then parse it. Cap
source and layer counts and relevant string lengths. Normalize a supported
style subset and validate unique IDs, layer/source relationships, glyph and
sprite templates, source URLs, inline tile templates, and the final response
origin before touching MapLibre.

Enforce the same provider-origin allowlist on nested requests, preferably with
a MapLibre request transform that fails closed even when a validated TileJSON
document later supplies a URL. If TileJSON is fetched for validation, bound and
validate it too. Apply the normalized style as a transaction: track each
successful mutation, restore previous glyph/sprite state, and independently
attempt every reverse-order removal after any failure. Mark the vector picker
active only after the complete commit; otherwise return to terrain-only mode
with an actionable but non-technical notice.

**Regression proof.** Cover redirects, foreign glyph/sprite/source/TileJSON
tile origins, credentials or fragments in resource URLs, oversized and
decompression-expanded bodies, excessive sources/layers, duplicate or invalid
IDs, unsupported source types, and a throw after each successful source/layer
addition. Inject cleanup failures and prove later resources are still removed.
Use the real hidden MapLibre frame on hardware WebGL to prove no foreign request
occurs, no partial vector resource survives, and the picker/notice reflects the
actual committed state. That hidden check will not prove a live provider's
future policy or native browser UI.

## F3 — Reconcile Chrome publication to the expected submitted revision

**Broken invariant.** Release automation may announce a submitted Chrome
version only after the remote store proves that exact revision is the submitted
revision. A timed-out non-idempotent upload or publish must be reconciled before
retry, not treated as a clean failure.

**Evidence.** `scripts/publish-chrome.mjs` (lines 46–72) performs each request
with plain `fetch()` and then retains `response.text()` without a request
deadline or body cap. The surrounding workflow's 15-minute job timeout cannot
classify whether an upload or publish applied before a hung response.

The publisher captures `crxVersion` only from the initial upload response and
polls only `lastAsyncUploadState` at lines 108–133. It reports that version, or
falls back to the package's expected version, at lines 159–162. The official
[upload contract](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload)
allows `crxVersion` to be absent while processing is `IN_PROGRESS`. The
[status contract](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus)
describes `lastAsyncUploadState` as the publisher item's most recent async
upload state, while the submitted revision's distribution channels contain the
revision `crxVersion`. The existing release test in `test/project/release.test.mjs`
(lines 877–903) deliberately omits the upload version from both the initial and
polled upload responses and accepts the local fallback. It never proves the
post-publish submitted revision.

**Remediation.** Give every request its own `AbortController` deadline and a
small response-body budget. Preserve endpoint, status, and phase in typed
errors. After upload processing succeeds and after `publish`, poll terminal
status and require the expected package version to appear in the submitted
revision's intended distribution channel with an appropriate submitted state.
Do not use global recent-upload state as sufficient correlation.

If upload or publish times out after dispatch, enter an explicit
outcome-unknown phase and fetch current store status before allowing another
mutation. If reconciliation cannot prove whether the operation applied, stop
with manual-inspection guidance; do not automatically replay it. Log
“Submitted version …” only from the reconciled remote revision.

**Regression proof.** Cover in-progress upload without `crxVersion`, an expected
and mismatched submitted revision, missing distribution channels, stale/global
async success, processing failure, stalled headers, stalled body, oversized
error body, malformed JSON, and deadline cleanup. Simulate upload and publish
applying just before client timeout, then prove retry preflight either observes
the exact expected revision or stops without a duplicate mutation.

## F4 — Apply byte and structure budgets to remaining response readers

**Broken invariant.** A supported remote endpoint must not be able to make an
extension surface retain and parse an unbounded body merely because headers
arrived before its deadline.

**Evidence.** `src/net/bounded-text.js` (lines 1–104) already streams text with
byte and character caps, dishonest-`Content-Length` handling, cancellation, and
reader cleanup. Several runtime clients bypass it:

- `src/github/github-api.js` (lines 95–168) uses `response.text()` for every
  GitHub API success and failure, including tree and content operations.
- `src/github/github-auth.js` (lines 83–128) retains the complete device-flow
  response before JSON parsing.
- `src/photos/imgbb-client.js` (lines 219–290) retains the complete response
  after the non-idempotent image upload.
- `src/maps/peak-markers.js` (lines 126–163) retains and DOM-parses the complete
  XML response; its 400-marker cap is applied only after all returned rows have
  been parsed.

These paths have request deadlines, but a deadline alone is not a memory or
parse-cost budget. F2 and F3 own the terrain-style and Chrome-release instances
because those need additional origin or reconciliation semantics.

**Remediation.** Route each response through the bounded reader with
endpoint-specific limits rather than one arbitrary global ceiling. Cap decoded
JSON/XML structure after parsing as well: item counts, depth or recursively
visited nodes where applicable, string sizes, and GitHub tree truncation or
pagination semantics. The Peakbagger marker path must reject before DOMParser
when the XML exceeds its budget. Preserve enough GitHub capacity for legitimate
large trees, but handle `truncated` and pagination explicitly instead of
silently raising an unlimited ceiling.

ImgBB over-limit and timeout failures after upload dispatch remain
outcome-unknown; do not retry automatically or relabel them as definite upload
failure. Surface an actionable provider-response-too-large error through each
owner's existing public-error boundary.

**Regression proof.** For every client, test an honest over-limit
`Content-Length`, no header, a dishonest low header, decompression expansion,
exact limit, one byte over, stalled mid-stream reads, abort, and malformed valid-
size content. Assert reader cancellation and that JSON/XML parsing never starts
after rejection. Add endpoint-specific valid-large fixtures, excessive
structure fixtures, and non-idempotent ImgBB ambiguity coverage.

## F5 — Bound settings imports before reading, cloning, or parsing

**Broken invariant.** Manual recovery input must be rejected at a small,
documented encoded-size boundary before either the options page or worker
retains and parses it. The worker must independently enforce the boundary
because page messages cross a trust boundary.

**Evidence.** `options/settings-backup.js` (lines 123–151) calls `file.text()`
before any size check and stores the complete string as `pendingImport`.
Confirmation then structured-clones that string into a runtime message at lines
168–182. `src/settings/settings-transfer.js` (lines 89–118) parses it with
`JSON.parse()` and no byte ceiling. The worker repeats the parse from the
message in `src/background/settings-file-routes.js` (lines 271–284), also
without a size ceiling. Schema validation limits recognized fields only after
the untrusted outer object has already consumed memory and parse time.

**Remediation.** Define one conservative import maximum in the pure transfer
owner—around 1 MiB is already far above a legitimate export—and export it to
both surfaces. On file selection, check a trustworthy positive `file.size`
only as an early optimization, then use `readBoundedBlobText` so a missing or
dishonest size cannot bypass the cap. `SettingsTransfer.parse()` must reject
the encoded byte length before `JSON.parse`, and the worker must perform that
same check before any migration, credential prompt, current-settings read, or
write.

Clear the pending content on rejection and say that the file is too large and
that the user should choose a Better Peakbagger settings export. Keep the
existing explicit credential opt-in and rollback semantics unchanged.

**Regression proof.** Cover exact limit, one byte over, multibyte UTF-8,
missing/dishonest Blob size, streaming without `Blob.text`, enormous ignored
properties, deep nesting, malformed JSON, and a direct oversized worker
message. Prove the page does not call `JSON.parse` or send a runtime message
after local rejection, and prove the worker does not read or mutate current
settings, API credentials, or GitHub authorization after its rejection.

## F6 — Give “Edit as new version” one owner and close decoded pixels

**Broken invariant.** One user action may create at most one child draft, and
every decoded image must be closed exactly once after thumbnail generation or
ownership transfer—even when a later storage or editor-load phase fails.

**Evidence.** `photos/photos.js` (lines 2078–2109) checks the global `busy` flag
but never acquires it before the first await. Two rapid card clicks can both
read the same parent, generate different IDs, and commit duplicate child
drafts. The fallback expression at line 2104 nests
`makeThumbnail(await decodeBlob(...))`; the temporary `ImageBitmap` is never
held for a `close()` call. The function also has no phase-level
`try`/`catch`/`finally`, so a failed thumbnail, draft write, reload, or editor
load escapes through an async click handler and can leave a committed child
without truthful feedback.

The general editor-control disabling in `photos/photos.js` (lines 397–419)
does not cover the dynamic actions on library cards at lines 2378–2395.
Existing editor coverage exercises one click with an already-stored thumbnail,
so it does not cross either failure boundary.

**Remediation.** Acquire a dedicated new-version transaction owner before the
first await and disable or mark busy the initiating card action. Avoid coupling
this to a global flag in a way that makes the transaction's own `loadBundle`
reject; explicitly transfer ownership into the editor-loading phase. Hold any
fallback `ImageBitmap` in a local variable and close it in `finally` after
thumbnail generation, whether generation or storage succeeds or throws.

Separate “draft committed” from “editor loaded.” If the commit succeeds but
the editor cannot load, leave the new draft visible and tell the user it was
saved and can be reopened. Release controls in `finally` and route errors to an
actionable toast instead of an unhandled rejection.

**Regression proof.** Barrier two rapid clicks before parent read, draft write,
and editor load and assert exactly one child. Test existing-thumbnail and
decode-fallback paths; count `ImageBitmap.close()` on success and failures from
thumbnail generation, `putDraft`, `getBundle`, and `loadBundle`. Exercise the
same and another card while the owner is active, parent deletion/conflict,
page teardown, and a committed child whose editor load fails. Assert there is
no unhandled promise rejection and the saved child remains recoverable.

## F7 — Reconcile photo-backup stamps in bounded store-owned batches

**Broken invariant.** A catalog-scale backup must use a bounded number of
IndexedDB transactions and live promises while preserving revision conflicts;
the declared 1,200-photo scale must not create 1,200 simultaneous write
transactions.

**Evidence.** `src/background/github-routes.js` (lines 1187–1236) lists every
photo and sends every changed record through one `Promise.allSettled` call on
both success and failure reconciliation. Each `updatePhotoBackup` in
`src/photos/photo-store.js` (lines 469–493) opens its own read-write transaction.
The 1,200-photo scale fixture in `test/scale/photos/photo-library.scale.mjs`
(lines 27–43) measures library rendering, not background backup reconciliation.

Apart from transaction scheduling and memory pressure, the fan-out makes
recovery reasoning harder: remote confirmation, per-record conflicts, worker
shutdown, and the final summary can all interleave across hundreds of
independent transactions.

**Remediation.** Add a store-owned batch/CAS operation that processes either one
bounded transaction or fixed-size chunks. Return exact conflicts and changed
counts. Bound live promises and transaction count; yield between chunks if one
transaction would monopolize the worker. Pair this with F1's catalog generation
so a remote-confirmed generation is journaled once and per-record presentation
can reconcile without making the catalog's recovery truth depend on completing
every decorative stamp write.

**Regression proof.** Back up and fail a 1,200-photo catalog while instrumenting
transaction count and maximum simultaneous promises. Inject a newer photo
revision in the middle of each chunk and prove it is preserved and reported as
pending, not overwritten. Restart the worker between remote confirmation and
each reconciliation chunk; prove recovery resumes and remote-confirmed data is
never presented as a definite remote failure.

## F8 — Drain Recently Deleted maintenance in bounded repeated batches

**Broken invariant.** Expired editing assets must eventually be pruned while a
photo-library page remains open, without requiring repeated page reloads and
without one unbounded catalog scan.

**Evidence.** `src/photos/photo-store.js` (lines 577–612) calls `getAll()`, sorts
all deleted candidates, prunes one `limit` slice, and returns `remaining`.
`photos/photos.js` (lines 2481–2495) schedules one 20-record batch, ignores that
`remaining` count, and swallows maintenance errors. Initialization schedules
maintenance only once at lines 2837–2857. More than 20 expired records therefore
retain original/project blobs indefinitely in a long-lived page unless the
user reloads it enough times. The unit test in `test/photos/photo-store.test.mjs`
(lines 236–257) proves a batch can return a nonzero remainder but does not prove
the page drains it. Maintained Photo Topos documentation describes background
batches, plural.

**Remediation.** Add or use an IndexedDB index/cursor that can visit eligible
deleted records by deadline without loading and sorting the full catalog.
Schedule another idle/short-delay batch while `remaining > 0`, yielding between
batches and cancelling the owned timer on teardown. Recompute the cutoff so a
long-lived tab also handles records that expire after initialization. Keep
maintenance quiet in the success path, but preserve diagnostic state and retry
a transient transaction failure rather than swallowing it forever.

**Regression proof.** Insert more than two batches of expired records and prove
all editing blobs are eventually pruned during one page lifetime with bounded
transactions. Cover exact deadline, a record restored or concurrently edited
between scan and write, a new deletion during maintenance, records that cross
the deadline after page load, hidden/visible transitions, timer teardown, and a
failed batch followed by retry. Assert recent and active records retain assets
and the UI remains responsive between batches.

## F9 — Enforce photo-backup capacity once, locally, and actionably

**Broken invariant.** An over-capacity local recovery document must be detected
before remote reads or writes, with one canonical serialization and a specific
user action. Remote merge growth must be rejected before mutation without
silently dropping recovery data.

**Evidence.** `src/photos/photo-backup.js` (lines 102–142) builds and sorts the
full payload, then stringifies and UTF-8 encodes it to enforce the 8 MiB limit.
`signature()` at lines 174–190 stringifies and encodes the payload again.
`src/background/github-routes.js` (lines 1173–1184) builds and signs the local
snapshot before `backupPhotoLibrary` later reads and merges the remote file; the
serialized size is not enforced until lines 1314–1341. The resulting
`RangeError` reaches the generic “photo-library backup failed” boundary at
lines 1409–1415.

The existing over-limit unit case in `test/photos/photo-backup.test.mjs`
(lines 79–89) parses a prebuilt oversized string. It does not prove generated
catalog behavior, absence of GitHub calls, one-pass memory use, merge growth,
or actionable UI. The reviewed 8 MiB limit itself is not a defect; enforcing it
late and opaquely is.

**Remediation.** Produce one bounded canonical byte representation and reuse it
for size, signature, and upload. Reject an oversized local snapshot before any
GitHub request. After a remote merge, produce and bound the merged bytes before
the compare-and-swap write. Return a typed `photo-backup-too-large` error with
actual and maximum sizes and a stable public action. Automatic backup should
not repeat expensive hopeless work until the catalog generation or capacity
policy changes.

Do not silently truncate annotations, references, deletions, or tombstones.
Choosing a compact schema, a larger reviewed limit, or an explicit per-project
exclusion workflow is a separate product/data-migration decision.

**Regression proof.** Generate payloads at the exact limit and one byte over,
including multibyte text and one very large project. Count canonical
serialization/encoding calls and assert no GitHub operation occurs for a local
over-limit generation. Cover a local payload under the limit whose remote merge
exceeds it, conflict/retry, worker restart, and repeated automatic scheduling.
Assert no remote write occurs on merged overflow and every surface gives the
same actionable capacity message.

## F10 — Provide a selectable fallback for saved-draft Markdown

**Broken invariant.** A copy action must preserve access to the complete text
when the preferred clipboard API fails. Keyboard and assistive-technology users
must be able to reach and select the exact Markdown through the same recovery
flow rather than being forced into an editing surface.

**Evidence.** `options/drafts.js` (lines 179–191) attempts only
`navigator.clipboard.writeText()` and then flashes “Couldn’t copy Markdown”.
The card renders only a 160-character excerpt at lines 58–63 and 213–217, so
the manager exposes neither the complete Markdown nor a selectable alternative.
The adjacent Open action remains an escape hatch into the editor, which bounds
this as poor recovery UX rather than data loss; it does not make the failed
copy action complete or accessible.

The product already uses the right recovery pattern elsewhere:
`src/reports/report-editor.js` (lines 663–681) reveals and selects a textarea
when copying fails, and `options/github.js` (lines 134–149) selects a device
code when clipboard access is unavailable. The draft manager is the outlier.

**Remediation.** Extract or reuse a small accessible copy-recovery component.
On clipboard absence, rejection, or synchronous throw, reveal a dialog or
inline panel containing the exact `markdownFor()` result in a readonly
textarea, focus and select it, give concise manual-copy instructions, and
provide an obvious dismiss action with focus return. Do not trim, reinterpret,
or reserialize the Markdown a second way.

**Regression proof.** Cover missing clipboard API, rejected promise,
synchronous throw, Markdown-native and Rich-converted drafts, empty/long/
Unicode content, repeat use, and dismissal. Assert exact textarea value,
focus/selection, accessible name, Escape/dismiss behavior, and focus return.
Visually inspect the real options page in light and dark modes at narrow and
wide extension-page viewports; jsdom behavior does not prove wrapping,
clipping, selection highlight, or visual hierarchy.

## F11 — Make profile Pause and Cancel immediately truthful

**Broken invariant.** Requesting Pause or Cancel must produce immediate visible
acknowledgement and abort work that is still safely retractable. A GitHub write
already in flight may finish, but the UI must say so and no later batch may
start.

**Evidence.** `src/profile/profile-backup-core.js` (lines 229–236 and 273–275)
checks cancellation only after retry and pacing sleeps of up to 15 seconds.
`safeLoad` at lines 195–198 does not pass an `AbortSignal` to the Peakbagger
loader even though `src/peakbagger/peakbagger-request.js` (lines 70–149)
accepts and observes one. The consumer awaits the current GitHub batch at
lines 293–321. Pause and Cancel only flip internal
flags and notify waiters at lines 349–365; the published state remains
`running` until the runner reaches a later boundary.

`src/profile/profile-backup.js` (lines 256–280) therefore keeps rendering the
old Reading/Uploading activity plus enabled Pause and Cancel buttons. The
documented contract in `docs/github-ascent-backup.md` (lines 499–519) correctly
says cancellation occurs at a safe boundary and that the current GitHub batch
may finish. The implementation should preserve that non-idempotent-write
boundary, not make the button look ignored.

**Remediation.** Replace fixed sleeps with a cancellable wait helper and give
each Peakbagger read an owned `AbortController`. Publish explicit
`pause-requested` and `cancel-requested` states immediately. During a
retractable read or wait, abort and settle promptly. During a GitHub mutation,
show “Stopping after the current GitHub batch…” (or the pause equivalent),
disable repeat requests, count the confirmed completed batch, and start no new
one. Do not abort or automatically retry an ambiguous GitHub write.

**Regression proof.** Request pause and cancel during the 15-second backoff,
pacing delay, stalled Peakbagger headers/body, producer-buffer wait, immediately
before GitHub dispatch, and during/after a GitHub mutation. Assert immediate
truthful visible state, request-signal abort where safe, no later read or batch,
correct accounting for a completed current batch, idempotent repeat controls,
and teardown of waiters/controllers. A hidden DOM check can prove state and
focus; native focus, screen-reader speech, and live-provider behavior remain
manual proof.

## F12 — Publish photo-backup completion as one visible transaction

**Broken invariant.** A completion test must wait for the final user-visible
postcondition, and the product must not announce success while its persistent
status still says the operation is running.

**Evidence.** After a successful backup response, `photos/photos.js`
(lines 2541–2546) shows the success or reconciliation-warning toast first,
then awaits a complete library render, then fetches and paints the authoritative
backup status. On a large or busy catalog, the toast can therefore say that the
GitHub copy is safe while the persistent status still says “Backing up photo
metadata…”.

`test/photos/photo-editor.test.mjs` (lines 239–280) waits only for text in that
early toast and immediately asserts the later status. The first full audit run
passed; the same-runtime post-documentation run failed with the live status
still equal to “Backing up photo metadata…”. The source ordering explains both
outcomes. A rerun could turn it green without changing the defect, so it is not
acceptable verification.

**Remediation.** Give backup completion one ordered presentation commit. Fetch
and paint the authoritative backup state before emitting the final toast, or
derive both from one worker response that carries the confirmed repository and
generation. Do not make a potentially expensive library rerender a prerequisite
for ending the visible backup phase; queue that refresh separately if it does
not affect the completion truth.

Change the behavior test to wait for the exact persistent user-visible
postcondition and report its live value on timeout. Do not wait on an outgoing
message, mutable test flag, early toast, arbitrary tick, or fixed sleep.

**Regression proof.** Hold library rendering and the status request behind
separate barriers. Prove the page never displays a success/warning toast beside
an in-progress or failed persistent status, and that the test remains pending
until the final status is visible. Cover confirmed current, reconciliation
pending, status-read failure, a second click, large-catalog render delay, and
page teardown. Run the focused case repeatedly under CPU load as a test-harness
stress check, then require a clean full `npm test` without selective reruns.

---

## Implementation sequence

Keep each independently verified unit in a focused commit. Do not bundle a
mechanical cleanup or unrelated refactor into remediation.

1. **Photo recovery foundation — F1, F7, F9, F12.** First fix F12's completion
   postcondition so the backup UI test is a trustworthy gate. Then define
   durable catalog and remote generations, journal remote confirmation, add
   bounded store reconciliation, and make canonical capacity enforcement
   consume that same snapshot. These
   findings share one data invariant and should be designed together, though
   schema/store, reconciliation, and user-facing capacity behavior can remain
   separate commits.
2. **Remote trust and resource budgets — F2, F4, F5.** Land bounded-response
   primitives and endpoint limits first, then constrain the terrain style and
   settings import at their additional trust boundaries. Keep the terrain
   origin/rollback transaction independently reviewable.
3. **Photo lifecycle and recovery UX — F6, F8, F10, F11.** These are separable
   owners: new-version transaction, maintenance scheduler, copy fallback, and
   profile cancellation state. Add behavior coverage with each owner; batch
   visual checks into one isolated browser launch after the UI commits exist.
4. **Release assurance — F3.** Add pure response/reconciliation tests before
   changing the release script, then validate the workflow contract without
   publishing. A live store mutation requires separate release authorization.

Dependencies are constraints, not permission to combine commits. In
particular, F1 should settle the generation semantics before F7 rewrites stamp
reconciliation, and F4's bounded reader should be reused by F2 rather than
copied.

## Verification matrix for remediation

For every finding, run the focused tests beside the changed owner before the
full gates. `npm test` rebuilds `dist/`; directly testing bundled surfaces
without rebuilding can exercise stale code.

| Gate | Findings | What it establishes | What it does not establish |
| --- | --- | --- | --- |
| pure/unit and fault-injection tests | all | generations, budgets, rollback, cancellation, exact copy, adversarial interleavings, and final-state synchronization | manifest interpretation, native layout, live providers |
| `npm run lint` and `npm test` | all | source/build hygiene and shipped-bundle behavior in the repository harness | real browser lifecycle or store/provider state |
| `npm run test:scale` with new transaction instrumentation | F1, F7, F8, F9 | catalog-scale transaction/promise bounds and eventual maintenance | abrupt OS termination or low-memory devices |
| hidden `npm run verify:browsers` | F1, F5, F6, F10, F11 and any load-boundary change | real unpacked manifests, worker/content startup, DOM interaction in isolated profiles | native focus, browser chrome, permission prompts, screen readers, touch |
| hidden hardware-GPU `npm run terrain:verify` and Firefox counterpart | F2 | real MapLibre install/rollback, request allowlist, renderer, and visual fallback | live provider policy or native browser UI |
| dry-run/fake-server release tests | F3 | deadlines, body caps, status reconciliation, retry decisions | a real Chrome Web Store submission |
| minimal manual/live checks under release authorization | F2, F3, F4, F6, F10, F11 | reviewed live provider/store behavior and visual/native UX | legal sufficiency or every account/device configuration |

Before handoff, inspect owned browser/profile processes and disposable
artifacts. Report browser, renderer, viewport, hidden/visible state, and every
remaining native/live proof gap rather than promoting protocol assertions into
onscreen evidence.

## Closure ledger

### Fixed and verified

- **F1 — generation-owned photo recovery (`e601f77`, corrected by
  `3299082`):** every recovery-relevant catalog mutation now advances a durable
  generation in its owning IndexedDB transaction. Remote confirmation journals
  that generation and its exact record revisions before stamp reconciliation;
  a recurring watchdog is armed without consuming a fail-soft settings read.
  Focused photo, worker, settings-policy, documentation, and 1,200-photo scale
  coverage passed in 155- and 95-test runs.
- **F2 — constrained vector style transaction (`97c5331`):** the OpenFreeMap
  style now passes explicit byte, structure, identifier, source, layer, type,
  and exact-origin validation before MapLibre receives it. Resource installation
  rolls back partial sources, layers, glyphs, and sprites on failure. Thirty-
  three focused tests passed; the live Liberty style normalized to 2 sources
  and 111 layers; hidden Chrome terrain passed at 798×448 and 448×448 on the
  Apple M3 Pro Metal renderer, followed by hidden real-extension verification.
- **F3 — reconciled Chrome publication (`4af7262`):** each Web Store request has
  a 30-second deadline and 64 KiB response ceiling with typed phase, endpoint,
  status, and outcome-unknown failures. Upload and publish are never replayed
  after an ambiguous mutation result. Success is reported only after
  `fetchStatus` proves the expected version in an appropriate submitted
  revision, while a retry observing that exact revision completes without
  another mutation. Forty-three release tests and the 1,486-test full suite
  passed.
- **F4 — bounded remote response owners (`478d695`):** GitHub REST and device
  flow, ImgBB, and Peakbagger marker readers now stream through endpoint byte
  ceilings and validate bounded parsed structures. GitHub discovery caps pages
  and items and rejects incomplete trees. One hundred thirty-one focused cases,
  ESLint, and hidden Chrome for Testing 151.0.7922.34 passed.
- **F5 — bounded settings import (`9a51238`):** both the options page and worker
  enforce the same 1 MiB UTF-8 and parsed-structure contract before JSON,
  credential, or settings-store work. Sixty-eight bounded-reader, transfer,
  worker, and options cases passed.
- **F6 — serialized photo version creation (`987e530`):** one synchronous owner
  now admits **Edit as new version**, keeps the control busy, distinguishes a
  committed child from later editor-load failure, and closes temporary
  `ImageBitmap` instances in every path. Fifty-two editor tests, ESLint, and
  hidden Chrome passed.
- **F7 — bounded photo reconciliation (`66464b8`):** a sequential store-owned
  compare-and-swap operation replaced per-photo transaction fan-out and handles
  at most 50 records per IndexedDB transaction while preserving exact conflicts
  and progress. Forty-two store/background/documentation tests passed,
  including the 1,200-photo transaction-bound case.
- **F8 — complete Recently Deleted maintenance (`c270254`):** schema version 4
  adds a deletion-time cursor; page-owned maintenance drains all eligible
  bounded batches with event-loop yields, retries transient failures, and arms
  only the next retained expiry while respecting hidden and teardown states.
  Eighty photo tests, ESLint, and hidden Chrome passed.
- **F9 — pre-write photo capacity (`6415843`):** one canonical UTF-8 recovery
  document now owns the 8 MiB check, signature, and upload. Local and merged
  overflow stop before remote mutation, expose measured actionable failures,
  and suppress futile automatic rebuilds until the generation changes. One
  hundred fifteen focused cases passed.
- **F10 — selectable Markdown recovery (`829dcf6`):** clipboard absence or
  refusal reveals the exact already-derived Markdown in a labelled readonly
  textarea, focuses and selects it, and returns focus after Done or Escape.
  Thirty-nine tests and two hidden Chrome runs passed; dark and light screenshots
  at the wide and 420×720 viewports were inspected without clipping or overflow.
- **F11 — truthful profile stop states (`683ca2e`):** Pause and Cancel publish
  requested state synchronously and abort owned Peakbagger reads and waits. A
  non-retractable GitHub batch is named, allowed to settle, counted, and followed
  by no later work. Thirty-eight core/runner/DOM tests, ESLint, and hidden Chrome
  passed.
- **F12 — authoritative backup completion (`fe68c6b`):** the persistent status
  refresh now completes before the success toast; a refresh failure produces
  matching recovery feedback while library rendering stays outside the
  completion-critical path. Three focused backup cases passed, and the final
  full suite passed without the original synchronization failure.

Final combined-tree verification recorded before archival:

- `npm test`: **1,486 passed, 0 failed**, after rebuilding all 27 `dist/`
  bundles.
- `npm run lint`: passed with the eight exact owner-reviewed warnings; no new
  error, notice, warning kind, file, or count was accepted.
- `npm run audit:ci`: passed only the two exact high `image-size` advisories in
  the development-only `web-ext`/`addons-linter` path through 2026-08-21.
- `npm run test:scale`: **6 passed**, covering the full Rainier table, 1,500
  favorites, the 20,000-point contract and contract+1 rejection, and a
  1,200-photo library.
- `npm run verify:browsers`: passed against the real unpacked extension in
  hidden Chrome for Testing 151.0.7922.34 new-headless and hidden Firefox
  153.0.4 at 1000×760. Fresh minified Chrome and Firefox archives each passed
  exact verification at 66 entries and then passed `verify:packages` in those
  isolated browsers.
- `npm run terrain:verify`: passed hidden at 798×448 and 448×448 on `ANGLE
  Metal Renderer: Apple M3 Pro`; wide, narrow dark, and failure-fallback
  screenshots were inspected. `npm run terrain:verify:firefox` passed hidden
  at 1000×760 on its reported Apple hardware renderer. Disposable screenshots,
  archives, certificates, and profiles were removed after inspection.

### Intentionally not changed

- The documented 128 MiB per-source Photo Topos input limit and separate 40 MiB
  project-archive limit remain distinct. They protect different operations and
  current evidence does not justify reopening that closed policy.
- A GitHub profile-backup batch already dispatched when Cancel is requested may
  finish. F11 preserves that non-idempotent boundary and changes cancellable
  reads/waits plus truthful feedback, not remote-write semantics.
- The reviewed 8 MiB `photo-library.json` ceiling remains in place pending an
  explicit capacity/data-migration decision. F9 changes early enforcement,
  one-pass representation, retry behavior, and user guidance.
- The eight owned `web-ext` warnings and two precisely accepted, development-
  only `image-size` advisories were neither introduced nor fixed here. The
  advisory exception expires 2026-08-21 and does not make the dependency graph
  clean.
- Previously closed 2026-08-08 findings remain closed unless implementation of
  this plan supplies new contrary evidence.
- No version bump, release tag, push, Chrome Web Store/AMO submission, or live
  remote write was performed. Those actions require separate release authority.

### Changed but not fully proven

- **F1, F7, F8, and F9:** deterministic IndexedDB interleavings, restart
  reconstruction, watchdog routing, and 1,200-record scale coverage prove the
  owned transaction contracts while the browser is running. Abrupt page,
  worker, browser, or OS termination at each persistence boundary and real
  low-memory devices were not exercised.
- **F2:** a current live style document was normalized and hidden hardware-GPU
  fixtures exercised installation and rollback. This does not guarantee future
  OpenFreeMap policy, availability, nested resource behavior, or other physical
  GPU/driver combinations.
- **F3:** fake responses prove deadlines, response caps, exact revision
  reconciliation, and no-replay decisions against the documented API schema.
  No live Chrome Web Store upload, timeout, submission, review, or publication
  was authorized.
- **F4 and F5:** adversarial readers and isolated extension runs prove local
  limits. No authenticated live Garmin, Strava, Peakbagger, GitHub, or ImgBB
  failure/oversize response was induced, and browser-native file-picker
  presentation was not inspected.
- **F6, F10, F11, and F12:** DOM behavior, packaged startup, and the stated
  screenshots passed, but hidden automation does not prove native clipboard or
  permission prompts, focus/window placement, screen-reader speech, touch,
  switch control, or physical-device behavior. F11 also leaves an already-
  dispatched GitHub mutation intentionally non-retractable.
- The two reviewed development-only `image-size` advisories remain accepted
  only through 2026-08-21; this is not a clean advisory graph. Legal review,
  privacy-policy sufficiency, package signing, store acceptance, and
  post-publication behavior remain release-owner evidence.
