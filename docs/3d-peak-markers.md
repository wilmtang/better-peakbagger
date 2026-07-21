# Peakbagger peak dots on the 3D terrain view

The native 2D map draws small ring markers for the peaks in view — green for
climbed, pink for unclimbed, orange when nobody is signed in — and reloads
them from a server feed on every pan/zoom settle. The 3D terrain view now
mirrors that behavior end to end: the same feed, the same request parameters,
the same zoom cutoff, the same ring colors, and the same click-for-name-link
popup, on ascent pages, Full Screen BigMaps, and Peak pages. Peak pages also
pass their subject explicitly because the native `t=P` feed asks the server to
exclude that same peak; feed refreshes must never make the summit disappear.

## The native mechanism (discovered from MasterMap.aspx)

Peakbagger's own map page (`/map/MasterMap.aspx`) fetches its dot markers
from an async endpoint on every `load dragend zoomend`:

```
GET /Async/PLLBB.aspx?miny=&maxy=&minx=&maxx=&t=<mapType>[&pid=<peakId>][&cid=<climberId>]
```

```xml
<?xml version='1.0' encoding='UTF-8'?>
<ts>
  <t i="58603" n="Iron Mountain" a="43.858591" o="-103.433511" c="1" r="246"/>
  <t i="-114297" n="Peak 5000 (Prov)" a="43.893161" o="-103.410337" c="2" r="0"/>
</ts>
```

- `i` peak id (negative for provisional peaks), `n` name, `a` lat, `o` lon,
  `c` climbed flag, `r` prominence.
