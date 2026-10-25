# Map overlay coverage by region

Updated **October 21, 2026**. Applies to the **Overlays** menu in native 2D and
supported 3D maps, including peak, ascent and Full Screen pages.

**Available** means the region is eligible for the overlay. **Partial** means
the control is offered but coverage is incomplete or uncertain. **Disabled**
means the control says **No coverage** and cannot be switched on. An available
overlay can still have no recent satellite capture, no nearby station or no
ownership record at a particular peak.

## Regional availability

These entries describe ordinary inland views. A border or wide map view can
include a neighboring coverage area and keep an overlay available.

| Region | Sentinel-2 imagery | Slope angle | Public lands | SNOTEL stations |
| --- | --- | --- | --- | --- |
| Western contiguous US states with SNOTEL, listed below | Available | Available | Available | Available; stations are sparse |
| Other contiguous US states and Washington, DC | Available | Available | Available | Disabled, except near a covered state |
| Alaska, including the Aleutians | Available | Available; resolution varies | Available | Available; stations are sparse |
| Hawaii | Available | Available | Available | Disabled |
| Puerto Rico, US Virgin Islands, Guam, Northern Mariana Islands and American Samoa | Available | Partial | Partial | Disabled |
| British Columbia | Available | Partial | Partial; BC access permission required | Only near a SNOTEL state |
| Southwestern Alberta, inside the regional service extent | Available | Partial | Partial; regional parcels only | Only near a SNOTEL state |
| Alberta outside that extent, including Jasper and northern/eastern Alberta | Available | Partial | Disabled unless BC or US coverage is also in view | Only near a SNOTEL state |
| Other Canadian provinces and territories | Available | Partial | Disabled unless BC or US coverage is also in view | Only near a SNOTEL state |
| Mexico, Central America and the Caribbean, excluding US territories above | Available | Partial | Disabled unless US coverage is also in view | Only near a SNOTEL state |
| Europe, Asia, Africa, Australia and New Zealand | Available within the latitude envelope below | Disabled | Disabled | Disabled |
| Most of South America | Available within the latitude envelope below | Disabled | Disabled | Disabled |
| Northern South America, western Greenland and other North American service-edge areas | Available within the latitude envelope below | Uncertain; the conservative service envelope may keep it offered | Disabled | Disabled |
| Far polar views wholly south of 60° S or north of 84° N | Disabled | Disabled | Disabled | Disabled |

