# Map layers

The **Layers** button at the upper-left of ascent, peak, Full Screen and
standalone native maps opens one compact overlay menu. The basemap selector
stays at the upper-right in both 2D and 3D. Enable any combination of overlays;
closing the menu leaves them visible. Each row's disclosure
opens its settings below the rows; only one detail is open at a time.
The caret points down when collapsed and up when expanded. Only activating the
**Layers** button toggles the menu, including Enter or Space while it has focus.
Map/page clicks, basemap changes and Escape leave it expanded. Switching between
2D and 3D also preserves the open menu and selected detail.

| Overlay | Default opacity | Coverage and meaning |
| --- | --- | --- |
| Sentinel-2 (experimental) | 100% | Natural-color imagery from a selected satellite pass in the past 30 days. Clouds and gaps can obscure terrain. |
| Slope angle | 60% | USGS 3DEP ground slope. Yellow 20–30°, orange 30–35°, red 35–40°, purple 40–45°, dark purple ≥45°. Below 20° and missing data are clear. Resolution varies; this is not an avalanche forecast. |
| Public lands | 25% | USGS PAD-US 4.1 fee ownership: BLM-managed federal land in saturated gold, USFS-managed federal land in deep blue, then muted colors for other federal, state, local/district and tribal holdings. Uncolored areas remain unknown. Ownership does not grant public access or camping permission; this is not a private-parcel map. |
| SNOTEL stations | Fully opaque markers | Active NRCS stations in the visible map. If activation finds none, reveal up to three nearby stations within 50 km once. Visible stations keep the camera unchanged; more than 50 visible stations asks the user to zoom in. |

Opacity updates immediately. Only opacity preferences are saved on this device;
unrelated map sessions start with overlays off. A native Full Screen link carries
the current selection once, for 30 seconds, to its matching destination tab.
The destination starts with the menu collapsed. The handoff contains no GPX,
route, scene catalog or account
data. Reloading the destination starts a new session with overlays off.

The same menu controls supported 3D maps. Existing 3D consent and subject gates
still apply. Switching between 2D and 3D preserves enabled layers, opacity and
the pinned Sentinel pass. The active renderer owns its provider work; a hidden
renderer cancels requests and removes its overlay resources.

Sentinel captures show mountain-local time and scene-wide cloud percentages.
Every capture choice keeps its cloud percentage (or `?` when unknown), and the
selected picker's tooltip and accessible option label retain the full date,
timezone and cloud value, matching the original Sentinel control.
Coverage estimates geographic footprints, not cloud-free pixels. Missing pinned
captures remain unavailable instead of silently switching to Latest. Temporary
catalog errors retain already rendered imagery with explicit feedback. Choosing
a different capture replaces its tiles; failed tiles show a retryable error.

SNOTEL shares the snow card's isolated metadata client and seven-day public
catalog cache. Viewport filtering happens locally; NRCS receives no map bounds
or summit coordinates. Explicit activation reveals the nearest three stations
within 50 km when none are visible, using the original one-time zoom-out and
reduced-motion behavior. Later pans and renderer changes do not repeat it;
moving the map while the catalog loads cancels pending auto-zoom.
**Show conditions** appears only for stations authorized
by the current peak's Nearby snow card, within its existing 50 km membership.
Other stations have an official NRCS link. **Settings → General → Show SNOTEL**
controls the card and every station layer independently of weather.

