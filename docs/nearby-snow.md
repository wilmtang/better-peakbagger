# Nearby snow observations

Peak pages in the western United States and Alaska show **Nearby snow** beneath
Summit weather. It uses public [USDA NRCS SNOTEL observations](https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui.html),
without an account, API key, subscription, or Better Peakbagger server.
**Settings → General → Show weather forecast and archive** controls this card
alongside the two weather cards. Turning it off cancels pending snow work and
prevents new NRCS requests. Settings must load successfully before any request.

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

**Snow depth** shows the latest available hourly depth; **Water equivalent**
shows the water held in the snowpack. Each reading keeps its own observation
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
previous result. Refresh retries the requested station, including a failed selection.
New selections cancel older work, and late responses cannot overwrite a newer
selection. Refresh remains focused while busy; pointer and keyboard activation
cannot start duplicate work. NRCS rate limits pause new requests, using
Retry-After when it is browser-readable and five minutes otherwise.

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

Set `BPB_VERIFY_SNOW_SCREENSHOT_DIR` to retain card/page screenshots. Provider
JSON is intercepted in this repeatable matrix. It proves the real manifest,
isolated-world CORS handling, DOM interaction, and rendered layout; it does not
prove live NRCS availability, native browser chrome or OS focus/placement,
screen-reader speech, or the representativeness of any station for a route.
Historical ascent observations and snow map overlays are outside this version.
