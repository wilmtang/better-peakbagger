# ImgBB photo editor: implementation record

Implemented and archived on 2026-07-27; the July 28 follow-up ledger remains
below. This is a historical record. Current behavior is maintained in the
[photo topo guide](../photo-topo-editor.md),
[report editor guide](../trip-report-editor.md), and
[GitHub recovery guide](../github-ascent-backup.md#photo-libraryjson-metadata-recovery).

The original plan assumed the provider's documented 32 MB limit and a local
upload gate. Those assumptions and the original verification limits are
preserved in the closure record; later policy belongs to the maintained guide.
The original provider reference was [ImgBB API v1](https://api.imgbb.com/).

## 3. Decisions and rejected alternatives

### 3.1 Better Peakbagger, not ImgBB, owns the catalog

Chosen because the documented API cannot reconstruct a list of uploads. Every
successful response must be persisted locally while it is still available.

Rejected:

- **Use the ImgBB profile as the library.** Account attribution is not a
  documented API contract and there is no supported enumeration endpoint.
- **Rebuild from report URLs.** Reports omit deletion capability, editable
  annotations, hashes, lineage, abandoned uploads, and locally saved drafts.

### 3.2 A dedicated extension page owns editing and upload

The current report editor is an isolated-world content script on Peakbagger.
It should launch an extension-owned page rather than holding an API credential,
large `File`, IndexedDB project, and complex editor inside the site DOM.

The extension page:

- owns the selected `File`/`Blob`, SVG overlay, IndexedDB access, raster export,
  and ImgBB request;
- receives a credential only after the background validates the exact
  extension-page sender;
- returns only the sanitized insertion result through the worker to the
  originating Peakbagger tab.

This also avoids converting a file to base64 merely to pass it through generic
runtime messaging. A provider-sized `Blob` stays in the page that selected it
and is posted directly.

Rejected:

- **Upload in the Peakbagger content script.** It broadens credential exposure
  and couples a long-lived editor to site markup and lifecycle.
- **Send the whole encoded image through the worker.** Chrome runtime messages
  are not a streaming binary transport, base64 expands the payload, and an MV3
  worker may suspend.
- **Run a developer proxy.** It contradicts bring-your-own-key and introduces
  an unnecessary server/privacy boundary.

### 3.3 SVG is editable state; canvas is export only

Annotation objects render into an SVG whose `viewBox` matches the decoded
image's natural width and height. Viewport pan/zoom is a transform, not a
mutation of object coordinates. Export draws the normalized source raster and
the SVG overlay into a canvas once.

Rejected:

- **Canvas-only editing.** Hit testing, text editing, selection handles, and
  non-destructive persistence become custom pixel-coordinate machinery.
- **Save only the flattened image.** It makes correcting a route destructive
  and loses object semantics.
- **Adopt the Mountain Project implementation.** The inspected editor is an old
  Google Closure application. Its behavior is a product reference, not a
  maintainable dependency for this extension.

### 3.4 Local storage is authoritative; GitHub is recovery

IndexedDB stores potentially large blobs and projects. `storage.local` remains
for small credential and preference records. `storage.sync` receives neither.

The optional GitHub copy is a recovery snapshot, not a second live database or
proof that remote pixels still exist. The existing shared connection,
credential gate, serialized write queue, conflict handling, and commit-link
feedback are reused, while the photo backup opt-in stays separate from ascent,
settings, and favorite backups.

For the first release, `photo-library.json` is one bounded root snapshot because
the existing client already supports independent root files. The serializer
must enforce an 8 MiB UTF-8 payload ceiling and fail with an actionable size
message rather than attempting an unbounded commit. This limit applies only to
the GitHub recovery document, not the local library or ImgBB upload. If real
usage approaches it, a future repository-schema migration may split records
into an explicitly owned namespace; that complexity is not required
preemptively.

### 3.5 Remote uploads are immutable versions

Editing an uploaded project produces a new upload. The earlier remote object is
not deleted or overwritten automatically. This preserves published URLs and
makes ambiguous network outcomes less destructive.

### 3.6 The key and deletion URL have different scopes

- The API key authorizes uploads and is stored only when the user opts in.
- The returned `delete_url` is treated as a bearer deletion capability. It is
  stored only in local protected metadata, redacted everywhere, and excluded
  from ordinary GitHub backup/export.
- A restored record can therefore be inserted and inspected but may not be
  remotely deletable from that device. The UI must state that honestly.

## 15. Closure ledger

Maintain this section during implementation and preserve it when archiving the
plan.

### Fixed and verified

- Implemented a versioned, bounded photo-project schema with routes, Bezier
  controls, text, anchors, pitons, rappels, belays, pitch markers, z-order, and
  style cleaning. Pure schema and mutation tests pass.
- Implemented deterministic SVG/Canvas flattening to JPEG or PNG with source
  and export SHA-256 metadata. Export tests verify that project metadata,
  source file names, EXIF-shaped source bytes, API keys, and delete URLs do not
  enter the encoded output.
- Implemented the authoritative IndexedDB catalog, projects, originals,
  thumbnails, upload journal, per-photo secret, and tombstone stores. Atomic
  draft/upload/restore and crash-recovery behavior are covered by tests.
- Implemented exact optional ImgBB permission and device-local BYOK storage,
  one direct multipart upload with a 32 MiB ceiling, strict response validation,
  and fail-closed ambiguous-outcome handling without automatic retry.
- Implemented the extension-owned editor and local library with autosave,
  undo/redo, route and climbing-symbol tools, new-version lineage, search and
  status filters, report reuse, project download disclosure, reachability
  state, and local Recently Deleted handling. Project downloads use a
  CSP-safe stored-ZIP writer because packaging proved the planned JSZip runtime
  import included a forbidden dynamic-code compatibility shim.
- Implemented one-time, source-tab/frame- and editor-tab-bound report handoff.
  Upload success is committed before insertion, and insertion failure cannot
  erase a public URL.
- Implemented deterministic `photo-library.json` recovery with an 8 MiB bound,
  metadata/project/tombstone merge, explicit conflict policy, preview signature,
  default-off automatic backup, and semantic GitHub ref-conflict retry.
- Unit, integration, DOM, manifest, and bundle tests pass for the implemented
  boundaries. The packaged page was visually inspected and behavior-tested in
  hidden Chrome for Testing at 1000×760 and 520×800 and in hidden Firefox at
  1000×760. Both full built-extension verifiers pass.
- Updated the public README, privacy disclosure, maintained architecture,
  report-editor design, GitHub design, and focused photo-topo design.

### Intentionally not changed

- ImgBB account-gallery import is unsupported because there is no documented
  list API.
- Files and exports above ImgBB's documented 32 MB provider maximum are
  unsupported; no chunked path is planned.
- Original pixels are not included in ordinary GitHub backup.
- Remote ImgBB deletion is not implemented. Delete URLs stay device-local, and
  local removal or report removal never implies remote removal.
- GitHub restore does not guess through catalog conflicts or claim to recreate
  original pixels, thumbnails, API credentials, or deletion capability.

### Changed but not fully proven

- ImgBB request and response behavior is covered with scripted fetches, but no
  real upload was made with a live API key. Provider retention and whether a
  particular API upload appears in an account profile remain unproven.
- GitHub payloads, worker routes, merge policy, retry behavior, and restore are
  covered with scripted clients and IndexedDB, but no live scratch-repository
  photo backup/merge/restore was performed.
- Hidden browser runs prove the packaged editor's DOM behavior, image decode,
  IndexedDB autosave, Chrome route/export flow, and desktop/narrow layout
  boundaries. They do not prove native permission-prompt presentation, browser
  focus/window placement, toolbar chrome, or other onscreen browser UI.

## 16. Audit remediation ledger — 2026-07-28

A post-implementation audit of the branch. Every fix below carries a check
that fails against the code as shipped.

### Fixed and verified

- The library listed every photo twice whenever the page opened on
  `?mode=library` — the "Choose from library…" entry point — because
  `setView()` and `initialize()` each started a render and the two passes
  interleaved their clear-then-append. Renders now coalesce to one running
  pass plus at most one queued, and a pass replaces the grid in one step.
  `verify:chrome` reopens the library with a saved photo and asserts one card,
  using a MutationObserver installed before page scripts so a settled sample
  cannot hide a transient duplicate.
- An upload whose provider outcome was never confirmed dead-ended the editor.
  `putDraft` accepted only the `draft` state, so every autosave after an
  ambiguous failure threw, and the retry path offered to abandon
  non-destructive editing and cleared the retained-asset flags for blobs that
  were still present. The store now accepts every pre-upload state, which is
  exactly the set `beginUpload` already took as retry input.
- Every arrowed route referenced one shared `<marker>` colored by whichever
  arrow route came first, so a two-color topo exported the wrong arrowhead
  color. One deduplicated marker per color now.
- The photo page honored only `prefers-color-scheme`, ignoring the extension's
  own Light/Dark setting that options and the popup both apply. It now loads
  the shared panel-theme bootstrap ahead of its stylesheet.
- An inserted photo's description was re-clamped to 300 characters in the
  report editor after the photo page and worker had both allowed 500.
- A rejected `permissions.request()` escaped as an unhandled rejection,
  leaving "Upload and insert" inert with no message. It now reports and names
  the host and the retry.
- `photos/photos.js` matched no ESLint file glob and was not a `lint:js`
  target, so 1,470 lines of page orchestration shipped with no rules and no
  browser globals applied. Both lists now derive their coverage requirement
  from `build-config.mjs`'s page-local roots, pinned by test.

### Intentionally not changed

- The upload ceiling stays at 32 MiB (33,554,432 bytes) against a provider
  that documents "32 MB". If ImgBB means the decimal value, an export between
  32,000,000 and 33,554,432 bytes passes the local gate and is refused by the
  provider, which the client already surfaces as a provider message. Choosing
  the permissive reading keeps the plan's "no extension-specific limit below
  ImgBB's documented maximum" rule; resolving the ambiguity needs a live
  upload this audit did not make.
- Rendering a library card reads the photo's full bundle — five object stores,
  including the original — to reach its thumbnail, and search re-renders on
  every keystroke with no debounce. Coalescing bounds the wasted work to one
  pass; narrowing the read to a thumbnail-only lookup is a separate change.
- `github-routes.js` identifies the photo page by origin and pathname while
  `photo-routes.js` also requires an integer tab id. The looser check is
  redundant rather than permissive: those routes are all in the worker's
  extension-page-only set. Left as is rather than widening the audit.

### Changed but not fully proven

- The permission-rejection path is reasoned from the API contract, not
  exercised: neither packaged verifier grants an optional host permission, so
  no run reaches `permissions.request()` at all.
- The theme fix is proven for an explicit Dark preference on a light OS. The
  `prefers-color-scheme` branch is exercised only by its absence, because the
  hidden verification profiles report a light scheme.
- Everything in section 15's "changed but not fully proven" still stands: no
  live ImgBB upload, no live GitHub scratch-repository round trip, and no
  onscreen verification of native prompts or window chrome.
