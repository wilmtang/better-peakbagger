# Report image captions

Status: planned; runtime implementation has not started.

## Outcome and scope

Let users add an optional visible caption beneath a trip-report image in Rich
text. Keep the caption attached to that image through editing, resizing, draft
restoration, Photo Topos replacement, saving, and reopening. Alt text remains a
separate accessibility description.

Rich text owns the dedicated caption controls. Markdown must preserve caption
text and its association with the image; a dedicated Markdown caption command is
optional. Existing uncaptioned images retain their current behavior and format.
Video captions, numbering, alignment settings, gallery layouts, and text burned
into uploaded photos are outside this change.

## Findings that constrain the design

- `src/reports/report-rich-editor.js` extends TipTap Image with bounded dimensions
  and a custom resize/local-preview node view. Images are currently inline nodes.
  A captioned block cannot simply replace every inline image without changing
  existing prose, links, lists, and tables.
- `src/reports/report-markup.js` is the shared conversion boundary for Rich HTML,
  Markdown, preview HTML, and saved Peakbagger bracket markup. Its image AST stores
  source, alt text, width, and height. Neither `figure` nor `figcaption` is currently
  allowlisted. Adding a caption only to the editor DOM would lose it on conversion.
- Markdown image titles and alt text are not a caption storage channel in the
  current converter. A following italic paragraph would preserve words but cannot
  distinguish a caption from ordinary report prose. Do not infer captions from
  proximity or typography.
- `src/reports/report-editor.js` replaces edited photos by exact node position and
  source, and uploads replace sources by walking nodes named `image`.
  `src/reports/report-local-photos.js` also owns local-image replacement. Preserve
  those contracts or update all affected paths together; duplicate image URLs
  must not cause one occurrence's caption to overwrite another's.
- The maintained guide, `docs/trip-report-editor.md`, documents lossy-conversion
  guards and the supported Peakbagger markup. A browser rendering locally generated
  HTML does not establish that Peakbagger accepts and returns new saved tags.

## Proposed interaction

- Selecting an image exposes **Add caption** in its contextual controls, reachable
  by keyboard. Adding it creates an editable text region directly below the image
  and places the caret there. Do not show empty caption rows on every image.
- Captions start as plain text, wrap naturally within the displayed image width,
  and use restrained but accessible styling in light and dark themes. Placeholder
  text is editor-only and must never reach preview, drafts, or saved markup.
- Enter leaves the caption for report prose; arrows and Backspace at boundaries
  must allow navigation without trapping the caret or unexpectedly deleting the
  photo. Use the document editor's history for caption edits and removal.
- Removing a caption keeps the image, its dimensions, and its alt text. Deleting
  or moving a complete captioned image acts on image and caption together. Undo
  restores the pair. An empty caption serializes as an ordinary image, while the
  active empty editing state may exist transiently inside Rich text.
- Adding a caption to an inline image splits surrounding prose into blocks while
  preserving text, marks, links, and order. Captioning a linked image must preserve
  its link. Support captions inside list items and table cells where the schema
  permits blocks; cover these cases explicitly before enabling the control there.

## Saved-format decision — resolve before runtime implementation

Preferred candidate: a narrowly defined figure containing exactly one image
(optionally linked) and one plain-text caption. For example:

```text
[figure][img src="https://example.com/ridge.jpg" alt="Rocky ridge"]
[figcaption]Looking north from the summit.[/figcaption][/figure]
```

This is a proposed format, not a claim of Peakbagger compatibility. Determine the
canonical whitespace as part of the probe: Peakbagger converts remaining newlines
to breaks, so serializer formatting must not introduce unwanted gaps.

1. Look for existing source-grounded evidence or a minimal read-only example of
   Peakbagger displaying and returning figure/caption markup. Verify appearance
   without the extension as well as the edit-field representation. Do not post or
   save a live report as an automated compatibility probe; an actual server save
   requires an explicitly authorized manual test if read-only evidence is absent.
2. Confirm that an isolated HTTPS Peakbagger fixture can load the real `dist/`
   extension before implementing UI. `scripts/verify-report-photos.mjs` already
   defines a hidden Chromium profile and the appropriate fixture transport, but
   its availability has only been inspected, not exercised for this plan.
3. If figure markup is supported, record the evidence and use that structure
   consistently in the AST, saved output, and editor. Prefer a wrapper retaining
   the existing `image` child so local-photo and resize behavior can be reused.
4. Preserve that same explicit structure in Markdown through a narrow HTML form
   such as `<figure><img ...><figcaption>...</figcaption></figure>`. Its text remains
   editable in Markdown and round-trips back to a caption in Rich. This avoids
   inventing ambiguous Markdown syntax or silently flattening captions into prose.
