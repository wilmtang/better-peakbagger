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
7. Peakbagger's bounded document client and Garmin/Strava capture already carry
   typed limits and bounded retry timestamps into their inline recovery UI.
   The capture headings can identify a request limit more directly.

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
