# Weather card UX refinement — 2026-10-11

Scope: summit and ascent weather presentation. Inspected both supplied dark
screenshots, the shipped bundles, component styles, and interactive HTTPS
fixtures before editing. Provider validation work was concurrently committed
as `10916f24` and `a2561904`; it is excluded from this UI change.

## Fixed and verified

- Shared packaged SVG weather illustrations replace inconsistent text glyphs.
  Amber sun, pale blue Moon/clouds, blue precipitation and violet wind reuse
  Sun & Moon's restrained semantic color. Clear night hours remain Moon icons;
  missing conditions retain their accessible Unavailable label.
- Both cards use the same light/dark palette and blue control accent. Component
  titles keep their own text color despite the site's global dark heading rule.
  Daily low/high colors and graph colors agree across both cards.
- Summit temperatures explicitly label Low and High; wind says Max wind.
  Temperature labels can wrap as complete readings in narrow cards.
- Range/location and model selection share a compact row on wide cards and
  stack on narrow cards. Accuracy copy is shorter and visually secondary;
  partial coverage reports an exact day count and labels the affected days.
- Duplicate model names are suppressed when the select already identifies the
  displayed data. Pending/failed model changes retain an explicit Using label
  for the old data. Archive resolution and model type remain visible.
- Browser verifiers now target the actual chart SVG instead of the first SVG
  illustration, ignore hidden nodes for overflow measurements, and assert the
  shared palette. An older audit assertion was corrected to expect the existing
  bordered hourly disclosure, consistent with the maintained archive verifier.

Verification: all 121 weather tests and focused ESLint pass. The real unpacked
extension was exercised headlessly in Chrome 153.0.8010.12 and Firefox 157.0.1,
light/dark, at 375/768/1440×1100 (archive checks additionally use 681×1100).
Summit tests include day activation, stable tab wrapping over 280–500 px card
widths, keyboard/hover/pinned readings, hourly tables, refresh, partial data,
unavailable models and rate limits. Archive tests include local-day navigation,
GPX selection, missing fields, column resizing, opt-out and error recovery.
Inspected wide/narrow light/dark forecast screenshots, narrow hourly conditions
and archive charts. Illustrations/charts use SVG; no WebGL renderer is involved.
The real-manifest Chrome check also passed, hidden at 1000×760, with BFCache
restoration and successful teardown.

## Intentionally not changed

- Model selection, forecast/history horizons, request/caching behavior and
  severe-condition precedence retain their existing contracts.
- Missing readings are not filled or shown as zero. Night/day semantics and
  text/accessibility labels remain independent of color.
- Native Peakbagger Save ownership, settings/privacy gates and GPX hover versus
  pinned selection remain intact. Unrelated work is excluded from this commit.

## Changed but not fully proven

- Hidden fixtures establish browser rendering, DOM focus and interaction, not
  screen-reader speech, physical touch, native browser/OS focus placement or
  accuracy of live weather estimates. These remain manual proof gaps.
