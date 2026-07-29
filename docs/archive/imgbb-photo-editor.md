# Plan: ImgBB-backed topo photo editor and photo library

Status: implemented and archived on 2026-07-27.

This plan adds a local, non-destructive topo-photo editor to the trip-report
workflow, uploads the finished raster through the user's own ImgBB API key, and
keeps an extension-owned photo library because ImgBB does not document an API
for enumerating uploads.

The central ownership decision is:

- **Better Peakbagger owns the editable project and catalog.**
- **ImgBB owns delivery of the flattened report image.**
- **GitHub may hold an optional recovery copy of non-secret catalog metadata
  and topo annotations.**
- **Peakbagger receives only the direct HTTPS image URL and alt text already
  supported by the trip-report format.**

ImgBB is not treated as the library or the only backup. Its
[official API v1 documentation](https://api.imgbb.com/) documents upload,
response metadata, optional expiration, and a returned deletion URL. It does
not document list, lookup-by-id, replace, or account-gallery endpoints. Even if
an API upload happens to appear in an ImgBB website account, the extension must
not rely on that behavior.

The provider contract must be rechecked immediately before implementation and
release. As of 2026-07-27, the documented upload maximum is 32 MB. Better
Peakbagger will support that provider maximum and no larger-file path:

- no chunked upload;
- no custom large-file service;
- no base64 transport when a multipart `Blob` is available;
- no extension-specific limit below ImgBB's documented maximum;
- a rendered export over the provider maximum is rejected before upload with
  an actionable message.

## 1. User stories

### A. Configure my own ImgBB key

> As a climber who already has an ImgBB API key, I want to connect that key on
> this device so Better Peakbagger can upload my edited photos without operating
> a developer-owned image account or proxy.

1. From the image control in the Rich editor, the user chooses **Upload and
   edit…**.
2. If no key is configured, the extension-owned editor opens a compact setup
   sheet explaining that:
   - the image will be uploaded directly from the browser to ImgBB;
   - the key is stored only on this browser profile when **Remember on this
     device** is selected;
   - neither the key nor the deletion URL is backed up to GitHub;
   - ImgBB, not Better Peakbagger, stores and serves the finished image.
3. Continuing requests the optional `https://api.imgbb.com/*` host permission.
   Declining leaves the ordinary **Paste image URL** workflow available.
4. The key is syntactically checked, saved only if requested, and proven by the
   first real upload. There is no fake **Test key** action that creates and
   abandons a throwaway image.
5. Settings shows **ImgBB configured on this device**, plus **Replace key** and
   **Remove key**. It never displays the full stored value after saving.

Acceptance:

- Saving or using an ImgBB key does not require enabling ascent backup.
- The key never enters `storage.sync`, report markup, a Peakbagger page,
  GitHub, a log message, an exception string, or an exported project.
- Removing the key does not delete local projects, catalog entries, remote
  images, or report URLs.

### B. Turn a photo into a topo

> As a climber writing a trip report, I want to draw routes, anchors, belays,
> rappel points, pitch labels, and notes over a photo so the result communicates
> the climb rather than merely showing the terrain.

1. **Upload and edit…** opens a dedicated Better Peakbagger extension page and
   preserves the originating report tab as the return target.
2. The user selects an image up to ImgBB's current maximum. The browser decodes
   it locally; no network request occurs merely because the file was selected.
3. The editor opens with **Select** as the default tool and a restrained tool
   rail for:
   - route line;
   - anchor;
   - piton;
   - rappel;
   - belay;
   - pitch label `P1` through `P50`;
   - free text.
4. Route styling supports color, line width, solid/dashed/dotted stroke,
   optional arrowhead, and editable vertices/curve controls. Marker and label
   styling supports color, scale, text alignment, and optional text background.
5. Selection exposes only controls relevant to that object. Users can move,
   edit, reorder, duplicate, or delete the selection.
6. Undo and redo cover every material editing operation. `Escape` cancels the
   current draw, Delete/Backspace removes the selection, and keyboard users can
   reach every tool and style control.
7. The editor autosaves the current project locally. Closing the tab does not
   silently upload anything.

Acceptance:

- All geometry is stored independently from the pixels in versioned JSON.
- Zooming, panning, or resizing the viewport never changes export coordinates.
- The extension can reopen a saved project without flattening its annotations.
- **Clear all annotations** states the exact count, requires confirmation, and
  offers Undo.
- The implementation uses an SVG overlay and browser canvas export rather than
  adopting Mountain Project's legacy editor code.

### C. Upload and insert the finished image

> As a climber who is happy with the topo, I want one clear action that uploads
> it and inserts it into my report without making me copy URLs between sites.

1. The primary action is **Upload and insert**.
2. Before sending data, the editor renders a final preview at the source
   image's natural orientation and dimensions, strips source metadata from the
   output, computes the encoded size and SHA-256, and asks for meaningful alt
   text. A deliberate **Decorative image** choice is available instead of
   silently accepting empty alt text.
3. The editor creates a provisional local catalog record before network I/O,
   then sends one multipart `POST` directly to ImgBB.
4. Real progress labels describe the current phase:
   **Preparing image…**, **Uploading to ImgBB…**, **Saving to library…**, and
   **Inserting into report…**.
5. After a validated ImgBB success response, the extension commits the returned
   metadata to the local catalog before inserting the direct HTTPS image URL.
6. The originating report receives only `{ returnToken, localPhotoId, url,
   alt }`. The Rich editor inserts through its existing image command and
   flushes through the existing report-markup boundary.
7. The photo editor closes or changes to a concise success view only after the
   report tab acknowledges insertion.

Acceptance:

- The report uses ImgBB's direct image URL, not its viewer page or deletion
  URL.
- The native `JournalText` field remains the Peakbagger submission authority.
- The extension never clicks a Peakbagger Save control.
- Closing or abandoning the editor before **Upload and insert** produces no
  remote upload.
- If upload succeeds but the report tab is gone, the image remains in the
  library as **Uploaded · Not inserted** rather than becoming invisible.

### D. Reuse an uploaded image

> As a climber with photos already uploaded through Better Peakbagger, I want
> to find and insert one again without depending on ImgBB's website profile.

1. The image control offers **Choose from library…** beside **Paste image URL**
   and **Upload and edit…**.
2. The library shows a lazy-loaded thumbnail, title/alt text, upload date,
   dimensions, encoded size, linked draft/ascent where known, and independent
   remote/backup status.
3. Search matches title, alt text, original filename, and known peak/ascent
   labels. Filters cover **All**, **Drafts**, **Uploaded**, **Not inserted**,
   **Backup pending**, and **Needs attention**.
4. The primary card action is **Insert**. Secondary actions are **Edit as new
   version**, **Copy URL**, **Open on ImgBB**, **Download project**, and
   **Remove…**.

Acceptance:

- The library is built exclusively from Better Peakbagger's catalog. It does
  not scrape ImgBB pages or imply that it can enumerate all images in the
  user's ImgBB account.
- A thumbnail load failure changes health to **Unreachable** only after an
  actual failed load. There is no background polling or speculative deletion.
- A restored catalog record without local source pixels remains insertable but
  clearly says **Original not on this device**.

### E. Revise a previously uploaded topo

> As a climber who notices a route or label mistake, I want to correct the topo
> without destroying the image already referenced by a published report.

1. **Edit as new version** opens the retained original and annotation project.
2. Uploading the revision creates a new ImgBB object and a new catalog record
   whose `parentLocalId` identifies the earlier version.
3. If the action began from an open draft, the user chooses:
   - **Replace in this draft**; or
   - **Keep both and insert the new version**.
4. The old remote object and catalog record remain until the user explicitly
   removes them.

Acceptance:

- No workflow claims to replace an ImgBB object; replacement is not in the
  documented provider API.
- The extension never rewrites previously published Peakbagger reports or
  external uses of the old URL.
- The library presents version lineage without hiding either URL.

### F. Recover my library metadata

> As a user who connected Better Peakbagger to my GitHub backup repository, I
> want an optional recovery copy of my photo catalog and topo annotations so
> losing browser data does not erase every record of what I uploaded.

1. Photo-library backup is a separate, default-off choice under the shared
   GitHub connection. It does not depend on ascent backup.
2. Manual **Back up photo library** and optional automatic backup serialize one
   schema-versioned root file, `photo-library.json`.
3. The backup includes public ImgBB metadata, report associations, hashes,
   version lineage, and annotation JSON.
4. It excludes API keys, deletion URLs, source EXIF, original pixel files,
   thumbnails, transient operations, and local database identifiers that are
   not part of the stable schema.
5. **Restore photo library** is explicit and confirmed. It merges stable photo
   IDs, honors tombstones, reports conflicts, and never silently replaces a
   newer local record.

Acceptance:

- ImgBB upload and report insertion succeed without GitHub being configured.
- GitHub backup failure never rolls back a successful ImgBB upload or blocks
  Peakbagger editing.
- Backup feedback appears on the photo-library surface as
  **Backing up…**, **Backed up** with an inspectable commit link, or
  **Backup failed · Retry**.
- Restoring metadata does not claim to restore an editable original that the
  backup intentionally excludes.

### G. Remove an image without surprises

> As a user cleaning up my library, I want to understand whether I am removing
> local data, a report reference, or the remote image before anything breaks.

The product exposes separate actions:

1. **Remove from this draft** changes only the current report.
2. **Move to Recently Deleted** hides the local library item and schedules its
   local original/project for removal after 30 days. Undo is available.
3. **Delete remote image** is not implemented until ImgBB's deletion-link
   behavior has been verified. The current API documentation returns a
   `delete_url` but does not document a deletion API.

Acceptance:

- Removing local data never implies the ImgBB image was deleted.
- Any eventual remote-delete action warns that the extension cannot know every
  published or externally copied reference and that those URLs may break.
- Tombstones enter the GitHub backup so restoring an older snapshot does not
  resurrect intentionally removed catalog entries.

## 2. Product scope and non-goals

### In scope

- Still-image topo annotation modeled on the useful Mountain Project concepts:
  selectable route geometry, climbing symbols, pitch labels, text, styling,
  z-order, undo/redo, and flattened export.
- User-provided ImgBB API keys.
- Direct multipart upload up to ImgBB's documented maximum.
- A local image/project library and optional GitHub metadata backup.
- Rich-editor insertion and reuse.
- Chrome and Firefox support under the repository's current MV3 boundaries.

### Not in scope for the first release

- Files larger than ImgBB supports, chunked uploads, resumable uploads, or a
  Better Peakbagger image proxy.
- Importing or reconciling the user's pre-existing ImgBB account gallery.
- Scraping ImgBB profile pages.
- Pixel-editing features such as exposure, healing, background removal, or
  generative editing.
- Collaborative editing, comments, or shared cursors.
- Upload-on-every-edit or silent background uploads.
- Automatic expiration. Report images default to no expiration because an
  expiring URL makes a persistent trip report fail later.
- Automated remote deletion until the provider behavior is separately proven.
- Automatic rewriting of saved Peakbagger reports when an image changes.
- Original-image backup to GitHub by default.

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

## 4. Detailed user experience

### 4.1 Report image popover

Replace the current hosting-hint-only presentation with three choices:

1. **Upload and edit…** — primary when ImgBB is configured; opens the editor.
2. **Choose from library…** — opens the reusable library picker.
3. **Paste image URL** — preserves the current HTTPS URL and alt-text flow.

When ImgBB is not configured, **Upload and edit…** opens the extension page
directly into its small setup sheet. The API key is never typed into the
Peakbagger content script. The ordinary URL flow never requires an ImgBB
permission or key.

The popover stays compact. Provider explanations, key management, backup, and
storage usage belong in the extension page or Settings, not inside the report
toolbar.

### 4.2 Editor layout

Use one obvious hierarchy:

- top bar: back, photo title, local-save state, undo, redo;
- left or bottom tool rail depending on viewport;
- central image viewport;
- contextual inspector for the selected tool/object;
- footer: encoded format/size and primary **Upload and insert** action.

Desktop keyboard and pointer behavior:

- `V`: Select;
- `L`: Route line;
- `T`: Text;
- `Escape`: cancel current draw or clear selection;
- Delete/Backspace: delete selected object, except while editing text;
- Command/Ctrl-Z and Command/Ctrl-Shift-Z: undo/redo;
- arrow keys: nudge selection; Shift modifies the increment;
- Space-drag: pan; wheel/trackpad: zoom around pointer.

Touch behavior must not require hover. Selection handles meet a minimum
comfortable target size without inflating their exported size.

### 4.3 Route line editing

- Click/tap creates vertices; double-click, Enter, or tapping **Done** finishes.
- A route with fewer than two distinct points is discarded.
- Selected vertices can move, insert, or delete.
- Optional curve controls are stored explicitly; they are not inferred
  differently on reload.
- Line styles: solid, dashed, dotted.
- End styles: none or arrow.
- Width and marker scale are expressed relative to the image coordinate system
  so a resized export remains proportional.
- Object z-order is stable and explicit.

### 4.4 Symbols and labels

Anchor, piton, rappel, and belay symbols are bundled SVG geometry, not emoji or
external images. They therefore export consistently and do not send another
network request.

Pitch labels:

- default sequentially from `P1`;
- allow explicit `P1` through `P50`;
- editing/deleting a label does not silently renumber the others.

Text:

- plain text only;
- bounded length;
- left/center/right alignment;
- optional high-contrast background;
- no arbitrary HTML, font URL, script, or pasted styling.

### 4.5 Preview and export

The decoded source is normalized to its displayed orientation. The export
contains no EXIF or source metadata because pixels are re-encoded through
canvas.

Defaults:

- preserve natural pixel dimensions;
- JPEG for an opaque photographic source;
- PNG when transparency must be retained;
- use a visible quality/format choice only when needed to keep the rendered
  result within ImgBB's limit or preserve intended transparency;
- show the actual encoded byte count before upload.

The renderer must wait for all bundled symbols and fonts it uses. Export is
deterministic for a given browser engine, source raster, project JSON, format,
and quality; cross-engine byte-identical encoding is not promised.

### 4.6 Library

The library is an extension page, not a Peakbagger overlay. It supports a
compact picker mode when opened from a report and a full management mode from
Settings.

Each card exposes three independent facts rather than one vague status:

- **Remote:** draft, uploading, uploaded, outcome unknown, or unreachable;
- **Use:** not inserted, linked to draft/ascent, or references unknown;
- **Backup:** off, pending, current, failed, or restored.

Loading a card does not contact the ImgBB API. Its thumbnail is the stored local
thumbnail when present; a restored record may fall back to its remote thumbnail
URL with `referrerpolicy="no-referrer"`.

### 4.7 Recently Deleted and storage

- Local removal is a soft delete with a 30-day tombstone and immediate Undo.
- Draft projects never uploaded may be offered for cleanup after 14 days.
- Uploaded originals/projects are not automatically pruned behind the user's
  back.
- The library shows approximate local storage consumption and lets the user
  remove original/project data while retaining the URL record.
- When original pixels are removed, the confirmation says that future
  non-destructive editing will require reselecting the original file.

Before retaining a large original, call `navigator.storage.estimate()` and
attempt the IndexedDB transaction before upload. If local persistence fails,
the user may explicitly **Upload without keeping an editable copy**; the
library record must then say so. Never promise that browser-local storage is a
durable backup.

## 5. Data and state contracts

### 5.1 IndexedDB ownership

Create a versioned `betterPeakbaggerPhotos` database with these object stores:

| Store | Key | Contents |
| --- | --- | --- |
| `photos` | `localId` | Catalog record and state; no original bytes |
| `projects` | `localId` | Versioned annotation document |
| `originals` | `localId` | Original local `Blob` plus decoded metadata |
| `thumbnails` | `localId` | Small locally generated preview |
| `operations` | `operationId` | Bounded upload/recovery journal |

Every upgrade is explicit, transactional, and tested against the prior schema.
Unknown future fields are ignored on read; unsupported future schema versions
fail closed without deleting data.

### 5.2 Catalog record

Illustrative shape:

```json
{
  "schemaVersion": 1,
  "localId": "uuid",
  "createdAt": "2026-07-27T18:00:00.000Z",
  "updatedAt": "2026-07-27T18:02:00.000Z",
  "title": "North face topo",
  "alt": "North face with the Northeast Ridge marked in red",
  "source": {
    "fileName": "north-face.jpg",
    "mime": "image/jpeg",
    "bytes": 8421132,
    "width": 4032,
    "height": 3024,
    "sha256": "hex"
  },
  "export": {
    "mime": "image/jpeg",
    "bytes": 7345001,
    "width": 4032,
    "height": 3024,
    "sha256": "hex"
  },
  "remote": {
    "provider": "imgbb",
    "state": "uploaded",
    "providerId": "string",
    "url": "https://i.ibb.co/...",
    "displayUrl": "https://i.ibb.co/...",
    "viewerUrl": "https://ibb.co/...",
    "thumbnailUrl": "https://i.ibb.co/...",
    "mediumUrl": null,
    "uploadedAt": "2026-07-27T18:02:00.000Z",
    "expiresAt": null
  },
  "lineage": {
    "parentLocalId": null
  },
  "references": [
    {
      "kind": "ascent-draft",
      "cid": 123,
      "aid": null,
      "pid": 456,
      "insertedAt": "2026-07-27T18:02:01.000Z"
    }
  ],
  "backup": {
    "state": "pending",
    "signature": "hex",
    "backedUpAt": null,
    "commitUrl": null
  },
  "deletedAt": null
}
```

The actual local record stores `deleteUrl` in a separate local-only secret
field or store so ordinary serialization cannot accidentally include it.

Do not persist:

- the API request URL containing the key;
- response bodies outside the allowlisted schema;
- source EXIF;
- image bytes in JSON or `storage.local`;
- a claim that a report reference is exhaustive.

### 5.3 Annotation document

```json
{
  "schemaVersion": 1,
  "localId": "uuid",
  "image": {
    "width": 4032,
    "height": 3024,
    "sourceSha256": "hex"
  },
  "objects": [
    {
      "id": "uuid",
      "type": "route",
      "z": 10,
      "geometry": {
        "points": [[640, 2590], [1040, 2100], [1500, 1650]],
        "controls": []
      },
      "style": {
        "color": "#d13b32",
        "width": 12,
        "stroke": "solid",
        "end": "arrow"
      }
    }
  ],
  "export": {
    "mime": "image/jpeg",
    "quality": 0.92
  },
  "updatedAt": "2026-07-27T18:01:40.000Z"
}
```

Validation requirements:

- finite coordinates within a bounded overscan range;
- bounded object count, point count, text length, line width, and scale;
- allowlisted types, colors, stroke styles, and alignments;
- stable unique IDs and integer z-order;
- source hash/dimensions must match the retained original before editing;
- cleaning is idempotent and shared by local load, restore, and renderer.

Suggested safety bounds should be chosen from rendered-performance tests rather
than guesses. A malformed object is rejected or omitted with an explicit
recovery report; it must never reach raw SVG/HTML injection.

### 5.4 Upload operation journal

Network and IndexedDB cannot form one atomic transaction, so record a bounded
journal:

```text
prepared -> request-started -> response-received -> catalog-committed
         -> insertion-sent -> insertion-acknowledged
```

On startup:

- `prepared` can safely resume before network;
- `request-started` without a response is **Outcome unknown**, not failed;
- `response-received` retries only the local catalog commit;
- `catalog-committed` can retry report insertion without re-uploading;
- completed operations are pruned after a bounded interval.

Because ImgBB does not document idempotency or upload lookup, the extension
must not automatically repeat an upload whose request may have reached the
provider. A manual retry warns that it can create a duplicate.

## 6. ImgBB client and credential boundary

### 6.1 Request

- Endpoint: the official v1 upload endpoint revalidated at implementation time.
- Method: multipart `POST`.
- Body: rendered `Blob` in `image`; optional bounded `name`.
- Expiration: omitted for report images.
- Cancellation: `AbortController`, with the result classified as potentially
  ambiguous once the request has begun.
- Concurrency: one active upload per editor page; repeated primary-action
  clicks are disabled.
- Cache: `no-store`.

The API key is passed only in the provider-supported location. Request URLs,
headers, bodies, network errors, and telemetry are scrubbed before producing a
user-facing/public error.

### 6.2 Response validation

Success requires:

- successful HTTP status;
- provider success indication;
- object-shaped `data`;
- required identifier and direct image URL;
- finite positive dimensions/size within sane numeric bounds;
- HTTPS for every retained URL;
- optional thumbnail/medium/expiration fields validated independently.

The client retains only the allowlisted response. Unknown fields do not enter
the catalog. A malformed "success" is a provider failure and is never inserted
into the report.

### 6.3 Credential storage and lease

Follow the existing GitHub credential principle without coupling the two
providers:

- key stored under a dedicated `storage.local` record only when remembered;
- no sync, GitHub backup, settings export, report content, or content-script
  route exposes it;
- a background route validates that the sender is the exact packaged photo
  editor URL before returning a short-lived in-memory credential lease;
- a one-time key entered without **Remember** remains only in the editor page;
- disconnect overwrites/removes the stored value and invalidates active leases;
- public errors use stable codes such as `permission`, `not-configured`,
  `rejected`, `too-large`, `network`, `ambiguous`, and `invalid-response`.

## 7. Report-tab handoff

1. `report-editor.js` sends `PHOTO_EDITOR_OPEN` only from a user action.
2. The worker validates the Peakbagger sender, creates a cryptographically
   random return token, stores `{ token, tabId, frameId, draftIdentity,
   expiresAt }` in `storage.session`, and opens the extension editor page.
3. The editor never receives the Peakbagger DOM or report body.
4. After the catalog commit, the editor sends `PHOTO_INSERT_RESULT` with the
   token and sanitized public fields.
5. The worker consumes the token exactly once and sends the result to the
   original tab/frame.
6. The content script confirms that the editor and report identity are still
   current, inserts through the Rich command, flushes `JournalText`, updates
   its draft, and acknowledges.
7. If the tab navigated, identity changed, or the token expired, insertion
   fails closed while the catalog item remains **Not inserted**.

Return tokens expire after a short bounded interval and are not reusable. No
path permits an arbitrary extension page or web page to inject a URL into a
report.

Markdown mode does not currently expose the Rich image toolbar. The first
release may launch the library/editor only from Rich mode, but insertion must
still produce canonical bracket markup so a later mode switch is correct.
Adding equivalent Markdown-mode entry is a separate UX choice, not a reason to
bypass the source-of-truth contract.

## 8. GitHub backup and restore

### 8.1 Backup payload

`photo-library.json`:

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-07-27T18:10:00.000Z",
  "extensionVersion": "x.y.z",
  "photos": [],
  "tombstones": []
}
```

Each photo contains:

- stable local ID;
- title and alt text;
- sanitized source/export metadata and hashes;
- public ImgBB response fields;
- annotation document;
- version lineage;
- bounded report associations;
- creation/update timestamps.

It excludes:

- API key and deletion URL;
- original and rendered pixel blobs;
- thumbnails;
- source EXIF;
- operation journal and UI state;
- selected repository/account data;
- GitHub token.

Serialization is deterministic. Stable key ordering and canonical arrays feed a
signature so the UI can prove whether the selected repository contains the
current library snapshot.

### 8.2 Write behavior

- Manual and automatic photo backup use one worker route and the existing
  serialized GitHub write queue.
- Automatic backup is separate, off by default, and debounced after a catalog
  mutation.
- A successful upload is never delayed awaiting GitHub.
- Before every write, read and validate the current remote snapshot, then merge
  it with the local snapshot by stable ID and tombstone. This preserves photos
  backed up from another device instead of silently applying last-writer-wins
  to the whole root file.
- A divergent same-ID edit that cannot be resolved from timestamps and lineage
  stops the write with **Backup conflict**. Automatic backup does not guess; the
  library offers an explicit conflict review.
- A conflict retry rereads the current ref and repeats the entire atomic root
  file read/semantic-merge/write without force.
- Success is bound to repository identity plus photo-library signature; either
  changing invalidates **Backed up**.

### 8.3 Restore behavior

Restore is an explicit extension-page operation:

1. Read and validate `photo-library.json`.
2. Reject unsupported future schema versions without mutating IndexedDB.
3. Preview counts: add, update, unchanged, conflict, tombstoned.
4. Merge by stable ID:
   - identical signature: unchanged;
   - one side newer and a direct ancestor: take newer;
   - tombstone newer than record: keep deleted;
   - divergent same-ID content: require user choice or import the remote record
     as a separate recovered copy.
5. Commit the accepted merge in one IndexedDB transaction.
6. Report that original pixels and deletion capability were not restored.

## 9. Failure model

| Failure | Required behavior |
| --- | --- |
| Optional host permission declined | Keep editor/project local; show **Upload permission needed** and retain Paste URL. |
| Missing/removed API key | Preserve project; route to key setup without losing edits. |
| Browser cannot decode file | Reject before creating a remote operation; name the file and decoding problem. |
| Selected or rendered file exceeds current ImgBB maximum | Block upload; show actual size and provider maximum. No chunking. |
| IndexedDB cannot retain original | Explain re-edit consequence; allow explicit upload-without-editable-copy or cancel. |
| Network fails before a response | Mark operation **Outcome unknown** once request started; no automatic retry. |
| ImgBB rejects request | Preserve project and parsed provider error without exposing the key. |
| ImgBB success response is malformed | Do not insert; retain scrubbed diagnostic and recovery affordance. |
| Response received, catalog write fails | Show public URLs and offer metadata download/copy; retry local commit only. |
| Report tab closed/navigated | Catalog record remains **Uploaded · Not inserted**. |
| Report insertion fails | Retry insertion from the catalog; never re-upload. |
| GitHub disconnected/fails | Local catalog remains authoritative; backup status becomes retryable. |
| Remote thumbnail/direct URL fails | Mark **Unreachable** after observed failure; do not delete local metadata. |
| Original/project missing after restore | Allow URL insertion; require reselecting a hash/dimension-matching original to edit. |
| Duplicate submit/click | One in-flight operation; later clicks ignored until terminal state. |
| Extension/browser closes mid-operation | Recover from journal; never infer remote failure from missing response. |

## 10. Privacy and security

The first upload disclosure must state:

- the flattened image is sent to ImgBB;
- ImgBB receives ordinary network metadata and associates the request with the
  user's API key;
- report readers' browsers later request the image from its host;
- anyone with the direct URL may be able to view it;
- users must have the rights required by
  [ImgBB's terms](https://imgbb.com/tos).

Implementation requirements:

- request `https://api.imgbb.com/*` only as an optional host permission;
- keep existing Peakbagger host permissions unchanged;
- add no broad `imgbb.com/*` permission merely to open a normal viewer link;
- apply `rel="noopener noreferrer"` to external navigation and no-referrer to
  locally rendered remote thumbnails;