5. If native figure markup fails, revise this section with an equally unambiguous,
   verified representation before implementing persistence. Ordinary image-plus-
   paragraph output is only a visual fallback, not fulfillment of attached-caption
   persistence. If server evidence is unavailable, record that verification gap;
   do not claim the save/reopen requirement complete based on fixture results.

## Implementation sequence

Commit each completed, independently verified unit before beginning the next.
Do not ship or commit a half-connected UI that drops caption data.

### 1. Conversion contract and regression coverage

- Resolve the format decision and specify exact accepted structure, nesting,
  whitespace, and empty-caption normalization in this plan.
- Extend the shared AST, bracket parser, DOM parser, Markdown HTML handling,
  serializers, and diagnostics in `src/reports/report-markup.js` together.
- Accept only the required figure structure and caption text. Reuse existing URL,
  link, and dimension validation. Do not allow arbitrary attributes, styles,
  events, nested media, or general HTML through the caption path. Preserve the
  existing conversion warning behavior for malformed or unsupported input.
- Add `test/reports/report-markup.test.mjs` cases for repeated round trips between
  all formats, Unicode, quotes, brackets, HTML-like text, whitespace, empty and
  long captions, linked images, invalid nesting, and unsafe URLs/attributes.
- Prove existing image-only documents keep their canonical output and that
  unrelated following text is never promoted into a caption.

### 2. Rich editing and photo lifecycle

- Add the captioned-image schema and contextual editing behavior in
  `src/reports/report-rich-editor.js` and `src/reports/report-editor.js`.
  Keep editable caption content in the document model, not an unmanaged input
  layered over the node view.
- Add scoped presentation in `src/reports/report-editor.css`, including preview
  layout. Keep the resize handle attached to the image corner; resizing the photo
  must update caption wrapping without including caption height in aspect ratio.
- Preserve photo captions through local preview resolution, Photo Topos returns,
  uploads, pending-photo errors, and draft restoration. Keep exact-occurrence
  replacement and late-return rejection intact. Do not change upload payloads,
  alt-text semantics, permissions, or final Save ownership.
- Extend the media, mode, draft, and local-photo suites under `test/reports/`.
  Include keyboard entry/exit, undo/redo, removal, copy/paste, duplicate URLs with
  distinct captions, edits while Photo Topos is open, resize, linked images,
  surrounding inline prose, lists, and table cells.
- Verify Rich → Markdown → Rich, Rich → Plain → Rich, preview, autosave/restore,
  and simulated form submission all retain both caption text and association.
  Switching modes without editing must preserve the existing no-rewrite behavior.

### 3. Browser verification and documentation

- Extend the existing hidden report fixture coverage to exercise the complete
  caption workflow with real keyboard input and rendered screenshots. Reuse one
  browser launch where practical; keep fixture Save submissions intercepted.
- Inspect Rich and preview at 1280×900 and 720×900, in light and dark themes,
  with empty, short, multiline-wrapping, long-unbroken-text, and resized captions.
  Check clipping, focus visibility, image/caption width, selection, and handle
  placement. Include Chrome and Firefox evidence for the editing interaction.
- Use condition-based waits and dedicated profiles; preserve HTTPS Peakbagger
  hostnames, reliable teardown, and post-run process/artifact inspection. Report
  browser versions, viewports, hidden/visible mode, and rendering evidence. Hidden
  tests do not establish native focus or window placement; mocked server responses
  do not establish live Peakbagger acceptance.
- Run `npm test`, `npm run lint`, and `npm run verify:browsers`. After a build, run
  the extended `node scripts/verify-report-photos.mjs` for the focused photo flow.
  Add any required Firefox caption assertions to its real-extension verifier;
  a generic existing verifier pass alone does not establish caption behavior.
- Update `docs/trip-report-editor.md` with the final UX, saved format, Markdown
  representation, and actual restrictions. Archive this plan and update the index
  when complete, retaining any unresolved evidence gaps.

## Completion criteria and evidence

- [ ] Saved format selected and server compatibility evidence recorded.
- [ ] Caption association survives every supported conversion and lifecycle path.
- [ ] Existing uncaptioned and inline images retain their behavior.
- [ ] Keyboard behavior, undo, accessibility, and rendered layout verified.
- [ ] Conversion, integration, and real-browser checks run with results recorded.
- [ ] Maintained guide updated and plan archived with remaining limitations.

Planning evidence: inspected the converter, Rich image extension, insertion and
replacement paths, local-photo integration, existing report tests, browser
fixture script, and maintained editor guide. No runtime changes or test/browser
runs were performed to prepare this plan. Live figure/caption support remains
unverified. Implementation authorization is outside this planning task.
