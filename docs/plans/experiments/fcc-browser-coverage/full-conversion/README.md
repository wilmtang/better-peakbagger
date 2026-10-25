# FCC full-source conversion experiment

October 25, 2026. **The local run was stopped at 122 of 460 source archives,
with one of nine national archives complete. A later explicit request resumed
the job on `build-host`; local converters remain stopped.** These scripts are
research tooling outside the extension build. See the
[VPS deployment record](vps-deployment.json) and the remote-execution section
below. Original data, credentials, tools and PMTiles remain outside Git.

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
| [fcc_run_vps.py](fcc_run_vps.py) | Persistent VPS supervision, imported-output verification, sequential assembly and data-only final audit. |
| [fcc_sizes.py](fcc_sizes.py) | Exact source-size survey using existing receipts or at most 64 KiB of a ZIP central directory per missing archive. |
| [start-vps.sh](start-vps.sh) | Linux-only systemd launcher with CPU/memory limits and a mounted-data-disk prerequisite. |
| [test_fcc_tiles.py](test_fcc_tiles.py) | Nine small regression fixtures covering data/geometry, safe resume, raw sizes, ZIP tails, completed-build and national-assembly restarts. |
| [fcc_compact.py](fcc_compact.py) | Separate delivery pass over completed PMTiles; copies zoom 12 unchanged and simplifies overview geometry. |
| [test_fcc_compact.py](test_fcc_compact.py) | Nine tiny fixtures for geometry, seams, feature fields, unchanged close-ups, independent audit rejection, catalogs and resume. |

The checked-in copies share `FCC_TILE_ROOT`, defaulting to `~/Dev/fcc-tiles`.
Set `FCC_TIPPECANOE_DIR` if the tool binaries are elsewhere. The browser verifier
finds this repository relative to its script; `BPB_REPO` overrides that location.
Compared with the interrupted local scripts, these copies have portable paths,
corrected environment descriptions, a **one-worker default and one encoder
thread**, and explicitly omit Playwright's software-WebGL fallback argument.
They do not modify or relaunch the stopped local jobs.

`FCC_ENCODER_THREADS` explicitly overrides the default encoder thread count;
the VPS profile uses two threads with one converter. It does not change the
local default or start local processes.

## Remote execution on build-host