- rasterize the uploaded export to remove EXIF/GPS metadata;
- retain the original locally without parsing or indexing EXIF;
- use CSP-compatible bundled code and symbols only;
- never set project text as `innerHTML`;
- validate restored projects through the same pure schema used for local data;
- redact the API key and deletion URL from all error/reporting paths;
- state before GitHub backup that the selected repository's visibility governs
  who can read titles, alt text, public ImgBB URLs, associations, and
  annotations in `photo-library.json`;
- add ImgBB upload, local original retention, public image serving, and GitHub
  photo-backup fields/timing to `PRIVACY.md`;
- update store privacy disclosures before release.

## 11. Module ownership

Proposed layout:

| Module | Responsibility |
| --- | --- |
| `photos/photos.html`, `photos/photos.css`, `photos/photos.js` | Extension-owned editor/library shell and page controller |
| `src/photos/photo-project.js` | Pure project schema, cleaning, migrations, object operations |
| `src/photos/photo-renderer.js` | SVG object rendering and flattened canvas export |
| `src/photos/photo-store.js` | IndexedDB schema, transactions, journal, cleanup, storage estimates |
| `src/photos/photo-library.js` | Pure catalog state transitions, search, lineage, tombstones |
| `src/photos/imgbb-client.js` | Multipart upload, response validation, scrubbed typed errors |
| `src/photos/photo-backup.js` | Deterministic GitHub serialization, signature, parse, merge |
| `src/background/photo-routes.js` | Sender checks, key storage/lease, return tokens, tab handoff |
| `src/background/github-routes.js` | Photo backup/restore messages through shared auth/write queue |
| `src/reports/report-editor.js` | Compact launch/picker controls and acknowledged URL insertion |
| `src/reports/report-markup.js` | Existing HTTPS image sanitizer and canonical report serialization |
| `scripts/build-config.mjs` | Photo page bundle/assets and background composition |
| `manifest.json` | Optional API host permission and packaged extension page |

