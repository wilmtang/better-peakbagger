# UX and engineering audit follow-up — 2026-08-08

Status: **active remediation plan.** No runtime finding in this document has
been fixed by creating the plan. Close each item only with its focused source
change, adversarial regression proof, and the relevant verification below.

Baseline: clean `main` at `f236fd846193fbc993bf883c5663ab341a350e8a`, tagged
`v3.5.0` and aligned with `origin/main`. This audit reconciled the current tree
with the archived [2026-08-08 codebase audit](../archive/codebase-audit-2026-08-08.md).
Previously closed findings are reopened here only where the current source or a
deterministic probe disproves the archived invariant.

## Scope and evidence

The follow-up covered the capture popup and local-GPX entry point, trip-report
editor and draft manager, GPX Analyzer, Photo Topos editor/library and backup,
GitHub authorization, terrain tile cache, settings/filter surfaces, third-party
metadata, browser compatibility declarations, and the release workflow.

Current-turn verification established this baseline:

- `npm test`: **1,333 passed, 0 failed** after rebuilding all 27 `dist/`
  bundles.
- `npm run lint`: passed with the eight accepted warnings. The TipTap warning's
  owner text is itself stale and is tracked as F11.
- Ninety-one focused ascent-upload, options, and release tests passed.
- `npm run release:check-history` reported ten sections and
  `npm run release:check -- v3.5.0` passed on the unmodified tree.
- Deterministic built-bundle probes reproduced the local-GPX generation race,
  both draft Undo races, stale autosave status, descendant-GPX metric
  contamination, and the GitHub authorization-generation race.
- Source-level fault injection reproduced overlapping photo backups, a
  post-create photo-editor rollback leak, and an oversized/non-WebP DEM body
  being buffered and returned.
- The current GitHub repository rulesets, `browser-stores` environment, and the
  v3.5.0 release log were read on 2026-08-08 PDT. The release log reported only
  one immutable changelog section because its checkout was shallow.

No browser window was launched. The current turn did not prove native layout,
focus, screen-reader speech, touch, a physical mobile device, live provider
behavior, or store acceptance.

## Priority summary

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | P1 | report recovery | draft Undo can be followed by the original delete or overwrite a newer same-key autosave |
| F2 | P1 | local GPX | a delayed result for file A can apply after the user selects file B |
| F3 | P1 | GitHub authorization | delayed repository selection can cross Disconnect/reconnect and bind an old repository to a new account |
| F4 | P1 | release provenance | any pushed `v*` tag can reach store publication without proving protected-`main` ancestry |
| F5 | P2 | release history | shallow checkout and current-heading iteration create independent immutable-history false negatives |
| F6 | P2 | GPX integrity | the Analyzer still admits descendant-owned fake points after the capture parser was fixed |
| F7 | P2 | report recovery UX | a failed later autosave leaves an obsolete “Draft saved” claim visible |
| F8 | P2 | GPX failure UX | fetch and parse failures leave a blank focusable interactive chart and impossible instructions |
| F9 | P2 | photo recovery UX | Recently Deleted hides its 30-day loss-of-editability deadline and retained-asset state |
| F10 | P2 | photo recovery UX | ordinary and last-resort Copy URL actions fail silently when clipboard access is unavailable |
| F11 | P2 | release metadata | shipped dependency versions can diverge from reviewer notes, acknowledgements, docs, and warning ownership |
| F12 | P2 | photo backup | overlapping backups can both commit remotely and leave the local catalog marked failed |
| F13 | P2 | terrain resources | a successful DEM response is fully buffered without a per-tile byte or WebP-format bound |
| F14 | P2 | compatibility | declared browser floors are not exercised at those floors, and Chrome has no declared tested minimum |
| F15 | P2 | photo lifecycle | a failed return-context bind leaves an unusable Photo Topos tab open |
| F16 | P2 | photo resources | decoded-pixel limits do not bound encoded source bytes buffered for hashing and retained in IndexedDB |
| F17 | P3 | ascent filter UX | first use hides host rows by default and exposes two independent trip-report word thresholds |

