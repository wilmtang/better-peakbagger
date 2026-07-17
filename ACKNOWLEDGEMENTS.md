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
- Packaged license text: [`vendor/chart-LICENSE.txt`](vendor/chart-LICENSE.txt)

### MapLibre GL JS

Better Peakbagger distributes the unmodified MapLibre GL JS 5.24.0 strict-CSP
browser build, worker, and stylesheet under `vendor/`.

- Project: [MapLibre GL JS](https://maplibre.org/projects/gl-js/)
- Source: [MapLibre GL JS v5.24.0](https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0)
- License: BSD 3-Clause
- Packaged license text: [`vendor/maplibre-LICENSE.txt`](vendor/maplibre-LICENSE.txt)

### Marked

Better Peakbagger distributes the unmodified Marked 18.0.6 UMD browser build
as `vendor/marked.umd.js`. The trip-report converter consumes its Markdown
token stream and does not use its HTML renderer.

- Project: [Marked](https://marked.js.org/)
- Source: [Marked v18.0.6](https://github.com/markedjs/marked/tree/v18.0.6)
- License: MIT
- Packaged license text: [`vendor/marked-LICENSE.txt`](vendor/marked-LICENSE.txt)

### tz-lookup

Better Peakbagger distributes the unmodified @photostructure/tz-lookup 11.6.0
coordinate-to-timezone lookup as `vendor/tz-lookup.js`. It resolves the GPX
track's starting coordinate to an IANA timezone entirely offline so chart
times can be shown in the climb's local time.

- Project: [@photostructure/tz-lookup](https://github.com/photostructure/tz-lookup)
- Source: [@photostructure/tz-lookup v11.6.0](https://www.npmjs.com/package/@photostructure/tz-lookup/v/11.6.0)
- License: CC0-1.0 (public-domain dedication)
- Packaged license text: [`vendor/tz-lookup-LICENSE.txt`](vendor/tz-lookup-LICENSE.txt)

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
