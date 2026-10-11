# Historical ascent weather

**Settings → General → Show weather cards** controls this archive and peak-page
summit weather together. The default is on. The preference uses `storage.sync`
and travels with settings files and GitHub settings backup. Turning it off
hides the card on open pages, cancels pending work, and prevents summit lookup
and weather requests until enabled again.

**Settings → General → Units** provides a default with optional overrides for
distance, elevation, temperature, precipitation, and wind speed. You can keep
GPX distance/elevation in miles/feet while displaying weather in Celsius and
millimeters. Wind also controls gusts. Existing unit preferences become the
default, and changing display units reuses the loaded weather data.

The independent isolated-world `content/ascent-weather.js` bundle mounts in the
right-hand column beneath Summary Total Data, beside the trip report. It follows
the existing divider width and stacks with the summary on narrow screens. Its
metrics and controls adapt to the column width. The same card moves into that
column if the table layout mounts later; GPX analysis never moves it out.
On GPX ascents, dedicated native GPS-note and download/send blocks move together
immediately above **Weather archive**, preserving their original controls and
handlers. The map and report stay in place; ambiguous note blocks are left
untouched. The footer reads **Powered by Open-Meteo**, with the
provider name linked. Unrecognized table layouts retain the native map/metadata
fallback. It does not depend on GPX, Chart.js,
terrain, ownership, backup, or a page-world settings bridge.

The strict subject reader uses the native saved date and heading peak link,
rejects partial/impossible dates and conflicting identity, and reads summit
coordinates and elevation from the matching Peakbagger peak page.
Backup’s existing best-effort reader is intentionally unchanged. Native report
weather fields are never written or used as observations.

## Model policy

Archive starts, delays, endpoints and variables live in
[weather-models.js](../src/weather/weather-models.js), based on the
[Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api),
[Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api)
and [published route definitions](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/ForecastapiController.swift).

The default **Best Match (Open-Meteo)** requests `models=best_match` from
`archive-api.open-meteo.com/v1/archive`. Open-Meteo combines ECMWF IFS, ERA5 and
ERA5-Land according to available dates and variables, with coverage back to 1940.
Source details identify this as a blend and do not invent per-value provenance.
The ascent archive no longer applies the extension's country recommendation chain.

The dropdown includes global alternatives, overlapping regional candidates,
CERRA’s finite 1985–June 2021 archive, and explicitly labelled surface-only or
no-precipitation choices. HRRR/HRDPS admission uses the provider’s mathematical
grid definitions. Other regional choices use conservative interior footprints,
which may omit edge locations; metadata never proves an actual archive slice.
A provider refusal disables that choice until an explicit Retry. Single-provider
seamless aliases are excluded to keep the displayed source unambiguous; the
explicit ERA5 + ERA5-Land combination is labelled as such.

Best Match and explicit selections each make one weather request, retaining
useful partial data. No selection silently falls back. An unavailable model
can be retried explicitly or replaced with a dropdown choice. Rate limits,
timeouts, malformed replies and server failures never cascade into other models.

## Historical local day

The packaged mountain-time resolver owns the summit zone. Requests use GMT and
Unix epochs over three UTC days; filtering uses historical local-day boundaries,
including 23/25-hour days and repeated clock hours. A skipped date is rejected.
The longitude fallback is labelled as estimated. Current-day output excludes
future hours and is marked partial.

**Previous day** and **Next day** buttons flank the archive date. There is no
date picker or editable date. Navigation starts at the saved ascent date and
steps through summit-local civil days, stopping at today's local date and the
selected model's archive start, end and publication delay. It never switches to
a forecast or silently changes the model. Available model choices are refreshed
for each displayed date. A successful response updates the date and readings
together; pending or failed requests retain the displayed day, and Retry requests
the failed day. Navigation is disabled while loading or rate-limited, retaining
keyboard focus on the button. The native ascent date stays unchanged. Hourly
expansion and the selected tab are preserved; a weather reading from the old
day is cleared.

Instantaneous temperature, condition and wind samples belong to `[start, end)`.
UTC padding is clipped at the model's archive boundaries; any missing part of
the local day remains partial. Historical IFS and ERA5 gusts use instantaneous
samples within the local day; CERRA and archived forecast gusts use preceding-hour
maxima, including the closing midnight and excluding the opening midnight.
Precipitation belongs to the preceding hour, so the starting midnight interval
is excluded and the following midnight interval included. Fractional-hour zones
use proportional boundary allocation, disclosed in Source details. Missing
values stay unavailable; incomplete precipitation is labelled Partial total.
Coarse native models expose provider-interpolated hourly values, disclosed in
Source details; the card does not count them as independent measurements.
Condition precedence is explicit, so a clear majority cannot erase rain/snow.

The bordered **Show hourly weather** control expands the hourly panel and changes
to **Hide hourly weather**. **Conditions** is the first and initially selected
tab. Its horizontal table shares the peak card's renderer and styles, with local
hours across the top, sticky row labels, packaged condition icons, temperature,
rain/snow, wind and gusts where the selected model provides them. Icons expose
code-specific descriptions including rain/snow intensity. No extra request is
made. Missing codes or hours remain **Unavailable**; models without weather codes
explain that limitation while keeping their other readings visible. Repeated DST
clocks retain distinct timezone labels. Rain/snow appears under its interval's
starting time, while gusts retain the selected model's instantaneous or interval
contract. The four tabs share keyboard arrow/Home/End navigation.

Numeric graphs have their own hourly reading explorer, including on ascents
without GPX. Tab enters the graph; arrows/Home/End select a returned hour or an
explicit unavailable slot, and Escape clears that selection. Pointer hover
previews a reading; pointer exit restores a pinned reading. Keyboard readouts
use a polite live region. Precipitation readings identify clipped intervals and
estimated boundary allocation. Weather reading selection does not change the
GPX cursor or issue a request.

The General weather display preference gates both requests and weather-owned
native GPS placement. Initial opt-out leaves GPS blocks in place; disabling
weather restores the original notes/download/send nodes and their handlers.

The GPX cursor highlights the corresponding hourly column in Conditions. An explicit
tab switch reveals the selected hour inside the table; GPX hover never scrolls
the table or page. The recorded point time stays separate from the hourly sample,
and returning to a numeric graph restores its cursor line. The daily headline
continues to use condition precedence rather than the most frequent hourly code.

## GPX time cursor

Hovering the GPX graph previews a dashed time cursor on the hourly weather graph;
clicking or using the GPX arrow keys retains a solid selection. Pointer exit
restores the selected time. Hourly weather stays collapsed until the user opens
it, and the cursor survives measurement, unit, model and width changes.

The MAIN-world analyzer publishes only validated epoch timestamps and hover/
selection flags through the local `gpx-time-cursor.js` presentation channel.
The isolated card validates the exact message shape, source and origin. No
coordinates, track objects or privileged actions cross this channel. Updates
are coalesced per animation frame and move a separate SVG overlay.

Epochs map into the summit's historical local day, including repeated DST hours.
Missing, suspect or constant track times show **GPX time unavailable**; points
outside that day show **Outside ascent day**, or **Outside displayed day** when
browsing another archive date, with no cursor line. The saved ascent supplies
the initial day and summit; adjacent-day navigation changes only the archive
view. The cursor requests no additional data and does not estimate weather along
the route or interpolate hourly values. BFCache suspension clears hover and
cancels pending updates;
restore retains selection and requests the analyzer's current snapshot.

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
