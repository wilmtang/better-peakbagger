# Detailed FCC tiles versus public GitHub H3 tiles

October 25, 2026. **Actual decoded T-Mobile LTE tile geometry around Snoqualmie
Pass, Washington**, rendered over the same terrain, projection, bounds, color
ramp and scale. No nationwide processing is required to view these files.

![Regional and close-up comparison of detailed FCC polygons and GitHub H3 cells](comparison.png)

[Full-size PNG](comparison.png) · [Close-up PNG](close-up.png) ·
[Self-contained local page](index.html) · [Evidence](comparison-evidence.json)

The detailed source retains smaller gaps and irregular signal-strength
boundaries. The public product replaces these shapes with much broader
hexagons. This is useful visual evidence of representation differences; it is
not a controlled experiment resampling an identical, fully documented input.
The public product omits environment and aggregation metadata, and its source
vintage is only the publisher's `D25` label. Finer shapes do not establish more
accurate reception predictions.

## Inputs and rendering

- **Left:** locally generated national T-Mobile LTE PMTiles, FCC availability
  as of December 31, 2025. Decode native zoom **12** and retain outdoor-eligible
  environment codes **0 and 1**. Code 1 includes both outdoor and in-vehicle
  eligibility; filtering to code 0 alone would incorrectly remove coverage.
- **Right:** public `coverage-lte-r8-tmobile-0.pmtiles`, pinned to commit
  `28f72437259d20268dd89a0686a05c0c0b507a19` of
  [wispiANt/cell-site-atlas-tiles](https://github.com/wispiANt/cell-site-atlas-tiles).
  Decode native maximum zoom **10**; sample geometry matches H3 resolution 8.
- Center: longitude **−121.429**, latitude **47.443**. Regional view has the
  footprint of a 512-pixel-tile web map at zoom 12; the close-up is equivalent
  to display zoom **14**, enlarging the same native geometry four times.
  Neither source acquires new detail in the close-up.
- Clip tile buffers to their tile cores before drawing to avoid duplicate
  border painting. Draw weaker signal bins before stronger bins for both
  sources. Use the same `minsignal`/`dbm` colors and a single group opacity.
- Terrain: **Esri World Hillshade**, with the source URL and projected bounds
  recorded in the evidence. Attribution: Esri, Vantor, Airbus DS, USGS, NGA,
  NASA, CGIAR, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen,
  Rijkswaterstaat, GSA, Geoland, FEMA, Intermap and the GIS user community.

The comparison needed six local zoom-12 tiles and one public zoom-10 tile.
The three required GitHub byte ranges total **7,634 bytes**, retained as small
range fixtures with their SHA-256 values. The two hillshade images total
1,036,740 bytes. Raw FCC ZIPs and complete PMTiles are not checked in.

The final corrected render ran in **hidden Chrome for Testing 156.0.8078.4 at
1704 × 1440**, using static SVG and one raster thread with GPU/WebGL disabled.
This choice is appropriate for static vector/image composition; it is not a
MapLibre GPU performance check. All four terrain images loaded; the four panel
count and browser errors were checked, and the result was visually inspected.
The owned browser, server, disposable profile and certificate were removed.
The conversion batch remained stopped throughout this comparison.

## Code and reproduction

[prepare.py](prepare.py) reads only visible tiles from the existing local
national archive, loads the three cached public ranges, clips/reprojects actual
MVT polygons and writes the SVG panels plus HTML. It requests two small
hillshade exports only if their cached images are absent.

[render.mjs](render.mjs) serves the result over disposable local HTTPS on a
Peakbagger hostname, captures the page in hidden Chrome, and tears down its
resources. The browser makes no external requests. Its launch guard refuses a
Chrome launch inside the macOS Seatbelt sandbox.

With the existing local archive, Python environment and repository Playwright
installation:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  ~/Dev/fcc-tiles/.venv/bin/python \
  docs/plans/experiments/fcc-browser-coverage/comparison/prepare.py

node docs/plans/experiments/fcc-browser-coverage/comparison/render.mjs
```

Use `FCC_TILE_ROOT` to select the existing data directory and
`FCC_COMPARISON_OUTPUT` for another output directory. If the latter is empty,
the small range and terrain fixtures will be downloaded again. `BPB_REPO`
overrides the repository location used by the browser renderer. No script
starts the full conversion. On macOS, run the browser renderer only through an
approved path outside Seatbelt; all browser work must remain hidden.
