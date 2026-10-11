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
accessible disclosure opens one day's hourly graphs; expanding another day
closes the previous one and retains the chosen data tab. Temperature, rain/snow,
wind and gusts use responsive line graphs; conditions use an hourly timeline.
Missing values break the line rather than appearing as zero. Hover previews a
reading; clicking or using arrow keys pins it, and Escape clears it. Data tabs
support arrow keys, Home and End. Charts fit inside the card without widening
the page; the conditions timeline scrolls vertically. Units follow the existing
preference without another weather request.
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
Their graphs show the same intervals, including the ending midnight and excluding
the starting midnight. Readouts name the interval and label fractional boundary
rain as estimated. Gust maxima are not prorated; overlapping boundary hours are
identified. Instantaneous fields exclude the ending midnight. Exact local times
and timezone labels retain repeated hours on DST days.

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
lazy loading, hourly DST folds, line gaps, midnight intervals, tab and cursor
keyboard behavior, unit changes, resize/disposal, failed refresh and stale BFCache
requests. `npm run verify:peak-weather` loads the real manifest in hidden Chrome
and Firefox over HTTPS Peakbagger fixtures with network interception, keyboard
disclosure, data tabs, cursor interaction and screenshots at wide/narrow
viewports. It proves those fixtures, not the user's live Brave profile or
weather-provider accuracy.