Boundaries:

- `report-editor.js` never sees the API key, original image, deletion URL, or
  GitHub token.
- `imgbb-client.js` knows nothing about Peakbagger DOM, GitHub, or IndexedDB.
- `photo-store.js` knows nothing about ImgBB request construction.
- `photo-renderer.js` accepts only a cleaned project and decoded local raster.
- GitHub code receives an already sanitized backup document, never local
  secrets or blobs.

## 12. Implementation plan

Each step is one focused, green commit unless a discovered invariant requires
splitting it further.

1. **`feat(photos): add versioned topo project model`**
   - pure schema/cleaner/migrations;
   - route, marker, pitch, text, style, z-order operations;
   - deterministic SVG representation;
   - unit tests for malformed and bounded input.

2. **`feat(photos): add extension-owned topo editor`**
   - packaged HTML/CSS/page bundle;
   - local file decode, natural-coordinate viewport, tools, inspector;
   - selection, keyboard behavior, undo/redo, clear confirmation;
   - no upload yet;
   - hidden real-browser visual verification in Chrome and Firefox.

3. **`feat(photos): persist editable projects in indexeddb`**
   - database/store schema and transaction wrapper;
   - autosave, thumbnails, originals, quota failure, cleanup/tombstones;
   - reopen/recovery library shell;
   - project-bundle download through the already packaged JSZip dependency.