The 13 SNOTEL states are **Alaska, Arizona, California, Colorado, Idaho, Montana,
Nevada, New Mexico, Oregon, South Dakota, Utah, Washington and Wyoming**. The
public active-station catalog was checked on the date above. Coverage follows
those state outlines with a border buffer; actual station locations are filtered
locally after activation. Nearby discovery still requires a station within
50 km. [NRCS network](https://www.nrcs.usda.gov/programs-initiatives/sswsf-snow-survey-and-water-supply-forecasting-program),
[South Dakota station](https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=354),
[active SNOTEL catalog](https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?stationTriplets=*:*:SNTL&elements=SNWD,WTEQ&durations=DAILY&activeOnly=true).

## Wildfire availability

The **Wildfires** overlay is eligible inside US state and Washington, DC outlines
(including Alaska and Hawaii). Canada and US territories remain unsupported.
Border views can include US reporting alongside unsupported neighboring areas;
clear pixels do not establish absence of fire. Current NIFC incident locations
and available perimeters have independent reporting and mapping dates. See
[Wildfires](map-layers.md#wildfires) for controls and limits.

## What each overlay actually covers

| Overlay | Provider and geographic scope | Limits that remain inside an eligible region |
| --- | --- | --- |
| Sentinel-2 imagery | Microsoft Planetary Computer Sentinel-2 L2A. Routine mission coverage includes continental land from 56° S to 82.8° N, coastal waters and qualifying islands. The extension uses a conservative 60° S–84° N eligibility envelope. | Only captures from the past 30 days; clouds, missing passes and incomplete scene footprints can leave gaps. The broad latitude envelope is not a promise of imagery. |
| Slope angle | USGS 3DEP. US coverage includes Alaska, Hawaii and territorial islands. Lower-resolution data also covers parts of Canada, Mexico, Central America and the Caribbean. | A conservative North American/island envelope avoids disabling uncertain service edges. Resolution and completeness vary. Slopes below 20° and missing data are both clear. This is not an avalanche forecast. |
| Public lands | USGS PAD-US 4.1 fee ownership in the US; ParcelMap BC ownership classifications; the southwestern Alberta regional ownership service. | BC and Alberta are partial. Alberta's approximate envelope is 49.14–53.65° N, 117.85–113.58° W; its provider excludes Calgary. A coarse extent cannot detect every internal gap. Unclassified/private/unknown records stay clear. Ownership does not establish access or camping permission. |
| SNOTEL stations | Active NRCS SNOTEL stations in the 13 states above. Map filtering happens locally. | Being in a covered state does not mean a station is near the peak. Activation can frame the nearest station within 50 km, while keeping the prior map center in view. More than 50 visible stations requires a closer zoom. Conditions actions require membership in the peak's Nearby snow card. |

Sources: [Copernicus mission coverage](https://sentiwiki.copernicus.eu/web/s2-mission),
[Planetary Computer dataset](https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a),
[USGS 3DEP products](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services),
[USGS regional elevation coverage](https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer),
[PAD-US fee layer](https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/0),
[ParcelMap BC](https://catalogue.data.gov.bc.ca/dataset/parcelmap-bc-parcel-fabric),
[Alberta regional layer](https://geospatial.alberta.ca/arcgis/rest/services/Hosted/Land_use_owndership_NN_project/FeatureServer/10).

## Menu behavior

| Situation | What the menu does |
| --- | --- |
| The peak's initial map region is outside an overlay's coverage | Keeps its row in place, disables its unchecked toggle and shows **No coverage**. Its disclosure still explains the state. |
| An enabled overlay leaves coverage after a pan or renderer change | Turns it off, removes its resources and cancels outstanding work. Late station results cannot restore it. |
| The map returns to coverage | Makes the toggle available again. It stays off until explicitly enabled; opacity preferences are retained. |
| The viewport is not known yet | Waits for a valid map region; it does not infer absence from missing bounds. |
| The region is supported but the map is too far out | Shows **Zoom in**. The overlay remains an available choice. |
| BC access is missing, a service fails, or a request is rate limited | Keeps the existing permission/recovery feedback. These are not treated as geographic absence. |

Availability is computed offline from packaged outlines and provider envelopes.
It adds no coverage-query requests, permissions or settings. Native and terrain
tiles share the same routing checks, including buffered tiles beyond the visible
map. Clear pixels are never used to infer that a whole region lacks coverage.

## Implementation and verification

The regional policy is in `src/maps/map-overlay-providers.js`, with ownership
routing in `src/maps/canadian-land.js`. The packaged Natural Earth outlines are
public domain and pinned to a source hash. Regenerate them with
`scripts/generate-map-overlay-regions.mjs` and the verified source file it names.
The shared menu and page owner apply the resulting availability in both renderers.

Implemented in `8fa032e6`. Verification: 3,125 full tests; lint with the eight
existing reviewed warnings; hidden Chrome 156 and Firefox 157 at 736/320 × 800,
light/dark and normal/doubled text; real unpacked Chrome native/3D integration
at 1000 × 700 on ANGLE/Metal Apple M3 Pro; Chrome startup/BFCache at 1000 × 760.
Checks cover disabling, cancellation, stale replies, border/wrapped views,
geometry, focus and return to coverage without automatic re-enablement.
Native and terrain unavailable renders were inspected. Provider tiles and
permission decisions are synthetic in those browser fixtures; this does not
prove live per-peak data completeness, the native permission prompt, full
Firefox 3D integration, physical touch or screen-reader speech.