P1 means a material data, identity, or release-provenance invariant is broken.
P2 is bounded but user-visible correctness, recovery, resource, or release
assurance debt. P3 is counterintuitive behavior with a visible escape hatch and
no demonstrated data loss.

---

## F1 — Make draft deletion and Undo one linearizable transaction

**Broken invariant.** Undo must serialize after the deletion it reverses, and
must never replace work saved after the deletion snapshot was taken.

**Evidence.** `options/drafts.js` (lines 88–107) writes the saved record
immediately. The single-delete path renders Undo before awaiting
`store.remove()` at lines 109–137; bulk deletion repeats the ordering at lines
291–336. `src/reports/report-editor.js` (lines 652–683) independently autosaves
the same identity key without a shared revision or conditional mutation.

Two controlled interleavings failed against the shipped bundle:

- a delayed remove completed after “Draft restored” and deleted the restored
  record; and
- a newer same-key editor autosave landed between Delete and Undo, then Undo
  replaced it with the older recovery snapshot.

The existing live-refresh test writes an `otherKey`, so it cannot detect the
same-key conflict.

**Remediation.** Give report drafts a shared storage owner with per-key revision
or generation semantics. Retain and await the delete operation before a restore
can run. Restore only when the key remains absent at the expected deletion
generation. If a newer record exists, preserve it and report that newer edits
already restored the draft. Apply the same contract to bulk deletion per key;
one conflict must not overwrite or suppress unrelated recoveries.

**Regression proof.** Add barriers for single and bulk delete at pre-remove,
post-remove, pre-restore, and post-restore boundaries. Cover immediate Undo,
same-key autosave, editor removal, two manager tabs, partial bulk conflicts,
storage failure, retry, expiry of the Undo window, and exact focus/status copy.
Do not announce `Draft restored` or return focus to the restored card until the
remove has settled; expose the pending mutation with appropriate disabled and
busy semantics.

## F2 — Invalidate local-GPX work when the selected file changes

**Broken invariant.** The GPX shown in the native file input must be the only
file whose analysis can mutate the form or open drafts.

**Evidence.** `src/ascent/ascent-upload.js` (lines 154–161) advances
`requestToken` only when restoring the native path; `showProcessButton()` at
lines 182–202 does not. The trusted change handler at lines 474–480 therefore
leaves a valid A request current when valid B is selected. The worker guard in
`src/background/background.js` (lines 1326–1404) begins only after B sends a
new `GPX_PROCESS_START`.

A delayed A response auto-applied `job-A` while the input displayed `B.gpx` and
only one processing request had been sent.

**Remediation.** On every trusted file change, advance the page generation,
clear pending result UI, and cancel or clear the worker-owned local-analysis
generation before exposing Process for the new file. Bind a result to both its
generation and an immutable file identity. Do not read or hash raw GPX merely
to establish identity before the user chooses Process.

**Regression proof.** Hold A at settings read, file read, worker lookup,
ready-result, and apply boundaries; select valid B without processing it and
assert no A card, form mutation, apply message, draft, or stale error survives.
Repeat with B processed, B cleared, a non-GPX B, Remove, tab navigation, and
extension-context failure.

## F3 — Bind GitHub repository selection to one credential generation

**Broken invariant.** A repository inspected with credential generation A must
not mutate generation B.

**Evidence.** `src/background/github-routes.js` (lines 358–395) reads a token,
awaits repository inspection, then calls `setRepo()` and
`setInstallationId()` without checking `githubAuthEpoch`. Disconnect increments
that epoch at lines 398–403. `src/github/github-auth.js` (lines 285–289 and
330–334) merges each patch into whichever authorization record is current.

A barrier probe delayed old-account inspection across Disconnect and reconnect;
the final status was connected as the new account with the old repository.

**Remediation.** Snapshot the complete authorization record and epoch before
inspection. After inspection, compare-and-set one replacement containing the
repository and installation ID only if the token/account generation is
unchanged. Treat a stale completion as superseded, never disconnected or
successful. Apply the same review to repository discovery/reconciliation.

