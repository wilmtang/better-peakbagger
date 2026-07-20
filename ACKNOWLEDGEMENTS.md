# Acknowledgements

Better Peakbagger is licensed under the
[GNU Affero General Public License v3.0 or later](LICENSE). This document records
the license notice for software distributed with the extension and credits a
project that inspired its design.

## Third-party software

### Chart.js

Better Peakbagger distributes the unmodified Chart.js 4.5.1 UMD build as
`vendor/chart.umd.min.js`.

- Project: [Chart.js](https://www.chartjs.org/)
- Source: [Chart.js v4.5.1](https://github.com/chartjs/Chart.js/tree/v4.5.1)
- License: MIT
- Packaged license text: `vendor/chart-LICENSE.txt` (copied from the npm package at build time)

### MapLibre GL JS

Better Peakbagger distributes the unmodified MapLibre GL JS 5.24.0 strict-CSP
browser build, worker, and stylesheet under `vendor/`.

- Project: [MapLibre GL JS](https://maplibre.org/projects/gl-js/)
- Source: [MapLibre GL JS v5.24.0](https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0)
- License: BSD 3-Clause
- Packaged license text: `vendor/maplibre-LICENSE.txt` (copied from the npm package at build time)

### Marked

Better Peakbagger distributes the unmodified Marked 18.0.6 UMD browser build
as `vendor/marked.umd.js`. The trip-report converter consumes its Markdown
token stream and does not use its HTML renderer.

- Project: [Marked](https://marked.js.org/)
- Source: [Marked v18.0.6](https://github.com/markedjs/marked/tree/v18.0.6)
- License: MIT
- Packaged license text: `vendor/marked-LICENSE.txt` (copied from the npm package at build time)

### tz-lookup

Better Peakbagger uses esbuild to wrap the `tz-lookup` 6.1.25 CommonJS
distribution as `vendor/tz-lookup.js`, without application changes to its
coordinate-to-timezone data or lookup logic. It resolves the GPX track's
starting coordinate to an IANA timezone entirely offline so chart times can be
shown in the climb's local time.

- Project: [tz-lookup](https://github.com/darkskyapp/tz-lookup)
- Source: [tz-lookup 6.1.25](https://www.npmjs.com/package/tz-lookup/v/6.1.25)
- License: CC0-1.0 (public-domain dedication)
- Packaged license text: `vendor/tz-lookup-LICENSE.txt` (copied from the npm package at build time)

### Mapterhorn

The optional 3D view requests elevation tiles from
[Mapterhorn](https://mapterhorn.com/). Mapterhorn is an external open-data
service, not bundled software or executable code. Its terrain-source
attributions are available on the
[Mapterhorn attribution page](https://mapterhorn.com/attribution/) and are also
shown in the rendered map.

## Inspiration

### Peakbagger GPX Ascent Logger

Better Peakbagger's activity-to-ascent draft workflow was inspired by Nelson
Wolf's
[Peakbagger GPX Ascent Logger](https://github.com/npwolf/peakbagger_gpx_ascent_logger),
which demonstrated how a GPX track could be used to discover nearby summits and
prepare Peakbagger ascent pages for review.

Copyright (c) 2025 Nelson Wolf. The upstream project is available under the
[MIT License](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/main/LICENSE).
It is credited here as design inspiration and is not distributed as a runtime
dependency of Better Peakbagger.

### peakbagger-cli

The Cloudflare bypass strategy documented in the project's development
guidelines — using Patchright with an isolated persistent Chrome profile,
waiting for challenge clearance, and reusing only the minted cookies — follows
the approach demonstrated in
[peakbagger-cli](https://github.com/dreamiurg/peakbagger-cli)'s
[browser transport](https://github.com/dreamiurg/peakbagger-cli/blob/main/peakbagger/browser_transport.py).
The project's rate-limit spacing for Peakbagger page fetches also used
peakbagger-cli's default as a reference point.

Copyright (c) 2025 PeakBagger CLI Contributors. The upstream project is available under the
[MIT License](https://github.com/dreamiurg/peakbagger-cli/blob/main/LICENSE).
It is credited here as design inspiration and is not distributed as a runtime
dependency of Better Peakbagger.
