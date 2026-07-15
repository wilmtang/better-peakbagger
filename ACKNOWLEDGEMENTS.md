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

The following license notice applies to Chart.js:

> The MIT License (MIT)
>
> Copyright (c) 2014-2024 Chart.js Contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### MapLibre GL JS

Better Peakbagger distributes the unmodified MapLibre GL JS 5.24.0 strict-CSP
browser build, worker, and stylesheet under `vendor/`.

- Project: [MapLibre GL JS](https://maplibre.org/projects/gl-js/)
- Source: [MapLibre GL JS v5.24.0](https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0)
- License: BSD 3-Clause
- Packaged license text: [`vendor/maplibre-LICENSE.txt`](vendor/maplibre-LICENSE.txt)

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