**Regression proof.** Cover disconnect only, disconnect/reconnect to the same
account, reconnect to another account, credential import, a second selection,
existing-repository confirmation, worker restart, and storage failure at every
mutation. Assert the token never leaves the worker response.

## F4 — Require protected-main provenance before a store release

**Broken invariant.** Store publication must be reachable only from the exact
reviewed commit integrated into protected `main`, through one intentional tag.

**Evidence.** `.github/workflows/release.yml` (lines 3–6) runs for every pushed
`v*` tag. `scripts/release-check.mjs` (lines 80–88) proves only tag-to-`HEAD`
equality. `scripts/release-bump.mjs` (lines 65–85) has no branch, clean-tree,
staged-index, upstream, or existing-tag preflight and recommends
`git push origin main --tags`. `docs/releasing.md` (lines 156–160) repeats that
broad push. The current remote has a protected-default-branch ruleset but no
tag ruleset; the `browser-stores` environment admits `v*` tags and has no
reviewers.

The bump also derives its changelog date from UTC. That produced a 2026-08-09
heading for a release committed on 2026-08-08 PDT without documenting UTC as
the project policy.

**Remediation.** Make the local bump fail unless the worktree and index are
clean, the branch is `main`, `HEAD` equals the intended `origin/main`, and the
tag is absent. Separate metadata stamping from commit/tag creation so all gates
run before the tag exists. Push `main` and only the exact new tag atomically.
In the workflow, fetch `origin/main` and require the tag commit to be an
ancestor. Add a protected `v*` tag ruleset and an appropriate store-environment
approval policy as owner-controlled remote changes. Define changelog dates as
UTC explicitly or accept an explicit release date/project timezone.

Before rerunning a failed store job, require a store-state check that determines
whether the version was already created or consumed; a failed client request
is not evidence that submission did not happen.

**Regression proof.** Exercise feature branch, detached HEAD, dirty worktree,
pre-staged unrelated file, diverged upstream, existing/annotated tag, unrelated
local tags, non-main tag ancestry, atomic-push command construction, and UTC
boundary dates. Inspect both stores before any injected post-upload retry.

## F5 — Compare every tagged changelog section under full history

**Broken invariant.** Every locally known release tag must have one unchanged
section in the current changelog, and the release job must possess the history
needed to prove that statement.

**Evidence.** The release checkout at `.github/workflows/release.yml` (lines
20–21) uses the default shallow depth before running the history check at lines
35–36; v3.5.0 logged `Verified 1 immutable changelog sections.` Main CI uses
`fetch-depth: 0`, but release CI does not. Independently,
`scripts/check-changelog-history.mjs` (lines 15–24) starts from versions still
present in the current changelog. Deleting the complete 3.4.0 section therefore
removed it from the comparison loop; the production assertion passed while the
`v3.4.0` tag remained.

**Remediation.** Fetch full tag history in release CI. Enumerate exact semver
release tags as the authority, read each tag's changelog, require its own
section, require the current section, and compare them byte-for-byte. Fail when
tag coverage is unexpectedly incomplete rather than accepting “at least one.”

**Regression proof.** Cover full-section deletion, renamed/malformed heading,
tag present only remotely, tag without a changelog, current release addition,
shallow repository, and a complete ten-tag fixture. Parse the workflow
semantically or add actionlint; do not let a YAML comment satisfy the guard.

## F6 — Use one direct-owned GPX parse for Analyzer geometry and metrics

**Broken invariant.** The capture parser, displayed route, chart, and statistics
must consume exactly the same GPX-owned tracks, segments, and points.

**Evidence.** The corrected `src/gpx/gpx-parse.js` (lines 102–116) requires a
root `gpx` and direct `trk` → `trkseg` → `trkpt` ownership. The Analyzer still
collects descendant `trkseg` in `src/gpx/gpx-analyzer.js` (lines 45–52) and
descendant `trkpt` at lines 1386–1418. An extension-owned point receives
fallback coordinate group zero for metrics while the map's direct-child pass
omits it. A two-point probe containing an extension-owned `(0, 0)` point
displayed 24,588.62 km while the map route retained only the two direct points.

