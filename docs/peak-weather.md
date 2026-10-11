# Past week weather on peak pages

The isolated `content/peak-weather.js` bundle adds **Past week weather** below
the native map, in a new row of the right-hand table. The existing map, Sun &
Moon panel, links and left-column metadata remain in their native flow. A peak
without a map uses its native right table. Unrecognized layouts or ambiguous
coordinates fail closed rather than mounting a full-page fallback or guessing
a location. Peak name, coordinates and elevation come from the current page;
there is no geocoding or extra Peakbagger request.

Seven compact rows show the latest completed local day first. Each row has the
day's most severe available condition, temperature low/high, precipitation
water equivalent (rain, showers and snow), and maximum wind. Missing values
remain unavailable and incomplete hours are labelled. A native keyboard-
accessible disclosure opens one day's hourly readings; expanding another day
closes the previous one. The hourly table scrolls inside the card, never widening
the page. Temperatures and distances follow the existing units preference.
The date range excludes today's partial day. Source details explain model
estimates and the footer credits **Powered by Open-Meteo**.

## Data and civil-day boundaries

The [Open-Meteo Forecast API](https://open-meteo.com/en/docs) provides recent
weather through an explicit `start_date`/`end_date` interval. Its default model
selection combines suitable regional models. The card labels this automatic
selection; it cannot name an individual model from a blended response and does
not present archived forecasts as station observations.

The packaged offline timezone lookup resolves the summit's civil days, including
DST transitions and date-line offsets. A labelled longitude estimate remains
the fallback. Requests use GMT and Unix timestamps: the provider's fixed UTC
offset otherwise ignores DST changes across a date range. UTC padding includes
the final midnight's preceding-hour precipitation and gust maximum. Fractional
boundary precipitation is proportionally allocated. Hourly rain/snow and gusts
refer to the preceding hour; daily aggregation includes the ending midnight.

The separate recent client allows at most nine inclusive UTC dates and 216 rows,
with five fixed hourly fields. The ascent client retains its three-date/72-row
contract. Both use a 128-KiB response bound, 15-second deadline, schema/grid/unit
validation, omitted credentials/referrer, and no redirects. Results live only
in the bounded per-page cache. Requests begin near the viewport. Failed refreshes
keep the previous result and its original date label. Back/forward suspension
aborts outstanding work; restoration resolves the date range again. Returning
to a tab after local midnight also refreshes the range when the card is visible.
No GPX, climber/peak IDs, name, account data or page URL goes to Open-Meteo.
See [PRIVACY.md](../PRIVACY.md#summit-weather).

## Verification

Pure tests cover seven civil days across DST, date-line and fractional-hour
zones, midnight precipitation/gust boundaries, missing coverage and unchanged
ascent limits. Built-bundle UI tests cover native placement with/without a map,
lazy loading, hourly DST folds, unit changes, failed refresh and stale BFCache
requests. `npm run verify:peak-weather` loads the real manifest in hidden Chrome
and Firefox over HTTPS Peakbagger fixtures with network interception, keyboard
disclosure and screenshots at wide/narrow viewports. It proves those fixtures,
not the user's live Brave profile or weather-provider accuracy.
