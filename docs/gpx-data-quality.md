# GPX charts with missing or degraded data

Better Peakbagger treats coordinates, elevation, and time as independent
recorded capabilities. A missing field should remove only the calculation that
needs it. It must not turn into zero, be silently interpolated, or cause
trustworthy route data to disappear.

## Resulting chart

The analyzer chooses the most useful honest visualization supported by the
track:

| Coordinate data | Elevation data | Time data | Result |
| --- | --- | --- | --- |
| Valid | Complete | Complete and progressing | **Elevation profile:** elevation by distance and elevation by time. Distance, gain, full duration, summit timing, and mountain-local details are available. |
| Valid | Complete | Missing, malformed, or non-progressing | **Elevation profile:** elevation by distance only. Time axes and time-derived statistics are omitted, with a concise reason. |
| Valid | Partial | Complete and progressing | **Elevation profile with gaps:** only recorded, plausible elevations are plotted. Distance and time still cover the complete coordinate route; gain is not counted across an elevation gap. |
| Valid | Complete or partial | Partial but progressing | **Partial time series:** valid timed runs are plotted with breaks around excluded timestamps. The panel reports a **Known time span**, not a complete duration, and shows time coverage. |
| Valid | Unavailable | Complete and progressing | **Route progress:** cumulative recorded distance over time. The chart remains synchronized with the 2D/3D route and never invents elevation. |
| Valid | Unavailable | Partial but progressing | **Partial route progress:** cumulative distance over each valid timed run, with breaks and time coverage. The span is explicitly partial. |
| Valid | Unavailable | Missing, malformed, or non-progressing | **Route-position scrubber:** a compact distance axis supports pointer and keyboard route inspection without implying a measured vertical or time value. |
| Partially valid | Any | Any | Invalid coordinate points split the route and are excluded. Remaining valid route sections use the applicable visualization above, and the panel reports the exclusion count. |
| Unavailable | Any | Any | **No chart:** the canvas and chart-only controls are hidden because no honest plot or map-synchronized coordinate selection is possible. |

A `<trkseg>` boundary alone does not force a visual or metric break. Recorders
often start a new segment after a pause even though the route continues.
Adjacent segment endpoints form one coordinate route when they are within
100 metres and any recorded elapsed time does not imply an impossible jump.
The elevation profile and gain also cross that boundary only when both endpoint
elevations are recorded, plausible, and within 100 metres of each other. More
distant endpoints, impossible timed jumps, and larger elevation resets remain
separate. Missing or excluded samples still create chart breaks; Chart.js is
never allowed to connect a line across an unknown run.

## What “complete,” “partial,” and “suspect” mean

- A coordinate is usable only when both latitude and longitude are finite and
  inside the geographic bounds.
- Elevation is complete when every coordinate-valid route point has a finite,
  conservatively plausible terrestrial elevation. Missing and malformed
  values, plus values outside −1,000 to 10,000 metres, are excluded. A partial
  profile reports its coverage and leaves visible gaps.
- Time is complete when every coordinate-valid route point has a valid
  ISO-shaped GPX timestamp and the set advances. When at least two valid
  timestamps advance but other timestamps are absent or malformed, time is
  partial. Equal timestamps may occur within a progressing track, but an
  all-equal series is non-progressing and cannot support a time view.
- The 2D/3D map geometry preserves GPX document order and explicit segment
  paths. Metrics and charts may reorder complete whole segments when every
  segment is internally chronological and their time ranges do not overlap.
  Partial, malformed, internally reversed, or overlapping segment timing
  keeps source order. Individual points are never reordered.

The analyzer labels complete timing as **Time** and incomplete timing as
**Known time span**. Start/back, summit-duration, and camping inferences require
complete timing and continuous time-coordinate groups; partial timing shows only the first and last known clock
values. Every displayed clock still uses the mountain-local timezone behavior
documented in [mountain-local-time.md](mountain-local-time.md).

## Suspect segments on saved ascents

Field validity alone does not prove that every segment describes the same
activity. The saved-ascent analyzer runs the pure
`src/gpx/gpx-segment-diagnostics.js` policy before chart sampling. It preserves
the original parsed segments and source point identities, then calculates
separate source and interpreted metric views. Activity capture, local-file
processing, and prepared drafts do **not** apply this additional policy.

Automatic exclusion from the interpreted view requires narrow evidence:

- **Degenerate duplicate:** at least eight valid points and 100 metres of path,
  with exactly the same ordered numeric coordinates as one unambiguous donor.
  Every candidate elevation is explicitly zero; every timestamp is identical
  and equals the donor's start. The donor must have complete plausible
  elevations, including a nonzero value, and complete nondecreasing timestamps
  with positive duration. A repeated lap with its own progressing time, a
  reversed route, missing elevations, or approximate similarity is insufficient.
- **Isolated distant point:** after duplicate exclusion, exactly one multi-point
  recording and one singleton remain. The recording meets the point/distance
  floors and has complete progressing time. The singleton is at least 24 hours
  outside that recording's time range and at least 50 kilometres from its
  entire path. Distance includes great-circle edge interiors, including polar
  and antimeridian crossings; ambiguous antipodal geometry cannot establish
  exclusion. Additional recordings or singleton breadcrumbs prevent this
  automatic choice. This rule is an inference of unrelated data, not proof of
  how or why the point was recorded.

Ambiguous duplicates, moving constant-time segments, and qualifying distant
singletons in ambiguous recordings remain included with review diagnostics.
Ordinary multi-day recordings, nearby early points, and legitimate repeated
routes remain included. There is no longest-route heuristic, approximate
matching, or reconstruction of missing measurements. Resource limits remain
100,000 track points and 50 segments, and classification runs once per load,
not on hover, resize, unit changes, or theme changes.

The existing metrics row always shows the **source** point count. When relevant,
an inline disclosure explains each segment decision, retained/excluded point
counts, and source-versus-interpreted distance and elapsed time. Its closed
state adds no header line; metric text truncates before the count and disclosure
at narrow widths. **Show all source segments** and **Use interpreted view**
switch views for this loaded GPX only. Source view still uses the normal metric
adjustments; it is not an unsmoothed or raw-data mode.

Changing views updates statistics, clock domains, summit timing, timezone,
chart sampling, extension route geometry and terrain input together. A selected
point is preserved by source identity if it survives, otherwise its map, Sun,
and coordinate-copy selection clears. Camping inference never bridges
separate time-coordinate groups. Interpreted terrain fits its selected route
instead of inheriting the native map's potentially contaminated source camera.
The native Peakbagger map layers remain untouched and may still show the source.

The saved GPX, download link, and files sent to Gaia, onX, AllTrails, and CalTopo
remain original. Interpretation changes no provider payload, stored setting,
permission, source timestamp/elevation, or saved ascent. No cleaned export is
created. The motivating source diagnosis and verification record are in the
[archived segment plan](archive/gpx-suspect-segments.md).

## Prepared ascent fields

Prepared Peakbagger drafts use the same sequencing, continuity, smoothing, and
plausible-elevation rules as the analyzer. The privacy-cleaned GPX upload still
keeps its original track and point order; a separate stable metric view may
sequence complete, non-overlapping track segments chronologically.

| Draft field | Required recorded data | Degraded result |
| --- | --- | --- |
| Start/end elevation | A plausible recorded elevation at that sequenced endpoint | Leave the existing or blank field unchanged. |
| Up/down distance | Complete admitted coordinates through the summit encounter | Leave the affected distance fields unchanged. |
| Up/down gain | Complete plausible elevations on that side of the encounter | Leave the affected gain fields unchanged; never bridge the missing run. |
| Up/down duration | Complete, ordered, progressing timestamps on that side | Leave the duration fields unchanged; never substitute zero. |
| Day gain/loss/max/camp | Complete plausible elevations for that day row | Leave every unavailable elevation-derived cell unchanged. |
| Day distance | Complete admitted coordinates for that day row | Leave the distance cells unchanged. |

An impossible elevation is removed before summit matching, reduction anchors,
draft derivation, and GPX serialization. It therefore cannot turn a match
Strong, inflate gain, or reach Peakbagger as if the recorder supplied it.

## No silent reconstruction

Better Peakbagger does not:

- replace missing elevation with sea level;
- connect gain, grade, or profile lines across missing elevation;
- treat matching elevation alone as proof that distant segments connect;
- interpolate missing timestamps;
- sample the optional 3D terrain tiles to manufacture a GPX elevation profile;
- present a partial known time span as the route’s complete duration.

The distance-over-time and route-position fallbacks are derived only from
recorded coordinates and trustworthy timestamps. They preserve useful chart
interaction without disguising derived or absent measurements as source data.
