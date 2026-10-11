# External API rate-limit feedback audit

Request: audit every extension-owned external API and show a clear, actionable
warning when a service limits requests. Do not infer rate limiting from opaque
image failures, offline errors, access denials or normal OAuth polling delays.

## Findings before implementation

1. Open-Meteo detects HTTP 429, but its inline message does not name the service
   or show a supplied retry time. The ascent summit lookup also replaces typed
   Peakbagger errors with a generic failure. Previous weather results survive.
2. GitHub REST recognizes 429 and primary/secondary 403 limits, including reset
   headers. A stalled/oversized error body can mask a known status. Device-flow
   HTTP 429 lacks the REST classification. OAuth `slow_down` is intentional
   polling pacing and must retain that behavior.
3. ImgBB detects 429 after reading and validating the response body; a stalled
   body or a provider message can mask the explicit warning. Photo source
   imports report a generic unreadable-image error for a readable HTTP 429.
4. Microsoft Planetary Computer catalog search says "busy" for 429. Its map
   control does not distinguish a rate limit, and map movement can retry it.
5. Mapterhorn elevation, OpenFreeMap styles/resources, and the 3D raster
   basemaps report generic failures. A tile burst must produce one contextual
   warning, rather than repeated popups or a false renderer diagnosis.
6. The extension's Peakbagger nearby-peak feed turns all failed responses into
   an empty marker list. Confirmed 429 must not look like an area with no peaks.
7. Peakbagger's document client and Garmin/Strava capture carry typed limits,
   but Peakbagger reads the body before classification. Capture headings are
   indirect. Follow-up inspection also found generic-error replacements in
   ignored lookup, hover-card Ignore and Buddy-source refresh; legacy native
   Buddy reconciliation silently drops limits, and a refused Buddy POST can
   trigger another status read before reporting a generic failure.

## Surface inventory and closure ledger

### Fixed and verified

- Open-Meteo: provider-named inline warning, bounded Retry-After time,
  retained weather, and per-page request/retry cooldown. Summit lookup retains
  typed Peakbagger errors. Unreadable 429 bodies cannot mask the warning.
  Verified: build, 63 weather/shared-helper tests, focused ESLint, and real
  unpacked extension in hidden Chrome 153 HTTPS ascent/peak fixtures at
  375/681/768/1440 × 1100. Inspected narrow peak and wide ascent warnings.
  Retry-After is usable only when CORS exposes it; otherwise the wait stays
  unstated. The browser fixture initially omitted that exposure; corrected it
  and both checks passed.

- GitHub: REST 429 and primary-limit 403 survive unreadable bodies; secondary
  message classification remains distinct from ordinary access denial. Device
  authorization 429 uses the same typed recovery path. Retry-After dates and
  reset timestamps are bounded. OAuth slow-down and write retry rules remain.
  Verified: 194 GitHub tests, 55 options GitHub tests, focused ESLint and build;
  real extension GitHub authorization warning inspected in hidden Chrome 153
  at 375/1000 × 760, light/dark. The fixture stubs optional permission grants
  and returns 429 without contacting GitHub.

- ImgBB and readable image-source imports: confirmed 429 is provider-named
  before reading a body, with Retry-After advice when exposed. ImgBB refusal
  remains definite and never triggers an automatic upload retry. Pending report
  photos, text and native controls remain usable; no ascent is submitted.
  Verified: 287 photo/report-local tests, build and focused ESLint; real
  extension intercepted upload in hidden Chrome 153 at 1280/720 × 900,
  light/dark warning inspection, one upload request and zero form POSTs.

- Maps: Planetary Computer catalog/observable tile limits, OpenFreeMap style
  and observable resource limits, Mapterhorn DEM limits, and observable 3D
  raster-provider limits use contextual provider warnings. Catalog movement
  stops retrying after a limit; known style/DEM cooldowns retain cached data.
  Nearby Peakbagger limits retain markers, use bounded bridge metadata and
  pause camera requests. Boot DEM limits explain the provider/2D fallback.
  Ordinary 404 coverage gaps and opaque Leaflet errors remain distinct.
  Verified: 157 map/terrain tests, build and focused ESLint; hidden Chrome 153
  Metal Apple M3 Pro hardware renderer, HTTPS terrain fixtures with non-flat
  synthetic DEM. Inspected Mapterhorn/OpenFreeMap warnings at 375/820 × 900
  in light/dark and Planetary Computer catalog warning at 820 × 900. MapLibre
  status events were injected for tile UI; catalog 429 used runtime fetch.
  Corrected a fixture CDP serialization failure and reran successfully.

- Peakbagger and activity capture: document 429 survives unreadable bodies;
  the shared bounded Retry-After parser accepts Headers and plain header
  records. Capture names Garmin/Strava/Peakbagger and gives local date/time or
  a general wait, without contradictory instructions. GPX, backup and Buddy
  readers retain typed copy. Ignored lookup, hover-card Ignore, Buddy sources,
  legacy native reconciliation and refused Buddy POSTs now preserve the limit
  diagnosis and local lists; a limited POST is never automatically retried.
  Verified: 143 shared request/provider/popup tests, 117 favorites/ignored
  tests, build and focused ESLint. Hidden Chrome 153 / Firefox 155 shipped
  popup fixtures at 390 × 600, light/dark, and Chrome real action popup sizing
  at tab zoom 100/200 percent. Inspected both provider and Peakbagger warnings.
  Real extension Chrome HTTPS climber/settings warnings also rendered and
  were inspected; permission/provider responses are fixture-owned.

### Intentionally not changed

- Links to Gaia, onX, AllTrails, CalTopo, Windy, AirNow, store pages and other
  navigation destinations do not query those services' APIs.
- Peakbagger's native 2D basemaps, remote image/video elements and Leaflet image
  tiles expose an error event without an HTTP status. Keep an honest unavailable
  message; do not label an unobservable failure as a detected rate limit.
- Existing consent, credential, cancellation, bounded response and upload
  ambiguity rules remain authoritative. No automatic retry of uploads/writes.
- OAuth pending/slow-down polling remains expected authorization flow.
- Hidden background warming stays non-interruptive; user-facing warnings belong
  to the feature whose requested data could not load.

### Changed but not fully proven

Implementation pending. Live provider throttling, browser chrome/focus behavior
and screen-reader speech are outside intercepted fixture proof.

## Implementation and verification

Use provider-named "request limit reached" copy, a validated retry time when
available, and an unstated wait otherwise. Preserve useful results and local
edits, stop known cooldown requests, and use existing inline status/recovery
surfaces. Keep 403 access denial distinct from GitHub's confirmed quota signals.
Rate-limit status must survive unreadable bodies. Reuse a small bounded
Retry-After parser; avoid changing authentication or network permissions.

Run focused regression tests per independent unit before committing, then the
full suite and lint. Real extension HTTPS fixtures can load weather, capture,
report-photo and settings surfaces; existing terrain fixtures support hidden
hardware-rendered map checks. Inspect warnings in light/dark and narrow/wide
layouts, record exact evidence and remaining gaps here, and check teardown.
