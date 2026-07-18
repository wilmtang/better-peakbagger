# Vector basemaps for the 3D terrain view

## Goal

The 3D terrain view drapes Peakbagger's 2D raster layers over the Mapterhorn
DEM. Raster drapes bake their labels into pixels, so when the camera pitches
and rotates, place names lie flat on the terrain, stretch up hillsides, and
turn upside down with the view. A **vector** basemap fixes this the way Gaia
GPS or Google Maps' 3D mode does: geometry drapes onto the terrain while
MapLibre renders labels as live symbols that billboard upright toward the
camera at every pitch and bearing, stay sharp at any zoom, and never rotate
with the ground.

This document evaluates third-party vector-tile providers the extension could
use for that, records the facts verified while evaluating them (July 2026),
and explains the recommendation the `OSM Vector (experimental)` prototype implements.

## What a provider must offer

The extension ships no server or remotely loaded executable code, and treats
every third-party request as a privacy decision (today the 3D view deliberately
contacts exactly one third party: Mapterhorn, for DEM tiles). A candidate
therefore needs:

1. **No API key and no registration.** A key shipped inside a public,
   AGPL-licensed extension is a public key; per-user keys are a sign-up wall.
   Domain-allowlist authentication cannot work either — the terrain frame's
   origin is `chrome-extension://…`/`moz-extension://…`, which providers do
   not accept as a registrable domain.
2. **CORS on every request class.** The frame is an extension page, so the
   style JSON, TileJSON, vector tiles, glyphs (fonts), and sprites are all
   plain cross-origin `fetch`es and each must carry
   `Access-Control-Allow-Origin: *`. (This is the same constraint that
   already decides which 2D layers can drape — see
   `3d-map-basemap-drape-cors.md`.)
3. **Terms that allow a free client-side app** with attribution, at hobbyist
   traffic levels, without a bandwidth contract.
4. **A usable outdoor story.** Peaks, water, land cover, trails/paths, place
   names. Contours and hillshade are *not* required from the provider — the
   extension already renders its own hillshade from Mapterhorn DEM and can
   derive contours from it later.
5. **A few origins, ideally one.** Every origin is a line in the privacy
   disclosure.

## Candidates

### OpenFreeMap — recommended

<https://openfreemap.org> — free public vector-tile host of full-planet
OpenStreetMap data in the OpenMapTiles schema, run by Zsolt Ero (MapHub),
with bandwidth sponsored by Cloudflare.

Verified directly (July 2026, `curl` with a `chrome-extension://` Origin):

- Style `https://tiles.openfreemap.org/styles/liberty`, the TileJSON at
  `…/planet`, vector tiles `…/planet/<build>/{z}/{x}/{y}.pbf`, glyphs
  `…/fonts/{fontstack}/{range}.pbf`, sprite `…/sprites/ofm_f384/ofm.{json,png}`,
  and the low-zoom Natural Earth raster `…/natural_earth/ne2sr/{z}/{x}/{y}.png`
  all answered `200` with `access-control-allow-origin: *` and long public
  cache lifetimes (tiles/sprites: one year).
- **Everything lives on the single origin `tiles.openfreemap.org`.**
- Site states: no registration, no API keys, no user database, no cookies,
  "no limits on the number of map views or requests", commercial use allowed.
  Attribution "OpenFreeMap © OpenMapTiles, data from OpenStreetMap" is
  required and arrives automatically via the TileJSON `attribution` field.
- Styles offered: Liberty, Bright, Positron, **Dark**, Fiord (all verified
  `200`) — a real dark style exists for theme follow-up.
- Vector tiles go to z14 (standard OpenMapTiles; MapLibre overzooms beyond
  that, which is fine because the extension supplies its own terrain and
  hillshade detail). The tileset includes the `mountain_peak` layer (named
  peaks with elevation) — none of the stock styles render it, but the
  extension could add its own peak-label layer later, which is a very good
  fit for this audience.
- Reliability: no SLA ("I don't offer SLA guarantees"), but the service is
  Cloudflare-fronted, survived a 100k-requests/second abuse spike in
  August 2025 while still serving 96% of requests, and is fully
  self-hostable (the whole stack and full-planet builds are open) if the
  public instance ever went away.
- Privacy posture: no cookies or user accounts; the CDN (Cloudflare) and the
  origin necessarily see tile coordinates and the requester's IP — the same
  class of exposure as Mapterhorn today. Tile fetches from the frame are sent
  with `credentials: 'omit'` semantics anyway (MapLibre default) and carry no
  Peakbagger context.

### VersaTiles — solid runner-up

