# Billboarded peak labels in the 3D terrain view — PoC and plan

## Goal

The 3D view drapes raster basemap tiles over Mapterhorn DEM terrain, so every
place name on the map is baked into raster pixels: text lies flat on the
terrain surface and tilts, shrinks, and rotates with the camera. This proof of
concept renders the ascent's peak name as a **MapLibre GeoJSON source + symbol
layer** instead — crisp, screen-oriented ("billboarded") text drawn by the
extension itself from data the page already has, with no new tile or label
provider.

## What was built

- **Data** (`src/gpx-analyzer.js`): the ascent page names its peak in the
  `Peak:` details row (a link to `peak.aspx`), with the
  `Ascent of <peak> on <date>` heading as fallback — structure confirmed
  against a Wayback `id_` capture of a public ascent page. The page carries
  **no peak coordinates**, so the track's highest smoothed point
  (`metrics.points` max `eleM`) stands in for the summit; on a successful
  summit ascent they coincide to within GPS noise. The
  `{ name, coordinates: [lon, lat] }` pair rides the existing `init` message
  (MAIN-world analyzer → isolated-world `src/terrain-map.js` bridge →
  terrain frame); no second channel was added.
- **Rendering** (`src/terrain-frame.js`): a `bpb-peak` GeoJSON source with two
  layers added after map load — a small theme-aware summit dot (`circle`) and
  a `symbol` layer with `text-rotation-alignment: 'viewport'` and
  `text-pitch-alignment: 'viewport'`, which is what keeps the text upright and
  screen-facing at any camera pitch/rotation. Text and halo colors live in the
  frame's `PALETTES` and follow live theme switches like every other layer.
  `validatePeak` mirrors the frame's other validators; malformed input drops
  only the label, never the terrain view.
- **Glyphs** (`vendor/glyphs/`): symbol text requires a `glyphs` endpoint in
  the style. Two Open Sans Semibold SDF ranges (U+0000–U+01FF: Latin,
  Latin-1 Supplement, Latin Extended-A; ~146 KB) are vendored from the
  MapLibre demotiles glyph server (provenance and Apache-2.0 font license in
  `vendor/glyphs-LICENSE.txt`) and served via `chrome.runtime.getURL`, so the
  label costs **no new remote origin** — the extension's only explicit
  third-party request remains Mapterhorn, and `manifest.json` is unchanged
  (extension-page fetches of the extension's own files need no
  `web_accessible_resources` entry).
- **Tests**: bridge forwarding (`test/terrain-map.test.mjs` handshake), frame
  validation + billboard layout + fail-closed-to-no-label (frame test), and
  the analyzer's peak extraction/summit anchor
  (`test/gpx-analyzer.test.mjs`). The hidden-Chrome visual check
  (`scripts/verify-terrain-visual.mjs`) now asserts the vendored glyph range
  is fetched with `{fontstack}`/`{range}` substituted; its `getURL` shim was
  fixed to plain concatenation because `new URL()` percent-encoded the braces
  (a harness-only bug — the real `chrome.runtime.getURL` never encodes).

## Known limitations

1. **The anchor is the track's highest point, not the peak's surveyed
   coordinates.** Wrong for unsuccessful/partial ascents (labels the high
   point of the attempt, not the peak) and slightly off under GPS drift or
   when the recording stops short of the true summit.
2. **One label, ascent page only.** The Full Screen BigMap's 3D view shares
   `terrain-frame.js` (an absent `peak` simply renders no label) but its
   coordinator (`src/big-map.js`) sends nothing yet, even though its Leaflet
   map holds many peak markers.
3. **Latin-only glyph coverage.** Names outside U+0000–U+01FF (Cyrillic, CJK,
   Greek…) would request glyph ranges the package does not carry; MapLibre
   fails soft (label missing/partial, terrain unaffected), and the post-load
   glyph fetch cannot trip the frame's load-failure path.
4. **No dedup against drape text.** The draped raster's own baked-in name can
   appear near our crisp label; mostly harmless (the drape label is oblique
   and small) but visible on some basemaps.
5. **Terrain occlusion is MapLibre's default and was not deterministically
   exercised.** MapLibre hides symbols whose anchor is behind terrain; in all
   captured views the summit was visible, so the hidden-behind-a-ridge case
   rests on upstream behavior for now.
6. **`Peak:`-row parsing is a new (fail-closed) dependency on Peakbagger's
   DOM**, like the analyzer's other page hooks: if the row and heading both
   change shape, the label silently disappears.

## Next steps, in priority order

1. **Real summit coordinates.** Best sources, in order: the peak marker
   Peakbagger already places in the same-origin MasterMap Leaflet iframe
   (matches the existing `mapsPlaceholder` access pattern; fail closed), or a
   one-shot fetch of the linked `peak.aspx` page (same-origin, but adds a
   request per 3D activation and needs the page's lat/lon format pinned by a
   fixture). Keep the highest-track-point as fallback and consider labelling
   the *attempt high point* distinctly for non-summit ascents.
2. **BigMap multi-peak labels.** Extend `src/big-map.js` to read the native
   peak markers (name + latlng) it already overlays, cap the count (the
   route-point budget pattern), and reuse the same `peak`/`peaks` message and
   symbol layer with MapLibre's built-in collision handling; decide
   elevation-or-prominence priority for `symbol-sort-key`.
3. **Occlusion + collision polish.** A deterministic check (camera placed so
   a ridge hides the summit) for MapLibre's terrain occlusion; confirm the
   label reappears on rotation. Evaluate `text-variable-anchor` so the label
   slides rather than collides with the route line at low pitch.
4. **Glyph coverage decision.** Either ship additional ranges on demand
   (vendor the ~dozen ranges covering the site's common alphabets — each
   range only loads when a name needs it) or accept Latin-only for v1 and
   document it. Never fall back to a font CDN at runtime — that would add a
   third-party request the privacy model deliberately avoids.
5. **Elevation subtitle, restrained.** The page's `Elevation:` row could
   render as a smaller second line via `text-field` formatting — only if it
   survives the UX bar (one label, no clutter).
6. **Release checks.** Confirm packaged-build size impact (~146 KB), AMO/Web
   Store review of binary assets (documented provenance), and a Firefox run
   of the visual check (the harness currently drives Chromium only).
