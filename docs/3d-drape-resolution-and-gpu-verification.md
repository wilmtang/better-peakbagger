# Drape resolution on tilt, and verifying on the real GPU

The 3D terrain view drapes raster topo tiles over a Mapterhorn DEM mesh.
Two related problems shipped together: the raster drape blurred on small
pitch changes, and the test suite that should have caught it was running on
SwiftShader — a software renderer that pegged the CPU for minutes and proved
nothing about what users see.

## The tilt blur

### Symptom

At zoom ~13.6, tilting the camera from pitch 50 to 52 caused the raster
drape to visibly lose resolution: the centre tile dropped from z15 to z14,
and centre-frame detail fell from 6.41 to 5.48 against a rising trend.
Tilting back restored the detail instantly.  The step was unambiguously
drape-only — peak rings (circle layers, not rendered to texture) stayed
sharp through the same tilt.

### Root cause

MapLibre's render-to-texture (RTT) terrain pipeline drapes `raster`,
`hillshade`, and `line` layers into a fixed 2048 px texture per terrain
mesh tile (`tileSize(1024) × qualityFactor(2)`), then maps that texture
onto the 3D mesh.  `circle` and `symbol` layers are drawn directly in 3D
— not draped — which is why peak rings stayed sharp while everything else
blurred; that asymmetry is what identified the RTT drape, rather than tile
loading or the GPU, as the culprit.

Each mesh tile's zoom level is chosen by a pitch- and distance-sensitive
LOD heuristic (`calculateTileZoom`, stock spread 9.314 zoom levels on
screen).  A small tilt pushes the tiles beneath the camera past a zoom
boundary, snapping the drape down one level: the tile now covers twice the
ground with the same 2048 px texture, halving resolution in one frame.

The terrain DEM source is not affected the same way because its tiles are
those same 2048 px render targets — their LOD is controlled by the mesh
quality factor, not the per-source zoom spread.

Retina compounds the problem.  MapLibre's drape texture ignores
`devicePixelRatio`, so on a 2× display the drape is already at ~1 texel
per device pixel at its best LOD.  One zoom step down drops that to ~0.5,
right where softness is obvious.  On a 1× display the same flip is mostly
invisible.

### Fix

`src/terrain-frame.js` calls MapLibre's `setSourceTileLodParams` to tighten
the spread to 4 zoom levels for the raster drape source only.  At that
spread the centre tile holds z15 through pitch 60, which covers every pitch
the 3D view actually uses.

Scope matters more than the number:

- **Only the drape source.**  The terrain source keeps the stock LOD because
  clamping it balloons the mesh from 14 tiles to 292 at pitch 80 — each one
  a 2048 px render target.
- **Not tighter than 4.**  At 2 or 1 the screen collapses onto a single LOD
  and flips as a whole, amplifying the symptom.
- **Not every host.**  The tighter LOD trades roughly 2–3× more tile
  requests for sharper rendering.  OpenTopoMap is volunteer-run under a tile
  usage policy, and a basemap read live off the page is an unknown host on
  unknown terms; both keep the stock LOD.  `terrain-basemap.js` marks them
  with `stockLod: true`, and `applyBasemapLod` skips them.

The LOD is applied in two places — `addBasemapLayer()` for user-initiated
layer switches, and the constructor `load` handler for the initial drape —
because the constructor-style source already carries the raster data before
the first `addBasemapLayer` call.

### Known limitation

Mesh LOD still flips past pitch 68.  That is controlled by MapLibre's
internal `qualityFactor` and the gigabytes of render targets it would need
to hold more mesh tiles; fixing it is upstream's to solve.

## SwiftShader and GPU verification

### Symptom

`scripts/verify-terrain-visual.mjs` passed `--use-angle=swiftshader` and
`--enable-unsafe-swiftshader` to Chrome, forcing every run to
software-render MapLibre's terrain.  Each terrain tile drapes through a
2048 × 2048 render target, so the suite pegged the CPU for minutes and
capped `MAX_TEXTURE_SIZE` at 8192.  The output screenshots looked plausible,
but they exercised a renderer no user runs.

### Root cause

The flags assumed headless Chrome cannot reach the GPU.  That was never
true: headless Chrome (new headless, not `chrome-headless-shell`) reaches
the real hardware renderer on its own — ANGLE Metal on macOS, the platform
default elsewhere.  Dropping the ANGLE override keeps the run hidden and
takes the suite from minutes of pegged CPU to ~16 s at 77 %.

### Fix

1. Removed `--use-angle=swiftshader`, `--enable-unsafe-swiftshader`, and
   `--disable-gpu` from the Chrome launch arguments.
2. Added a renderer assertion at the start of the suite: it creates a WebGL
   context, reads `WEBGL_debug_renderer_info`, and fails closed if the
   unmasked renderer matches `swiftshader`, `software`, or `llvmpipe`.
   The actual renderer string is logged so a future failure reads
   `Renderer: ANGLE (Apple, …, Metal)` rather than a mysterious timeout.

The assertion is the important part.  Trusting the absence of `--use-angle`
is not enough — a Chrome update, a missing GPU driver, or a CI environment
could silently fall back to software.  Failing closed on the renderer means
the suite either proves something about the GPU users have or tells you it
cannot.

### Rules captured in AGENTS.md

- Never pass `--use-angle=swiftshader`, `--enable-unsafe-swiftshader`, or
  `--disable-gpu` to anything rendering WebGL.
- Assert the renderer rather than trusting the flags.
- `--disable-gpu` is still acceptable for static, non-WebGL page screenshots
  where it buys determinism.
- If a graphics check is burning CPU, suspect the renderer before the
  workload.

## Verification

The drape LOD tests are in `test/terrain-basemap.test.mjs`: they pin that
OpenTopoMap and live Leaflet layers keep `stockLod: true`, and that every
other known host takes the tuned LOD.  The GPU renderer assertion runs at
the start of every `npm run terrain:verify` invocation.  Both changes were
verified on the real GPU at DPR 2 against Mapterhorn DEM and CalTopo tiles.