This reopens the Analyzer half of archived F21; commit `bee3314` changed the
parser/provider path but not this Analyzer collection.

**Remediation.** Expose a shared document parser that returns direct-owned
segments with quality-aware points. Consume that one result for map geometry,
chart data, metrics, camping/day derivation, and capture serialization. Keep
source order and legitimate repeated points; do not deduplicate after a broad
descendant search.

**Regression proof.** Add default and prefixed namespaces, wrong root, multiple
tracks, extension-owned point, nested track/segment, misplaced waypoint,
repeated legitimate point, partial elevation/time, and parser/Analyzer parity
fixtures. Assert route point counts, breaks, distances, gain, chart values, map
geometry, and capture lookup boxes agree.

## F7 — Make the report autosave indicator describe the latest edit

**Broken invariant.** Persistence copy must describe the newest editor state,
not the most recent historical write that happened to succeed.

**Evidence.** Edits schedule autosave in `src/reports/report-editor.js` (lines
598–602). Success sets “Draft saved on this device” at lines 673–682, while the
catch at line 683 silently retains that text. An injected second-write failure
left storage on `first saved version`, the editor on `newer unsaved version`,
and the old saved timestamp visible.

**Remediation.** Mark the draft dirty on every meaningful edit, transition
through `Unsaved changes`, `Saving…`, and `Saved`, and surface persistent
storage failure without removing live form content. Offer actionable
keep-this-page-open and copy-Markdown recovery; do not use a transient toast as
the only failure signal.

**Regression proof.** Cover first-write and later-write failure, quota and
unavailable storage, recovery on a subsequent save, mode switch, pagehide,
empty/credit-only draft removal and failed removal, pending native Save, and
terminal confirmed submission. Assert status/live-region text and stored
content separately.

## F8 — Remove unavailable GPX chart semantics on terminal failure

**Broken invariant.** A terminal error must not leave focusable controls or
assistive instructions for a chart that does not exist.

**Evidence.** `src/gpx/gpx-analyzer.js` (lines 220–275) creates a visible 300 px
canvas with `tabindex="0"`, `role="application"`, arrow-key instructions, and
coordinate controls before the GPX resolves. Fetch failure at lines 1376–1384
and parse failure at lines 1490–1493 change only status text. Known no-data
states correctly hide the chart and controls.

**Remediation.** Route every terminal fetch, parse, invalid-root, and no-data
outcome through one `renderUnavailable()` owner that destroys any chart, hides
canvas/legend/coordinate controls, clears stale values and terrain/route state,
and leaves one actionable error. Preserve retry only where a real retry exists.

**Regression proof.** Assert DOM semantics for signed-out, 404, challenge HTML,
invalid XML, invalid root, timeout, no points, no valid points, and a successful
retry. Verify keyboard tab order and live-region announcements at wide and
narrow page sizes. Exercise the terminal states through a hidden real-unpacked
extension fixture over HTTPS and assert that no chart role, tab stop, or
arrow-key instructions remain.

## F9 — Disclose and represent Photo Topos deletion expiry honestly

**Broken invariant.** A reversible destructive action must state when
reversibility ends and what a later Restore can recover.

**Evidence.** The confirmation and toast in `photos/photos.js` (lines
2081–2113) do not mention expiry. Maintenance at lines 2259–2272 prunes assets
after the 30-day constant at line 26. `src/photos/photo-store.js` (lines
564–599) removes the original, project, and thumbnail while retaining the
catalog record. Deleted cards at `photos/photos.js` (lines 2153–2177) always
offer generic Restore without expiry or retained-asset state.

**Remediation.** State “restorable with editing data for 30 days” in the
confirmation and result. Show deletion and expiry dates plus local/remote asset
state in Recently Deleted. After pruning, disable editing recovery and relabel
the action `Restore record only`, or remove local-only records that have no
remaining useful recovery path after an explicit policy decision.

