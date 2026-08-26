# Mountain-local time and civil-time conversion

## Goal

The GPX Analyzer's clock times ("Start / Summit / Back to car"), its `Day N`
boundaries, and camping-spot detection originally used the *viewer's*
timezone. GPX timestamps are UTC, so anyone reading an ascent recorded in
another timezone saw shifted times, and day boundaries could even move
camping spots. All of these now use the **climb's local time**, and the stats
bar discloses it: *"Times in the mountain's local time (PDT)"*.

The same resolver and formatter now own the offline
[Sun position calculator](sun-position.md). Peak pages use the validated summit
coordinate; GPX analysis continues to use the trailhead. No surface derives a
mountain clock from the viewer's machine timezone.

## Where the timezone comes from

The track's **starting coordinate** is resolved to an IANA timezone by
[`tz-lookup` 6.1.25](https://www.npmjs.com/package/tz-lookup/v/6.1.25), a
dependency-free ~73 KB raster that answers entirely offline. The locked npm
package ships CommonJS, so esbuild bundles it directly into the consumers that
need mountain time: `dist/content/gpx-analyzer.js`,
`dist/content/ascent-editor.js`, and `dist/content/peak-map.js`. The shared
`src/time/mountain-time.js` module is the only authored owner of resolution,
formatting, local-day comparison, and editable civil-time conversion. There is
no page-owned global for Peakbagger or another extension to replace.

- **Why not an accurate polygon library?** `geo-tz` carries ~100 MB of
  boundary data and needs Node file access — unusable in a content script.
- **Why not a web lookup service?** Sending coordinates off the page would
  violate the extension's privacy model. The raster never touches the
  network.
- **Why the start point and not the summit?** The trailhead decides which
  side of a zone border (or of a border peak) the trip's civil time belongs
  to: an Everest climb approached from Nepal should read in Nepal time even
  though the summit's raster cell resolves to `Asia/Shanghai`. The raster is
  also coarse near borders (Mount Baker resolves to `America/Vancouver`
  rather than `America/Los_Angeles`), which is harmless when the rules are
  identical and still better than any solar estimate.

Given the zone, `Intl.DateTimeFormat` renders wall-clock times with the
zone's real political offset and DST for the trip's date, while respecting
the viewer's 12/24-hour locale preference. Day boundaries come from the
zone's `YYYY-MM-DD` (`en-CA`) date of each timestamp.

## Converting an editable mountain clock to an instant

Peak Sun planning and untimed GPX previews start with a civil `YYYY-MM-DD` and
minute of day rather than a recorded UTC timestamp. `mountain-time.js` resolves
the UTC instant whose formatted date and clock match that civil value in the
resolved zone:

- an ordinary local minute resolves exactly;
- a spring-forward gap snaps to the first valid minute after the gap, and the
  visible control reflects the resolved minute; and
- a repeated fall-back minute chooses the earlier occurrence.

The same conversion handles half-hour and quarter-hour zones and dates on both
sides of the international date line. If the zone is the labelled longitude
fallback, conversion uses that fixed offset directly. No `new Date(year,
month, day, ...)` local constructor is used, because that would silently apply
the viewer's timezone.

Formatter instances are cached in a bounded module-local LRU keyed by
constructor, locale, zone, and options. A missing civil time uses a bounded
offset-transition search to find the first valid minute instead of testing up
to 1,440 separately formatted minutes. The cache is page-local only: it adds no
extension storage and cannot make the answer depend on the viewer timezone.

## When a saved GPX has no usable time

GPX permits trackpoints without timestamps, and stored tracks can pass through
devices, mapping tools, format conversions, and Peakbagger's saved-track export
before the analyzer reads them. That process can leave time absent or invalid.
It can also produce syntactically valid but meaningless data: a confirmed live
case had the same generated timestamp copied onto every point, several days
after the ascent date.

The analyzer therefore treats time as a capability, not as a consequence of a
`<time>` element existing. At least two valid timestamps must advance. When
every coordinate-valid point has one, timing is complete. When some timestamps
are missing or malformed but the valid subset still advances, timed chart runs
remain available with visible breaks and coverage; the elapsed value is
labelled **Known time span** rather than complete duration. Start/back,
summit-duration, and camping inference remain limited to complete timing.

Map geometry stays in GPX document order. When every segment has complete,
internally chronological timing and the segment ranges do not overlap, metrics
and charts may safely sequence those whole segments chronologically. Partial,
malformed, internally reversed, or overlapping timing preserves source order;
individual points are never reordered. Time views still use a stable timestamp
sort, so equal timestamps retain their relative source order. An all-equal
series cannot be repaired by sorting, so its time-derived output is omitted.
The full continuity and chart fallback matrix is maintained in
[gpx-data-quality.md](gpx-data-quality.md#resulting-chart).

This validation happens before timezone resolution. A displayed mountain time
therefore always comes from a usable UTC sequence; timezone conversion cannot
repair incorrect source chronology.

Partial timing never changes the geographic owner. The timezone anchor is the
first coordinate-valid route point even when that point has no timestamp; the
first later timed point supplies timing evidence only and cannot silently move
a cross-border trailhead into another civil zone.

## Why an offline whole-earth lookup can still fail

Every point on earth has a zone, but two failure paths are real, and both of
them must degrade instead of breaking the analysis panel:

1. **Out-of-range coordinates.** `tzlookup` throws
   `RangeError: invalid coordinates` for anything outside |lat| ≤ 90 /
   |lon| ≤ 180. The analyzer excludes these before timezone resolution and
   reports the coordinate-quality loss instead of passing malformed data into
   the lookup.
2. **tzdata rename skew.** The raster returns zone ids frozen at the tzdata
   edition it was built from; the browser's ICU has its own. After a rename
   (`Europe/Kiev` → `Europe/Kyiv`), `new Intl.DateTimeFormat({ timeZone })`
   can throw on an id the browser no longer (or does not yet) know. ICU
   keeps aliases, so this is rare — but the vendored raster is frozen while
   users' browsers update for years.

**Fallback:** on either failure, times use solar time rounded to the whole hour
from the start longitude (`Math.round(lon / 15)`), and the hint honestly
changes to *"(UTC−8, estimated from longitude)"*. The chart never dies on an
uncaught timezone exception. Because the resolver is a bundled import, a
missing dependency is a build failure rather than a runtime ordering state.

## Performance

The camping-spot scan asks for the local day of every track point, and
full-resolution ascent-page tracks can exceed 50,000 points — an
`Intl.DateTimeFormat.format` call per point costs seconds. Day lookups are
memoized per **UTC minute**: modern IANA offsets are whole minutes, so a
UTC-minute bucket can never straddle the climb zone's local midnight.

## Testing

`test/time/mountain-time.test.mjs` pins ordinary conversion, DST gaps and folds,
Apia's skipped civil date, unusual offsets, date-line dates, bounded formatter
construction/work, formatter failure, and longitude fallback.
`test/gpx/gpx-analyzer.test.mjs` uses an overnight fixture that crosses the
*mountain's* local midnight but **not** UTC midnight, so its `Day 2` and
camping assertions hold regardless of the timezone of the machine running the
tests. One test asserts the IANA path (PDT hint), a second asserts the
labelled longitude fallback when the browser rejects the resolved timezone.