4. **`feat(photos): render metadata-free image exports`**
   - orientation normalization;
   - SVG-to-canvas flattening;
   - JPEG/PNG selection, byte count, SHA-256;
   - provider maximum enforcement without chunking;
   - EXIF-removal and dimension tests.

5. **`feat(photos): connect a device-local imgbb credential`**
   - optional permission flow;
   - background-owned remembered key and exact-sender lease;
   - Settings state, replace, remove, redacted errors;
   - tests proving the key cannot enter sync/export/content routes.

6. **`feat(photos): upload exports to imgbb`**
   - injected-fetch client, multipart `Blob`, response validator;
   - operation journal and ambiguous-outcome handling;
   - atomically persist successful metadata including local-only deletion URL;
   - scripted API coverage, never a live key in automated tests.

7. **`feat(reports): insert uploaded photos into trip reports`**
   - image-popover actions;
   - single-use return-token handoff;
   - canonical direct-URL/alt insertion and report-draft flush;
   - not-inserted recovery when the tab is gone;
   - focused Rich editor and bundled-worker tests.

8. **`feat(photos): add the uploaded photo library`**
   - picker/full management modes, search/filter, status, reuse;
   - edit-as-new-version and lineage;
   - Recently Deleted, Undo, local-data cleanup;
   - no remote deletion automation.

