# FCC full-source conversion experiment

October 25, 2026. **Stopped by the user: 122 of 460 source archives verified,
one of nine national archives complete.** These scripts are research tooling,
outside the extension build. Adding them to this report does not resume the
batch. Original data, credentials, tools and generated PMTiles remain outside
the repository, normally in `~/Dev/fcc-tiles`.

The [run snapshot](run-snapshot.json) records 246 downloaded archives, 122
verified conversions representing 5,197,020 source features, and one verified
national archive. Incomplete working files are retained locally. Historical
progress files can list the tasks active at interruption; that is not proof
that a process is still running. There is no complete national manifest.

## Code inventory

| Script | Purpose |
| --- | --- |
| [fcc_download.py](fcc_download.py) | Authenticated, serialized bulk downloads; 6.5 seconds between API starts, bounded cache, hashes and receipts. |
| [fcc_convert.py](fcc_convert.py) | GeoPackage identity/schema checks, streamed GeoJSON, Tippecanoe encoding, independent source-point classification checks. |
| [fcc_finalize.py](fcc_finalize.py) | Assemble a national carrier/technology group only after every selected source in that group is verified. |
| [fcc_catalog.py](fcc_catalog.py) | Portable archive index with bounds, zooms, fields, bytes and checksums; partial output remains marked `building`. |
| [fcc_status.py](fcc_status.py) | Read local progress, sizes and discrepancy receipts without printing credentials. |
| [fcc_verify_browser.mjs](fcc_verify_browser.mjs) | Hidden hardware-WebGL rendering of selected source classifications in Washington, California and New York. |
| [fcc_audit.py](fcc_audit.py) | Archive hashes, PMTiles directory counts, every unique gzip tile payload and final inventory/catalog/browser consistency. |
| [test_fcc_tiles.py](test_fcc_tiles.py) | Small regression fixtures for source counts, national completeness, catalog safety, holes, modes, small islands, merging and corrupted payloads. |

The checked-in copies share `FCC_TILE_ROOT`, defaulting to `~/Dev/fcc-tiles`.
Set `FCC_TIPPECANOE_DIR` if the tool binaries are elsewhere. The browser verifier
finds this repository relative to its script; `BPB_REPO` overrides that location.
Compared with the interrupted local scripts, these copies have portable paths,
corrected environment descriptions, a **one-worker default and one encoder
thread**, and explicitly omit Playwright's software-WebGL fallback argument.
They do not modify or relaunch the stopped local jobs.

## Selected source and geometry policy

[selected-downloads.json](selected-downloads.json) pins the 460 selected public
FCC inventory rows: AT&T, Verizon and T-Mobile; LTE and 5G at 7/1 and 35/3 Mbps;
all listed states and territories; availability as of December 31, 2025.
Missing provider/state/technology combinations are not invented. FCC revisions
can change the current contents behind a file ID; per-download hashes and
receipts are needed to identify an actual run.

The encoder uses zooms 4–12, extent/detail 4096, identical-attribute coalescing,
no feature-count or tile-size dropping, no tiny-polygon reduction, and no
simplification of shared nodes. It retains `frn`, `providerid`, `brandname`,
`technology`, `mindown`, `minup`, `minsignal` and `environmnt`. Quantization,
clipping and other encoder simplification still apply. This is a detailed map
product, not lossless archival geometry or a proven production size policy.

**Environment codes describe overlapping eligibility, not two mutually
exclusive outdoor/vehicle layers:**

- `0`: outdoor stationary **only**.
- `1`: **both** in-vehicle mobile and outdoor stationary.
- An outdoor overlay includes **0 and 1**. An in-vehicle overlay selects **1**.

The [FCC field specification](https://help.bdc.fcc.gov/hc/en-us/articles/6047425308187-Formatting-Mobile-Broadband-Availability-Coverage-Maps)
defines these values. The national browser verifier intentionally checks an
individual source classification; its `environmnt == sample value` filter is
not a complete outdoor product filter. The corrected
[comparison renderer](../comparison/prepare.py) includes both eligible codes.

## Completed evidence and limits

- [National T-Mobile LTE receipt](national-tmobile-lte.json): all 52 selected
  source files, **3,315,322,831 bytes**, 1,295 independent source sample points.
- [Payload audit](archive-audits.json): archive SHA-256 and all **177,217 unique
  compressed tile payloads** checked. Gzip integrity is not exhaustive polygon
  equivalence or a real-world reception measurement.
- [National browser checks](national-browser-results.json): hidden Chrome for
  Testing 156.0.8078.4, Apple M3 Pro / ANGLE Metal, **960 × 640**, three selected
  source points. These checks use local HTTPS range serving, no external basemap
  and no extension integration. They do not prove native focus or placement.
- [Sizes by zoom](tmobile-lte-zoom-sizes.json): the largest compressed overview
  tile is **13,726,587 bytes** at zoom 5. Zooms 11–12 account for 1,146,609,610
  payload bytes; removing those zooms alone would leave roughly **2.17 GB**.
  Overview rendering performance remains unverified.
- [Catalog/source-count discrepancy](source-count-discrepancy-probe.json): FCC
  file 1859332 lists 8,836 records, but fresh GeoPackage and Shapefile downloads
  each contain 8,793. The GeoPackage hash repeats and SQLite integrity passes.
  Actual rows are retained; the difference is explicitly recorded.
- [GitHub hosting probe](github-hosting-probe.json): raw GitHub browser ranges
  work; the tested Release asset supports HTTP ranges but fails browser CORS.
- [H3 geometry comparison](public-h3-comparison.json): five sampled public
  hexagons match H3 resolution 8 within one MVT coordinate unit. This does not
  establish the publisher's aggregation rule or complete national footprint.

The batch has **not** completed, and no final nine-archive audit exists. There
is no public upload, Cloudflare deployment or shipped coverage overlay.

## Reproduction and resource boundary

Do not start any download or conversion merely to read this report. Four
concurrent conversion workers, each with two encoder threads, caused severe
CPU contention in the interrupted run. All conversion/download/assembly/audit
and owned browser processes were terminated at the user's request. A future
resume requires a separate explicit instruction and a conservative resource
budget; `nice` reduces scheduling priority but is not a CPU cap.

For small fixture tests, use an existing environment with the pinned
[Python dependencies](requirements.txt) and Tippecanoe 2.79.0. The official tool
archive SHA-256 was
`cc17b9db1b598babe08696e59dd05167a449b91c95fbad106cba22a3223cfc81`.
The test runs synthetic tiny geometries only:

```sh
TIPPECANOE_MAX_THREADS=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  ~/Dev/fcc-tiles/.venv/bin/python \
  docs/plans/experiments/fcc-browser-coverage/full-conversion/test_fcc_tiles.py
```

If a later authorized run uses a different data directory, initialize
`metadata/selected-downloads.json` there from the checked-in inventory before
invoking the scripts. The downloader reads `.secrets/fcc.json` with `username`
and `hash_value` keys. Keep that file private and outside Git; no real values
or account identifiers are included here. Runtime clients need no FCC token.
The scripts deliberately use assertions and must not be run with Python `-O`.

For the bounded screenshot reproduction, see the separate
[comparison instructions](../comparison/README.md). Its static renderer does
not launch a converter or scan the complete national archive.
