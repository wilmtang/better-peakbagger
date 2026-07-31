# Better Peakbagger — sensible default size for report images

Self-contained brief for an implementing agent working in the `better-peakbagger`
repo. Read and follow `AGENTS.md` first (commit discipline: small conventional
commits straight to `main`; architecture boundaries; real-browser verification;
UX bar).

## Goal

An image inserted into the trip-report editor arrives at its full natural size —
a phone photo is roughly 4,032 × 3,024 — so it fills the whole editor column and
renders at natural size on the saved Peakbagger page. Every photo therefore has
to be dragged down to a readable size by hand, every time.

Make the common case need no adjustment: images insert pre-sized to fit the
report, adjusting is one click rather than a drag, and a user whose taste differs
from the default can set their own once. Never rewrite dimensions in reports the
user already saved.

## Context — verified facts

- **Nothing sets a dimension on insert.** `applyImage()`
  (`src/reports/report-editor.js:882-893`) inserts `{ src, alt }` from the
  popover's URL field; `handlePhotoInsertion()` (:1110-1130) inserts the
  `{ src, alt }` returned by the photo editor. Both reach TipTap through
  `richCommands.insertImage` (`src/reports/report-rich-editor.js:436`), so the
  node's `width`/`height` attributes stay `null` and `domToBracket` emits
  `[img src="…"]` with no size.
- **The export is deliberately full-resolution.** `exportProject()`
  (`src/photos/photo-renderer.js:218-247`) draws into a canvas at
  `project.image.width/height` and returns `{ width, height, … }`; `photos.js`
  already holds those values at upload time (`photos/photos.js:974-983`) and
  stores them on the library record (`export.width` / `export.height`, validated
  in `src/photos/photo-library.js:46-57`, :149). Keeping the hosted file at full
  resolution is correct — this plan changes the *display* size only.
- **The size machinery already exists and is bounded.** `ReportImage`
  (`src/reports/report-rich-editor.js:78-189`) parses `width`/`height` through
  `sanitizeReportDimension` and renders through TipTap's `ResizableNodeView`:
  one bottom-right handle, aspect-locked drag, left/right arrow steps of 10 (50
  with Shift), min 64 × 40 (:71-72), max `MAX_REPORT_IMAGE_DIMENSION` = 1600
  (`src/reports/report-markup.js:137`, sanitizer at :153-156).
- **Both serializations already carry a width.** Bracket output
  `[img src="…" width="640"]` (`src/reports/report-markup.js:934-936`) and the
  Obsidian-style Markdown suffix `![alt|640](url)` (:906-911, :1055-1074).
  Documented at `docs/trip-report-editor.md:291-301`. A width-only node is a
  supported state on both paths — height may stay `null`.
- **The editor already clamps visually, the saved page does not.**
  `.bpb-re-surface img` is `max-width: 100%; height: auto`
  (`src/reports/report-editor.css:560-563`), so an unsized image fills the
  editor column instead of overflowing it. That is why the pain reads as "too
  big" rather than "broken layout" while editing, and why the saved report is
  worse than the editor preview suggests.
- **The insert boundary is validated twice.** Worker:
  `cleanPublicInsertion()` (`src/background/photo-routes.js:32-49`) accepts only
  `{ localPhotoId, url, alt }` and `insertResult()` (:189-232) forwards exactly
  that to the report tab. Content script: `cleanPhotoInsertion()`
  (`src/reports/report-editor.js:1091-1108`) revalidates independently before
  inserting. Any new field must be validated in both places.
- **Report settings live in the shared schema.** `DEFAULTS`
  (`src/settings/settings-schema.js:30-49`) holds `enableReportEditor`,
  `addReportCredit`, `reportEditorMode`; `clean()` (:166) normalizes them. The
  schema is pure and imported by page-world bundles, and
  `test/settings/settings-schema.test.mjs` fails if a `src/` module hardcodes a
  schema default or bound.
- **Existing jsdom coverage to extend:**
  `test/reports/report-editor-media.test.mjs` — popover validation and insert
  (:10, :151, :196, :235), proportional image resize (:413), keyboard resize
  ceiling (:460).