9. **`feat(photos): back up photo metadata to github`**
   - `photo-library.json` serializer/parser/signature/size bound;
   - independent manual/automatic opt-in;
   - shared worker auth/write queue;
   - explicit merge restore, conflict preview, tombstones;
   - persistent commit-linked status.

10. **`docs: document photo editing and imgbb data handling`**
    - update `docs/architecture.md`, `docs/trip-report-editor.md`,
      `docs/github-ascent-backup.md`, `PRIVACY.md`, README, and changelog;
    - update store privacy disclosures;
    - move this plan to `docs/archive/` with its closure ledger.

Steps 1-4 form a completely local editor and can land without an external
permission. Steps 5-7 form the minimum safe upload-and-insert release. Steps
8-9 add management and recovery and are required before describing the feature
as an uploaded-photo library.

## 13. Automated verification

### Pure and storage tests

- `test/photos/photo-project.test.mjs`
  - each object type and style;
  - coordinate/length/count bounds;
  - schema migrations and future-version rejection;
  - idempotent cleaning;
  - undoable operations and stable z-order.
- `test/photos/photo-renderer.test.mjs`
  - natural dimensions and orientation;
  - route/symbol/text placement;
  - JPEG/PNG selection;
  - source metadata absent from output;
  - exact enforcement of the current provider byte maximum.
