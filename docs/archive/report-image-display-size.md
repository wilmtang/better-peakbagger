# Report image display size

Status: implemented on 2026-07-30.

## Outcome

Report sizing belongs at the point where a Photo Topos image is prepared, not
as another persistent control inside the trip-report editor. When Photo Topos
has a live report return context, both Editor and Library expose one
**Size in report** choice:

- Small — 320 px
- Medium — 480 px
- Large — 640 px, the default
- Original — no width attribute

The choice is previewed on the photo stage and remembered as the synced
`reportImageWidth` setting for later report insertions. A fixed choice is a
maximum rather than a command to upscale: a 400 px source remains 400 px.
Original sends no width. All other choices send a width only, so the browser
preserves the aspect ratio.

This is presentation metadata only. `photo-renderer.js` still exports at the
project's natural dimensions, ImgBB receives that full-resolution raster, and
the photo-library record retains the real export width and height.

## Evidence behind the 640 px default

The supplied `Ascent Editor - Peakbagger.com.mhtml` is the legacy ascent editor,
not a saved public ascent page. Its captured Peakbagger stylesheet has no
responsive rule for report images. In a hidden Chrome for Testing pass, the
`JournalText` field measured 869 px wide at a 1280 × 900 viewport and 921 px at
1440 × 900. At 390 × 844 the legacy page retained a 1096 px body and a 768 px
report field rather than becoming responsive. A fixed 800 px image would exceed
the narrower desktop report field once its padding and surrounding content are
considered; 640 px leaves a useful margin and is safer on Peakbagger's fixed
mobile layout.

## Trust and ownership boundaries

`photos/photos.js` derives the chosen display width from trusted export metadata
and sends it on `PHOTO_INSERT_COMMIT`. `src/background/photo-routes.js` validates
the optional field with the existing report dimension sanitizer before
forwarding it. `src/reports/report-editor.js` independently applies the same
sanitizer before inserting a width-only image node. Invalid or oversized values
are dropped without losing an otherwise valid insertion.

`src/photos/photo-report-size.js` owns only the preset and no-upscale decision.
It is deliberately outside the raster renderer and photo-library schema because
one hosted image may be shown at different sizes in different reports.

## Closure ledger

### Fixed and verified

- New Photo Topos uploads and reused library photos can carry a chosen,
  width-only report display size.
- Small sources are not upscaled; Original remains unsized.
- The Editor and Library controls stay synchronized and appear only while a
  report is waiting.
- The stage preview changes CSS width without changing project dimensions.
- The shared settings schema defaults to 640, preserves Original as `null`, and
  bounds untrusted values to the existing 64–1600 report dimension range.
- Worker and report-editor validation reject invalid dimensions without
  rejecting the image URL and alt text.
- Focused schema, page, editor, worker, report insertion, bundle-contract, and
  lint checks passed.
- The real unpacked extension passed in hidden Chrome for Testing (new
  headless) at 1000 × 760 and 520 × 800. Both viewports kept the control and
  320 px stage inside the page, showed the unchanged 900 × 600 project size,
  and had no horizontal overflow. The desktop and narrow screenshots were
  visually inspected.
- The packaged Firefox extension also passed its hidden 1000 × 760 startup,
  photo decode, and IndexedDB autosave verification.

### Intentionally not changed

- Direct image URLs pasted into the report editor remain unsized because their
  natural dimensions are not known at that boundary.
- Existing saved reports are never rewritten or bulk-fitted.
- The trip-report editor's existing drag and keyboard resizing remain the way to
  tailor one image after insertion.
- Display width is not stored on a photo-library record.

### Changed but not fully proven

- No live ImgBB upload was made, so provider receipt of the unchanged
  full-resolution blob is covered by the unchanged renderer boundary and local
  tests rather than a new production upload.
- Hidden browser verification cannot establish native browser chrome, window
  focus, or placement; this feature does not change those behaviors.
