# Peakbagger peak dots on the 3D terrain view

The native 2D map draws small ring markers for the peaks in view — green for
climbed, pink for unclimbed, orange when nobody is signed in — and reloads
them from a server feed on every pan/zoom settle. The 3D terrain view now
mirrors that behavior end to end: the same feed, the same request parameters,
the same zoom cutoff, the same ring colors, and the same click-for-name-link
popup, on both the ascent page and the Full Screen BigMap.

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
3. **Coordinators** (`src/gpx-analyzer.js`, `src/big-map.js`): answer via the
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
   Everything fails closed to "no dots" — the terrain view never breaks
   because of markers.

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

0. **A dot marks Peakbagger's database coordinates, not the rendered
   summit.** The feed's features carry only lat/lon — no elevation is ever
   set by this extension. MapLibre elevates each billboard in the circle
   shader (`get_elevation`) by sampling the same Mapterhorn DEM the
   mountains are drawn from, at exactly that point, with exaggeration 1. A
   ring therefore always sits on the rendered ground at its own coordinates
   and cannot float — but nothing places it on the mountain's apex. Three
   "summits" can disagree: the database coordinate, the DEM's rendered high
   point (finite DEM resolution smooths and shifts sharp peaks), and the
   true summit where a GPS track converges. When the database coordinate is
   some tens of meters off, the ring lands visibly downslope at high zoom
   and pitch. The 2D map draws the identical data at the identical spot —
   flat tiles just cannot betray the offset. Snapping dots to a local DEM
   maximum would misrepresent the data (and could grab a neighboring bump),
   so they stay at the feed's coordinates.
1. **The clamped far field.** At high pitch, dots load for roughly 3× the
   straight-down viewport around the camera center, not all the way to the
   horizon (where they would be sub-pixel anyway). Panning re-requests, so
   the near field is always populated.
2. **No terrain occlusion.** Circle layers draw over terrain, so a ring
   behind a ridge is still visible (the native 2D map has no equivalent
   situation) — and, consistently, still clickable where it is drawn.
   Switching to a symbol layer in `buildPeakLayers()` would opt into
   MapLibre's terrain occlusion if wanted.
3. **A capped feed keeps the most prominent peaks.** The native map renders
   everything the feed returns; the 3D view caps at 400 markers (prominence
   priority) as a defensive budget, same spirit as the route point budget.
4. **Group BigMaps show no dots** — deliberate native parity, not a gap.
5. The billboarded peak-name **labels** PoC (vendored glyphs, symbol layer)
   lives on `feat/3d-peak-labels-poc` and is complementary: dots + popup here
   are DOM/circle-based and need no glyphs.

## Verified

- 178/178 unit tests, including: the shared client's URL/context/XML
  semantics against the archived response shape; frame validation,
  stale-reply rejection, zoom cutoff, popup safety (name as text, link from
  integer id); the screen-space hit test (edge miss, nearest-of-overlapping
  wins, hover cursor set and restored, constant `circle-pitch-scale`
  pinned, and no layer-scoped handlers ever registered); bridge forwarding;
  both coordinators end-to-end with a stubbed feed (ascent: `t=A&cid=…`, no
  `pid`; group: `unavailable`).
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
- Packaged-extension load smoke check on Chrome for Testing 150 (manifest
  with the new content script loads).
