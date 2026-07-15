# Chart times in the climb's local timezone

## Goal

The GPX analyzer's clock times ("Start / Summit / Back to car"), its `Day N`
boundaries, and camping-spot detection originally used the *viewer's*
timezone. GPX timestamps are UTC, so anyone reading an ascent recorded in
another timezone saw shifted times, and day boundaries could even move
camping spots. All of these now use the **climb's local time**, and the stats
bar discloses it: *"Times in the mountain's local time (PDT)"*.

## Where the timezone comes from

The track's **starting coordinate** is resolved to an IANA timezone by
[`@photostructure/tz-lookup`](https://github.com/photostructure/tz-lookup)
(`vendor/tz-lookup.js`, vendored unmodified), a dependency-free ~73 KB raster
that answers entirely offline.

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

## Why an offline whole-earth lookup can still fail

Every point on earth has a zone, but three failure paths are real, and all of
them must degrade instead of breaking the analysis panel:

1. **Out-of-range coordinates (reachable today).** `tzlookup` throws
   `RangeError: invalid coordinates` for anything outside |lat| ≤ 90 /
   |lon| ≤ 180. The analyzer's GPX parser only checks that coordinates are
   *finite* — it renders tracks other people uploaded to Peakbagger, so a
   malformed `lat="95"` flows straight into the lookup.
2. **tzdata rename skew.** The raster returns zone ids frozen at the tzdata
   edition it was built from; the browser's ICU has its own. After a rename
   (`Europe/Kiev` → `Europe/Kyiv`), `new Intl.DateTimeFormat({ timeZone })`
   can throw on an id the browser no longer (or does not yet) know. ICU
   keeps aliases, so this is rare — but the vendored raster is frozen while
   users' browsers update for years.
3. **Missing global.** MAIN-world scripts share the page's global namespace
   with Peakbagger's scripts and other extensions, so `globalThis.tzlookup`
   can be absent (packaging or ordering regression) or clobbered. The guard
   also lets tests and the showcase load the analyzer without the raster.

**Fallback:** on any of these, times use solar time rounded to the whole hour
from the start longitude (`Math.round(lon / 15)`), and the hint honestly
changes to *"(UTC−8, estimated from longitude)"*. The chart never dies on an
uncaught timezone exception.

## Performance

The camping-spot scan asks for the local day of every track point, and
full-resolution ascent-page tracks can exceed 50,000 points — an
`Intl.DateTimeFormat.format` call per point costs seconds. Day lookups are
memoized per **UTC minute**: modern IANA offsets are whole minutes, so a
UTC-minute bucket can never straddle the climb zone's local midnight.

## Testing

`test/gpx-analyzer.test.mjs` uses an overnight fixture that crosses the
*mountain's* local midnight but **not** UTC midnight, so its `Day 2` and
camping assertions hold regardless of the timezone of the machine running the
tests. One test asserts the IANA path (PDT hint), a second asserts the
labelled longitude fallback when the raster is not loaded.