- **Not verified:** Peakbagger's rendered report column width, and whether its
  stylesheet constrains `img` on narrow viewports. See
  [Open decision](#open-decision--the-default-number).

## Design

Four layers. Layer 1 removes the repeated work; 2–4 are independently
shippable improvements on top of it.

### Layer 1 — fit on insert

Every image the extension inserts carries
`width = min(naturalWidth, defaultWidth)` and **no height**: the browser derives
the height, so the aspect ratio cannot be distorted by a stale or rounded value,
and both serializations already support width-only. **Never upscale** — a
400 px image inserts at 400.

- *Photo-editor and library paths*: dimensions are already known. Carry
  `width`/`height` on `PHOTO_INSERT_COMMIT` (`photos/photos.js:1018-1024` from
  `exportMetadata`, and :1140-1146 from `item.export`), validate them in
  `cleanPublicInsertion()` with `sanitizeReportDimension`, forward them, and
  revalidate in `cleanPhotoInsertion()`. Nothing new leaves the browser: these
  are the pixel dimensions of an image the user just chose, travelling the same
  extension-internal path as its URL.
- *Pasted-URL path*: dimensions are unknown at insert time. Preload with
  `new Image()` after `sanitizeImageSrc()` accepts the URL, with a ~2 s timeout;
  on load insert with the fitted width, on error or timeout insert unsized
  exactly as today. Do not invent a width for an image that could not be
  measured — that is how a 64 px icon gets blown up to 800.
- Pasted/dropped markup keeps whatever dimensions it declares; markup that
  declares none is handled by Layer 4, not silently resized.

### Layer 2 — one-click sizes

Selecting an image reveals the resize handle today. Add a compact chip at the
image's lower-left showing the current width (`640 px`), which opens
`S · M · L · Original` (320 / 640 / fit / natural) with the current value
marked. It lives inside the existing `.bpb-re-image-resize` container
(`src/reports/report-editor.css:575-660`) so it inherits the resize styling,
focus-visible treatment, and reduced-motion rules, and it is reachable from the
same selection state the handle uses.

This is what replaces "drag until it looks right" with one click — and it is the
only way back to the original size, which today requires knowing the source
pixel count.

### Layer 3 — make the choice stick, explicitly

Last item in that menu: **"Use this size for new photos"**, writing a bounded
`reportImageWidth` (64…1600, default per the open decision below) into
`src/settings/settings-schema.js`. Layer 1 reads it as its default width.

Explicit, not learned. Silently adopting whatever the user last dragged means
one deliberate thumbnail poisons every later insert, and the user has no way to
see or undo the rule. One click, permanent, visible in the menu that set it.
Mirroring it as a plain number field beside the other report settings on the
options page is optional and cheap; the menu item is the discoverable path,
because it appears at the moment the user is already correcting a size.

### Layer 4 — reports that already exist

Never rewrite saved content silently. Two affordances instead:

- A selected image with no width shows `Original` in the chip, so Layer 2's
  presets fix it in one click.
- On load, if the report contains unsized images, one dismissible line in the
  existing status area — *"3 photos have no size set · Fit them"* — applying all
  of them as a single undoable step.

Markdown mode inherits every layer through the `|640` suffix. Plain mode remains
the untouched native textarea.

## Non-goals

- Downscaling the uploaded file. The hosted image stays full resolution; only
  its display size in the report changes.
- A responsive or percentage width. Peakbagger's markup surface accepts pixel
  `width`/`height` only (`src/reports/report-markup.js:214-225`); this plan does
  not widen the allowlist to `style`.
- Any change to the 1,600 px serialization ceiling or to the existing drag and
  arrow-key resize behavior.
- Touching video or YouTube sizing. Their node views share the pattern
  (`src/reports/report-rich-editor.js:194-345`) and can adopt Layers 2–3 later;
  the sizing pain reported is about photos.

## Implementation units

Each unit is one commit, buildable and tested on its own.

1. **`feat(reports): insert photos at a readable default width`** — Layer 1 for
   the photo-editor and library paths: dimensions on `PHOTO_INSERT_COMMIT`,
   validated in `cleanPublicInsertion()` and `cleanPhotoInsertion()`, fitted
   width passed to `insertImage`. Tests: sized insert, no upscale of a small
   source, malformed/oversized dimensions rejected without failing the insert.
2. **`feat(reports): size a pasted image URL before inserting it`** — Layer 1
   for the popover path, including the timeout fallback to today's unsized
   insert. Tests: measured insert, load failure and timeout both still insert.
3. **`feat(reports): offer one-click image sizes on selection`** — Layer 2 chip
   and preset menu, keyboard reachable, both themes. Tests: presets write the
   expected attribute, current size is marked, `Original` clears the width.
4. **`feat(reports): remember a chosen image width for new photos`** — Layer 3
   setting, bound, and menu item. Tests: schema bound and normalization, new
   inserts honor the stored width.
5. **`feat(reports): offer to fit unsized photos in an existing report`** —
   Layer 4 status-line offer, applied as one undo step. Tests: offer appears
   only when unsized images exist, dismissal sticks for the session, undo
   restores every image at once.

## Verification

- `npm test` after each unit; extend
  `test/reports/report-editor-media.test.mjs` beside the existing insert/resize
  tests, and `test/settings/settings-schema.test.mjs` for unit 4.
- Round-trip assertions in `test/reports/report-markup.test.mjs`:
  `[img src="…" width="640"]` ⇄ `![alt|640](url)` ⇄ DOM, width-only (no height)
  in both directions.
- Real-browser pass after units 3 and 5: fixture-served `ascentedit.aspx` over
  **HTTPS on a real Peakbagger hostname** (plain `http://localhost` is refused
  by `src/peakbagger/peakbagger-request.js` and the check fails for the wrong
  reason). Insert a photo, screenshot the selected state at desktop and narrow
  widths, confirm the chip and handle do not collide and that the serialized
  form carries the width. State whether the run was hidden or visible, the
  renderer, and the viewport.
- One read-only, rate-limited look at a real public ascent page that has photos
  in its report, to settle the open decision below.

## Open decision — the default number

The fitted width should be pinned by measuring, once, on a real ascent page:

1. the rendered trip-report column width on desktop, and
2. whether Peakbagger's stylesheet constrains `img` (e.g. `max-width: 100%`).

If it does constrain, **800 px** is the right default. If it does not, a fixed
pixel `width` overflows a phone viewport and **640 px** is the safer default —
still a vast improvement over 4,032. Ship Layer 1 with 800 pending the
measurement, and treat the number as a one-line change once measured.