- Markers render only at Leaflet zoom ≥ 12 and are cleared below it ("the
  map covers too big an area").
- Rows with prominence below the page's `hj` URL parameter are dropped
  client-side; a missing prominence never passes (`parseInt` semantics).
- Only map types `P/A/K/W/I/E/U/J/S` load peaks; group maps (`G`) never do.
  These are the peak-feed subset of the full native map-type table in
  [peakbagger-map-types.md](peakbagger-map-types.md), not every value accepted
  by `MasterMap.aspx`.
- `pid` (the page's subject peak, excluded server-side) is passed for
  `P/K/I/U/E`; `cid` personalizes the climbed flag: `c="1"` climbed (green
  `GreenCircle16.gif`), `c="2"` unknown/anonymous (orange
  `SmallOrangeCircle.gif`), anything else unclimbed (pink
  `PinkCircle16.gif`). All three gifs are 16×16 hollow rings; the exact ring
  colors are `#00ff00`, `#ffcc33`, and `#ff6699`.
- Each marker's popup is a link to `peak.aspx?pid=<id>` opening in a new tab.

Verified against the live page source (Wayback capture of MasterMap.aspx,
December 2025 — the Leaflet, Google, and Bing renderers in it implement
identical semantics) and an archived real `PLLBB.aspx` response.

## How the 3D view mirrors it

Data flows through the existing analyzer → bridge → frame message channel;
the extension-origin frame never contacts peakbagger.com itself:

1. **Frame** (`src/terrain-frame.js`): on every camera settle (debounced
   `moveend`) it posts a `peaksRequest` with the visible bounds. No request
   below MapLibre zoom 11 — the same ground area as Leaflet 12 (512px vs
   256px tiles) — and the dots are cleared instead. A pitched camera's raw
   bounds stretch to the horizon, so the request is clamped to a multiple of
   the straight-down viewport around the camera center.
2. **Bridge** (`src/terrain-map.js`): forwards `peaksRequest` to the page and
   the `peaks` reply back — nothing else.
3. **Coordinators** (`src/gpx-analyzer.js`, `src/big-map.js`,
   `src/peak-map.js`): answer via the
   shared `src/peak-markers.js` client, which reads `t`/`d`/`c`/`hj` from the
   same-origin MasterMap iframe URL and issues the *identical* request the
   native 2D map would make (single-flight: a newer camera position aborts
   the in-flight fetch). Surfaces without a native peak feed — group maps, a
   missing iframe — answer `unavailable` once and the frame stops asking.
4. **Frame render**: replies are re-validated all-or-nothing (like the route)
   and drawn as hollow rings in the native colors above the route, with a
   click popup carrying the peak name as a link built from the validated
   integer id only. Clicks and hover are hit-tested by the frame in screen
   space (see below), never via MapLibre's layer-scoped events. Refreshing
   the dots closes an open popup, matching the native marker rebuild.
   The validated Peak-page subject is merged back after each replace-style
   feed reply; everything else fails closed to "no dots" — the terrain view
   never breaks because of markers.

### Clicking a dot on a pitched camera

The frame hit-tests clicks and hover itself: `peakFeatureAt()` projects every
rendered anchor through the terrain-aware `map.project()` and compares pixel
distance against the ring spec, nearest ring within the radius wins, and
anything unprojectable fails closed to a miss. Hover work is deferred to the
next animation frame, so a fast pointer costs at most one scan of the ≤400
dots per painted frame.

MapLibre's layer-scoped `click`/`mouseenter` events cannot be used here: with
terrain enabled, the library resolves the clicked pixel to a map location by
reading the *terrain surface* under the cursor (its coords framebuffer), then
queries features near that ground point. The rings, though, are billboards
drawn in screen pixels around a terrain-elevated anchor. Straight down the
two coincide, but as the camera pitches toward horizontal, the ray through a
ring's pixels grazes the summit and strikes ground far behind it — or the
sky. The resolved ground point then lands tiles away from the peak, the
peak's tile is never queried, and the click and pointer cursor go dead — the
effective click area shrank with tilt until the dots were unclickable
near-horizontal.

Two spec choices keep the drawn shape and the hit shape identical at every
pitch and camera distance:

- `circle-pitch-scale: 'viewport'` — rings render at a constant screen size
  (like the native fixed 16×16 gifs) instead of shrinking with distance from
  a pitched camera, so a constant hit radius is exact rather than
  approximate.
- The hit radius derives from the same `PEAK_MARKERS.ring` numbers the layer
  paints (`radius + strokeWidth`; MapLibre strokes outward from the fill
  radius), plus `hitSlopPx` as a touch allowance that also absorbs the
  slight offset between the shader's terrain sample and `map.project()`'s at
  high pitch.

### Privacy

No new origin and no new request shape: the extension only queries the same
same-origin Peakbagger endpoint the native 2D map queries, with the same
parameters the page itself supplies (including the climber id that the map
URL already carries). Requests happen only while the 3D view is open and only
for the area being looked at — which is the request the 2D map would have
made for the same view. Nothing is persisted.

### Changing how the markers look

All knobs live in the `PEAK_MARKERS` spec at the top of
`src/terrain-frame.js` — zoom cutoff, debounce, count cap, bounds clamp,
per-state colors, ring geometry, hit slop — and the layer definition itself
is produced by the single `buildPeakLayers()` builder (data-driven color via
a `match` expression generated from the spec). The screen-space hit test
reads its radius from the same ring spec, so recoloring a state, switching
the hollow rings to solid dots, or resizing touches only those places;
requesting, validation, and popup wiring are unaffected. Replacing the
circle layer with a symbol layer wholesale would additionally allow moving
hit-testing back onto MapLibre's own queries — symbols are queried through
the collision index in screen space, which stays correct under pitch — but
keep the constant-size + shared-spec invariant either way.

## Known limitations

A convenient real-world test case for items 0 and 1 is
[Silver Tooth, WA](https://www.peakbagger.com/peak.aspx?pid=36344): a
serrated ridge of tightly clustered spires whose knife-edge relief makes
DEM zoom levels disagree hard about every apex. Its Peak-page 3D view is
where the marker-motion reports came from that led to the held-verdict
behavior and the rise leash below.

0. **A dot's height is never computed here — and its position is snapped to
   the rendered summit.** The feed's features carry only lat/lon; MapLibre
   elevates each billboard in the circle shader (`get_elevation`) by
   sampling the same Mapterhorn DEM the mountains are drawn from, at
   exactly that point, with exaggeration 1 — so a ring always sits on the
   rendered ground at its own coordinates and cannot float. But three
   "summits" can disagree: the database coordinate, the DEM's rendered high
   point (finite DEM resolution smooths and shifts sharp peaks), and the
   true summit where a GPS track converges. A database coordinate a few
   dozen meters off lands the ring visibly downslope at high zoom and pitch
   (the 2D map draws the identical data — flat tiles just cannot betray
   the offset). So `snapToLocalSummit()` walks each dot uphill on the
   rendered terrain (`map.queryTerrainElevation`, shrinking compass
   strides) to the local DEM maximum, leashed by `PEAK_MARKERS.snap`.
   Everything fails closed to the feed's coordinates: an unreadable start
   (MapLibre reports 0 for an unloaded DEM tile, indistinguishable from the
   sea) never climbs, and a resting point that the ground keeps rising past
   is a neighboring, bigger mountain's flank — not this dot's summit — so
   it is rejected. The leash is two-dimensional: horizontal
   (`snap.leashM`, 100 m from the feed coordinate) and vertical
   (`snap.riseM`, 100 m of gain above the feed point's own terrain — the
   feed carries no peak elevation, so that is the only vertical reference
   there is). The vertical leash closes the case the keeps-rising guard
   cannot see: a taller neighboring spire whose own genuine apex sits
   *inside* the horizontal leash. The monotone-uphill walk can never cross
   a col, but a feed coordinate landing on such a neighbor's flank would
   legitimately summit it — and no plausible coordinate error times any
   plausible smoothed-DEM slope gains 100 m, so that climb (or a DEM
   spike) is rejected to the feed coordinates instead. Two dots within
   one leash of the same apex can still stack at similar heights;
   the nearest-center hit test still separates their clicks. The popup
   anchors at the snapped point; the link and name are untouched data.
   Verdicts are cached per peak (bounded, least-recently-used, cleared with
   the map): `queryTerrainElevation` reads whatever terrain tiles are
   loaded, and tilting the camera can change their resolution — on a
   knife-edge ridge the coarser DEM's apex sits somewhere else entirely,
   so an uncached dot wandered with every tilt. A verdict is re-opened only
   after crossing into a higher integer zoom level, where a finer terrain
   sample may be available. When that crossing outruns the DEM stream and
   the re-climb starts unreadable, the previous verdict keeps rendering
   (at its old zoom, so the next batch retries) — it used to fall back to
   the raw feed coordinates, hopping the dot off the summit and back
   across two settles on every zoom-in. That caching also makes every
   settle after a readable verdict free of climbing; an unreadable start
   with no prior verdict is missing data, not a verdict, and retries on
   the next batch.
1. **A dot can still slide on screen during a tilt or zoom — its height is
   the terrain's.** The snap cache pins a dot's geographic anchor: panning
   and tilting never change its lat/lon, and only a higher integer zoom may
   refine it (one deliberate hop onto the finer DEM's apex, delivered with
   the next feed batch). What cannot be pinned is the anchor's *rendered
   elevation*: MapLibre re-samples it in the circle shader from whatever
   DEM tiles are currently loaded, and the terrain source keeps MapLibre's
   stock pitch-sensitive LOD — the tightened drape LOD is deliberately not
   applied to 2048px DEM render targets (see the `stockLod` notes in
   `src/terrain-frame.js`). A small tilt or a zoom can therefore swap the
   DEM under a peak a whole level; the mountain reshapes, the ring is
   re-elevated with it, and on a pitched camera that height change projects
   as a slide across the screen — most visible on knife-edge ridges, where
   DEM resolutions disagree the most. The ring and the terrain move
   together (a ring can never float), but relative to the previous frame's
   summit it can appear to jump. Eliminating this would mean pinning the
   terrain source's LOD, multiplying DEM fetch and meshing cost for every
   view; it is a known, accepted artifact of streamed terrain.
2. **The clamped far field.** At high pitch, dots load for roughly 3× the
   straight-down viewport around the camera center, not all the way to the
   horizon (where they would be sub-pixel anyway). Panning re-requests, so
   the near field is always populated.
3. **No terrain occlusion.** Circle layers draw over terrain, so a ring
   behind a ridge is still visible (the native 2D map has no equivalent
   situation) — and, consistently, still clickable where it is drawn.
   Switching to a symbol layer in `buildPeakLayers()` would opt into
   MapLibre's terrain occlusion if wanted.
4. **A capped feed keeps the most prominent peaks.** The native map renders
   everything the feed returns; the 3D view caps at 400 markers (prominence
   priority) as a defensive budget, same spirit as the route point budget.
5. **Group BigMaps show no dots** — deliberate native parity, not a gap.
6. The billboarded peak-name **labels** PoC (vendored glyphs, symbol layer)
   lives on `feat/3d-peak-labels-poc` and is complementary: dots + popup here
   are DOM/circle-based and need no glyphs.

## Verified

- Unit coverage pins the shared client's URL, context, and XML semantics; frame
  validation and stale-reply rejection; zoom cutoff and popup safety;
  screen-space hit testing; summit snapping and held-verdict behavior; bridge
  forwarding; and coordinator behavior for ascent and group maps. The current
  suite result belongs in CI, not this design note.
- Hidden real-browser check (`scripts/verify-terrain-visual.mjs`, headless
  Chrome on the real GPU — the renderer is asserted and a software fallback
  refused — synthetic Peakbagger + synthetic PLLBB feed): feed queried with
  native parameters only after entering 3D, climbed ring found on the
  composited WebGL output by pixel color, click on the found ring opens the
  correct popup, then a right-drag pitches the camera past the 80° clamp and
  the re-settled ring must show the pointer cursor on hover and open the
  correct popup from a click on its upper half — the pixels whose
  behind-the-billboard terrain is farthest away, where layer-scoped events
  failed hardest. Zooming out clears dots and popup, and a group BigMap
  never queries the feed.
- `npm run verify:browsers` covers both real manifests and content-script loads;
  `npm run terrain:verify:firefox` adds Firefox GPU interaction coverage. See
  [development.md](development.md) for what each check can establish.
