# Changelog

## 1.0.0 — 2026-07-09

Initial release as a standalone Chrome + Firefox extension (Manifest V3).

Migrated from two Tampermonkey userscripts, previously maintained in
`wilmtang/tampermonkey-scripts`:

- **Peakbagger GPX Analyzer** (was v13.13) → `src/gpx-analyzer.js`, running in
  the page's main world with Chart.js 4.5.1 now vendored locally instead of
  pulled from a CDN.
- **Peakbagger Ascent Beta Filter** (was v0.1.0) → `src/ascent-filter.js`,
  running as an isolated content script.

Feature behavior is unchanged from the userscripts. Because both features read
and write the same page-origin `localStorage` keys (`pb_gpx_unit_pref`,
`pbAscentBetaFilter.v1`), existing preferences carry over seamlessly for anyone
switching from the userscripts to the extension.