**Regression proof.** Cover local-only, uploaded, unreachable, referenced,
pre-expiry, exact-expiry, post-prune, restored-before-maintenance, and backup
metadata cases. Inspect both themes and narrow/wide library cards.

## F10 — Give every Photo Topos URL copy a selectable fallback

**Broken invariant.** A recovery action must either confirm success or leave
the recovery value accessible without the failed API.

**Evidence.** Committed and ambiguous upload recovery toasts call unchecked
`navigator.clipboard.writeText()` in `photos/photos.js` (lines 1747–1785).
Ordinary library copy at lines 1878–1882 also rejects without feedback and is
invoked fire-and-forget from the card. The GitHub device-code and GPX coordinate
surfaces already implement a selectable fallback.

**Remediation.** Reuse one extension-owned `copyTextWithFallback()` behavior.
On missing or rejected clipboard access, reveal a focused read-only field,
select its complete URL, and announce manual-copy instructions. Keep the URL
visible indefinitely for ambiguous/committed upload recovery.

**Regression proof.** Cover success, missing API, synchronous throw, rejected
promise, lost focus, repeated click, extremely long signed URL, toast
replacement, and both ordinary and last-resort recovery paths. Assert that no
unhandled rejection occurs and that no URL is copied or announced after its
owning recovery surface has been replaced.

## F11 — Derive reviewer and maintained dependency versions from the lock

**Broken invariant.** Reviewer metadata, public acknowledgements, maintained
technical documentation, and audited-warning ownership must match the exact
package bytes shipped by the release.

**Evidence.** `package-lock.json` records Marked 18.0.9 and TipTap core 3.29.2.
`scripts/create-amo-metadata.mjs` (line 52), `ACKNOWLEDGEMENTS.md` (lines
59–78), `docs/trip-report-editor.md` (lines 150–159), and
`test/project/release.test.mjs` (lines 187–194) preserve Marked 18.0.6.
`scripts/check-web-ext-lint.mjs` (lines 52–57) and the acknowledgements preserve
TipTap 3.28.0. Generated `THIRD_PARTY_NOTICES.txt` and copied runtime bytes are
current, so the defect is false human/reviewer metadata rather than stale code.

**Remediation.** Build approval-note dependency records from the lockfile and
the generated notice inventory, with reviewed templates for how each component
is used. Generate or parity-check acknowledgements and maintained exact-version
references. Bind warning-owner acceptance to the resolved package/version and
warning fingerprint so a dependency update requires renewed review rather than
merely matching the old file/count.

**Regression proof.** Test every exact version named in reviewer notes,
acknowledgements, focused docs, copied-vendor descriptions, and audit
acceptances against the lock and notice inventory. Simulate a dependency-only
update and require metadata drift to fail.

## F12 — Serialize the complete photo-backup transaction

**Broken invariant.** A confirmed remote commit must not be downgraded to local
failure merely because another backup advanced the local catalog revision.

**Evidence.** `src/background/github-routes.js` (lines 1249–1257) snapshots the
catalog before `writeQueue.run()`. Only `updateRootFile()` is inside that queue
at lines 1257–1280; backup-state write and per-photo revision stamping occur
after it at lines 1281–1297. A stale expected revision conflicts in
`src/photos/photo-store.js` (lines 456–480), and the catch marks the catalog
failed. Two overlapping manual/automatic backups produced two remote commits,
results `true,false`, and final local backup state `failed`.

**Remediation.** Serialize snapshot → merge → remote commit → backup-state
write → catalog reconciliation as one owned operation. If holding the full
queue across local reconciliation is undesirable, journal `remote committed,
local reconciliation pending` and repair idempotently. Never mark the whole
catalog failed solely because a confirmed remote commit raced a newer local
revision.

**Regression proof.** Barrier-test manual/manual, manual/automatic,
automatic/alarm, unchanged coalescing, edit during commit, delete/restore during
commit, worker restart after remote commit, state-write failure, partial catalog
stamping, and retry. Assert remote commit count, final signature, per-photo
status, and truthful UI independently.

## F13 — Bound and validate each DEM response before buffering

