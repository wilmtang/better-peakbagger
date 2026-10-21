# Nearby snow observations

Peak pages in the western United States and Alaska show **Nearby snow** beneath
Summit weather. It uses public [USDA NRCS SNOTEL observations](https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui.html),
without an account, API key, subscription, or Better Peakbagger server.
**Settings → General → SNOTEL snow observations → Show SNOTEL** controls the
whole feature independently of weather. Turning it off hides the card and map
control, clears station markers and popups, cancels pending snow work, and
prevents new NRCS requests. Settings must load successfully before any request.
For older settings without this preference, an existing weather opt-out also
keeps SNOTEL off until the user explicitly enables it.

The card finds the three closest active SNOTEL stations within 50 km of the
summit, in straight-line distance. Selection is local and can cross state
boundaries. Each station option includes distance and elevation. This is a
nearby observation, not a summit measurement, route estimate, snow forecast,
snowline, or avalanche bulletin. A station can be across a ridge or thousands
of feet lower. No nearby station is distinct from a service failure.
An empty whole-network catalog is treated as a service failure. A valid catalog
with no nearby match produces a compact message and NRCS link, hiding the
unavailable readings and chart. This single initial coverage result deliberately
compacts the card while keeping its header action in place; loaded-station
refreshes and errors preserve the full layout and reading position.

**Snow depth** shows the latest available hourly depth; **Water equivalent (SWE)**
shows the snow water equivalent: the water held in the snowpack. The daily table
labels this measurement **SWE**. Each reading keeps its own observation
time, including when the two sensors report at different times. The card looks
back 48 hours and labels readings older than six hours. Missing data stays
unavailable and zero stays zero. Metric depth uses centimeters, imperial depth
uses inches, and water equivalent follows the existing precipitation units
(millimeters or inches). Unit changes make no request.

The compact graph spans seven days of daily snow depth, including both endpoint
dates. Missing values break the line. **Daily readings and source details**
opens the accessible table for both measurements and their original QC/QA
flags. Dates follow NRCS's end-of-day convention; they are not relabelled as
summit-local dates. Hourly timestamps use the station metadata's fixed UTC
offset, not the browser timezone or a daylight-saving clock. The linked NRCS
report uses the same end-of-day daily series.

