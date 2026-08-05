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

Separate GPX track segments always remain separate. Missing or excluded samples
also create chart breaks; Chart.js is never allowed to connect a line across
an unknown run.

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
- Time-derived views use a stable chronological copy. Route geometry,
  distance, gain, and elevation-by-distance retain GPX document order.

The analyzer labels complete timing as **Time** and incomplete timing as
**Known time span**. Start/back, summit-duration, and camping inferences require
complete timing; partial timing shows only the first and last known clock
values. Every displayed clock still uses the mountain-local timezone behavior
documented in [mountain-local-time.md](mountain-local-time.md).

## No silent reconstruction

Better Peakbagger does not:

- replace missing elevation with sea level;
- connect gain, grade, or profile lines across missing elevation;
- interpolate missing timestamps;
- sample the optional 3D terrain tiles to manufacture a GPX elevation profile;
- present a partial known time span as the route’s complete duration.

The distance-over-time and route-position fallbacks are derived only from
recorded coordinates and trustworthy timestamps. They preserve useful chart
interaction without disguising derived or absent measurements as source data.