**Broken invariant.** A provider response must obey a small per-tile resource
and format contract before it can consume memory, reach MapLibre, or enter the
cache.

**Evidence.** `src/terrain/terrain-cache.js` (lines 240–254) accepts any
successful response and awaits `arrayBuffer()` before applying the total cache
budget. It does not preflight Content-Length, stream to a limit+1 boundary,
check Content-Type, or validate WebP bytes. A probe configured with a 1 MiB
cache returned a 2 MiB `application/octet-stream` body intact.

**Remediation.** Define a measured per-tile encoded-byte maximum. Reject an
oversized honest Content-Length before reading, otherwise stream with a
limit+1 abort under the existing deadline. Require an accepted image media type
and validate the WebP RIFF signature before returning or caching. The rule must
apply even when caching is disabled.

**Regression proof.** Cover exact limit, limit+1, missing/dishonest
Content-Length, chunked overflow, empty/truncated body, incorrect type, invalid
RIFF/WebP signature, cancellation, timeout, provider 404, cache hit, zero cache,
and multiple concurrent tiles. Re-run both hardware terrain suites and assert
the renderer is not software.

## F14 — Test or raise every declared browser compatibility floor

**Broken invariant.** A minimum version in the manifest is a supported-runtime
promise and must be exercised, not inferred from the current browser.

**Evidence.** `manifest.json` (lines 301–313) declares Firefox desktop 140.0
and Android 142.0. `.github/workflows/test.yml` (lines 114–132) and
`.github/workflows/release.yml` (lines 73–94) install Firefox latest only. The
manual desktop check names Firefox Stable. `scripts/build.mjs` (lines 98–116)
targets Chrome 110 and Firefox 115 syntax, while the manifest declares no
Chrome minimum and CI tests current Chrome for Testing.

**Remediation.** Add a packaged Firefox 140 smoke alongside latest, or raise
the advertised desktop floor to the oldest version actually verified. Declare
the intended Chrome minimum and exercise its packaged extension, or explicitly
limit the build target to the maintained promise. Keep the physical Firefox
Android 142+ release check; desktop automation cannot replace it.

**Regression proof.** Run package installation, worker boot, settings bridge,
local GPX selection, report editor, and one storage/message handshake on each
declared desktop floor and latest browser. Record exact versions and keep mobile
layout/device behavior as a separate manual result.

## F15 — Roll back the created Photo Topos tab when context binding fails

**Broken invariant.** A failed `PHOTO_EDITOR_OPEN` transaction must leave
neither a return context nor an unusable tab.

**Evidence.** `src/background/photo-routes.js` (lines 154–188) stores a return
context, creates the tab, then performs a second context mutation to bind the
tab ID. The catch at lines 189–195 deletes only the context. Fault injection
after successful tab creation returned `ok=false`, an empty context map, and no
tab removal.

**Remediation.** Track the created tab ID and independently best-effort close it
on every later failure. Delete the context and close the tab with bounded
`Promise.allSettled` cleanup so one rollback failure cannot suppress the other;
log owned cleanup failures without exposing raw errors.

**Regression proof.** Inject failure before context creation, tab creation,
context bind, response, context cleanup, and tab cleanup. Assert exact retained
contexts/tabs and retry behavior at every boundary.

## F16 — Add an encoded-source budget for Photo Topos

**Broken invariant.** A decodable image must still have a bounded source-byte
cost for hashing, memory, and persistent local storage.

**Evidence.** `photos/photos.js` (lines 1468–1486) intentionally has no input
size gate because upload output is re-encoded from decoded pixels. The decoded
64-megapixel and per-axis constraints do not bound metadata or trailing bytes.
`src/photos/photo-renderer.js` (lines 221–224) buffers the entire Blob for
SHA-256, and `photos/photos.js` (lines 1509–1536) retains and schedules the
original for IndexedDB persistence.

**Remediation.** Add a separate, generous encoded-source processing/storage
ceiling based on measured browser and quota behavior; do not reuse the smaller
upload or project-download limits. Preflight storage quota where available and
use an incremental hash path if supported by the selected implementation.
Explain the limit in source-import copy and preserve the user's original file
outside the extension.

