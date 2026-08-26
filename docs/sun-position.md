# Sun and Moon position calculator

Better Peakbagger adds an offline astronomical Sun and Moon calculator to
validated Peak Dynamic Maps and saved-ascent GPX analysis. It reports apparent
Sun and Moon azimuth and elevation, level-horizon sunrise and sunset, Moon phase
and illuminated percentage, and a compass that stays aligned with the visible
2D or 3D map.

It does **not** predict whether nearby terrain blocks either object, cast
shadows, clouds, smoke, or actual direct light on a slope. It does not calculate
moonrise or moonset. GPX elevation is deliberately not used as an
observer-height or terrain-horizon correction.

## Supported surfaces and subjects

The **Sun & Moon** disclosure is collapsed by default and never overlays a map.

- On a Peak page, `src/maps/peak-map.js` creates it directly below the Dynamic
  Map only after the page id, Full Screen Peak-map id, bounded focus coordinate,
  and subject name agree. The validated summit coordinate is its subject. An
  ambiguous or unsupported page gets no calculator.
- In the GPX Analyzer, `src/gpx/gpx-analyzer.js` places it after the selected
  coordinate controls and before the chart legend. Before selection, its
  disclosure remains openable and prompts for a chart point. Chart hover previews
  the Sun and Moon at the hovered route point, then restores the deliberate
  selection when the pointer leaves; click, touch, or keyboard selection fixes
  the route point. Replacing the native map keeps a still-valid chart selection,
  while loading, failure, or route invalidation clears the old subject.
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
time slider changes only the calculation for the selected route point; it
cannot move the chart selection, map marker, native map, or 3D highlight.

## Timezone and daylight-saving behavior

`src/time/mountain-time.js` is the shared clock policy for the GPX chart and the
calculator. It resolves coordinates through the packaged `tz-lookup` raster and
uses the browser's `Intl` timezone data. The Peak surface resolves the summit;
the GPX surface continues to use the route's starting coordinate even if the
track crosses a political timezone boundary.

If lookup or formatting fails, both surfaces use the existing labelled,
whole-hour longitude estimate. Each displayed clock owns the zone abbreviation
active at its exact instant, so sunrise and sunset remain correctly labelled
when a selected time falls on the other side of a DST transition. Adjacent-day
events say `previous day` or `next day` instead of flattening the solar cycle
onto one date. For editable civil times, a DST gap snaps forward to the first
valid minute and a repeated hour chooses the earlier occurrence. The viewer's
machine timezone never supplies calculation state.

See [mountain-local-time.md](mountain-local-time.md) for the shared resolver,
fallback, and GPX timing-quality contract.

## Astronomy, Moon phase, and compass orientation

`src/sun/sun-position.js` is a narrow pure wrapper around the locally bundled
`suncalc` 2.0.1 package. It validates coordinates, instants, and package output,
then returns apparent Sun and Moon azimuth clockwise from true north, apparent
elevation, 16-point compass labels, Sun rise/set or polar-day/polar-night state,
and Moon illumination for the same instant. The Moon phase name snaps
SunCalc's continuous phase value to the nearest eighth: New Moon, Waxing
Crescent, First Quarter, Waxing Gibbous, Full Moon, Waning Gibbous, Last
Quarter, or Waning Crescent. The separate percentage is the illuminated
fraction rounded to a whole percent; it is not derived from the phase name.

Rise/set uses observer height zero. A bounded nearby-anchor search selects the
cycle whose solar noon belongs to the requested local civil date, including
near the international date line. That cycle may legitimately rise on the
previous date or set on the next date. Missing or malformed daily events leave
the finite instantaneous Sun and Moon positions visible with a bounded
rise/set-unavailable message. Moon position and illumination are independent:
missing or malformed data for either leaves the Sun and the other lunar reading
visible while labelling only the failed value unavailable.

Absolute azimuth and elevation do not change when the map rotates. The graphic
is map-relative: for either object's azimuth `A` and accepted map bearing `B`,
its marker is drawn at `A - B`; cardinal labels use the same inverse bearing.
Native Peakbagger maps are north-up. While 3D is active,
`src/terrain/terrain-coordinator.js` forwards only its already authenticated,
finite, normalized view bearing. Stop, failure, replacement, or return to 2D
resets the compass to bearing zero. Pitch is intentionally ignored.

On ordinary days, a restrained arc inside the compass runs from the
level-horizon sunrise azimuth to the sunset azimuth through the solar-noon side
of the sky. A hollow endpoint marks sunrise and a filled endpoint marks sunset;
the exact event clocks remain in the line below. The arc is omitted when daily
event directions are unavailable and rotates with the same accepted map bearing
as the Sun, Moon, and cardinal labels. A cool crescent and radial line identify
the Moon; a hollow marker means it is below the astronomical horizon.

Compass animation is coalesced to animation frames. Sun movement, Moon movement,
and map-bearing changes use the shortest arc across north. Bearing-only updates
affect only the decorative, `aria-hidden` compass; the absolute direction and
elevation remain text, and the bearing stream is not announced to assistive
technology. Reduced-motion preferences remove the CSS transition.

Daily events are cached by validated subject, civil date, and zone. Slider
input updates the thumb and requested wall clock immediately, then calculates
and publishes only the final minute supplied in each animation frame. Changing
the date or subject invalidates the daily-event cache; changing only map bearing
never calls the astronomy package.

The range exposes its resolved mountain clock and short zone label through
`aria-valuetext`, not the internal 0–1439 minute index. Its input/focus box is
44 CSS pixels high while the visual track remains compact. A below-horizon Sun
or Moon uses a hollow, subdued marker, daylight progress appears only from exact
sunrise through exact sunset, the Moon row reports direction, elevation, phase,
and illuminated percentage, and the disclosure chevron follows expansion.

## Privacy, packaging, and failure boundaries

Coordinates, dates, times, and results remain ephemeral in the Peakbagger tab.
The calculator adds no permission, setting, storage key, provider request,
telemetry, or developer service. SunCalc, its BSD license, `tz-lookup`, and the
shared calculator stylesheet are packaged with the extension; no CDN or runtime
code download is used.

Only the MAIN-world GPX Analyzer and Peak-map bundles contain the astronomy
modules, and only those manifest entries load `css/sun-calculator.css`. The
pure state owner, `src/sun/sun-state.js`, keeps route selection one-way and
clears stale subjects. A valid subject with a date/time or formatting failure
keeps its controls open and usable so another selection can recover. A missing
subject or zone is terminal and may disable or omit the calculator. Neither
path exposes caught exception text or interrupts the native map, chart, or
terrain lifecycle.

Unit tests cover Sun and Moon reference positions, eight-phase classification,
local-solar-noon cycle selection, adjacent-day events, polar states, DST gaps
and folds, daylight-direction arcs, bounded formatter work, route provenance,
coalesced hover/slider interaction, accessibility, responsive layout, theme,
recovery, and cleanup. Hidden
packaged-browser checks load the real manifest in Chrome and Firefox and
exercise keyboard focus, slider semantics, Moon position and phase presentation,
Peak/GPX responsive geometry, and light/dark rendering in isolated profiles.
Hardware-GPU checks rotate both supported surfaces and prove that absolute text
stays fixed and the visual compass resets in 2D. Those hidden checks do not
establish live Peakbagger markup, actual screen-reader speech, physical touch
ergonomics, native browser chrome, or window placement.
