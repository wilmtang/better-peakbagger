# Sun position calculator

Better Peakbagger adds an offline astronomical Sun calculator to validated Peak
Dynamic Maps and saved-ascent GPX analysis. It reports apparent azimuth and
elevation, level-horizon sunrise and sunset, and a compass that stays aligned
with the visible 2D or 3D map.

It does **not** predict whether nearby terrain blocks the Sun, cast shadows,
clouds, smoke, or actual direct light on a slope. GPX elevation is deliberately
not used as an observer-height or terrain-horizon correction.

## Supported surfaces and subjects

The disclosure is collapsed by default and never overlays a map.

- On a Peak page, `src/maps/peak-map.js` creates it directly below the Dynamic
  Map only after the page id, Full Screen Peak-map id, bounded focus coordinate,
  and subject name agree. The validated summit coordinate is its subject. An
  ambiguous or unsupported page gets no calculator.
- In the GPX Analyzer, `src/gpx/gpx-analyzer.js` places it after the selected
  coordinate controls and before the chart legend. It remains unavailable until
  an existing chart, pointer, touch, or keyboard selection supplies a valid
  route point. Loading, replacement, failure, or route invalidation clears the
  old subject.
- Full Screen maps, activity capture, editors, lists, the popup, and Settings do
  not get a calculator.

Peak pages have a native date input and default to the current date and clock
time in the summit's timezone. Changing the date preserves the clock time. GPX
pages have no date input:

1. A selected point with a strictly valid timestamp uses that instant's date
   and time in the Analyzer's trailhead-owned timezone.
2. An untimed point uses a complete saved ascent date and a clearly labelled
   preview time, initially noon. A later untimed selection retains that preview.
3. Without a valid point timestamp or complete ascent date, the calculator says
   that no track or ascent date is available. It does not use today's date or
   turn a year-only ascent date into January 1.

All-equal generated GPX timestamps are not treated as recorded time. Moving the
Sun time slider changes only the calculation for the selected route point; it
cannot move the chart selection, map marker, native map, or 3D highlight.

## Timezone and daylight-saving behavior

`src/time/mountain-time.js` is the shared clock policy for the GPX chart and the
calculator. It resolves coordinates through the packaged `tz-lookup` raster and
uses the browser's `Intl` timezone data. The Peak surface resolves the summit;
the GPX surface continues to use the route's starting coordinate even if the
track crosses a political timezone boundary.

If lookup or formatting fails, both surfaces use the existing labelled,
whole-hour longitude estimate. Every displayed date, clock, sunrise, and sunset
uses the same real or estimated zone label. For editable civil times, a DST gap
snaps forward to the first valid minute and a repeated hour chooses the earlier
occurrence. The viewer's machine timezone never supplies calculation state.

See [mountain-local-time.md](mountain-local-time.md) for the shared resolver,
fallback, and GPX timing-quality contract.

## Astronomy and compass orientation

`src/sun/sun-position.js` is a narrow pure wrapper around the locally bundled
`suncalc` 2.0.1 package. It validates coordinates, instants, and package output,
then returns apparent azimuth clockwise from true north, apparent elevation,
a 16-point compass label, and rise/set or polar-day/polar-night state. Rise/set
uses observer height zero and rejects events that fall outside the requested
local civil date, including near the international date line.

Absolute azimuth and elevation do not change when the map rotates. The graphic
is map-relative: for Sun azimuth `A` and accepted map bearing `B`, the Sun is
drawn at `A - B`; cardinal labels use the same inverse bearing. Native
Peakbagger maps are north-up. While 3D is active,
`src/terrain/terrain-coordinator.js` forwards only its already authenticated,
finite, normalized view bearing. Stop, failure, replacement, or return to 2D
resets the solar compass to bearing zero. Pitch is intentionally ignored.

Bearing-only animation is coalesced to animation frames and uses the shortest
arc across north. It updates only the decorative, `aria-hidden` compass; the
absolute direction and elevation remain text, and the bearing stream is not
announced to assistive technology. Reduced-motion preferences remove the CSS
transition.

## Privacy, packaging, and failure boundaries

Coordinates, dates, times, and results remain ephemeral in the Peakbagger tab.
The calculator adds no permission, setting, storage key, provider request,
telemetry, or developer service. SunCalc, its BSD license, `tz-lookup`, and the
shared calculator stylesheet are packaged with the extension; no CDN or runtime
code download is used.

Only the MAIN-world GPX Analyzer and Peak-map bundles contain the solar modules,
and only those manifest entries load `css/sun-calculator.css`. The pure state
owner, `src/sun/sun-state.js`, keeps route selection one-way and clears stale
subjects. Invalid inputs, unavailable formatting, non-finite astronomy output,
or a missing mount disable or omit the calculator without interrupting the
native map, chart, or terrain lifecycle.

Unit tests cover astronomy reference values, direction/bearing math, polar and
date-line events, DST gaps and folds, route provenance, asymmetric interaction,
accessibility, responsive layout, theme, and cleanup. The hidden packaged-
browser checks load the real manifest in Chrome and Firefox. The hardware-GPU
terrain checks rotate both supported surfaces and prove that absolute text stays
fixed and the visual compass resets in 2D. Those hidden checks do not establish
live Peakbagger markup, touch-device gestures, native browser chrome, focus, or
window placement.