**Regression proof.** Cover normal large photos, exact limit, limit+1, a small
decoded image with oversized metadata/trailing bytes, unavailable quota,
hashing failure, persistence quota failure, and cleanup of partially prepared
state. Measure peak memory rather than assuming streaming from API shape.

## F17 — Preserve the host ascent list until the user chooses a filter

**Broken invariant.** Installing the extension should not silently make valid
host records disappear, and two controls that look like one threshold should
not have independent meanings.

**Evidence.** `src/ascent/ascent-filter.js` (lines 42–50) defaults `beta` to
true, so first use hides every ascent that does not match the extension's beta
definition. The active chip and `Showing X of Y` status make this recoverable.
The global Has-beta trip-report threshold is owned by
`src/settings/settings-schema.js` (lines 85–121), while the visible inline Trip
report threshold is independently stored at `src/ascent/ascent-filter.js`
(lines 749–752 and 888–904). Both can be active and AND-compose; changing the
visible number does not redefine Has beta.

**Remediation.** Default all filters off for users without remembered page
state, or provide an explicit one-time choice before hiding rows. Prefer one
threshold owner. If both product concepts remain, label the inline control
`Trip report filter: ≥ N words` and surface the active Has-beta definition near
its chip instead of relying on a hover tooltip.

**Regression proof.** Cover first visit, remembered old state, corrupted
storage, settings changes, both thresholds active, zero matches, year-section
collapse, keyboard navigation, and narrow/wide layouts. Verify no flash of
unfiltered/filter-reordered rows at startup.

## Execution order and focused commit boundaries

Each item is a focused, independently verified commit. Do not bundle unrelated
findings or start the next unit with a knowingly incomplete prior one.

1. **Make release evidence complete (F5).** Switch to tag-owned enumeration and
   full checkout; prove deletion and shallow-history failures. The ancestry
   gate in the next step must not be built on a shallow clone.
2. **Block unsafe release entry points (F4).** Land local preflight, workflow
   ancestry, exact-tag push instructions, date policy, and tests. Apply remote
   tag/environment protections only with explicit owner authorization and
   record them separately from repository changes.
3. **Eliminate dependency metadata drift (F11).** Derive versioned reviewer and
   warning-owner data from the lock/notice graph before another dependency
   release.
4. **Exercise compatibility floors (F14).** Establish or revise the supported
   browser matrix before runtime refactors depend on newer APIs.
5. **Repair draft mutation ownership (F1).** Introduce the smallest per-key
   generation/CAS store and migrate manager/editor mutations together.
6. **Make autosave feedback truthful (F7).** Build on the shared draft owner;
   keep status behavior as a separate reviewable UI commit.
7. **Restore one GPX ownership tree (F6).** Land shared document ownership and
   Analyzer/capture parity before changing request generations.
8. **Invalidate replaced local-GPX work (F2).** Apply page and worker generation
   changes with delayed-result coverage.
9. **Unify terminal Analyzer failures (F8).** Remove stale semantics and inspect
   rendered wide/narrow error states.
10. **Close GitHub credential-generation races (F3).** Reuse conditional auth
    replacement rather than adding another mutable token/repository path.
11. **Serialize photo backup end-to-end (F12).** Treat remote commit and local
    reconciliation as one journaled transaction.
12. **Make photo return opening failure-atomic (F15).** Keep tab/context rollback
    independent and fault-tested.
13. **Finish photo recovery UX (F9, then F10).** Establish deletion asset-state
    semantics before changing card copy, then share clipboard fallback behavior.
14. **Bound photo source processing (F16).** Measure and document the separate
    source-byte ceiling; do not conflate it with upload output.
15. **Bound DEM bodies (F13).** Add the streaming/format gate and run hardware
    terrain verification before proceeding.
16. **Clarify first-use filtering (F17).** Treat the default and threshold model
    as a product decision, with default-off as the recommended safe behavior.
