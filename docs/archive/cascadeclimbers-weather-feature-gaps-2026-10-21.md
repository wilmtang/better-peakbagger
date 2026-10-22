# CascadeClimbers weather: features missing from Better Peakbagger

Inspected October 21, 2026. This is a feature comparison and research report,
not an approved implementation plan. No plugin runtime changes were made.

## Findings

Better Peakbagger already implements the basic forecast experience. The main
gaps are **comparing models simultaneously, additional atmospheric variables,
regional hazard data displayed inside the page, and vertical/region-wide
forecast visualizations**. The beta page also adds derived snow-surface and
trip-window assessments, which would require a separate modelling decision.

Do not describe model selection, hourly forecasts, arbitrary map-point weather,
SNOTEL, Sun & Moon, fire/smoke links, or avalanche-service links as wholly missing.
Those already exist. An external-service link, however, is not equivalent to
rendering that service's data inside Better Peakbagger.

The comparison uses these live references:

- **W — [Weather Research](https://cascadeclimbers.com/forum/weather)**:
  point forecasts, model comparisons, weather/hazard map layers and summaries.
- **B — [Weather Lab](https://cascadeclimbers.com/forum/weather-beta)**:
  altitude profiles, UW products, snow-surface analysis and regional maps.
- **W-JS — [Weather Research's loaded application script](https://cascadeclimbers.com/forum/uploads/cc_weather.js?v=1787888861)**:
  used to distinguish conditional features and data provenance from what
  actually rendered.

## Scope and evidence

Both pages were inspected in the existing Chrome session, using new background
tabs for interactions. Original tabs and their selections were preserved.
Chrome reported version 156, with a **2048 × 950 CSS-pixel viewport and device
pixel ratio 2**. Page screenshots were inspected through the browser protocol.
Maps used Leaflet; graphs used Canvas/Chart.js. No WebGL renderer was asserted,
and this was not a hardware terrain, native focus, or window-placement test.

Weather Research was checked at Mt. Stuart and at a coordinate near Whistler
(50.1163, -122.9574). All eight weather tabs were opened. The precipitation
12-hour buckets and cumulative view were exercised. Model chart datasets were
inspected to distinguish populated series from labels with no readings.

Weather Lab was checked at Stampede Pass. Its 19-station list and regional
filter were inspected; a time-height hover produced altitude-specific readings.
The UW Raw image loaded. Changing aspect and slope changed the snow timeline.
The advanced radiation chart was opened. All six WRF categories were inspected;
a snow product loaded and advanced from its first to its second frame.

Plugin claims below come from the local source tree, package version **4.0.2**,
at base commit **1902c9f24d230e227f38a075fbe296a0586c20ea**, including in-progress
working-tree map changes. No extension build or runtime suite was run for this
documentation task. Source findings do not establish the version installed in
the user's browser or published in a store.

### Source evidence key

| Key | Current plugin boundary inspected |
| --- | --- |
| E1 | [Weather client](../../src/weather/open-meteo-client.js), lines 11–23 and 33–67: the complete supported field set, one/two-model request bound and request parameters. No probability, cloud, humidity, freezing-level, snowfall-depth, radiation, UV, CAPE or pressure-level fields. |
| E2 | [Peak models](../../src/weather/peak-weather-models.js), lines 9–35 and 43–52, and [weather models](../../src/weather/weather-models.js), lines 43–81: named Open-Meteo models, coverage and horizon handling. |
| E3 | [Peak weather UI](../../src/weather/peak-weather.js), lines 49–80 and 326–346, [hourly chart](../../src/weather/peak-weather-hourly.js), lines 10–35, and [hourly table](../../src/weather/weather-hourly-table.js), lines 10–27: one displayed model per period; day-specific graphs and a conditions table. |
| E4 | [Weather windows](../../src/weather/weather-week.js), lines 9–42: sixteen forecast days and sixteen completed past days. |
| E5 | [Shared settings schema](../../src/settings/settings-schema.js), lines 43–55, and [map layers](../map-layers.md): the overlay allowlist is Sentinel, slope, public lands and SNOTEL. |
| E6 | [Peak links](../../src/maps/peak-links.js), lines 135–160, and [avalanche destinations](../../src/avalanche/avalanche-links.js), lines 4–38 and 58–76: Windy, Copernicus, country-gated AirNow and regional avalanche-service navigation. |
| E7 | [Nearby snow](../nearby-snow.md), lines 13–40, and [SNOTEL data](../../src/snow/snotel-data.js), lines 6 and 31–40: station depth/SWE observations and nearby-station selection, not snowfall or surface-state forecasts. |
| E8 | [Sun & Moon](../sun-position.md), lines 3–16: offline astronomical positions and events; explicitly excludes cloud, smoke, terrain shadows and actual slope illumination. |
| E9 | [Peak subject](../../src/weather/peak-weather-subject.js), lines 7–27, [weather location](../../src/weather/peak-weather-location.js), [map-point interaction](../../src/maps/peak-weather-map.js), and [summit weather guide](../peak-weather.md): page-owned summit context with a selectable map point and reset. |

## Missing or partial features on Weather Research

“Missing” means no equivalent implementation was found in the inspected plugin.
“Partial” means a related feature exists but does not provide the reference
experience. Each row identifies the additional capability, not just a tab name.

| ID | Reference feature | Plugin gap and evidence |
| --- | --- | --- |
| W01 | **Simultaneous model comparison**, with separate colored curves, a mean and spread envelope. | **Partial.** GFS, ECMWF, HRRR, HRDPS, ICON and GEM model choices already exist. The plugin displays one forecast model at a time; its two-model request supports independent past/forecast choices, not a comparison chart. No shared-time comparison, model-visibility toggles, mean or spread view. E1–E3. |
| W02 | **Precipitation probability** charts and summary percentages. | **Missing.** The plugin requests precipitation amount and condition codes, not probability. A rain/snow icon or water-equivalent total does not provide a chance of precipitation. E1, E3. |
| W03 | **Selectable 6/12/24-hour precipitation buckets and cumulative curves** across a continuous multi-day timeline. | **Partial.** Daily totals and hourly precipitation graphs exist. There is no bucket selector, cumulative storm-total curve or continuous cross-day comparison chart. The reference's 12-hour and cumulative views were exercised. E3–E4. |
| W04 | **Freezing-level altitude, comparison with summit elevation, and a separate forecast snowfall-depth chart.** | **Missing.** Plugin rain/snow is combined water equivalent. It does not request a freezing-level series or predicted snowfall depth, and SNOTEL readings do not supply either forecast. These should remain separate measurements if added. E1, E3, E7. |
| W05 | **Cloud-cover percentages, cloud layers and relative humidity.** | **Missing.** A condition icon exists, but there is no quantitative total/low/mid/high cloud or humidity field. W charts total cloud cover; B exposes layers and humidity in the vertical-profile hover. E1, E3. |
| W06 | **Forecast solar radiation and UV exposure.** | **Partial.** Sun & Moon already supplies astronomical positions and daylight events. It does not forecast irradiance or UV; those fields are absent from the weather client. W renders a shortwave-radiation chart and advertises UV when available; a populated UV reading was not observed. E1, E8. |
| W07 | **CAPE-based convective/thunderstorm indicator.** | **Missing.** The reference overview displays a CAPE value with a lightning-risk label. The plugin has weather-code conditions but no instability variable or dedicated indicator. CAPE would need to retain its identity as an atmospheric diagnostic rather than become a measured lightning probability. E1, E3. |
| W08 | **Direct NWS hourly forecast comparison and local-office forecast discussion.** | **Missing.** The reference had a populated NWS temperature series in the US and an office-specific discussion control. The plugin's NCEP model choices, including NBM, are not that NWS point-forecast/discussion integration. No such adapter or UI was found. Discussion text retrieval was not exercised. E1–E3; W-JS. |
| W09 | **Official severe-weather alert display**, including event, severity and validity. | **Missing.** W exposes US NWS and Canadian ECCC alert handling. The plugin has no alert client or alert display in the weather card. Both inspected reference locations showed an empty alert state; a populated live alert was not tested. E1–E3; W-JS. |
| W10 | **Inline air quality and smoke**, including AQI/PM2.5 and regional AQI/smoke overlays. | **Partial.** AirNow is already linked for supported countries. The plugin does not fetch pollutant readings, render an AQI card, or offer the reference's AQI and ECCC smoke layers. W rendered modelled pollutant values; overlay controls were inspected, not validated end to end. E5–E6. |
| W11 | **Inline wildfire context**: nearby incident summary/list, distance, acreage, containment, markers, perimeters and Canadian hotspots. | **Partial.** AirNow navigation exists. There is no incident adapter, proximity calculation, embedded fire list or fire/perimeter/hotspot overlay. W and B rendered incident summaries; Canada hotspots are distinct from US incident records. E5–E6. |
| W12 | **Precipitation radar overlays**, with separate US NEXRAD and global choices. | **Missing.** No radar overlay or radar-frame client exists in the shared layer inventory. Sentinel natural-color imagery is a different product. Reference layer controls were visible; radar tile correctness and playback were not tested. E5. |
| W13 | **A dedicated current-conditions snapshot**, including humidity and cloud cover. | **Partial.** The plugin lets users inspect today's hourly model readings, including feels-like and wind direction. It has no separate current-data request or current-conditions panel, and lacks the additional humidity/cloud fields. The reference's “observed” wording needs qualification; see below. E1, E3. |
| W14 | **A weather-first location workspace** with place search, coordinate entry and a geolocation action. | **Partial.** The plugin already supports any selected point on a peak's 2D/3D map. It has no weather-specific place/coordinate search or geolocation control independent of a peak page. Reference coordinate entry was exercised; place-name search and geolocation permission flow were not. E9. |
| W15 | **Automatic trip-window scoring**, daily go/maybe/no-go labels, best-day marking and a trend summary. | **Missing.** The plugin presents readings and uncertainty, without a weather-derived trip verdict. The reference scores a fixed morning/early-afternoon interval. Reproducing this would introduce an assessment model, not merely another display of provider data. E1, E3. |

## Missing features on Weather Lab

| ID | Reference feature | Plugin gap and evidence |
| --- | --- | --- |
| B01 | **Interactive time-height diagram**: weather across time and altitude, freezing contour, cloud shading, winds aloft, precipitation and exact hover values; selectable stations and regional filtering. | **Missing.** Plugin weather is a surface-point estimate with optional elevation adjustment. It does not request pressure-level temperature/humidity/wind or build a vertical atmospheric cross-section. Its SNOTEL station picker is for snow observations and is not equivalent. The reference hover and region filter worked. E1, E3, E7. |
| B02 | **UW Raw time-height images** and links to the UW station product. | **Missing.** No UW WRF diagram/image adapter or alternate raw-product view was found. The reference's Stampede Pass raw image loaded. This is a separate source from its interactive GFS diagram. E1–E3. |
| B03 | **Regional WRF forecast-map browser and animation player.** Categories cover precipitation, snow/freezing level, surface/upper-air wind, temperature, pressure and clouds. Products offer different grids and forecast ranges, with frame stepping, playback speed, enlargement and a UW link. | **Missing.** The plugin has 2D/3D terrain and analytical overlays, but no meteorological forecast-image catalog, time axis or animation player. A reference snow image loaded and frame stepping worked; continuous playback, speed changes, enlargement and every product were not tested. E3, E5. |
| B04 | **Aspect/slope-dependent solar and snow-surface analysis**, with firm/softening/corn/wet/isothermal states and suggested travel windows. An advanced chart compares slope-adjusted, horizontal and diffuse radiation. | **Missing.** Astronomical Sun & Moon and measured snow depth/SWE do not model snow-surface supportability or corn formation. The reference changed its suggested windows when aspect/slope changed. Its timeline uses an approximate fixed 7,000-foot context, not a validated route snowpack model. E1, E7–E8. |
| B05 | **Snow-to-liquid ratio / snow-density forecast**, displayed as a time strip and in altitude-profile hover values. | **Missing.** No SLR, forecast density or powder/heavy/slush classification exists in the weather or snow clients. Measured SWE divided by station depth should not be substituted for the density of newly forecast snowfall. E1, E7. |

## Additional differences with limited proof

- **Embedded Avalanche Canada bulletin:** W-JS contains a Canadian forecast
  fetch/render path. No bulletin appeared at either inspected location, so this
  is a source-observed conditional capability, not demonstrated live parity.
  Better Peakbagger already provides Avalanche Canada and other issuing-service
  links (E6). The remaining difference is retrieving and displaying a current,
  geographically applicable bulletin. Its existing
  [avalanche plan](../plans/avalanche-forecast-links-and-layer.md) already records
  the boundary between implemented source links and proposed exact-zone/data
  integration; do not open a duplicate “add avalanche links” task.
- **Independent hiking-trail overlay:** W exposes a separate layer checkbox.
  The plugin's basemaps and mapping-app links can already show trails, but its
  shared overlay inventory has no independently toggled trail layer (E5–E6).
  The reference checkbox alone does not establish better trail coverage.
- **Additional weather-research links:** B collects UW, NWS discussions, NWAC,
  Alpine Conditions, SpotWx and Meteoblue. The plugin already links Windy and
  regional avalanche gateways. Additional shortcuts are a navigation difference,
  not evidence that all those services' features are embedded in B.

## Existing capabilities excluded from the gap list

| Capability | Why it is not a missing feature |
| --- | --- |
| Long-range forecast and recent weather | Up to sixteen days in each direction already exist, subject to model horizon. The reference's seven-day overview is not an improvement in forecast length. E2–E4. |
| Multiple model choices | Already implemented, with geographic/date eligibility. The actual gap is simultaneous comparison. E2–E3. |
| Hourly conditions and interactive readings | Already implemented with feels-like, wind direction, gusts, graphs, table scrolling and keyboard exploration. E3. |
| Forecast at a selected map point | Already implemented through the 2D/3D context menu and summit reset. E9. |
| Snow observations and station markers | Depth, SWE, nearby-station selection, history and map markers already exist. Forecast snow state is a different feature. E5, E7. |
| Astronomical daylight planning | Sun & Moon already provides sunrise/sunset and positions. Forecast irradiance, UV and snow response remain separate. E8. |
| Basemap choices, satellite imagery and terrain layers | Already supported. The missing overlays are meteorological/hazard products, not a generic Layers menu. E5. |
| Fire/smoke and avalanche resources | AirNow and region-aware avalanche links already exist. Inline data integration remains partial. E6. |
| Windy access | Already offered at the peak's coordinates. E6. |

## Interpretation and possible implementation order

The clearest extensions of the existing product are **W01–W06**: compare the
models already available, then add probability, accumulation controls,
freezing/snowfall, cloud/humidity and radiation fields. These expand the current
weather card without first creating a new regional research application.
Each independent addition should retain explicit units, data gaps, model
coverage and source identity.

Direct official forecasts/discussions and alerts (W08–W09) are a separate
provider integration. Inline air/fire/radar data (W10–W12) fits the shared map
architecture but introduces distinct coverage, freshness, attribution and
failure states. AirNow and issuing-service links should remain useful while
any new data source is unavailable.

Time-height diagrams and regional WRF browsing (B01–B03) warrant a dedicated
research surface or disclosure. They require different data and interaction
models from the compact daily forecast card.

Trip verdicts and snow-surface/SLR modelling (W15, B04–B05) need independent
requirements and validation before adoption. Their presence on another page
does not establish that their inferences are appropriate for this plugin.

### Reference limitations that affect the comparison

1. **Enabled does not mean populated.** At Mt. Stuart the temperature chart
   included an ECMWF dataset with 168 slots and zero non-null values, while
   GFS, HRRR, HRDPS and NWS had data. The comparison UI exists; universal model
   availability was not demonstrated.
2. **A model spread is not automatically probabilistic confidence.** The
   reference mixes deterministic models with different coverage/horizons.
   Its mean/spread labels do not establish a calibrated ensemble forecast.
3. **Interactive GFS and raw WRF are distinct.** B identifies Open-Meteo GFS as
   its interactive source and UW WRF as its raw-image source. Treating the whole
   beta page as interactive UW WRF would misstate the observed implementation.
4. **The current-condition observation claim was not proven.** W-JS assigns
   this panel from Open-Meteo's `current` response. The inspected panel supplied
   no station identifier or direct station-observation provenance. The feature
   gap is a current snapshot; verified station observations are not established.
5. **Geographic applicability needs stronger evidence than proximity.** The
   inspected Avalanche Canada code chooses a nearest centroid rather than
   proving polygon membership. The plugin should preserve its existing
   fail-closed coverage principles if adding bulletin retrieval.
6. **Derived quantities need distinct labels.** Freezing altitude, precipitation
   phase/snowline, snowfall depth, water equivalent, station depth and
   snow-surface supportability are different quantities. Their proximity in the
   reference interface does not make them interchangeable.

## Verification limits and report status

This report establishes observed reference controls/results and source-level
plugin gaps. It does not validate forecast accuracy, live alert contents,
avalanche applicability, all regional products, geolocation prompts, or overlay
tile correctness. Narrow/zoomed layouts, error/retry transitions, layout
stability, accessibility and Firefox were not audited. No claims about those
behaviors follow from the desktop screenshots.

Only this report and its archive-index entry were authored for the task.
Unrelated working-tree changes were preserved. All three checks in
`node --test test/project/documentation.test.mjs` passed. Whitespace validation
passed for the report and index. Runtime, browser-extension, build, lint and
full test suites were not run.