The user approved a **separate 200 GiB zonal Balanced Persistent Disk**,
`build-host-fcc-tiles` in `us-west1-a`, and explicitly approved exporting the FCC
credential to this machine. The disk is privately mounted at `/mnt/fcc-tiles`,
with an `/etc/fstab` UUID entry. The boot disk was not resized. At Google's
[listed pricing](https://cloud.google.com/compute/disks-image-pricing), this
adds approximately **USD 20/month, or USD 0.66/day**, prorated by time. It stays
billable until deleted; finishing the conversion does not delete its data.

The VM is `e2-medium`, with two shared vCPUs, 4 GiB RAM and no GPU. The Python
environment and native Tippecanoe 2.79.0 build are under `~/Dev/fcc-tiles`.
Missing SQLite development files were extracted privately from an Ubuntu
package; system packages were not upgraded. The native Linux regression run
passed **nine tests**. A real AT&T DC 5G 35/3 source (file 1859524) converted
4,455 features to a 380,011-byte PMTiles in 2.38 seconds and passed source/tile
checks. This small test does not establish peak memory or total build time for
the largest states.

`fcc-tiles-conversion.service` survives SSH disconnects. Both current jobs are
parented by VPS PID 1. All 71 imported output files (10,357,582,168 bytes) are
on the VPS and passed SHA-256 checks. The [handoff proof](vps-handoff-status.json)
records **125/460** source conversions and both services active. The Mac may
sleep or disconnect; no Mac process, tunnel, mount or open SSH session is
required. No Codex reminder or monitoring automation was created because the
user will ask for a fresh status later.

Persistent service definitions under `/etc/systemd/system` and matching
`multi-user.target.wants` links are installed for the next VPS boot. The
current transient service processes were left running with unchanged PIDs.
`systemd-analyze verify` passed; an actual reboot was not performed. Resume
tests cover imported states already superseded by verified national archives
and prevent a completed data build from starting downloads again.

The conversion service admits one converter
and two encoder threads, with `CPUQuota=200%`, `MemoryHigh=1800M` and
`MemoryMax=2400M` (MiB units). OOM/fatal child errors stop the service; it does
not blindly restart. The downloader retains the shared 6.5-second API-start
spacing and bounded cache. National assembly runs after conversion, reducing
simultaneous RAM use. The existing 122 source receipts and 71 completed output
files (10,357,582,168 bytes) are imported rather than recomputed. Transfer can
overlap new conversion, but imported files must all arrive and pass SHA-256
checks before final assembly.

The first remote resume reproduced a missing-ZIP bug: historical receipt
presence was treated as source availability, while raw caches were deliberately
not copied. The queue now admits only a published `.zip` file; `.zip.part` and
receipt-only entries remain unavailable. A regression case covers this exact
migration boundary, and all seven tests then passed on both Mac and VPS before the
service restarted.

`fcc-raw-size-survey.service` independently measures remaining archives with
bounded ZIP-tail reads. It uses the same API lock/rate stamp as the downloader,
so the combined traffic stays below ten starts per minute. Its summary is
`/mnt/fcc-tiles/metadata/raw-size-survey.json`; `complete` must be true before
calling its byte sums the complete selected corpus. Individual source-size
proofs do not claim that the full archive payload was downloaded or validated.

Useful read-only commands:

```sh
ssh build-host '~/Dev/fcc-tiles/status.sh'
ssh build-host 'cat /mnt/fcc-tiles/metadata/vps-run.json'
ssh build-host 'cat /mnt/fcc-tiles/metadata/raw-size-survey.json'
```

Explicitly stopping the owned services uses:

```sh
ssh build-host 'sudo systemctl stop fcc-tiles-conversion fcc-raw-size-survey'
```

Child logs are under `/mnt/fcc-tiles/logs/`. Success requires `manifest.json`,
`catalog.json` and `verification/vps-final-data-audit.json`. The VPS audit checks
all selected source IDs, source-feature totals, national hashes, catalog
agreement and every unique tile's gzip integrity. It explicitly leaves browser
verification pending: the GPU-less VPS does not run software-WebGL checks or
pretend that data validation proves rendered behavior. Existing local render
evidence remains limited to the earlier completed layer and comparison.

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

## Smaller delivery archives

The separate `overview-half-pixel-v1` delivery pass reads the completed national
PMTiles. It needs **no FCC downloads or repeat source conversion**. Original
archives, receipts and the baseline catalog remain unchanged. The delivery pass
waits for the baseline's complete data audit before using the VPS's working
memory; it produces its own `delivery/tiles/`, `delivery/manifest.json` and
`delivery/catalog.json`. Paths in that catalog resolve relative to `delivery/`.

- Zoom **12 and higher**: original compressed tile bytes are copied unchanged.
  The archive audit independently compares **every** finest-zoom tile, rather
  than extrapolating from a few source points.
- Zooms **4–11**: polygon chains are simplified with a tolerance of 4 units in a
  4096-unit tile: **half a pixel when the tile is drawn at 512 px**. These are
  approximate overviews, not exact point-coverage query results. This does not
  improve the underlying FCC reception model.
- Tile-edge crossing segments are pinned. Invalid candidates and candidates
  whose tile-edge intersections change are rejected. Polygon parts and holes
  remain present; very small or narrow rings retain their original coordinates.
  This does not claim exact preservation of shared boundaries between different
  classifications inside a tile; subpixel differences can occur there.
- Feature order, IDs, property dictionaries and all eight source fields are
  preserved, then independently audited. There is no same-class reordering,
  cross-class merging or attribute removal. Reordering overlapping signal
  classes could change paint order and needs a separate rendering contract.
- Tiles exceeding 128 MiB uncompressed and individual features exceeding one
  million geometry command integers are retained unchanged to bound memory.
  A transformed tile is used only if its compressed payload is smaller.
- Output payload deduplication uses SHA-256 **and a byte comparison**. Scratch
  lives on the dedicated data disk. Every output address and gzip checksum is
  checked; output receipts bind the input and output hashes. Partial or orphaned
  outputs are not advertised as complete, and unverified existing destinations
  are not overwritten.

The bounded real-data benchmark chooses the largest tile no larger than 2 MB
compressed at each available zoom. It intentionally does **not** cover the
13.7 MB worst overview tile or estimate whole-archive savings. Initial measured
zoom-4 and zoom-5 samples saved only about **2%**: preserving every small island
and hole at overview scales limits potential savings. The earlier 635 MB figure
is the size of finest-level payloads alone, **not** the promised final archive.
Whole-country bytes and low-zoom browser rendering remain unproven until the
full delivery pass and separate browser checks finish.

```sh
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  ~/Dev/fcc-tiles/.venv/bin/python \
  docs/plans/experiments/fcc-browser-coverage/full-conversion/test_fcc_compact.py

# Run on the Linux VPS; --wait leaves the independent baseline build alone.
FCC_TILE_ROOT=/mnt/fcc-tiles \
  ~/Dev/fcc-tiles/.venv/bin/python \
  ~/Dev/fcc-tiles/code/fcc_compact.py delivery --wait
```

Nine tiny regression fixtures pass locally. The small-island containment
assertion first failed on the initial simplifier, then passed after adding the
small-ring guard. A deliberately altered zoom-12 payload is rejected by the
independent archive audit. Catalog/resume tests run a complete nine-archive
synthetic delivery, verify portable URLs and original hashes, then resume without
reprocessing. These fixtures do not prove national size or browser performance.
