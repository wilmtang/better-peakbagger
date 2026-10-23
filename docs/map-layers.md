# Map overlays

The **Overlays** button at the upper-left of ascent, peak, Full Screen and
standalone native maps opens one compact overlay menu. The basemap selector
stays at the upper-right in both 2D and 3D. Enable any combination of overlays;
closing the menu leaves them visible. Toggling a layer selects its matching
settings below the rows, with a tinted row and downward chevron identifying the
selected detail. Each row's disclosure also opens or closes those settings
without changing enablement; only one detail is open at a time. The
layer name and checkbox form one large visibility toggle; the separate chevron
opens settings without changing visibility. Checkbox Space activation uses the
same path as clicking the name. The menu uses BPB's warm panel palette, green
accents and 8px controls, with immediate hover/pressed feedback and no reflow
animation.
Raster percentages are explicitly labelled **Opacity**. The slider runs from
**Clear** (see the base map) to **Solid** (show the overlay at full strength).
Turning a layer off leaves its own disabled settings selected. Provider updates
do not change the selected detail or move keyboard focus.
Each row has a compact status: opacity or station count when ready,
**Loading** with a small spinner during work, **Couldn’t load** on failure, or
**Needs access** for BC permission. Detailed explanations and **Retry**/**Allow**
stay in that layer's settings. Turning a layer off hides stale loading/errors.
Spinner motion stops when reduced motion is requested.
The [regional coverage table](map-overlay-coverage.md) lists which overlays are
offered in each region. Unsupported rows stay in place with disabled toggles and
**No coverage**. Moving out of coverage turns an active overlay off and cancels
its work. Moving back makes it available without automatically enabling it.
Opacity preferences remain intact; partial coverage, zoom requirements,
permissions and temporary service failures keep their distinct feedback.
Below their zoom limits, Sentinel, slope and public lands say **Zoom in** instead
of showing stale loading/errors or an ineffective Retry. Sentinel uses its
existing capture-search limit; slope and land use the raster tile limit. Zooming
back in restores provider feedback. Both renderers use equivalent tile zoom.

Raster tiles get one automatic retry for a temporary network failure, timeout or
HTTP 408/500/502/503/504. Other errors and provider rate limits need explicit
recovery; rate-limit deadlines still apply. Partial slope, land and Sentinel
failures say **Partly loaded** and keep available content visible. Native Retry
requests only missing tiles; 3D refreshes its existing source while retaining
painted tiles. Leaving a failed tile behind removes its warning when the native tile
unloads or the terrain viewport changes. No-data areas remain clear, rather
than being treated as a transport failure or evidence of gentle ground.
Land providers are independent within each tile: a BC permission or service
failure cannot erase validated US/Alberta coverage. Each Alberta provider pass
still requires complete, validated pagination before any of its polygons are
published. Provider-specific cooldowns survive renderer changes and Full Screen
handoffs; these contain only named service deadlines, never request URLs.
Concurrent failures and renderer updates retain the longest deadline for each
provider. A shorter or missing Retry-After cannot reopen that provider early.

Retry remains anchored and rejects repeated activation while work is pending.
After success, a focused Retry becomes a working **Reload** action until focus
leaves it; it does not disappear under the pointer or become a fake success
button. Long error feedback reserves its current height during focused recovery,
so a scrollable menu cannot shrink and move Retry; leaving the action releases
that temporary reservation. Tile feedback follows complete tile/body/decode work, including queued
requests; late cancelled work cannot clear newer loading. Capture search and
imagery loading are tracked separately so Sentinel's dated picker is usable
while tiles load. Other layers, opacity and the Overlays disclosure remain usable.
The caret points down when collapsed and up when expanded. Only activating the
**Overlays** button toggles the menu, including Enter or Space while it has focus.
Map/page clicks, basemap changes and Escape leave it expanded. Switching between
2D and 3D also preserves the open menu and selected detail.

| Overlay | Default opacity | Coverage and meaning |
| --- | --- | --- |
| Sentinel-2 (experimental) | 100% | Natural-color imagery from a selected satellite pass in the past 30 days. Clouds and gaps can obscure terrain. |
| Slope angle | 60% | USGS 3DEP ground slope. Yellow 20–30°, orange 30–35°, red 35–40°, purple 40–45°, dark purple ≥45°. Below 20° and missing data are clear. Resolution varies; this is not an avalanche forecast. |
| Public lands | 25% | USGS PAD-US 4.1 fee ownership, ParcelMap BC ownership records and southwestern Alberta regional parcels. BLM and Canadian provincial Crown land are gold; USFS is deep blue; other recorded ownership uses muted colors. Canadian coverage is partial. Uncolored areas remain unknown. Ownership does not grant public access or camping permission; this is not a private-parcel map. |
| SNOTEL stations | Fully opaque markers | Active NRCS stations in the visible map. If activation finds none, frame the nearest station within 50 km once. Unobscured visible stations keep the camera unchanged; more than 50 visible stations asks the user to zoom in. |

Public-land settings have individual checkboxes for the types available in the
visible region. **All types** controls the visible categories, with a mixed state
when some are selected; selections for other regions stay saved. **Only** beside
a type selects just that type. US local and district land share one checkbox.
All types are selected by default. Clearing every type clears the land overlay
and makes no tile requests. Filtering applies to provider queries in both 2D and
3D; unchecked BLM/USFS parcels cannot reappear as Other federal. A filter change
cancels old requests and removes deselected pixels immediately, while ordinary
pans retain loaded tiles. Selections survive renderer switches, Full Screen and
page reloads. **Sources** expands the provider notes; **Check camping rules**
opens official regional guidance without adding another map preset.

Opacity updates immediately and changes only the edited raster; station markers
and unrelated overlays stay untouched. Unchanged legends are reused, and
regional land metadata is recalculated only when the viewport changes.
Opacity and public-land type preferences are saved on this device. Startup waits for both saved
opacity and settings before announcing them, and a
late startup read cannot replace a newer save.
Unrelated map sessions start with overlays off. A native Full Screen link carries
the current selection once, for 30 seconds, to its matching destination tab.
The destination starts with the menu collapsed. The handoff contains no GPX,
route, scene catalog or account
data. Reloading the destination starts a new session with overlays off.

The same menu controls supported 3D maps. Existing 3D consent and subject gates
still apply. Switching between 2D and 3D preserves enabled layers, opacity and
the pinned Sentinel pass. The active renderer owns its provider work; a hidden
renderer cancels requests and removes its overlay resources.
Style, theme and condition membership changed during frame authorization are
replayed after loading, including resume. Unknown station membership offers no
weather-card action.

Sentinel captures show mountain-local time and scene-wide cloud percentages.
Every capture choice keeps its cloud percentage (or `?` when unknown), and the
selected picker's tooltip and accessible option label retain the full date,
timezone and cloud value, matching the original Sentinel control.
Coverage estimates geographic footprints, not cloud-free pixels. Missing pinned
captures remain unavailable instead of silently switching to Latest. Temporary
catalog errors retain already rendered imagery with explicit feedback. Choosing
a different capture replaces its tiles; failed tiles show a retryable error.
Image recovery keeps the selected capture and reuses the valid catalog rather
than starting another search. Search errors have their own **Search failed**
summary; imagery errors do not disable ready capture choices or change dates.

SNOTEL shares the snow card's isolated metadata client and seven-day public
catalog cache. Viewport filtering happens locally; NRCS receives no map bounds
or summit coordinates. Catalog requests use one bounded transient retry; invalid
data, permanent failures and rate limits are not automatically replayed. Snow
observation requests keep their existing behavior. A failed refresh preserves
loaded markers, says **Refresh failed** with **Showing loaded locations**, and
recounts only known locations still in view. This is distinct from a confirmed
empty result. An overflow says **Zoom in**, rather than claiming zero stations.
Explicit activation reveals the nearest station within 50 km when none are
usable in the visible map. The camera frames that station and the previous map
center, never zooms in, and avoids the expanded overlay menu, basemap picker and
zoom controls. Further stations do not widen this discovery view; they appear
when the resulting viewport includes them. A station already clear of controls
keeps the camera unchanged. A fully covered or tiny map does not start an
unusable camera move.
The reveal uses one brief transition, or no animation with reduced motion.
Later pans, retries after a completed reveal, and renderer changes do not repeat
it. Navigation start cancels pending discovery before a late response can move
the camera; toggling SNOTEL during an ongoing gesture does not schedule a reveal.
Alaska uses the nearest wrapped longitude copy. The catalog and 50 km search
remain local and use the existing device cache.
**Show conditions** appears only for stations authorized
by the current peak's Nearby snow card, within its existing 50 km membership.
Other stations have an official NRCS link. **Settings → General → Show SNOTEL**
controls the card and every station layer independently of weather.
Startup waits for the stored setting before reporting availability, preserving
an enabled Full Screen handoff while the read is pending. A later settings change
takes precedence over that startup read. Delayed Nearby snow availability updates
the conditions actions immediately without requiring a pan. When the station
list is unchanged, membership updates preserve open popups and focused NRCS
links; removing a focused **Show conditions** action returns focus to that link.

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

The same **Public lands** row and opacity slider cover BC and Alberta; the
legend and official rule links follow the visible area. BC shows explicitly
recorded Crown provincial, federal, Crown agency, local government and First
Nations ownership. It excludes private, mixed, unclassified and untitled records.
The [LTSA definitions](https://help.ltsa.ca/parcelmap-bc/owner-type) describe
untitled parcels as lacking an active title, which alone does not establish
public ownership. ParcelMap BC is a parcel fabric, not a complete map of
unsurveyed Crown backcountry. Use **Allow** in the land detail to grant optional
access to BC maps; denial leaves an explicit retry action and makes no BC
provider request. Firefox requires a second **Allow access** click in a small
extension setup tab; it refreshes the original map after a grant. **Return to map**
closes that setup tab. Repeating setup reuses its existing tab.

Alberta shows explicit provincial and municipal classifications from
[the government's regional ownership service](https://geospatial.alberta.ca/arcgis/rest/services/Hosted/Land_use_owndership_NN_project/FeatureServer/10).
Its published extent is southwestern Alberta (roughly 49.14–53.65° N,
117.85–113.58° W); it excludes Calgary and does not cover the whole province.
Private and unknown classifications stay clear. Other Canadian provinces and
territories currently have no coverage. The detail links to
[BC Crown land rules](https://www2.gov.bc.ca/gov/content/industry/crown-land-water/crown-land/crown-land-uses)
and [Alberta camping rules](https://www.alberta.ca/camping-on-public-land).
These ownership records do not establish whether dispersed camping is allowed.

## Implementation boundaries

`src/maps/map-layers.js` owns the page session and outer control. Embedded
MasterMap documents defer to a recognized parent, so one map has one menu.
The native basemap selector and its existing handler remain untouched. The
terrain frame owns its separate upper-right basemap picker. The overlay control
aligns 10 pixels inside the visible map's left edge in either renderer.
Its document anchor scrolls with the page without waiting for JavaScript;
scroll callbacks update dropdown viewport limits and visibility. Document
coordinates survive asynchronous status paints and the dark theme's positioned body.
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
When a pan changes the scene mosaic, native maps repaint their existing canvases
and terrain reloads its existing raster source. Already painted imagery remains
visible while replacement tiles load. Native tile refreshes do not restart
Leaflet's fade animation; this also applies to slope and public-land retries.
The compositor limits work to four concurrent tiles, a 128-entry waiting queue,
eight scenes per capture, 4 MiB per encoded image, 1024-pixel decoded dimensions
and 15-second transport/body/decode deadlines. Decoded bitmaps are closed after
drawing, and cancellation propagates through queued work and fetches. There is
no extension-managed persistent satellite or analytical tile cache.
The single raster retry waits 350 ms and uses the same concurrency budget; each
attempt retains the 15-second deadline. Turning the layer off also cancels this
wait. Raster success/failure feedback tracks retained tile coordinates, instead
of preserving the first error for the renderer's entire lifetime. Browser HTTP
caching remains responsible for reusing successful provider responses.

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

BC uses a transparent, explicitly classified export from the
[provincial parcel service](https://maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_cadastre/MapServer/0).
Its CORS policy requires optional extension host access in both renderers. The
worker accepts only validated BC tile coordinates and allowlisted land-type IDs from Peakbagger content
scripts or the packaged terrain frame embedded in a Peakbagger tab. It builds
the fixed provider URL, checks permission, bounds PNGs to 1 MiB and 256 square
pixels, limits concurrent jobs to 16, and cancels on owner/tab teardown. No
general URL proxy or privileged account route is exposed. The trusted Allow
click requests permission synchronously. Browsers that reject web-page
activation open the packaged `bc-land/access.html` setup page, where permission
is requested by another explicit user click. Only that exact extension page can
acknowledge a grant to the map; its source-tab integer is not persisted.

Alberta's CORS-enabled query service returns class-only polygons. Each tile
allows four ordered pages of 500 features, 4 MiB per page, 50,000 vertices and a
single 15-second deadline. Incomplete, malformed or repeated pages fail without
publishing a partial tile. Even-odd filling preserves polygon holes. Both
Canadian sources compose into the same opaque working tile before the map
applies opacity once. Coarse, packaged public-domain Natural Earth province
outlines select providers only; parcel records determine every colored area.

## Location menu

Right-click a peak, ascent, BigMap or standalone native Leaflet map, or an active
3D terrain view, for elevation and decimal coordinates. Coordinates remain
selectable text. The first elevation unit follows the shared elevation preference
and, in Auto on peak pages, the native elevation heading; the second unit is
always shown. An enabled peak weather card adds its existing forecast/archive
action. Weather opt-out and weather cooldown do not disable the elevation readout.

The shared MAIN-world menu is owned by the map-layer lifecycle. Native point
projection lives in `src/maps/peak-weather-map.js`; the terrain frame sends a
validated, generation-bound point through its existing bridge. Only the isolated
weather card performs forecast requests. Map replacement, navigation, dismissal
and a newer selection invalidate and abort the prior elevation lookup.

`src/maps/map-elevation.js` reads credential-free Mapterhorn Terrarium tiles at
fixed zoom 14, falling back through zoom 10 only on 404. This detail policy is
independent of the viewport, 3D tile availability and terrain exaggeration.
It samples the clicked raster cell; it does not snap to a nearby peak or read
the ascent's GPX elevation. It reuses the terrain loader's bounded WebP response
validation, checks decoded 512-pixel dimensions, and shares one eight-second
deadline across downloads and decoding. Up to four decoded tiles and 64 absent
keys remain in page memory; this does not use the optional persistent 3D cache.
429 responses gate subsequent uncached lookups until Retry-After, or five minutes.
No data, polar coordinates beyond Web Mercator coverage, corrupt responses and
network errors show an unavailable reading rather than a fabricated sea level.

Elevation is a terrain estimate. [Mapterhorn's underlying source resolution](https://mapterhorn.com/)
varies geographically, and the served tile can be coarser; resolution is not a
vertical-accuracy guarantee. [Underlying sources and attribution](https://mapterhorn.com/attribution/)
remain available from the provider. Sharp summits and cliffs can differ substantially
from a survey or Peakbagger's listed summit elevation. The menu rounds to whole
units and labels the estimate instead of implying decimal precision.

## Verification

`npm run verify -- map-location` exercises the real extensions in hidden Chrome
and Firefox with pinned Leaflet and synthetic Mapterhorn/weather responses:
all four native surfaces, light/dark, desktop/narrow, slow success, no data,
service failure/reopen, rate limits, 200% browser zoom, wrapped labels,
forecast activation/cooldown, map-frame reloads, Shift+F10, and hardware 3D without
weather. Per-frame menu geometry
and the surrounding native content are compared through the pending/success
transition; failure states use the same geometry assertion. A deliberate five-pixel
shift is a negative control. Use `BPB_VERIFY_WEATHER_SCREENSHOT_DIR` to retain
screenshots. Live provider elevations, browser context-menu chrome, OS focus and
screen-reader speech remain outside these hidden fixtures.

`npm run verify -- map-layers` runs the compact component checks and real
unpacked Chrome integration with pinned Leaflet, synthetic provider responses
and hardware MapLibre. It checks all native map surfaces, independent rasters,
overlap pixels at 0/50/100%, a failing per-scene-alpha negative control, native
layer preservation, BLM/USFS classification/checklist/guidance and opacity pixels,
individual type selection, empty filters, saved preferences and Full Screen filters,
station rendering, pinned captures, 2D/3D suspend/resume
and a real one-use Full Screen handoff. Canadian checks exercise BC's
MAIN/isolated/worker relay, Allow pending/denial/retry geometry, both provincial
sources on all four native surfaces, Alberta holes/private/unsupported areas,
both sources in hardware 3D, and the packaged setup fallback and grant message.
The setup page also runs the Chrome/Firefox component matrix with stable
heading/card/action geometry, pending/denial/retry/success, guarded duplicate
activation and retained keyboard focus. Permission decisions and provider responses are
stubbed; this does not establish the browser's native optional-permission prompt
or current live parcel completeness. The historical Sentinel verifier entry
delegates to this integration check. Use `BPB_VERIFY_LAYERS_SCREENSHOT_DIR` to
retain integration screenshots.
Run `node scripts/verify-map-layer-control.mjs --firefox` for the matching compact
component matrix in Firefox.
Both browsers also sample real wheel scrolling at 736/320 × 800, light/dark,
normal/doubled control text, and open/closed menus. Delayed position callbacks
and loading/error/success paints must preserve the map inset, button dimensions
and following native content.

`npm run verify -- snow-map` covers the real Chrome and Firefox extensions,
keyboard station popups, card selection, pending/error/retry, opt-out, renderer
handoff and narrow/zoomed layouts. Terrain and general extension verification
remain separate. Hidden fixtures do not establish live Peakbagger/provider
compatibility, native browser menus, OS focus, physical touch or screen-reader
speech. The [archived implementation ledger](archive/map-layers-and-overlays-2026-10-21.md)
retains the exact evidence and open proof gaps.
The [October 21 follow-up audit](archive/map-overlays-audit-2026-10-21.md)
records the label, zoom feedback, settings races and popup-membership fixes.


`BPB_VERIFY_SNOW_MAP_CASE=camera npm run verify -- snow-map` selects the focused
camera audit matrix in both browsers: closest-station framing, usable-marker
visibility beside open controls, unchanged already-visible/empty cameras,
passive pan behavior, navigation-start cancellation, and stable surrounding
layout at 1440/375 × 1100 in light/dark native and hardware 3D views. Unknown
case selections and zero executed cases fail. The
[SNOTEL camera audit ledger](archive/snotel-map-camera-audit-2026-10-22.md)
records the findings and the broader popup-theme verification limitation.
