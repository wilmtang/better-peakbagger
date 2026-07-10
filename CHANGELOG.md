# Changelog

## 1.2.1 — 2026-07-10

Dark mode polish: kill the flash for good, fix the washed-out header, and guard
contrast with a test.

- **Dark mode flash, finished.** 1.2.0 made the `data-bpb-theme` attribute
  land synchronously, but the dark stylesheet itself was still injected through
  the manifest `content_scripts.css` array — a separate renderer channel that
  doesn't reliably apply before first paint (Brave, cache-served loads), so the
  flash persisted. `src/theme.js` now injects the sheet from JS as a `<style>`
  in `<html>` at `document_start`, in the same synchronous tick that sets the
  attribute — the approach Dark Reader uses. The rules moved from
  `src/site-dark.css` (removed) to `src/site-dark-css.js` as `window.BPBDarkCSS`;
  the manifest no longer uses a `css` entry. Details in
  `docs/dark-mode-flash.md`.
- **Legible header banner.** The site header sits on the (light) `header.jpg`
  photo with its title + nav links set to inline `color:black`. The theme's
  global `a { color: … }` was overriding that black with the light-on-dark link
  color, washing the links out over the photo. `.mainbanner a` / `.mainmenu a`
  are now re-darkened to `#000`.
- **WCAG AA contrast guard.** New `test/dark-contrast.test.mjs` parses the
  shipped dark stylesheet and asserts every text/background pair meets WCAG 2.1
  AA (4.5:1 normal, 3:1 large), grounded against the captured fixtures. Fixing
  the pre-existing failures nudged a few muted colors lighter (placeholder,
  filter label/count) — no visible change, now compliant. Added a home-page
  capture (`test/fixtures/pages/home-default.html`) so the header is covered.

## 1.2.0 — 2026-07-10

Instant date sorting, a user-defined "has beta", and a dark mode fix.

- **Instant Ascent Date sort** on the ascent list: the header's
  `Ascent Date` / `[sort desc]` links now reorder the table in the DOM
  (milliseconds, no page reload). Implemented as a reversal of the served
  order — sections and rows within sections — so `Unknown`/malformed dates
  keep their backend ordering. The URL is rewritten via
  `history.replaceState` so reload/share reproduce the view, and a ▲/▼
  arrow now marks the active sort direction (the site never showed one).
  Views where the links would change the row set (non-date sorts, the
  default "Most Recent Year" page) still navigate normally.
- **Configurable "Has beta"**: new options-page group choosing which
  signals the chip counts — trip report with **≥ N words** (its own
  threshold, separate from the Trip report chip's), GPS track, external
  link. Defaults match the old hardcoded rule; at least one signal must
  stay checked. Changes apply live to open tabs (count and tooltip
  included).
- **Test infrastructure**: raw `PeakAscents.aspx` fixtures captured from
  the Wayback Machine (`test/fixtures/peakascents/`, provenance in its
  README) and a jsdom harness (`npm test`) running the real content
  scripts against them — no live-site access needed for development.
- **Fixed the flash of the light page on load with dark mode enabled**
  (most visible in Brave). `src/theme.js` now mirrors the theme preference
  into page `localStorage` and applies it synchronously at `document_start`,
  before first paint, instead of waiting for the async `chrome.storage` read
  (which stays authoritative and reconciles afterwards). Details in
  `docs/dark-mode-flash.md`.

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