17. **Release rehearsal.** From a clean protected-main candidate, run every gate
    below, inspect fresh packages and metadata, and create no tag or store
    submission until the closure ledger is complete.

## Final verification matrix

Close the plan only after recording exact commands, results, browsers,
renderers, viewports, and remaining evidence gaps.

- Run focused barrier/fault tests beside every affected owner, then `npm test`,
  `npm run lint`, `npm run audit:ci`, and `npm run test:scale`.
- Run `npm run verify:browsers` hidden against the real unpacked `dist/` after
  GPX, background, report, photo, settings, or manifest changes.
- Build fresh Chrome and Firefox archives; run exact archive verification and
  `npm run verify:packages` before any release tag.
- Run the packaged Firefox floor and latest-browser matrix added by F14. Record
  the exact versions. Keep Firefox Android 142+ as a physical-device release
  check.
- Run `npm run terrain:verify` and `npm run terrain:verify:firefox` hidden on
  reported hardware renderers after F13. Fail closed on software rendering and
  inspect verifier-owned teardown.
- Render and inspect GPX terminal states, draft status states, Recently Deleted,
  clipboard fallback, and ascent filtering at maintained wide and narrow
  viewports in both themes. DOM assertions alone do not prove clipping,
  wrapping, focus appearance, or visual hierarchy.
- Perform keyboard-only checks for every changed recovery action. Record native
  screen-reader speech, touch, switch control, and physical-device behavior as
  unproven unless actually exercised in dedicated test profiles/devices.
- Run `npm run release:check-history` in a full-history clone and the focused
  whole-section-deletion/shallow-history fixtures. Confirm the count equals the
  exact semver tag inventory.
- Generate AMO metadata and acknowledgements from the candidate lockfile;
  compare every named dependency with the packaged notice inventory and copied
  bytes. Owner/legal review remains separate from mechanical version parity.
- Verify repository tag rules and release-environment protection immediately
  before publication. If a store request fails after upload begins, inspect the
  store's version state before deciding whether a rerun is safe.
- Keep live Garmin, Strava, Peakbagger, ImgBB, GitHub, Mapterhorn, and browser
  store checks minimal and separately recorded. Synthetic fixtures do not prove
  live provider behavior.

## Initial closure ledger

### Fixed and verified

- None. This document records an audit and execution plan only.

### Intentionally not changed

- Popup selection remains locked after draft opening starts. The current lock
  preserves draft identity, explains how to reset, and keeps opened drafts
  discoverable; loosening it would reintroduce a closed transaction defect.
- `Show all` remains a remembered action. Its tooltip and subsequent active
  state expose persistence; the first-use default and threshold model are the
  actual F17 issues.
- Peakbagger Save remains manual and user-owned. No verifier should click Save
  merely to prove report-draft consumption.
- The generated third-party notice inventory and shipped Marked/TipTap bytes are
  current. F11 concerns duplicated reviewer/public metadata, not stale runtime
  artifacts.
- The total terrain cache setting is not itself replaced by F13. The new bound
  applies to each response before the existing cache policy.

### Changed but not fully proven

- None. No runtime or configuration remediation has begun.

When implementation starts, move every completed item into exactly one ledger
category. Do not archive the plan or describe it as fully fixed while an owner
decision, remote configuration change, live-provider check, legal review, or
native/device verification remains open.

## Current proof gaps

- No live authenticated Garmin, Strava, Peakbagger, ImgBB, GitHub backup, or
  Mapterhorn failure path was exercised in this audit.
- No browser window was launched, so native focus, browser chrome, permission
  prompts, screen-reader speech, touch, and physical-device layout remain
  uninspected.
- The concurrency probes control browser/storage promises while the process is
  alive; they do not establish durability across an actual browser or OS crash.
- Current GitHub ruleset/environment observations can drift. Re-query them at
  implementation and release time.
- Mechanical dependency/version parity does not establish license sufficiency.
  Owner or counsel review remains required before release.
- No release tag, push, remote-rule mutation, store submission, or live data
  mutation is authorized by this plan.