<https://versatiles.org> — a FLOSS map stack (funded by NLnet and
MIZ Babelsberg) with a free public server at `tiles.versatiles.org`, no API
key. Verified: the Colorful style JSON, vector tiles
(`/tiles/osm/{z}/{x}/{y}`), and glyphs all answer with
`access-control-allow-origin: *`, single origin. Styles: Colorful, Graybeard,
Eclipse (dark), Neutrino, Shadow.

Why it is second, not first:

- It serves the **Shortbread** schema, not OpenMapTiles: no `mountain_peak`
  layer with elevations, and generally thinner outdoor/POI content than the
  OpenMapTiles planet build.
- Its styles use the multi-sprite form (`sprite: [{id, url}]`), which needs
  `map.addSprite()` and per-icon `basics:` name prefixes when grafting into
  an existing style — slightly more merge code.
- The public server publishes no terms/limits statement at all; OpenFreeMap
  explicitly commits to free unlimited use.

It recently published global hillshade/terrain data too, but the extension
already has Mapterhorn for that.

### Protomaps — great tech, wrong fit for a serverless extension

<https://protomaps.com> — single-file PMTiles basemaps designed for
self-hosting on cheap object storage, plus a hosted API.

- The hosted API (`api.protomaps.com`) **requires an API key** — verified: an
  unkeyed style request returns `403`. Free for noncommercial use, paid via
  GitHub sponsorship for commercial use. A key shipped in this public repo
  would be everyone's key; per-user keys are a sign-up wall. Not usable here.
- Self-hosting is genuinely cheap (their calculator: ~$11/month on
  Cloudflare for 625k tile requests) but means the maintainer starts
  operating map infrastructure that every user's traffic depends on — a
  bigger commitment than this extension makes for anything today. It would
  also add a `pmtiles` protocol adapter dependency to the generated runtime.
- Worth revisiting if a keyless free instance ever appears or if the project
  ever wants first-party infrastructure.

### OpenMapTiles-based free endpoints

OpenMapTiles is the schema, not a service; its commercial steward is MapTiler,
whose endpoints **require an API key** (free tier exists, but keyed and
origin-restricted — same shipped-key problem as Protomaps/Stadia).
`demotiles.maplibre.org` is keyless but is an intentionally minimal
demo (low zoom, no glyph coverage for a real style) and not offered for
production. **OpenFreeMap is, in effect, the production-grade keyless
OpenMapTiles endpoint**, which is why it is evaluated as the primary
candidate rather than separately.

### Stadia Maps / MapTiler free tiers — ruled out on authentication