- `test/photos/photo-library.test.mjs`
  - state transitions, search, lineage, references, tombstones;
  - no "missing" inference without a failed load;
  - restored-without-original behavior.
- `test/photos/photo-store.test.mjs`
  - database creation/upgrades;
  - multi-store atomic writes;
  - response-received recovery;
  - quota failure;
  - bounded journal and Recently Deleted cleanup.
  - Add a focused IndexedDB test dependency only if browser-backed integration
    cannot cover these contracts cleanly; do not hand-roll a misleading mock.
- `test/photos/photo-backup.test.mjs`
  - deterministic serialization/signatures;
  - complete secret/blob exclusion;
  - the exact 8 MiB UTF-8 size bound;
  - merge-before-write preservation of records from another device;
  - merge, conflict, and tombstone behavior.

### API and credential tests

- `test/photos/imgbb-client.test.mjs`
  - multipart `Blob`, name, no expiration;
  - provider rejection and malformed success;
  - optional response fields;
  - HTTPS URL validation;
  - redaction of key and deletion URL;
  - abort/ambiguous outcome;
  - no automatic retry.
- `test/background/background-photo.test.mjs`
  - exact extension-page sender gets a lease;
  - content scripts, web pages, wrong frames, expired tokens, and replay fail;
  - returned insertion payload contains public fields only;
  - remove-key invalidates access.
