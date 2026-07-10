# Better Peakbagger

A browser extension that makes [Peakbagger](https://www.peakbagger.com/) better for trip planning. It works on **Chrome** and **Firefox** (Manifest V3), and needs no userscript manager.

It bundles two features that used to be separate Tampermonkey userscripts:

- **GPX Analyzer** — on an ascent page with a GPS track, injects a rich interactive elevation chart (by distance *and* time), adjusted route metrics, timing/camping stats, and a marker that follows your cursor on Peakbagger's own map.
- **Ascent Beta Filter** — on a peak's "Ascents of a Peak" list, adds a sticky, stackable filter bar so you can instantly narrow hundreds of logged ascents down to the ones with a trip report, GPS track, or link.

Everything runs locally in your browser. The extension makes no network requests of its own and sends nothing anywhere — the GPX Analyzer only fetches the GPX file already linked on the page, and both features store your preferences in the page's `localStorage`.

---

## Install

The extension is not (yet) on the Chrome Web Store or AMO. Load it unpacked:

### Chrome / Edge / Brave

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Visit a Peakbagger ascent or peak-ascents page.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file in this folder.
4. Visit a Peakbagger ascent or peak-ascents page.

> Temporary add-ons are removed when Firefox restarts. To install permanently, the extension needs to be packaged and signed by Mozilla (`web-ext sign` / AMO). For day-to-day use on your own machine, [Firefox Developer Edition or Nightly](https://www.mozilla.org/firefox/channel/desktop/) can run unsigned add-ons by setting `xpinstall.signatures.required` to `false` in `about:config`.

---

## Features

### GPX Analyzer

Runs on individual ascent pages (`climber/ascent.aspx`). When the page has a "Download this GPS track" link, it parses the GPX in-browser and renders a Chart.js elevation chart.

- **Dual-axis charting** — simultaneous **Elevation by Distance** and **Elevation by Time** lines; click a legend entry to isolate one.
- **Interactive tooltips** — elevation, distance, grade, and timestamp for any trackpoint.
- **Map synchronization** — hovering the chart drops a color-coded marker onto Peakbagger's native Leaflet map, in sync with your cursor.
- **Adjusted metrics** — Haversine distance with confirmed-movement de-noising, hysteresis-based elevation gain, and windowed grade, to get closer to Garmin/Strava-style totals. Raw-vs-adjusted deltas are shown when they matter.
- **Unit persistence** — toggle Imperial/Metric; the choice is remembered.
- **Multi-day + camping** — detects multi-day trips (adds "Day N" labels) and flags overnight camping coordinates.
- **Double-click a point** to copy its `lat, lon` to the clipboard.

> The map-hover marker reaches into Peakbagger's same-origin `MasterMap.aspx` iframe and uses two undocumented globals it defines there (the Leaflet instance `mapsPlaceholder` and `L`). This is fragile by nature: if Peakbagger renames them the marker silently stops, but the chart itself is unaffected. This is why the GPX Analyzer runs in the page's main world.

### Ascent Beta Filter

Runs on a peak's ascent list (`climber/PeakAscents.aspx`). Injects a sticky filter bar above the table.

- **Has beta** (on by default) — only ascents with a trip report, GPS track, *or* link.
- **Trip report** — only ascents with a written report, with an adjustable **≥ N words** threshold.
- **GPS track** / **Link** — only ascents with a GPS track / an external link.
- Filters **stack** (AND), each chip shows its count, and there's a one-click **Show all**. Empty year separators collapse. Preferences persist across visits and stack on top of Peakbagger's own year/sort/unit URL filters.
- The condensed `PeakAscents.aspx?pid=...` view has no columns to filter; there the bar degrades to a link to the full "all years, full details" view.

---

## How it's built

Plain Manifest V3, no build step. Two static content-script registrations:

| Feature | Pages | World | Why |
| --- | --- | --- | --- |
| GPX Analyzer | `ascent.aspx` | **MAIN** | Needs page-context access to the map iframe's globals, the page's `localStorage`, and the bundled `Chart` global. |
| Ascent Beta Filter | `PeakAscents.aspx` | isolated (default) | Only reads the DOM table and page `localStorage`. |

[Chart.js](https://www.chartjs.org/) 4.5.1 is vendored at [`vendor/chart.umd.min.js`](vendor/chart.umd.min.js) (MIT) instead of being loaded from a CDN, so the extension ships no remote code — required by MV3 and better for privacy and reliability.

The `world: "MAIN"` content-script feature requires **Chrome 111+** and **Firefox 128+** (declared as `strict_min_version` in the manifest).

```
manifest.json          # MV3 manifest, both browsers
src/gpx-analyzer.js     # elevation/time chart (MAIN world)
src/ascent-filter.js    # ascent-list filter bar (isolated world)
vendor/chart.umd.min.js # Chart.js 4.5.1, bundled (MIT)
icons/                  # 16/32/48/128 px
```

## License

[AGPL-3.0-or-later](LICENSE). Chart.js is under the MIT License.