Both offer polished styles (Stadia's Outdoors style even includes contours)
and free tiers, but both authenticate by API key or registered web domain.
An extension page cannot present a registrable domain, and a shipped key is
public. Ruled out for this architecture; noted here because they would be the
obvious choices for a hosted web app.

## Comparison

| | OpenFreeMap | VersaTiles | Protomaps hosted | Protomaps self-host | MapTiler/Stadia free |
|---|---|---|---|---|---|
| API key / signup | none | none | key required (403 without) | n/a (own bucket) | key or domain auth |
| CORS `*` on style/tiles/glyphs/sprites | yes (verified) | yes (verified) | n/a without key | operator-controlled | yes, keyed |
| Origins contacted | 1 (`tiles.openfreemap.org`) | 1 (`tiles.versatiles.org`) | 1 | operator's | 1–2 |
| Schema | OpenMapTiles | Shortbread | Protomaps v5 | Protomaps v5 | OpenMapTiles / Stadia |
| Peaks w/ elevation in tiles | yes (`mountain_peak`) | no | partial (`pois`) | partial | yes |
| Dark style available | yes (Dark, Fiord) | yes (Eclipse) | yes | yes | yes |
| Stated limits | "no limits", commercial OK | none published | free noncommercial | own cost | quotas |
| Funding/backing | donations + Cloudflare bandwidth | NLnet/MIZ grants | company | self | company |
| SLA | none | none | none on free | self | none on free |
| Fit for this extension | **best** | good fallback | blocked (key) | blocked (infra) | blocked (key) |

## Recommendation

**OpenFreeMap, Liberty style**, as a single extension-provided entry in the
3D drape picker (`OSM Vector (experimental)`). It is the only candidate that is
simultaneously keyless, CORS-clean on every request class, single-origin,
explicitly unlimited and commercial-use-friendly, OpenMapTiles-rich (peaks!),
and self-hostable as an escape hatch. VersaTiles is the designated fallback
if OpenFreeMap's posture changes — the prototype's merge code is
provider-shaped, not hardcoded to Liberty's contents, so swapping the style
URL (plus small multi-sprite handling) would be a contained change.

## Privacy surface

Selecting `OSM Vector (experimental)` makes the terrain frame contact **exactly one
new third-party origin, `https://tiles.openfreemap.org`**, for six request
classes: style JSON, TileJSON, vector tiles, glyph ranges, sprite JSON+PNG,
and low-zoom Natural Earth raster tiles. As with Mapterhorn and raster
drapes, tile coordinates necessarily describe the viewed area (the climb's
location) to the provider and its CDN (Cloudflare). Nothing else is sent: the
requests are `credentials: 'omit'`/`no-referrer` from the extension frame and
carry no Peakbagger identity.

- **No `manifest.json` change is required.** The frame is an extension page;
  MV3's default extension-page CSP restricts scripts, not `connect-src`, and
  the provider's `Access-Control-Allow-Origin: *` satisfies CORS without a
  host permission. This was verified in a real Chromium with the unpacked
  extension loaded (see the prototype's verification notes). Deliberately
  **not** adding a host permission keeps the request subject to CORS and
  visible in the disclosure rather than silently privileged.
- Traffic starts only when the user explicitly picks the entry — never by
  default — matching how raster drapes behave today.
- The options page, first-use 3D confirmation, and README privacy section name
  OpenFreeMap alongside Mapterhorn. The UI identifies OpenFreeMap—not
  OpenStreetMap—as the service receiving vector requests; OpenStreetMap is the
  underlying data source.

### Why it is not in the native 2D picker

OpenFreeMap's supported public interface is a MapLibre style plus vector tiles,
glyphs, and sprites. Its documentation shows a MapLibre-to-Leaflet binding for
2D use, but publishes no supported raster tile endpoint. Peakbagger's native 2D
selector creates Leaflet raster layers from URL templates and does not ship that
binding. Adding this entry there would therefore require a second WebGL renderer
and lifecycle integration, not a safe endpoint substitution. Peakbagger's
existing OpenStreetMap raster layer remains available in 2D.

## Prototype notes (what `OSM Vector (experimental)` does)

- The entry lives in `src/terrain-frame.js` (`VECTOR_BASEMAP`), not in
  `src/terrain-basemap.js` — it is extension-provided, not mirrored from
  Peakbagger's Leaflet menu, so the 2D-menu mirror stays untouched.
- On selection the frame fetches the Liberty style once per frame lifetime,
  then grafts it into the live inline style: sources and layers are added
  under `bpb-vector:`-prefixed ids (no collisions with `terrain`, `basemap`,
  or `bpb-route*`), `map.setGlyphs`/`map.setSprite` supply fonts and icons,
  and the style-level `terrain`/route/highlight state is untouched — no
  `setStyle`, so the Mapterhorn terrain mesh is not rebuilt.
- Layer order: non-symbol vector layers are inserted **below
  `terrain-hillshade`**, so the extension's hillshade keeps shading the map
  exactly as it does raster drapes; symbol layers are inserted **above the
  route** (below the hover highlight), so labels stay crisp over both
  terrain and track.
- Upright labels come from MapLibre defaults: Liberty sets no
  `text-pitch-alignment`, so point labels (places, POIs, water names)
  default to viewport alignment and billboard upright under pitch/rotation,
  while road labels keep `text-rotation-alignment: map` and follow their
  roads — the same behavior Gaia-style apps show. Verified in a pitched,
  rotated real-browser session.
- Failure falls back exactly like a CORS-blocked raster drape: notice +
  revert to terrain-only; the picker entry is not permanently disabled
  because a style fetch can fail transiently.

## Next steps (not in the prototype)

- **Dark theme:** load `styles/dark` (or Fiord) when the frame theme is
  dark, and re-graft on theme switch. Today the entry always uses Liberty.
- **Peak labels:** add an extension-owned symbol layer over the tileset's
  `mountain_peak` source-layer (name + elevation) — high value for this
  audience and free with the same tiles.
- **Caching:** vector/glyph/sprite responses are served with long public
  cache lifetimes and could join a bounded CacheStorage cache like
  `terrain-cache.js` gives Mapterhorn DEM tiles; the browser HTTP cache
  already helps meanwhile.
- **Contours:** derive from Mapterhorn DEM client-side (e.g.
  maplibre-contour) rather than adding another provider.
- **De-drape polish:** consider dimming `terrain-relief` under the opaque
  vector background (currently simply covered), and evaluate whether the
  0.48 hillshade exaggeration reads well over Liberty's palette.
- **Vendoring glyphs/sprites** under `vendor/` would cut two request classes
  and work offline, at the cost of ~arbitrary font-range files; only worth it
  if the feature graduates from beta.