Public lands puts BLM (gold, `#e69f00`) and USFS (blue, `#0072b2`) first in the
legend. Other federal land is gray, state land purple, local/district land rose,
and tribal land green, all muted so the two agency colors stand out.
Both agencies require the fee polygon's federal ownership and matching
`Mang_Name = BLM` or `USFS`, rather than proclamation/designation boundaries or
ownership alone. The detail includes [BLM camping rules](https://www.blm.gov/programs/recreation/camping).
Most BLM land allows dispersed camping, with local closures, access rules and
fire restrictions still applying. This overlay does not contain current camping
permissions, closures, campsite locations or road-access rules. Check the local
BLM office and posted restrictions before choosing a site.

## Implementation boundaries

`src/maps/map-layers.js` owns the page session and outer control. Embedded
MasterMap documents defer to a recognized parent, so one map has one menu.
The native basemap selector and its existing handler remain untouched. The
terrain frame owns its separate upper-right basemap picker. The overlay control
aligns 10 pixels inside the visible map's left edge in either renderer.
The overlay bootstrap does not depend on GPX readiness or 3D eligibility.

The presentation lives in `src/maps/map-layer-control.js`. State and opacity
validation use `src/settings/settings-schema.js`; preferences use a separate
local bridge, never the analyzer settings-write allowlist. The terrain bridge
revalidates typed snapshots, bounded status and basemap choices, source, origin,
frame generation and revision. No arbitrary tile URL or scene catalog crosses
that boundary. Full Screen handoffs use bounded `storage.session` records,
a SHA-256 destination fingerprint, source/opener tab, window, expiry and
one-use removal. Raw Full Screen URLs and their view/identity parameters are
not retained in session storage.

Native panes paint Sentinel, land, then slope below native vectors. MapLibre
owns equivalent raster sources without resetting its terrain style. Imagery
scenes are composited at full alpha into one transparent 256-pixel tile; opacity
is applied once by the renderer, so overlaps do not become darker. A tile is
published only after all intersecting scenes finish successfully. Engines own
tile reuse and request coalescing; unchanged scene sets retain their sources.
The compositor limits work to four concurrent tiles, a 128-entry waiting queue,
eight scenes per capture, 4 MiB per encoded image, 1024-pixel decoded dimensions
and 15-second transport/body/decode deadlines. Decoded bitmaps are closed after
drawing, and cancellation propagates through queued work and fetches. There is
no extension-managed persistent satellite or analytical tile cache.

The provider request and legend share one color definition. Slope uses the
USGS **Slope Degrees** template followed by explicit inclusive-lower,
exclusive-upper remapping and a color map. PAD-US uses an explicit `Own_Type`
renderer on the fee layer, with an invisible default symbol. Filtered BLM and
USFS passes draw on top in the same service export; both map engines apply opacity
once to that single image. Sources:
[USGS 3DEP service](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer),
[Esri raster function contract](https://developers.arcgis.com/rest/services-reference/enterprise/raster-function-objects/),
[PAD-US fee service](https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/0),
[Esri dynamic-layer export contract](https://developers.arcgis.com/rest/services-reference/enterprise/export-map/).

## Verification

`npm run verify -- map-layers` runs the compact component checks and real
unpacked Chrome integration with pinned Leaflet, synthetic provider responses
and hardware MapLibre. It checks all native map surfaces, independent rasters,
overlap pixels at 0/50/100%, a failing per-scene-alpha negative control, native
layer preservation, BLM/USFS classification/legend/guidance and opacity pixels,
station rendering, pinned captures, 2D/3D suspend/resume
and a real one-use Full Screen handoff. The historical Sentinel verifier entry
delegates to this integration check. Use `BPB_VERIFY_LAYERS_SCREENSHOT_DIR` to
retain integration screenshots.
Run `node scripts/verify-map-layer-control.mjs --firefox` for the matching compact
component matrix in Firefox.

`npm run verify -- snow-map` covers the real Chrome and Firefox extensions,
keyboard station popups, card selection, pending/error/retry, opt-out, renderer
handoff and narrow/zoomed layouts. Terrain and general extension verification
remain separate. Hidden fixtures do not establish live Peakbagger/provider
compatibility, native browser menus, OS focus, physical touch or screen-reader
speech. The [archived implementation ledger](archive/map-layers-and-overlays-2026-10-21.md)
retains the exact evidence and open proof gaps.