- Extend settings transfer and schema safety tests to prove credentials and
  photo blobs never sync or export.

### Report and build tests

- Extend `test/reports/report-editor.test.mjs`:
  - three image entry choices;
  - launch message only from user action;
  - acknowledged result inserts sanitized direct URL and alt;
  - expired/mismatched result fails closed;
  - current pasted-URL behavior remains.
- Extend the built-worker integration harness for return-token and credential
  routes.
- Extend manifest/build tests to pin:
  - optional ImgBB API permission;
  - photo page bundle/assets;
  - background module composition;
  - no ImgBB permission in required `host_permissions`.
- Extend privacy fixture scans so no API key, deletion URL, original photo, or
  real user image can enter fixtures/artifacts.

### Real-browser verification

Run after the relevant implementation steps:

- `npm test`
- `npm run lint:js`
- `npm run lint`
- `npm run verify:chrome:built`
- `npm run verify:firefox:built`

Use hidden, isolated test profiles. Visual checks cover:

- editor at laptop and narrow viewports;
- light/dark themes;
- high-DPI source;
- route/marker/text selection and handles;
- keyboard-only editing;
- reduced motion;
- export preview against the SVG editor;
- library cards with every status and long labels;
- permission-denied, provider-error, ambiguous-upload, quota, and restored
  states.

