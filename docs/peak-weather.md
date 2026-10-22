# Summit weather on peak pages

**Settings → General → Show weather forecast and archive** controls both summit weather and
the ascent weather archive. It is on by default, saved in `storage.sync`, and
included in settings export/import and GitHub settings backup. Turning it off
hides both cards on open pages and cancels pending weather work. Disabled pages
make no weather requests; summit lookup for the archive is also skipped.

The isolated `content/peak-weather.js` bundle adds **Summit weather** immediately
after the native map row in the right-hand table, whether the map is above or
below the peak details. Sun & Moon follows the map's complete native legend and
full-screen link, so those controls stay together. A peak
without a map uses its native right table. Unrecognized layouts or ambiguous
coordinates fail closed rather than mounting a full-page fallback or guessing
a location. Peak name, coordinates and elevation come from the current page;
there is no geocoding or extra Peakbagger request.

A small hint beneath the weather title explains how to choose another map point;
it stays visible across visits and location changes, and is hidden on mapless peaks.
Right-click the peak's **2D or 3D map** and choose **Forecast and archive for
this location** to use that point for both periods. The menu opens beside the
pointer, fits within the viewport, supports keyboard activation and Escape,
and closes on an outside click, wheel zoom, scrolling, or resizing. Escape,
Tab and Shift+Tab return focus to the map without moving the page. Opening it sends no
weather request. The shared [location menu](map-layers.md#location-menu) also
shows coordinates and an approximate elevation, including when weather is off.
Only the elevation lookup contacts Mapterhorn on opening. The card identifies the selected coordinates; **Reset to
summit** immediately restores the already-loaded summit result and cancels any
pending location request. Neither action pans the map or scrolls the page.
Reset also restores the summit's model choices. A failed location switch names
its target on **Retry** and can be retried by selecting the same map point.
If summit weather has not loaded yet, a failed reset remains available to retry.
Resetting during a provider cooldown retains its explanation and request limit.
An open menu becomes usable when the cooldown expires, without reopening it.

Selected points use their own offline timezone and Open-Meteo terrain elevation,
without applying the summit's elevation to another location. A regional model
that cannot cover a newly selected point switches to GFS for that page without
overwriting the stored preference. Coordinates and results stay in page memory;
reloads start at the summit. A pending or failed location request retains the
previous weather and its actual location label. Loading feedback and the reset
action reserve their layout space so they do not push the forecast rows around.
Before any usable readings exist, loading labels use the requested point's
identity, terrain elevation and local date. Location changes have a polite
accessible status announcement; previous readings keep their own label until
replacement data arrives.
The location behavior is covered by the peak-weather browser verifier; run
`node scripts/verify-peak-weather-3d.mjs` after building for the hardware-rendered
3D context menu, elevation, reset and right-drag checks.

The card defaults to **16-day forecast**, covering today plus fifteen days in forward
order. **Past 16 days** shows sixteen completed local days, latest first, excluding
today. Both views share one weather request; period tabs support arrow keys, Home and End
and retain each view's expanded days. Forecast conditions use expected rather
than past-tense rain/snow labels. Each compact row has the
day's most severe available condition, temperature low/high, precipitation
water equivalent (rain, showers and snow), and maximum wind. Missing values
remain unavailable and incomplete hours are labelled. A native keyboard-
accessible disclosure opens that day's hourly graphs independently. Opening
another day leaves existing panels and the surrounding reading position in
place, without scrolling the page; only explicit collapse closes a day. Each
day retains its own data tab, pinned reading and hourly-table scroll through
refresh, unit changes and period switches. **Conditions** is the
initial data tab; the last explicit data-tab selection is saved in extension-local
storage on this device and restored across peak pages and reloads. Missing or
invalid saved selections fall back to Conditions. Temperature, rain/snow, clouds,
wind and gusts use responsive line graphs; Conditions shows a horizontally scrollable hourly table of condition icons,
cloud cover, temperature, feels-like, rain/snow, new snow depth, freezing level,
wind, gusts and wind direction. Row labels
stay visible while scrolling; clear hours use a Moon icon at night.
**Clouds** shows total cloud cover on a fixed 0–100% scale, with percentages
unchanged by the unit preference. It describes modelled sky coverage, not cloud
base or whether the summit is inside cloud. It uses `cloud_cover` in the same
weather request; no additional request or setting is needed. Unavailable or
invalid cloud readings remain gaps without discarding usable core weather.
**Snowfall** shows hourly new-snow depth as bars and a total for the displayed
local day. It uses `snowfall` in the same request, in centimeters or inches,
following the precipitation-unit preference. It is distinct from rain/snow
water equivalent and from existing snow depth. Partial hours are proportionally
allocated; unavailable hours remain gaps and make the total partial. The provider
uses an approximate 7:1 snow-to-liquid ratio, so this is a modelled depth estimate.
**Freezing level** uses `freezing_level_height` from that same request: altitude
above sea level of 0°C air, following elevation units. A dashed reference marks
the summit or selected location when its elevation is known. It is not a snowline.
Both are supplementary fields: unavailable or invalid readings do not discard
the core forecast. The collapsed daily rows retain their compact layout.

Hourly tabs use two balanced rows, with compact **Temp** and **Freezing** labels
in narrow cards and full accessible names. All graph tabs share the same hint.
The circled information button opens the active measurement's explanation over
the chart, within the viewport, without adding layout height. Clicking it again,
pressing Escape or pressing outside dismisses it. Escape returns focus to the
information button. Hover readings, pinned readings and information remain
available by pointer and keyboard; explanatory text does not depend on hover.
Both weather cards share packaged SVG illustrations and the Sun & Moon palette:
amber sun and temperature graphs, blue rain/snow, and muted violet wind graphs.
Daily temperature ranges use normal text color and label **Low** and **High**; wind is
labelled **Max wind**. The selected model is named once; a separate **Using**
label appears when retained readings belong to a different model during loading
or after a failed model change. The range and model control sit side by side
where space allows and stack within narrow cards.
Missing values break the line rather than appearing as zero. Hover previews a
reading; clicking or using arrow keys pins it, and Escape clears it. Data tabs
support arrow keys, Home and End. Charts fit inside the card without widening
the page; the Conditions table scrolls horizontally. **Settings → General → Units**
provides a default plus independent distance, elevation, temperature, precipitation,
and wind choices. For example, miles/feet can stay paired with Celsius and millimeters.
Temperature also controls feels-like values; wind also controls gusts. Changing units
reuses the loaded weather data without another weather request.
Day activation closes the previous panel and mounts the new graph in one update,
preserving the activated summary's viewport position and keyboard focus. The
hourly panel does not force a scroll to fit the viewport; users scroll into it
at their own pace.
Unrelated preferences retain weather controls. Necessary unit/data refreshes
restore valid pinned source instants, Conditions horizontal scroll position and focused
controls; an expired date clears selection and returns focus to the period tab.
Metric and period labels reserve their selected font width so selection cannot
change wrapping.
The forecast view warns that estimates may be inaccurate, especially farther
ahead or at mountain summits, and prompts users to check local mountain forecasts.
Each period has a **Weather model** dropdown, initially set to **GFS** for its
sixteen-day forecast horizon. Each period's last selected model is saved
in extension-local storage on this device, separate from synced settings and
backups. A saved regional model that does not cover a newly opened summit falls
back to GFS at startup; an explicit choice on an open page never silently changes.

**Best Match (Open-Meteo)** is the first option in both period lists. It uses
`models=best_match` on the [Forecast API](https://open-meteo.com/en/docs), which
automatically combines suitable models for the location, with up to sixteen
forecast days. This is distinct from the ascent card's Historical Weather API
archive blend. Its resolution is **Automatic**; underlying model resolution,
availability and update times vary. Source details do not claim a fixed grid
resolution, a single run, or the source of each value. The update table labels
the blend's clocks **Varies by model** without requesting individual-model metadata.

Named alternatives are filtered by geographic coverage and date availability.
History excludes delayed reanalyses that cannot cover yesterday. Forecast
options show their published run horizon. Selecting a shorter-range model
shows the available forecast days, including partial boundary days; interior
missing days remain visible. **Using [model]** identifies the model behind the
currently displayed data. Each period keeps an independent choice.
Switching periods or expanding hourly graphs makes no weather request. A model change
requests the two selected models together, deduplicated when they match, and
can reuse the exact cached selection. An explicit choice never silently falls
back; a failure preserves the previous dated/model-labelled result. Model
changes abort superseded requests; known rate-limit cooldowns disable both
Refresh and the model dropdown while period tabs remain usable.

**Source details** first distinguishes the requested summit or selected location
from the provider's weather grid point and explains why they may differ. A second
paragraph identifies the displayed model and resolution, forecast or historical
estimate type, local timezone, elevation adjustment and load time. Best Match identifies its automatic blend;
combined responses disclose that model grids may differ, and estimated timezone
or partial-hour precipitation remains labelled. Default selection, saved-choice
behavior and summary calculation explanations stay in this documentation.
Hourly values may be interpolated from coarser native output, and forecast
horizons are measured from the model run. The named API fields establish which
requested model or Best Match blend supplied each period, without claiming exact
run initialization or sub-grid provenance. Horizons were checked against Open-Meteo's
[Forecast API and provider tables](https://open-meteo.com/en/docs) and named
model routing against its [published selection code](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/ForecastapiController.swift).
Opening **Source details** also loads update times for the model supplying
the displayed weather in the active period, shown in summit local time. Other eligible models are not requested. Switching periods or models
updates the table; a failed model change retains clocks for the displayed weather.
The [metadata API](https://open-meteo.com/en/docs/model-updates) reports availability
and cadence. **Update interval** displays `update_interval_seconds` from the same
metadata response (for example, **Every 6 h**), with no additional request. It is
the usual model-update cadence, distinct from `temporal_resolution_seconds`,
which describes weather-data spacing. Updates overdue relative to the last
availability time plus that cadence remain marked delayed in **Next expected**,
which displays that calculated time alongside the interval. GFS lists its 13 km and 25 km products
separately, so GFS needs two metadata requests; other mapped models need one.
Best Match and unmapped models make no metadata requests. Missing or unavailable
metadata is labelled unavailable rather than guessed (BOM has no mapping in the provider's published update table).
These are provider-wide clocks, not proof of the exact model run behind each
forecast or historical hour. Metadata requests contain no coordinates or dates;
they are limited to three concurrent requests, a five-second deadline and
16 KiB per response, with successes/failures cached in page memory for five
minutes. Closing the disclosure, disabling weather or suspending the page
cancels pending work. Update failures do not hide usable weather.

Incomplete days are labelled in the daily rows and status. The footer credits
**Powered by Open-Meteo**. An unavailable period does not hide usable data in the other view.

## Data and civil-day boundaries

The [Open-Meteo Forecast API](https://open-meteo.com/en/docs) provides recent
and forecast weather through one explicit `start_date`/`end_date` interval. The card explicitly sends one or two allowlisted model IDs. Multi-model replies
use model-suffixed hourly columns, validated and split before grouping into the
two local periods. Recent archived forecasts are model estimates rather than
station observations. Forecasts include the
whole local day, including earlier hours of today. Future forecast hours are
admitted explicitly by the peak window; historical ascent windows retain their
future-date rejection and cutoff at the current time.

The packaged offline timezone lookup resolves the summit's civil days, including
DST transitions and date-line offsets. A labelled longitude estimate remains
the fallback. Requests use GMT and Unix timestamps: the provider's fixed UTC
offset otherwise ignores DST changes across a date range. UTC padding includes
the final midnight's preceding-hour precipitation and gust maximum where the
API horizon allows it. The request's last UTC date is capped at today UTC plus
fifteen days: requesting padding beyond that limit would be rejected. Summaries
still expect full civil-day coverage, so missing final-day hours or midnight
accumulations remain incomplete, never filled with zero or extrapolated. Fractional
boundary precipitation is proportionally allocated. Hourly rain/snow and gusts
refer to the preceding hour; daily aggregation includes the ending midnight.
Their graphs show the same intervals, including the ending midnight and excluding
the starting midnight. Readouts name the interval and label fractional boundary
rain as estimated. Gust maxima are not prorated; overlapping boundary hours are
identified. Conditions places rain/snow and gusts under the start of each interval alongside
instantaneous readings at that time; missing boundary readings stay unavailable.
Instantaneous fields exclude the ending midnight. Exact local times
and timezone labels retain repeated hours on DST days.

The separate peak client allows at most thirty-three inclusive UTC dates and 792 rows,
with eleven fixed hourly fields per model and at most two named models. The ascent client retains its three-date/72-row
contract. Both use a 128-KiB response bound, 15-second deadline, schema/grid/unit
validation, omitted credentials/referrer, and no redirects. Results live only
in the bounded per-page cache. Requests begin near the viewport. Failed refreshes
keep both previous views and their original date labels. Known rate-limit
cooldowns disable Refresh and model selection while period tabs remain usable; failed requests
never create an automatic visibility-refresh loop. Back/forward suspension
aborts outstanding work; restoration resolves the date range again. Returning
to a tab after local midnight or five minutes refreshes the range when the card
is visible. Forecast-bearing responses expire from memory after five minutes.
No GPX, climber/peak IDs, name, account data or page URL goes to Open-Meteo.
See [PRIVACY.md](../PRIVACY.md#summit-weather).

## Verification

Pure tests cover sixteen completed days and sixteen forecast days across DST,
date-line and fractional-hour zones, full future hours, the UTC forecast cap,
midnight precipitation/gust boundaries, missing coverage and unchanged ascent
limits. Built-bundle UI tests cover native placement with/without a map,
lazy loading, hourly DST folds, line gaps, midnight intervals, tab and cursor
keyboard behavior, unit changes, resize/disposal, failed refresh and stale BFCache
requests. `npm run verify -- peak-weather` loads the real manifest in hidden Chrome
and Firefox over HTTPS Peakbagger fixtures with network interception, keyboard
disclosure, forecast/past period switching without requests, data tabs, cursor interaction and screenshots at wide/narrow
viewports. It proves those fixtures, not the user's live Brave profile or
weather-provider accuracy.

The forecast addition was verified on 2026-10-11: 67 focused weather tests and
all 2,555 tests passed; full lint passed with six existing owned vendor/manifest
warnings. Real unpacked extension fixtures passed in hidden Chrome for Testing
153.0.8010.12 and Firefox 157.0.1 at 375/768/1440 × 1100, light/dark. Inspected
the wide forecast, narrow expanded forecast and live forecast/source details.
The first fixture run toggled a remembered expanded forecast closed; corrected
the verifier to respect that state, then both engines passed.

One live public Mount Rainier probe in hidden Chrome at 1440 × 1100 confirmed
CORS, accepted the combined interval, and rendered both periods and the hourly
forecast using exactly one weather HTTP request. The full real-manifest Chrome
check also passed at 1000 × 760 with BFCache restoration. All checks reported
teardown; a final process/profile inspection found no owned verification
browser, server or disposable profile. Hidden checks do not establish native
focus/window placement, screen-reader speech, the user's Brave session or
forecast accuracy.

The sixteen-day extension was verified on 2026-10-11: 74 focused weather tests
and all 2,567 tests passed. Full lint passed with the same six owned warnings;
the verifier's final wait change also passed ESLint. Real unpacked extension
fixtures passed in hidden Chrome for Testing 153.0.8010.12 and Firefox 155.0
at 375/768/1440 × 1100 in light and dark themes. Inspected the wide forecast,
narrow warning, expanded model details and final-day graph. The first Chrome
run read the remembered final-day graph while the first-day disclosure was
settling; its wait now requires the specific first-day graph and one open day,
and the rerun passed. One live public Rainier request accepted the maximum
combined interval and rendered both views from exactly one HTTP request.
The full `npm run verify -- chrome` check passed, including BFCache restoration.
Final process and disposable-profile checks found no owned verification
browser or profile remaining. Hidden fixtures and the live CORS probe do not
establish forecast accuracy, screen-reader speech or the user's Brave session.

Matching history to the forecast was verified on 2026-10-11: 74 focused weather
tests passed, as did ESLint for the changed JavaScript and the build. Regression
coverage includes sixteen completed local days across spring/fall DST, year and
date-line boundaries, complete oldest-day hourly data, and the 33-date/792-row
transport cap. Hidden real-extension fixtures passed in Chrome for Testing
153.0.8010.12 and Firefox 155.0 at 375/768/1440 × 1100 in light and dark themes.
Visually inspected wide light history and narrow dark history with an expanded
hourly graph. One live public Rainier probe rendered both sixteen-day periods
from exactly one weather HTTP request; the real-manifest Chrome check passed at
1000 × 760 with BFCache restoration. Final process/profile inspection found no
owned test browser or disposable profile remaining. The full suite passed
2,565 of 2,567 tests; two photo-documentation assertions fail because the
separately rewritten README omits its encoded-source budget and saved-key
disclosure wording. Those omissions are also present in HEAD independently of
the weather length edits. Hidden verification does not establish the user's
Brave session, native focus/window placement, screen-reader speech or provider
accuracy.

The model-selection change was verified on 2026-10-11: the build, changed-file
ESLint and all 91 weather tests passed. The full shipped-bundle suite passed
2,582 of 2,584 tests; the two existing photo README assertions still fail for
omitted encoded-source-budget and exact saved-key disclosure wording. Earlier
runs encountered concurrent ascent/verifier edits; their targeted rechecks now
pass. An isolated source snapshot confirmed the final weather tests and real
unpacked extension fixtures independently of ongoing workspace edits.

Hidden Chrome for Testing 153.0.8010.12 and Firefox 155.0 passed at
375/768/1440 × 1100 in light/dark, including independent model choices, a
short-range forecast, named-response reuse, rate-limit controls and responsive
graphs. Inspected the narrow short-range selection, default forecast, wide
history and live source disclosure. One live public Rainier request rendered
HRRR history and GFS forecast through the combined endpoint. The hidden
real-manifest Chrome check passed at 1000 × 760 with BFCache restoration.
Owned profile/process inspections confirmed teardown. These checks do not
prove the user's Brave session, native focus/window placement, screen-reader
speech or model accuracy.

The hourly-table, local-model and update-clock changes were verified on
2026-10-11: 104 weather tests passed. The full shipped-bundle suite passed
2,595 of 2,597 tests; the two photo README assertions for the encoded-source
budget and saved-key disclosure were already failing before these changes.
Full lint passed with six existing owned warnings, and changed-file ESLint
passed after the final request-failure regression was added.

Real unpacked extension fixtures passed in hidden Chrome for Testing
153.0.8010.12 and Firefox 157.0.1 at 375/768/1440 × 1100 in light and dark;
day-switch checks also used those widths at 1000 pixels tall. Inspected the
horizontal table and the expanded update list, including all three update
columns at 375 pixels. Frame traces allow at most one immediate movement to
reveal a below-fold day; a panel that fits at the clicked heading stays put.
HTML/SVG fixtures do not require WebGL. A live public Rainier probe confirmed
one weather request plus sixteen coordinate-free metadata requests. A separate
GFS/IFS request validated eight hourly fields in 60,769 bytes. The full hidden
real-manifest Chrome check passed at 1000 × 760 with BFCache restoration.
A final process/profile inspection found no owned verification browser or
disposable profile remaining. Hidden checks do not prove the user's Brave session,
native window focus or placement, screen-reader speech, model accuracy or a
promised next update.

The Best Match option was verified on 2026-10-11: build, focused ESLint and all
124 weather tests passed. Hidden real-extension Chrome 153.0.8010.12 and
Firefox 157.0.1 fixtures passed selection/persistence, combined and deduplicated
requests, blend source details and responsive layout at 375/768/1440×1100.
Inspected narrow and wide Best Match renders; charts/icons use SVG, not WebGL.
The real-manifest Chrome check passed hidden at 1000×760 with BFCache restoration.
Two live public Mount Rainier API probes validated Best Match alone (36,026 bytes)
and alongside GFS (62,705 bytes), each with 792 hourly timestamps and the expected
plain/model-suffixed fields. These establish the transport contract, not forecast
accuracy, native dropdown-menu behavior or screen-reader speech.

Cloud cover was verified on 2026-10-22: build, changed-file ESLint and all 182
focused weather/unit tests passed. The percentage assertion was also run against
the previous formatter read-only and failed as expected (100 became 62 in
imperial settings). The full suite ran 3,205 tests: 3,204 passed; the sole failure
was broken links in the pre-existing untracked codebase audit document, which
this change leaves untouched.

`node scripts/verify-ascent-weather.mjs --clouds` (after building), with
`--firefox` for Firefox, checks the real unpacked extension against HTTPS
Peakbagger fixtures. Hidden Chrome for Testing 156.0.8078.4 and Firefox 158.0.1
passed 16 configurations each: 1440/375 × 1100, light/imperial and dark/metric,
100%/200% browser zoom, forecast/history. Inspected screenshots of the Clouds
graph and Conditions table. Frame and geometry checks cover graph-tab changes,
keyboard readings, surrounding card/native-table positions and document scroll;
held refresh, service failure, retry and missing-cloud cases also passed.
Controls must be panned into view on the native page at narrow 200% zoom.
Provider responses are stubbed in these repeatable checks. The existing broader
peak verifier failed its location-in-header assertion before implementation;
this focused check does not establish that unrelated placement behavior.

A live public Rainier request returned total cloud cover for GFS and IFS in one
65,519-byte, 768-row response, within the unchanged 128-KiB bound. Best Match/AIFS
also returned cloud columns, but that pair failed existing core validation
because AIFS gusts used an `undefined` unit; that compatibility gap is unchanged.
The real-manifest Chrome smoke check passed hidden at 1000 × 760 with BFCache
restoration. These HTML/SVG checks do not require WebGL, and no WebGL renderer
was asserted. Hidden checks do not prove native focus/window placement,
screen-reader speech or forecast accuracy. Layer-specific cloud forecasts and
snow-surface predictions are outside this addition.

The snowfall/freezing-level addition was verified on 2026-10-22 with 185 focused
weather/unit tests, changed-file ESLint and a successful build. Hidden Chrome for
Testing 156.0.8078.4 and Firefox 158.0.1 each passed the 16-configuration weather
details verifier at 1440/375 × 1100, light/imperial and dark/metric, 100%/200%
zoom, history/forecast. Screenshot review caught and corrected a lonely third
row of tabs. Geometry and rendered-frame checks cover graph switching, keyboard
readings, following content, native-table size and document scroll; information
open/close additionally checks viewport containment and Escape focus. Held
refresh, service failure, retry and unavailable supplementary fields passed.
These checks use stubbed provider responses and real unpacked extension assets.

One live public Rainier request returned 83,442 bytes for two models and eleven
fields, below the unchanged 128-KiB bound. GFS had 768 populated snowfall and
freezing-level samples; IFS had 745 snowfall samples and no freezing-level
values. Missing provider fields remain unavailable without changing models.
The hidden real-manifest Chrome smoke check passed at 1000 × 760 with BFCache
restoration. Charts and tooltips use HTML/SVG; no WebGL renderer was asserted.
Hidden checks do not establish native window focus/placement, screen-reader
speech or forecast accuracy.
