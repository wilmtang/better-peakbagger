# Historical ascent weather

The independent isolated-world `content/ascent-weather.js` bundle mounts below
the whole route explorer, below a native map if no analyzer is present, or after
the ascent metadata when no map exists. It does not depend on GPX, Chart.js,
terrain, ownership, backup, or a page-world settings bridge.

The strict subject reader uses the native saved date and heading peak link,
rejects partial/impossible dates and conflicting identity, and reads summit
coordinates, nation and elevation from the matching Peakbagger peak page.
Backup’s existing best-effort reader is intentionally unchanged. Native report
weather fields are never written or used as observations.

## Model policy

Archive starts, delays, endpoints and variables live in
[weather-models.js](../src/weather/weather-models.js), based on the
[Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api),
[Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api)
and [published route definitions](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/ForecastapiController.swift).

Auto prefers HRRR for United States summits within its projected CONUS grid
from 2018, HRDPS Continental for Canadian summits within its projected grid from
March 2023, then global IFS from 2017, ERA5 + ERA5-Land from 1950, or ERA5 from
1940. Alaska, Hawaii, unknown or multiple nations use global candidates unless
regional preference and projected coverage both match. This is a product
recommendation, not a validated universal accuracy ranking. Other countries
currently use the global default; their eligible regional models are selectable.

The dropdown includes global alternatives, overlapping regional candidates,
CERRA’s finite 1985–June 2021 archive, and explicitly labelled surface-only or
no-precipitation choices. HRRR/HRDPS admission uses the provider’s mathematical
grid definitions. Other regional choices use conservative interior footprints,
which may omit edge locations; metadata never proves an actual archive slice.
A provider refusal disables that choice until an explicit Retry. Single-provider
seamless aliases are excluded to keep the displayed source unambiguous; the
explicit ERA5 + ERA5-Land combination is labelled as such.

Auto tries at most three candidates for absent/incomplete core fields. It
preserves a useful partial result when none is complete. Explicit selection
never silently falls back. Optional gusts do not disqualify a useful model.
Timeouts, rate limits, malformed replies and server failures stop the chain.

## Historical local day

The packaged mountain-time resolver owns the summit zone. Requests use GMT and
Unix epochs over three UTC days; filtering uses historical local-day boundaries,
including 23/25-hour days and repeated clock hours. A skipped date is rejected.
The longitude fallback is labelled as estimated. Current-day output excludes
future hours and is marked partial.

Instantaneous temperature, condition and wind samples belong to `[start, end)`.
UTC padding is clipped at the model's archive boundaries; any missing part of
the local day remains partial. Precipitation belongs to the preceding hour, so the starting midnight interval
is excluded and the following midnight interval included. Fractional-hour zones
use proportional boundary allocation, disclosed in Source details. Missing
values stay unavailable; incomplete precipitation is labelled Partial total.
Coarse native models expose provider-interpolated hourly values, disclosed in
Source details; the card does not count them as independent measurements.
Condition precedence is explicit, so a clear majority cannot erase rain/snow.

## Requests and lifecycle

The [weather client](../src/weather/open-meteo-client.js) accepts only packaged
models and fixed HTTPS hosts. It omits credentials/referrers, refuses redirects,
bounds the body to 128 KiB and the exchange to 15 seconds, and validates units,
arrays, numeric ranges, timestamps and grid/elevation metadata. A per-tab cache
holds at most eight responses for six hours (five minutes for a current day).
It deduplicates flights, cancels superseded requests and guards generations.
Retry clears cached responses and unavailable choices, then makes a fresh request.
BFCache suspension cancels requests; restore rechecks visibility. Disposal
disconnects observers/subscriptions and clears the cache.

No new API host permissions or worker routes are required: the provider’s CORS
policy permits direct content-script requests. Privacy and provider retention
are disclosed in [PRIVACY.md](../PRIVACY.md). Free hosted access remains
non-commercial, with Open-Meteo attribution in the card.
