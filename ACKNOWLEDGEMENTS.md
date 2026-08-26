# Acknowledgements

Better Peakbagger is licensed under the
[GNU Affero General Public License v3.0 or later](LICENSE). This document records
the license notice for software distributed with the extension and credits projects that inspired its design.

The packaged `THIRD_PARTY_NOTICES.txt` is generated from the complete shipped
npm dependency graph and retains each package's full license and notice text.
It is the authoritative notice inventory; the summaries below provide human
context for the extension's principal dependencies and inspirations.

## Third-party software

### Chart.js

Better Peakbagger distributes the locked Chart.js UMD build as
`vendor/chart.umd.min.js`.

- Project: [Chart.js](https://www.chartjs.org/)
- Source: [Chart.js](https://github.com/chartjs/Chart.js)
- License: MIT
- Packaged license text: `vendor/chart-LICENSE.txt` (copied from the npm package at build time)

### CodeMirror

Better Peakbagger bundles CodeMirror 6, including its Lezer parser
dependencies, into `content/ascent-editor.js` to provide the Markdown source
editor.

- Project: [CodeMirror](https://codemirror.net/)
- Source: [CodeMirror repositories](https://github.com/codemirror)
- License: MIT
- Packaged license text: `THIRD_PARTY_NOTICES.txt`

### BetaCreator

Better Peakbagger's X-shaped Bolt, plus the Piton, Rappel, and Belay photo-topo
SVG paths, adapt canvas stamp geometry from BetaCreator, the editor used by
Mountain Project. The coordinates were normalized and translated to SVG; the
Better Peakbagger-only Anchor symbol is not derived from BetaCreator.

- Project: [BetaCreator](https://github.com/nemophrost/betacreator)
- Source: [BetaCreator stamp views](https://github.com/nemophrost/betacreator/tree/2a3b7898f009fbf4cf116673e121cf16202a5498/js/betacreator/views/stamps)
- Copyright: 2012 Alma Madsen
- License: Apache License 2.0
- Packaged license text: `vendor/betacreator-LICENSE.txt`

### MapLibre GL JS

Better Peakbagger loads the locked MapLibre GL JS ESM distribution directly from
the extension-owned terrain frame. Its main module, module worker, shared module,
and stylesheet are copied unmodified under `vendor/`.

- Project: [MapLibre GL JS](https://maplibre.org/projects/gl-js/)
- Source: [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)
- License: BSD 3-Clause
- Packaged license text: `vendor/maplibre-LICENSE.txt` (copied from the npm package at build time)

### Marked

Better Peakbagger distributes the locked, unmodified Marked UMD browser build
as `vendor/marked.umd.js`. The trip-report converter consumes its Markdown
token stream and does not use its HTML renderer.

- Project: [Marked](https://marked.js.org/)
- Source: [Marked](https://github.com/markedjs/marked)
- License: MIT
- Packaged license text: `vendor/marked-LICENSE.txt` (copied from the npm package at build time)

### TipTap

Better Peakbagger bundles the locked TipTap core with its TipTap extension and
ProseMirror dependencies into `content/ascent-editor.js` to provide the
rich-text editor.

- Project: [TipTap](https://tiptap.dev/)
- Source: [TipTap](https://github.com/ueberdosis/tiptap)
- License: MIT
- Packaged license text: `THIRD_PARTY_NOTICES.txt`

### tz-lookup

Better Peakbagger uses esbuild to bundle the locked `tz-lookup` CommonJS
distribution directly into the GPX analyzer and ascent editor, without
application changes to its coordinate-to-timezone data or lookup logic. It
resolves the GPX track's starting coordinate to an IANA timezone entirely
offline so chart times can be shown in the climb's local time.

- Project: [tz-lookup](https://github.com/darkskyapp/tz-lookup)
- Source: [tz-lookup](https://www.npmjs.com/package/tz-lookup)
- License: CC0-1.0 (public-domain dedication)
- Packaged license text: `vendor/tz-lookup-LICENSE.txt` (copied from the npm package at build time)

### SunCalc

Better Peakbagger bundles the locked SunCalc ESM distribution into the Peak-page
and GPX-analyzer calculators. It computes apparent Sun position and rise/set
events locally in the browser without a network service.

- Project: [SunCalc](https://github.com/mourner/suncalc)
- Source: [SunCalc](https://www.npmjs.com/package/suncalc)
- License: BSD 3-Clause
- Packaged license text: `THIRD_PARTY_NOTICES.txt`

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
The runtime managed-challenge signature follows its
[HTTP client](https://github.com/dreamiurg/peakbagger-cli/blob/main/peakbagger/client.py):
status 403 plus either the `cf-mitigated: challenge` header or `Just a moment`
near the start of the response body.
The project's rate-limit spacing for Peakbagger page fetches also used
peakbagger-cli's default as a reference point.

Copyright (c) 2025 PeakBagger CLI Contributors. The upstream project is available under the
[MIT License](https://github.com/dreamiurg/peakbagger-cli/blob/main/LICENSE).
It is credited here as design inspiration and is not distributed as a runtime
dependency of Better Peakbagger.
