# FCC coverage in the browser: feasibility experiment

October 24, 2026. **Browser-side processing and viewport rendering worked for a
small real-data sample. Direct FCC bulk downloading and full-state performance
remain unverified.** No extension runtime, dependency manifest, permission,
settings or shipped UI changed.

## Findings

1. **The documented automated FCC download route is authenticated.** The
   [official public-data API specification](https://us-fcc.app.box.com/v/bdc-public-data-api-spec),
   version 1.7 dated June 8, 2026, requires an FCC account, generated token and
   `username`/`hash_value` request headers. The documented limit is 10 calls per
   minute. File downloads select a bulk file by ID; the operation documents no
   viewport/bounding-box parameter. Do not embed a shared account token in the
   extension.
2. **Direct access failed in this environment.** Both the public download page
   in isolated hidden Chrome and an anonymous request to the documented API
   returned HTTP 403, with an edge-server Access Denied page. That does not
   establish what a valid credential or the user's existing session would do.
   The FCC's public Box copy of the API specification was accessible. See
   [access-results.json](access-results.json). No account was created, token
   requested, CAPTCHA attempted or access restriction bypassed.
3. **A browser can unzip and query an indexed GeoPackage in a Worker.** The
   successful candidate was `@sqlite.org/sqlite-wasm` 3.54.1-build1. The first
   candidate, `sql.js` 1.15.1, opened the table but failed when querying its
   R-tree: `no such module: rtree`. Its compile options omit `ENABLE_RTREE`;
   the successful build includes it. The same failure occurred in the browser,
   and the [Node compatibility canary](check-parsers.mjs) independently confirms
   the distinction. See [parser-results.json](parser-results.json).
4. **Viewport changes can reuse the loaded dataset.** All 16 settled-view cases
   matched an independent oracle from the source geometry: four positions in
   each of Leaflet and MapLibre, in both Chrome and Firefox. Nonempty, wider,
   panned and outside-sample empty views were included. There was one ZIP
   request per browser; pans and renderer switches made no additional ZIP
   requests. This demonstrates memory reuse, not IndexedDB persistence.
5. **Layer presence alone was insufficient verification.** Visual inspection
   found that Leaflet painted newly added coverage over the synthetic route.
   A screenshot-pixel assertion failed against the unfixed prototype with zero
   unobscured red route pixels. A dedicated coverage pane below the route fixed
   it; both renderers then passed the pixel assertion in both browsers. An
   initial screenshot-decoder attempt failed on fixture CSP and was corrected
   before the meaningful pre-fix failure was recorded.

## Data and measured results

The FCC original state/carrier archive could not be obtained, so these are
**not measurements of an original FCC archive**. The input was a bounded
[AZGeo-hosted FCC-derived LTE layer](https://services6.arcgis.com/clPWQMwZfdWn4MQZ/ArcGIS/rest/services/FCC_Mobile_Broadband/FeatureServer/195),
published by `cparkhurst_azgeo`. Two ordered GeoJSON pages supplied 2,799 unique
H3 hexagons around Sedona, Arizona. The experiment validated complete pagination,
unique IDs and closed finite Polygon geometry before using the data.

The mirror has no carrier field in this layer, and its FCC reporting vintage
was not established. It is not a substitute for the proposed Washington
carrier-specific sample. The source item reports roughly 2.99 GB of storage
across its service layers; that is **not a ZIP/download size** and is not used
as one here.

[prepare.py](prepare.py) locally repackages the real geometries and selected
attributes into a SQLite GeoPackage fixture with a private `sample_bounds`
R-tree, then ZIP-compresses it. The geometry headers/WKB are exercised, but this
fixture does not establish compatibility with FCC's actual archive layout,
table names or all permitted GeoPackage geometry variants. The independent
oracle retains the pre-repackaging geometry and computes exact bounding-box
membership outside the browser/SQLite path.

| Measurement | Observed result |
| --- | --- |
| Sample rows / distinct hexagons | 2,799 / 2,799 |
| Locally generated ZIP | 226,005 bytes, approximately 221 KiB |
| Uncompressed GeoPackage fixture | 770,048 bytes, 752 KiB |
| SQLite WASM linear memory after load | 8 MiB in each browser; not total memory or peak allocation |
| Chrome local ZIP fetch, module initialization, unzip and database open | 45.6 ms |
| Firefox local ZIP fetch, module initialization, unzip and database open | 37 ms |
| Chrome indexed query plus geometry decoding | 0.2–3.3 ms per tested view |
| Firefox indexed query plus geometry decoding | 0–4 ms per tested view; timer resolution affects small values |
| Chrome Worker request through completed map update | 21.8–35.4 ms per tested view |
| Firefox Worker request through completed map update | 23–51 ms per tested view |

These are single-run observations on this machine, not statistical benchmarks,
Internet download times or a latency guarantee. Leaflet completion includes two
animation frames; MapLibre completion waits for its idle event. The tested views
contained 0, about 300, or 1,101 records. Slightly different renderer bounds
correctly produced 304 versus 305 records in one position.

Process-tree RSS was also sampled every 100 ms: Chrome approximately
998–1,248 MiB and Firefox 1,326–1,607 MiB across the whole fixture lifecycle.
Those totals include browser, GPU, two initialized map engines and rendering
allocations. Sampling can miss transient peaks; these numbers cannot be
attributed to the dataset or used to extrapolate full-state memory. Frame-gap
samples likewise include map updates, screenshots and source requests, and are
not an isolated parser-stall benchmark.

Exact source URLs, response sizes/times, fixture hash and provenance are in
[source-manifest.json](source-manifest.json). Full browser measurements are in
[browser-results.json](browser-results.json). No individual coverage features or
source archive are committed.

## Browser and correctness evidence

- Hidden Chrome for Testing **156.0.8078.4**, 1000 × 760, hardware renderer
  **ANGLE / Metal / Apple M3 Pro**.
- Hidden Firefox **157.0**, 1000 × 760, WebGL renderer reported
  **Apple M1, or similar**. That is the browser's reported renderer string,
  not a claim that the host hardware differs between runs. Software-renderer
  strings are rejected by the harness.
- Real Leaflet 1.9.4 and MapLibre 6.13.0; a plain background and synthetic route,
  without live basemap tiles or terrain/DEM. This does not prove 3D draping or
  the installed extension's bridge and manifest behavior.
- HTTPS fixture on `www.peakbagger.com` with a disposable certificate and a CSP
  allowing packaged scripts/workers and WASM compilation, without unrestricted
  script evaluation. This is fixture CSP, not proof of live Peakbagger CSP.
- A live, credential-free count query to the government mirror succeeded from
  this fixture in both browsers, returning 2,799. This proves that request's
  CORS behavior, not FCC ZIP downloads or extension-origin CORS.
- Invalid ZIP and invalid viewport inputs rejected; a failed replacement kept
  the already loaded dataset usable. Deliberately dropping one feature caused
  the independent membership assertion to reject the result.
- Four final renderer screenshots were captured; the route-visibility defect
  and corrected Chrome Leaflet render, plus the final Chrome/Firefox MapLibre
  renders, were visually inspected. Native focus, onscreen window placement,
  screen-reader output, narrow/zoomed layouts and slow-network UI were not
  established by these hidden desktop checks.
- Owned browsers, profiles, HTTPS servers and certificates were torn down.
  Process-command and exact temporary-directory checks found no leftovers.

Screenshots, the pre-fix route image and the generated sample ZIP are retained
locally in the ignored `browser-evidence/fcc-browser-coverage-2026-10-24/`
directory. This is an explicitly retained experiment artifact directory,
not a production cache. Temporary parser installations and source downloads
are disposable.

## Reproduce

Run from the repository root with its normal dependencies already installed.
No candidate packages are added to the extension. The source service can change;
a fresh run records its own complete sample and hash or fails its input gates.

```sh
experiment_root=$(mktemp -d /tmp/bpb-fcc-experiment.XXXXXX)
npm install --prefix "$experiment_root" --ignore-scripts --no-audit --no-fund --save-exact sql.js@1.15.1 @sqlite.org/sqlite-wasm@3.54.1-build1 leaflet@1.9.4
python3 docs/plans/experiments/fcc-browser-coverage/prepare.py "$experiment_root"
node docs/plans/experiments/fcc-browser-coverage/check-parsers.mjs "$experiment_root"
node docs/plans/experiments/fcc-browser-coverage/browser.mjs "$experiment_root"
```

Run browser launches through the approved execution path outside the macOS
Seatbelt sandbox, retaining headless mode. The runner calls the repository
launch guard before launching Chrome. Inspect results and retain desired
artifacts, then remove only the exact experiment directory created above.

The fixture reader is intentionally narrow and trusts the locally generated
archive. Its 8 MiB compressed / 32 MiB decoded / 100,000-row ceilings and ZIP
metadata checks are not a production streaming-decompression or hostile-file
security boundary. It is not a general user-file importer.

## Decision and remaining gates

The browser approach is viable for bounded regions. **Do not approve seamless
direct FCC downloads or full-state performance from this experiment.** An
official carrier/state ZIP is still needed to measure real compressed size,
schema compatibility, initial latency and peak memory at the intended scale.

For a public feature, evaluate user-supplied local files or a permitted public
distribution path. Static spatially indexed files/tiles remain an alternative
when bulk downloads are too large; a processing server is not intrinsically
required for rendering. Any government mirror would need its own provenance,
coverage, retention and usage review before becoming a runtime provider.

Verified here: small-sample Worker decoding/index queries, correct local
viewport membership, renderer updates, reuse and visual route priority.
Intentionally unchanged: extension runtime and wildfire plan. Still unproven:
original FCC archives, full states, persistence/eviction, cancellation under
large loads, mixed carrier/technology semantics, raw coverage polygons,
production world/CSP boundaries, full map UI and 3D terrain.
