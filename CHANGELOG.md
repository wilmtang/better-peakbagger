# Changelog

## 1.1.0 — 2026-07-09

Site-wide dark mode and a centralized settings page.

- **Options page** (`options/`) backed by `chrome.storage.sync`: units
  (auto / imperial / metric), theme (follow system / light / dark), and the
  ascent filter's default minimum trip-report words. Changes apply live to open
  Peakbagger tabs.
- **Dark mode** across all of Peakbagger via `src/theme.js` (sets
  `data-bpb-theme` on `<html>`) and `src/site-dark.css` (dark rules scoped under
  that attribute, injected but inert until enabled). The GPX chart and filter
  bar theme themselves to match.
- **Settings bridge** (`src/bridge.js`): the MAIN-world GPX analyzer can't read
  `chrome.storage`, so it exchanges settings with the isolated world over
  `window.postMessage`. Units and theme now come from the shared settings; the
  in-chart unit dropdown and the filter's word input write back to the same
  store instead of page `localStorage`.
- The in-chart unit dropdown and the filter word threshold are now centralized
  (chip on/off states still persist per-visit in `localStorage`).
- Expanded the README into an architecture deep-dive (content-script worlds, the
  bridge, GPX metrics, the Leaflet map-hover injection, dark mode).

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
