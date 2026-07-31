# Codebase audit — 2026-07-30

Status: **remediation complete and verified.** This archived document records
the original eight findings—three P1, three P2, and two P3—and the work that
closed them. No P0 issue was found. The [closure ledger](#closure-ledger)
separates fixed behavior from intentional non-changes and proof that still
requires live services, native browser UI, or physical devices.

Baseline: clean local `main` at `cccd048`, 101 commits after the `v3.2.0` tag and
15 commits ahead of `origin/main`.

Archived documents are point-in-time records and were not treated as maintained
descriptions of current behavior. Prior audits were used only to avoid reopening
closed findings without current evidence. Runtime claims below were checked
against the current source, tests, built extension, and living documentation.

## Scope and evidence

This pass covered:

- 102 JavaScript runtime-source files across `src/`, `options/`, `popup/`, and
  `photos/`;
- the background worker, provider capture, GPX processing, prepared drafts,
  report editor, photo editor/library, GitHub and ImgBB integrations, favorite
  climbers, settings/theme, map/terrain, and Peakbagger request boundaries;
- `manifest.json`, `scripts/build-config.mjs`, package and dependency state,
  extension lint, browser verification, and scale/graphics checks;
- 95 test files and their relationship to the current production owners;
- 54 Markdown documents, with maintained documents checked separately from the
  historical material in `docs/archive/`;
- the 25,154 added lines and 5,475 removed lines since the preceding 2026-07-26
  audit baseline, with special attention to the newly introduced Photo Topos
  workflow.

Evidence collected:

- `npm test`: **1,047 passed, 0 failed**.
- `npm run lint:js`: passed.
- `npm run lint`: passed with the six exact owned cross-browser/vendor warnings.
- `npm run test:scale`: **4 passed, 0 failed**, including the 20,000-point
  provider-track case and the 1,500-entry favorites surfaces.
- `npm run verify:browsers`: passed with the real unpacked `dist/` in hidden
  Chrome for Testing and hidden Firefox.
- `npm run terrain:verify`: passed hidden on the Apple M3 Pro Metal renderer at
  798×448 and 448×448.
- `npm run terrain:verify:firefox`: passed hidden at 1000×760, including terrain,
  basemap, route, peaks, scroll zoom, right drag, Ctrl-drag, and resize.
- `npm run terrain:lod`: failed twice on the already-documented 67°→70° residual:
  122 ms and 161 ms against the 120 ms budget.
- `npm run audit:ci`: passed its exact, expiring development-only acceptance.
- `npm audit --omit=dev --json`: zero runtime findings.
- A maintained-document target check found one missing file target; a fragment
  check found no broken maintained-document fragments.
- Focused executable probes reproduced the upload-state downgrade and the
  project-archive write/read contradiction described below.

All browser and graphics checks ran hidden. They do not prove native browser
chrome, permission-prompt presentation, focus/window placement, touch behavior,
or physical-device behavior. Teardown inspection found no remaining test
browsers, debugging processes, or disposable profiles.

## Priority summary

| ID | Severity | Category | Finding | Status |
| --- | --- | --- | --- | --- |
| F1 | P1 | upload transaction | A known successful ImgBB upload can be overwritten as `outcome-unknown` after a downstream failure | Fixed and verified |
| F2 | P1 | editor consistency | The photo editor remains mutable while export/upload commits an older snapshot | Fixed and verified |
| F3 | P1 | capture recovery | Provider GPX fetch has no deadline, and Cancel does not release the blocked process for retry | Fixed and verified |
| F4 | P2 | archive contract | The extension can download a project bundle that its own reader refuses to reopen | Fixed and verified |
| F5 | P2 | import robustness | Imported metadata can request a canvas up to 100,000×100,000 without matching decoded pixels | Fixed and verified |
| F6 | P2 | privacy disclosure | Public documentation falsely says neither extension page can read a saved ImgBB key | Fixed and verified |
| F7 | P3 | scalability | Photo-library rendering is an unbounded sequential N+1 IndexedDB path | Fixed and verified |
| F8 | P3 | documentation | The active-plan index and maintained source/test pointers have drifted | Fixed and verified |

Severity is impact and urgency, not implementation effort. P1 is a material
data-integrity or recovery defect. P2 is a bounded but user-visible correctness,
privacy-contract, or robustness defect. P3 is maintainability, scalability, or
documentation debt that should be corrected before it compounds.

---

## F1 — A successful upload can be overwritten as `outcome-unknown`

**Severity: P1 · upload transaction and recovery**

### Evidence

[`photos/photos.js`](../../photos/photos.js) correctly treats the ImgBB response
and local catalog commit as separate transaction stages:

1. It receives and journals the provider response.
2. It constructs the uploaded catalog record.
3. `store.commitUpload()` atomically writes the uploaded record and delete URL.
4. It journals `catalog-committed`.
5. Only then does it insert into a report and record the reference.

The problem is the single catch around all five stages. Once `providerResponse`
is non-null, **any** later exception enters:

```js
if ((publicFailure.ambiguous || providerResponse) && uploadingPhoto) {
    photo = Library.markOutcomeUnknown(uploadingPhoto);
    await store.putPhoto(photo).catch(() => {});
}
```

`uploadingPhoto` is the stale pre-success record. `markOutcomeUnknown()` strips
the export metadata and public URLs by design. The catch therefore overwrites a
known, committed success when any of these later operations fails:

- writing the `catalog-committed` journal state;
- returning the image to the report;
- recording the report reference;
- deleting the operation journal.

The UI then says cataloging failed even when cataloging already succeeded.
`recoverOperations()` handles `request-started` and `response-received`, but
does not resolve or delete a lingering `catalog-committed` operation. After
reload, the downgraded record and orphaned journal remain inconsistent.

A focused pure-state probe reproduced the loss: a valid uploaded record with
public URL and export metadata became `outcome-unknown` with `export: null`.

This contradicts the living contract in
[`docs/photo-topo-editor.md`](../photo-topo-editor.md), which says:

- an insertion failure leaves the uploaded catalog record intact; and
- upload and backup state remain independent.

The archived feature acceptance also required that upload success not disappear
because report insertion failed. That historical statement matches the current
living contract, but the runtime does not.

### Remediation

Split the transaction at the irreversible boundary:

1. Before a validated provider response/local commit, classify failures as
   refused, ambiguous, or retryable.
2. After `commitUpload()` succeeds, never call `markOutcomeUnknown()`.
3. Treat report insertion/reference persistence as a separate operation whose
   failure leaves `photo.remote.state === "uploaded"`.
4. Make `catalog-committed` recovery idempotently preserve the committed
   catalog record and remove or resume only the pending insertion step.
5. Ensure journal-cleanup failure cannot change catalog semantics.

### Required regression coverage

- Drive the real page orchestration with a successful ImgBB response and failed
  `PHOTO_INSERT_COMMIT`; assert the catalog retains URL/export/delete secret.
- Inject failures into reference persistence and operation deletion after
  commit; assert they do not downgrade remote state.
- Reload with a `catalog-committed` journal and verify idempotent cleanup or
  insertion recovery without another upload.
- Assert the user-facing failure copy distinguishes “uploaded but not inserted”
  from an ambiguous provider outcome.

---

## F2 — The editor remains mutable while upload commits an older snapshot

**Severity: P1 · editor consistency and lost edits**

### Evidence

`setBusy()` in [`photos/photos.js`](../../photos/photos.js) disables only:

- Upload;
- file selection;
- project import; and
- API-key save.

It does not disable or guard:

- title or image description;
- Undo/Redo;
- the inspector controls;
- reorder, duplicate, delete, and Clear;
- tool selection and route completion;
- keyboard deletion, nudging, Undo/Redo, or tool shortcuts.

Pointer-down is the only edit path that checks `busy`. The mutation helpers,
field handlers, inspector handlers, and keyboard handlers do not. `setBusy()`
also does not call `updateHistoryButtons()`, so already-enabled Undo/Redo buttons
stay enabled.

`Renderer.exportProject()` cleans and captures the project passed at the start
of export. The page then awaits encoding, IndexedDB work, and a network request
that may last up to two minutes. Edits during that interval can:

- remain visible but not enter the uploaded raster;
- update the in-memory project after the upload snapshot;
- schedule a draft write while the stored record is transitioning through
  `uploading`;
- change title/alt text that is then replaced by the older `uploadingPhoto`
  record at commit;
- appear saved in the UI even though published-state autosave subsequently
  refuses them.

The result can be a different raster, alt text, title, or annotation project in
the editor, local catalog, and report.

The page behavior suite exercises gestures and autosave, but it does not attempt
edits during export, provider upload, catalog commit, or insertion.

### Remediation

Create one immutable upload snapshot after the required draft save:

- snapshot the cleaned project, source bitmap/blob identity, title, alt text,
  and export settings;
- disable every mutating control and mutation shortcut while that snapshot is
  being exported and committed, or explicitly queue edits as a new local
  revision;
- make all mutation helpers fail closed when `busy`, not only pointer-down;
- cancel any scheduled autosave before beginning the upload transition;
- call `updateHistoryButtons()` whenever busy state changes; and
- after completion, render the exact committed snapshot or explicitly reopen
  later edits as a new version.

### Required regression coverage

- Hold export and upload on controllable promises, attempt every mutation family,
  and prove the project/catalog/report cannot diverge.
- Verify title and description edits cannot be silently lost.
- Verify keyboard mutation paths obey the same busy contract as buttons.
- Run the packaged page visually to confirm disabled state, focus treatment, and
  progress copy in Chrome and Firefox at desktop and narrow widths.

---

## F3 — Provider GPX fetch has no deadline, and Cancel cannot unblock retry

**Severity: P1 · capture liveness and recovery**

### Evidence

[`src/capture/provider-page.js`](../../src/capture/provider-page.js) performs
the authenticated Garmin or Strava export with plain `fetch()` followed by
`response.text()`. It has no deadline, abort controller, or caller signal.

The background worker awaits that page-world promise through
`scripting.executeScript()`. Cancel removes the session job but does not abort
the page fetch or remove the entry from the worker's `processes` map. A later
capture for the same tab sees that entry and awaits the old process before it
can create a replacement.

Therefore a black-holed provider connection produces this sequence:

1. capture remains pending;
2. the user chooses Cancel;
3. the popup discards the visible job;
4. retry waits on the original unresolved fetch;
5. only navigating or closing the provider tab reliably tears the work down.

The shared request-deadline module says every third-party request must be
bounded. The test named “every third-party transport bounds its requests” is a
hand-maintained allowlist and omits `capture/provider-page.js`. It also allows
the map-marker client to maintain its own abort timer without making that
exception explicit in the inventory.

### Remediation

- Bundle the shared request-deadline module into `provider-page.js`, or add a
  provider-specific adapter that uses the same primitive.
- Bound the whole response exchange, including `response.text()`.
- Add a capture-generation/cancellation token so the worker can signal the
  page-world request to abort.
- Remove or replace the `processes` entry immediately on cancellation while
  retaining late-result guards.
- Make the transport-inventory test discover fetch owners mechanically or
  maintain one explicit registry consumed by both the build and test.

### Required regression coverage

- A never-settling provider `fetch()` must end in a bounded public timeout.
- A never-settling body read must time out too.
- Cancel followed immediately by retry must start a new capture without waiting
  for the abandoned promise.
- A late result from the cancelled generation must not recreate or overwrite
  the new job.
- Both Garmin and Strava endpoint/header contracts must remain unchanged.

---

## F4 — The extension can write a project archive it refuses to read

**Severity: P2 · project portability and documentation contract**

### Evidence

The current editor deliberately has no source-size gate. A large source may
decode and re-encode to an upload small enough for the user's ImgBB account, so
the provider now decides the upload ceiling.

The CSP-safe archive format still assumes the former fixed ceiling:

- `createProjectArchive()` does not enforce `MAX_ARCHIVE_BYTES`;
- `readStoredZip()` rejects every archive larger than 40 MiB;
- the comment describes that 40 MiB as room for a source under the old 32 MiB
  ImgBB limit.

A focused probe created a project archive from a 41 MiB original:

```text
original: 42,991,616 bytes
archive:  42,991,984 bytes
reader maximum: 41,943,040 bytes
re-import: rejected by ArchiveError
```

The UI and living docs disagree with both implementations:

- `photos/photos.html` says “Up to 32 MB”;
- `README.md`, `PRIVACY.md`, `docs/architecture.md`, and
  `docs/photo-topo-editor.md` describe a fixed 32 MiB limit;
- `photos/photos.js` and `src/photos/imgbb-client.js` intentionally enforce no
  local upload-size limit;
- the archive reader enforces a separate 40 MiB limit.

There are currently three incompatible contracts: 32 MiB, 40 MiB, and whatever
the browser/provider accepts.

### Remediation

Choose and document separate bounds for separate resources:

- source decode/import;
- raster export;
- ImgBB upload;
- downloadable project archive; and
- project archive import.

At minimum, the writer must never emit an archive the reader rejects. If project
portability intentionally has a lower ceiling than editing/upload, block
Download project before allocating the archive and state the exact remedy.
Otherwise raise the reader bound using a defensible memory budget rather than
an obsolete provider limit.

### Required regression coverage

- Round-trip an archive at the exact maximum.
- Assert the writer rejects one byte above any reader maximum before emitting a
  download.
- Cover a source larger than 32 MiB whose flattened export is accepted by the
  scripted provider.
- Pin all maintained UI and documentation to the chosen contracts.

---

## F5 — Imported metadata can request an enormous canvas

**Severity: P2 · local-input robustness**

### Evidence

[`src/photos/photo-project.js`](../../src/photos/photo-project.js) accepts width
and height independently up to 100,000. A maximum-size project describes ten
billion pixels.

Project import:

- cleans the project and catalog metadata;
- verifies that the original blob's SHA-256 matches both metadata records;
- decodes the original only to create a thumbnail;
- does **not** compare decoded width/height with `project.image` or
  `photo.source`; and
- stores the project if IDs and hashes agree.

`photo-store.js` likewise requires matching IDs and source hash, but not matching
dimensions. `photo-renderer.js` later allocates its canvas directly from the
project metadata.

A small crafted or corrupted bundle can therefore contain a valid small image
and matching hash while claiming 100,000×100,000 metadata. Loading or exporting
that project can request an invalid or destructive canvas allocation, freeze the
extension page, or terminate its renderer.

### Remediation

- After decode, require exact agreement among bitmap dimensions,
  `project.image`, and `photo.source`.
- Enforce a realistic total-pixel budget in addition to per-axis limits.
- Apply the same invariant in `photo-store.js`, so no caller can persist a
  mismatched bundle.
- Validate the invariant again before canvas allocation.
- Report a bounded “project dimensions do not match its image” import error.

### Required regression coverage

- Reject a valid image/hash with mismatched project dimensions.
- Reject project/photo dimension disagreement even when their hashes match.
- Reject exact-axis and total-pixel boundary violations.
- Verify a near-limit legitimate panorama still imports and exports.

---

## F6 — Public ImgBB credential disclosure contradicts runtime

**Severity: P2 · privacy and store disclosure**

### Evidence

The runtime boundary is narrow and intentional:

- Settings and the photo page may configure the saved ImgBB key.
- Status messages expose only whether a key exists.
- `PHOTO_IMGBB_LEASE_KEY` returns the literal key only to the exact packaged
  photo page.
- The photo page uses that returned value to construct the direct ImgBB upload.

The behavior and its worker sender checks are covered by tests.

The public documentation is false or self-contradictory:

- `README.md` says “no page can read it back.”
- `PRIVACY.md` says neither the photo editor nor Settings can read a saved key
  back, then says the worker leases the value to the exact photo page.
- The focused photo design is more accurate: only the photo page can receive
  the key because it owns the upload.

This is not evidence that Peakbagger or an arbitrary page can read the key.
It is a material disclosure error about what a trusted extension page receives.

### Remediation

Use one precise statement in every maintained/public document:

> The saved key remains in device-local extension storage. It is never exposed
> to Peakbagger, another website, GitHub, browser sync, or status UI. The
> background worker provides it only to Better Peakbagger's exact packaged photo
> page immediately before that page sends a direct upload to ImgBB.

Keep the existing exact sender-path tests and add a documentation assertion for
the approved disclosure wording.

---

## F7 — Photo-library rendering is an unbounded sequential N+1 path

**Severity: P3 · scalability and responsiveness**

### Evidence

Every library render:

1. reads the entire photo catalog;
2. prunes eligible deleted assets sequentially;
3. filters and sorts the complete list;
4. calls `store.getBundle()` once per matching photo, sequentially;
5. constructs every card before changing the grid; and
6. only then renders anything.

Search input schedules the same full pass. Render coalescing prevents duplicate
passes, but does not reduce the work inside the final pass.

There is no catalog count bound, paging, virtualization, thumbnail batch read,
or photo-library scale test. Unlike Favorites, which has an explicit 1,500-entry
guardrail and scale coverage, the photo library can grow for the lifetime of the
browser profile.

### Remediation

- Read catalog rows and thumbnails in one or a bounded number of transactions.
- Render an initial bounded page before loading the rest.
- Add pagination or virtualization rather than relying on an unbounded DOM.
- Debounce search separately from render coalescing.
- Move expired-asset pruning to bounded maintenance work rather than every
  visible render.

### Required regression coverage

Add a scale test with a realistic large catalog that records:

- transaction count;
- time to first visible card;
- time to filtered result;
- maximum rendered card count; and
- object-URL revocation across searches/pages.

---

## F8 — Maintained documentation and plan lifecycle have drifted

**Severity: P3 · documentation correctness**

### Evidence

Before this audit document was added, `docs/plans/README.md` still advertised
`report-image-default-size.md` as active even though the implementation had
already moved to
[`docs/archive/report-image-display-size.md`](../archive/report-image-display-size.md).
The target file no longer existed.

Other maintained code/test pointers are stale:

- `docs/architecture.md` names “options/section-nav.js”; the current owner is
  `src/ui/section-nav.js`.
- `docs/architecture.md` and `docs/trip-report-editor.md` name the deleted
  monolithic “test/options/options.test.mjs”.
- `docs/trip-report-editor.md` names the deleted monolithic
  “test/reports/report-editor.test.mjs”.
- `docs/architecture.md` still says the ImgBB client refuses blobs above 32 MiB,
  contradicting the current client.

The repository tests links in selected generated/store assets, but has no
general maintained-document target/path check.

### Remediation

- Remove the implemented report-image plan from the active index.
- Update maintained source/test paths and the current ImgBB size contract.
- Add a project test that checks relative links and backticked repository paths
  in root living docs, `docs/*.md`, and `docs/plans/*.md`.
- Exclude `docs/archive/` from drift enforcement; its index already says those
  files are point-in-time history.

---

## Test-design findings

The defects above expose three recurring test weaknesses:

1. **Primitive coverage is being mistaken for orchestration coverage.** Photo
   library, store, client, archive, and editor gesture tests are individually
   strong, but no test drives the upload transaction through each downstream
   failure boundary.
2. **Hand-maintained source allowlists can certify an incomplete inventory.**
   The request-deadline test proves that listed transports import the shared
   module; it does not prove every actual `fetch()` owner is listed.
3. **Source-regex assertions pin implementation spelling, not behavior.**
   `test/photos/photo-page.test.mjs` confirms that strings such as
   `outcome-unknown` and `PHOTO_INSERT_COMMIT` appear in the source, but cannot
   catch the invalid state transition joining them.

Do not remove structural source tests that protect manifest/build/CSP
boundaries. Add behavioral fault injection beside them for transaction,
cancellation, and round-trip invariants.

## Recommended execution order

Each step should be a focused commit with appropriate checks:

1. **F1 — upload transaction and journal recovery.** This protects an
   irreversible remote side effect and is the highest data-integrity risk.
2. **F2 — immutable upload snapshot/busy boundary.** Reuse the F1 orchestration
   harness to prove mutation exclusion and committed-state consistency.
3. **F3 — provider deadline and true cancellation.** Preserve ownership,
   provider endpoint, privacy, and late-generation guards.
4. **F4 + F5 — photo resource contracts.** Establish size/dimension invariants
   together so archive, import, storage, decode, and render agree.
5. **F6 — public disclosure repair.** Update every maintained/public consumer
   from one canonical wording.
6. **F7 — bounded library rendering.** Land only after correctness boundaries
   are stable.
7. **F8 — maintained-document repair and drift test.** Update the current docs
   for the final runtime behavior, then archive this plan with its completed
   closure ledger.

After any change to manifest/build composition, content-script load, worker
composition, or provider injection, run `npm run verify:browsers`. After
graphics changes, run the hidden hardware-GPU terrain checks. Photo UI changes
require real rendered inspection at the desktop and narrow viewports already
used by the browser verifier.

## Closure ledger

### Fixed and verified

- **F1 (`d60742d`)** — upload recovery now treats the local catalog commit as
  irreversible. Report insertion, reference persistence, and journal cleanup
  cannot downgrade a committed ImgBB success; `catalog-committed` recovery is
  idempotent.
- **F2 (`7928c21`, integrated with current `main` in `83fbf19`)** — export and
  upload use one immutable saved snapshot. Every editor mutation family,
  including upload format, JPEG quality, keyboard, and history paths, fails
  closed while that snapshot is being exported and committed.
- **F3 (`03dce29`)** — provider export and body reading share one 30-second
  page-world deadline. Cancel aborts the current generation, removes its
  process immediately, permits immediate retry, and late results cannot replace
  the retry. Garmin and Strava endpoint/header contracts remain unchanged.
- **F4 and F5 (`f182980`)** — the archive writer and reader share an exact
  40 MiB contract with preflight before allocation. Source decode, import,
  persistence, and rendering enforce 16,384 pixels per side, 64 megapixels
  total, matching hashes, and matching decoded/project/catalog dimensions.
  ImgBB remains the owner of upload-size refusal.
- **F6 (`8aba6c0`)** — every maintained public surface now states the exact saved
  key boundary, including the one trusted packaged photo page that receives the
  key immediately before direct upload.
- **F7 (`a56736a`, `9da22d3`)** — the library renders at most 48 cards, fetches
  that page's thumbnails in one transaction, debounces search, prunes deleted
  assets in bounded maintenance batches, and revokes replaced object URLs. A
  1,200-photo scale gate and packaged Chrome/Firefox pagination checks pin the
  bounds.
- **F8 (`bc167a3`)** — stale settings/report test owners were corrected. A
  project test now resolves relative links and exact repository paths across
  root living documents, `docs/*.md`, and active plans; archived point-in-time
  records remain exempt.

### Intentionally not changed or not reopened

- Archived documents remain historical and may contain stale paths, line
  numbers, or decisions. This audit does not convert them into maintained
  sources of truth.
- The photo catalog remains lifetime-sized metadata so search can cover every
  record. The bounded resource is the visible card/thumbnail page, not catalog
  retention.
- ImgBB upload bytes remain provider-owned. The extension bounds local decode,
  canvas, and project archives without inventing an account-independent upload
  ceiling.
- The one `brace-expansion` advisory remains in the development-only
  `web-ext` 1.x compatibility path. The exact repository acceptance remains
  machine-checked and expires on 2026-08-09. `npm audit --omit=dev` is clean.
- Remote ImgBB deletion remains intentionally unsupported. The stored delete
  capability remains device-local.
- ImgBB account-gallery import remains unsupported because the current
  integration has no documented listing API.

### Changed but not fully proven

- F1 and F2 passed fault-injected page orchestration and packaged-browser
  checks, but no real ImgBB upload was made with a live key.
- F3 passed never-settling fetch/body, cancel/retry, late-generation, and real
  packaged-worker checks, but no live Garmin or Strava export was made.
- F4 and F5 passed exact-boundary archive round trips and dimension/hash
  mismatch tests. A real browser was not asked to decode or export an image at
  the full 64-megapixel ceiling.
- F7 passed the 1,200-record scale gate and hidden packaged-browser checks in
  both engines at desktop and narrow sizes. Hidden screenshots and DOM
  assertions do not prove native focus, window placement, browser chrome, or
  permission-prompt presentation.
- No live authenticated Peakbagger markup check or live GitHub
  backup/merge/restore against a scratch repository was made.
- Firefox desktop passed; Firefox Android and touch behavior were not tested on
  a physical device.
- The pre-existing `terrain:lod` 67°→70° transient was outside these changes and
  remains above its 120 ms budget in the audit's two recorded runs.

### Audit verification complete

- Unit/integration: **1,080/1,080**.
- Scale: **5/5**, including the new 1,200-photo transaction, timing, DOM, and
  object-URL gate.
- JavaScript and extension lint: passed with the same six owned
  cross-browser/vendor warnings.
- Hidden packaged Chrome for Testing and Firefox 153.0.1 verification: passed.
  The 49-photo library rendered 48-card page 1 and one-card page 2 without
  horizontal overflow at 1000×760 and 520×800. Protocol screenshots were
  visually inspected in Chrome light and Firefox dark rendering.
- The audit's earlier hidden hardware-GPU terrain verification remains valid;
  remediation did not change terrain or graphics code.
- Maintained-document relative links and exact repository paths: passed.
- Browser/profile/debug-server teardown: inspected and clean.
- The audit baseline's runtime dependency audit remained clean; remediation did
  not change dependencies or lockfiles.