Hourly data is provisional and daily data receives more review. A change in
depth is not fresh snowfall: settlement, melting, wind, and measurement issues
can affect it. Water equivalent is a different measurement, not snow depth
converted to another unit. See [NRCS's station and data guidance](https://www.nrcs.usda.gov/state-offices/montana/montana-snow-survey/frequently-asked-snow-survey-questions-montana).

Refresh preserves the displayed station and readings until a complete replacement
arrives. Station selection shows placeholders while loading, so old readings
cannot be attributed to the new station. A failed replacement restores the
previous result and restores that station as the request target. Refresh reloads
the station shown in the picker; choosing the failed station again retries it.
Every offered station remains selectable, including a restored map station
outside the three nearest choices.
New selections cancel older work, and late responses cannot overwrite a newer
selection. Refresh remains focused while busy; pointer and keyboard activation
cannot start duplicate work. NRCS rate limits pause new requests, using
Retry-After when it is browser-readable and five minutes otherwise.
Requests that exceed their 15-second deadline show an explicit timeout message.
Refresh becomes available immediately at full opacity after a timeout, keeping
keyboard focus and the previous readings when available. Status messages share
reserved space so pending, timeout and retry do not move the controls, card,
following native content or reading position. A timeout has no retry cooldown;
an explicit NRCS rate limit still does.

## Requests and storage

The isolated `content/peak-snow.js` bundle reads the current peak's validated
native coordinates and country. It mounts only on recognized US peak pages west
of 100°W, plus Alaska across the date line. It does not read a GPX or use the
background worker. Requests begin when an enabled card approaches the viewport.

The client fetches the public station catalog with `stationTriplets=*:*:SNTL`,
`elements=SNWD,WTEQ`, `durations=DAILY`, and `activeOnly=true`. This matches
stations with either measurement; a missing sensor remains unavailable. Public
catalog metadata is cached under `bpbSnotelCatalogV1` in extension-local storage
and refreshed after seven days when next used. Expired metadata may remain on
disk until replaced or extension data is cleared. It contains no peak identity,
location query, selected station preference, or observations.
Concurrent card and map readers share one catalog flight. Each can cancel its
own subscription; only the last departure cancels the shared source. Clearing
the client abandons the flight, and a late response cannot replace newer data.

The selected station's hourly and daily requests use only its public triplet,
the two element codes, relative date ranges, end-of-period timestamps, quality
flags, and `returnSuspectData=false`. Credentials and referrers are omitted;
redirects are refused. No summit coordinates, peak/ascent/climber IDs, report,
page URL, GPX, or account information is sent to NRCS. Normal request metadata,
including the user's IP address, reaches NRCS. Following the source link is
ordinary navigation to the station's public report.

Observations stay in page memory for 30 minutes, with at most three cached
station results. Refresh bypasses that observation cache. Returning to a visible
card after expiry may refresh it; failures do not trigger automatic retries.
Catalog reads, fetches, and response bodies have deadlines, byte limits,
identity/unit/date validation, cancellation, and explicit rate-limit handling.
No new host permission or privileged messaging route is needed because the
official API allows cross-origin, credential-free requests.

## Verification

`npm run verify -- snow` runs the shipped extension in hidden Chrome and Firefox
against HTTPS Peakbagger fixtures. It checks initial load, slow refresh, failure,
retry, station switching, missing measurements, rate limits, mapless layout,
long station names, settings, and 200% browser zoom. Geometry checks compare the
action, heading, card, native column, following native heading, and document
scroll at 375, 681, and 1440 pixels in light and dark themes, plus refresh/error
states at 200% browser zoom in the desktop viewport. The native fixture keeps
its existing minimum page width; the card must fit its column without widening
the host layout. The assertion is
also challenged with a deliberately shifted disposable page.
The timeout cases hold actual network responses past the production deadline,
check full-opacity, focused Refresh and retained measurements, then immediately
retry in desktop and narrow layouts in both themes, and at 200% browser zoom.
After a failed station switch, the browser check also verifies that Refresh
loads the station shown in the restored picker without moving the card.

Set `BPB_VERIFY_SNOW_SCREENSHOT_DIR` to retain card/page screenshots. Provider
JSON is intercepted in this repeatable matrix. It proves the real manifest,
isolated-world CORS handling, DOM interaction, and rendered layout; it does not
prove live NRCS availability, native browser chrome or OS focus/placement,
screen-reader speech, or the representativeness of any station for a route.
Historical ascent observations are outside this version.

## Station map layer

The shared [Layers menu](map-layers.md) offers SNOTEL on ascent, peak and
Full Screen maps in native 2D and supported 3D. It starts off, and closing the
menu leaves enabled stations visible. Blue hexagonal snowflakes distinguish
stations from summit dots. The layer filters the national public catalog
locally to the visible map. More than 50 visible stations asks the user to zoom
in; enabling the layer does not move the camera. Opening an edge popup may pan
just enough to keep it readable.

Station popups show name, elevation and an official NRCS link. **Show conditions**
exists only for a station in the current peak card's authorized nearby set.
It reveals the card, focuses its station picker and loads readings. The card
retains its three nearest choices plus an explicitly selected nearby station;
its 50 km contract and failed-replacement behavior remain unchanged. Ascent,
Full Screen and distant stations have an NRCS link without a card action.

The layer shares the card's metadata client and public local catalog cache.
Toggling cached stations does not request measurements. Only validated public
station identifiers, names, coordinates, and elevations cross into page-world
rendering and the 3D frame. Selection returns only a station identifier, which
the isolated source resolves against its own previously exposed nearby catalog;
page-supplied coordinates, names, and time offsets cannot select a station.
Fetching stays isolated, summit coordinates stay
local, and disabling **Show SNOTEL** clears both renderers' station layers.
Pending requests can be canceled with the same SNOTEL toggle; failures provide
Retry, respecting the NRCS retry deadline. A completed empty local match is
distinct from a catalog failure.

`npm run verify -- snow-map` loads the real unpacked extension in hidden Chrome
and Firefox against the masked peak page, pinned Leaflet 1.9.4, deterministic
NRCS JSON and non-flat synthetic DEM tiles. It checks loading, cancellation,
retry, cached toggling, keyboard station popups, live popup themes, frame
replacement, settings, 2D/3D switching and parked-frame reuse. The camera starts
with an explicit view containing the fixture stations: enabling viewport
stations does not auto-frame the map.

Both renderers exercise the authorized conditions action, including a fourth
nearby station, loading, failure, explicit reselection, distinct readings,
focus transfer and card geometry through recovery. Native popup colors and
3D geographic anchoring are checked; a disposable detached-popup style must
fail the anchor assertion. Control, map, heading, following native content and
scroll geometry are compared at 375 and 1440 pixels in both themes, plus a
200% zoom case. Hardware WebGL is required for 3D. The General preference is
also exercised independently of weather, including a fresh opted-out page
that makes no NRCS request.

The shared control's component/integration checks separately cover compact
rows, one detail disclosure, whole-menu collapse, opacity, keyboard navigation,
light/dark, enlarged text and stable map/row positions. Set
`BPB_VERIFY_SNOW_MAP_SCREENSHOT_DIR` to retain station-check screenshots.
These fixtures do not establish live Peakbagger/provider compatibility, native
browser menus, OS focus/placement, physical touch or screen-reader speech.