The provider network is exercised against a local HTTPS stub with the same
request/response contract. A real ImgBB smoke test is manual, uses a
user-supplied disposable test image/key, records the created image and cleanup
status, and is never part of CI. Do not claim the actual provider upload is
verified from stub coverage.

Hidden tests do not prove browser permission-prompt placement or native focus.
If those behaviors require visible verification, use a dedicated test profile
on the built-in display under the repository's real-browser rules.

## 14. Release acceptance criteria

The feature is ready to ship only when:

- a browser-decodable image within ImgBB's current documented maximum can be
  annotated, exported, uploaded, cataloged, and inserted through the real
  extension;
- no key, deletion URL, EXIF, or original blob crosses a forbidden boundary;
- an upload success cannot disappear merely because report insertion or GitHub
  backup failed;
- an ambiguous upload is never automatically duplicated;
- an uploaded image can be found and reused without visiting an ImgBB profile;
- editing a published image creates a new version without breaking the old URL;
- local deletion, report removal, and remote deletion are clearly distinct;
- backup/restore accurately states that metadata and annotations, not original
  pixels or deletion capability, were recovered;
- Chrome and Firefox built-extension checks pass;
- the rendered editor and library receive real visual inspection;
- `PRIVACY.md`, maintained design docs, and store disclosures describe the
  shipped behavior;
- the closure ledger below contains no hidden product-risk gap.

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
