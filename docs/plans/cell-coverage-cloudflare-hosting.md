# FCC cell coverage on Cloudflare: storage and free-tier investigation

October 24, 2026. **R2 plus a small tile-serving Worker is a supported deployment
architecture. A zero-dollar deployment is possible within the included usage,
but a complete current US tileset has not been obtained or measured.** This is
research and a local size experiment; nothing has been deployed.

## Findings

1. **There is no single size for "FCC tiles."** Our documented FCC source is
   bulk coverage data; we would build our own tiles. Country/state, carriers,
   LTE/5G speed thresholds, outdoor/in-vehicle modes, hexagons versus coverage
   footprints, retained attributes and zoom levels all change the output.
   Keeping several historical snapshots multiplies stored data. Original ZIP,
   decoded database, GeoJSON, MBTiles and PMTiles sizes are different measures.
2. **The available real sample is small, and its provenance limits remain.**
   We converted the previously retained 2,799-hexagon Sedona sample to PMTiles
   and decoded every output tile. At the highest generated zoom, every source
   feature ID and its selected attributes remained present. This is a bounded
   FCC-derived government mirror sample, without an established reporting date
   or carrier field, not an original FCC carrier/state archive or US census.
   Do not extrapolate its bytes per feature or area to a national total.
3. **R2's included usage can cover a small public deployment.** Standard storage
   includes 10 GB-month, 1 million Class A operations and 10 million Class B
   operations per month; Internet egress is free. Additional standard storage
   costs $0.015/GB-month, writes $4.50/million and reads $0.36/million, subject
   to billing-unit rounding. These allowances are shared with other R2 usage
   in the account. R2 onboarding includes a subscription checkout, and usage
   above the allowances is billable; this is not a guaranteed zero-spend cap.
   See [pricing](https://developers.cloudflare.com/r2/pricing/) and
   [onboarding](https://developers.cloudflare.com/r2/get-started/).
4. **Worker requests can become the tighter free limit.** Workers Free allows
   100,000 requests per day across the account, 10 ms CPU per HTTP request and
   128 MB memory per isolate. A user's map session can request many tiles.
   Cache hits that pass through the Worker still count as Worker requests;
   caching primarily saves storage reads and work. A cold PMTiles tile can
   require more than one R2 range read, so tile requests are not a reliable
   one-to-one estimate of Class B usage. The free Worker limit and cold-request
   CPU behavior must be measured in a real deployment. See
   [limits](https://developers.cloudflare.com/workers/platform/limits/),
   [Workers pricing and caching](https://developers.cloudflare.com/workers/platform/pricing/)
   and [PMTiles storage requests](https://docs.protomaps.com/pmtiles/cloud-storage).
5. **Static Pages hosting has different constraints.** Pages Free and Workers
   Free static assets allow 20,000 files and 25 MiB per file. Pure Workers static
   asset requests are free and unlimited, but requests invoking Worker code
   use Workers quotas. A small regional set of individual MVT files may fit.
   A large single PMTiles file cannot be uploaded as one static asset. Pages
   also documents returning HTTP 200 rather than 206 for range requests, so
   Pages is not the recommended host for a PMTiles archive. A sharded archive
   design would need its own range, CORS and client-routing verification.
   See [Pages limits](https://developers.cloudflare.com/pages/platform/limits/),
   [Pages serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/),
   [Workers asset limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets)
   and [asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

## Measured tile sizes

[measure-tiles.py](experiments/fcc-browser-coverage/measure-tiles.py) uses the
retained ZIP pinned by the earlier [source manifest](experiments/fcc-browser-coverage/source-manifest.json).
Its narrowly scoped reader checks the fixture's exact GeoPackage/WKB variant.
It is not a general FCC archive reader. Tippecanoe 2.79.0 was built locally from
the official tagged source archive (source directory revision `68ab8dc`, archive
SHA-256 `cc17b9db1b598babe08696e59dd05167a449b91c95fbad106cba22a3223cfc81`).
No global tool or repository runtime dependency was installed.

| Same 2,799 source features | Bytes | Tiles |
| --- | ---: | ---: |
| Earlier local GeoPackage fixture | 770,048 | n/a |
| Earlier ZIP of that fixture | 226,005 | n/a |
| PMTiles, zooms 6–12, H3 ID plus coverage fields | 324,394 | 27 |
| PMTiles, zooms 6–14, H3 ID plus coverage fields | 520,691 | 198 |
| PMTiles, zooms 6–14, coverage fields without H3 string | 344,310 | 198 |

Coverage fields were `technology`, `mindown`, `minup`, and `environmnt`.
All configurations kept numeric feature IDs. Increasing the maximum zoom from
12 to 14 increased this sample's bytes by about 61%; removing the H3 string at
zoom 14 reduced bytes by about 34%. A tile pyramid can exceed the source ZIP
because geometries recur across zoom levels and tile boundaries. These are
observations on this sample, not universal compression ratios.

Feature dropping, tile-size limits, line simplification and tiny-polygon
reduction were disabled for this experiment. Tile coordinate quantization and
clipping still occur. ID and attribute preservation does not prove exact
geometry/coverage equivalence, correct low-zoom appearance, absence of seams,
or production tile sizes. Dissolving adjacent cells with identical semantics
was not tested. A production build needs boundary, holes and small-island
checks before choosing simplification or aggregation.

The three completed builds and their decode assertions passed. The first
validation attempt incorrectly treated decoded layer collections as features;
the assertion traversal was corrected, and the complete experiment reran.
The [result JSON](experiments/fcc-browser-coverage/tile-size-results.json) records
commands, hashes, tile counts and checks. No browser render, HTTP Range server,
R2 upload, cache hit, live latency or Cloudflare CPU measurement was performed.
Commands in that JSON shorten temporary paths for readability. Build-path
metadata can change archive sizes by a few bytes; the table records the final
completed run. Its three PMTiles files are retained locally under the earlier
ignored experiment artifact directory's `tiles/` subdirectory.

## Storage budget rather than an unsupported national estimate

A proposed initial scope could be three named US carriers, each with one LTE
and one 5G outdoor coverage definition: six logical layers. This excludes
alternate speed thresholds, in-vehicle layers, voice and historical releases.
Multiple logical layers can share one archive; the following arithmetic uses
an assumed average size per layer, not a measured national size.

| Assumed size per layer | Six layers, one release | Six layers, two releases |
| --- | ---: | ---: |
| 500 MB | 3 GB | 6 GB |
| 1 GB | 6 GB | 12 GB |
| 2 GB | 12 GB | 24 GB |

For those example total storage levels, steady-state Standard storage alone
would cost approximately $0/month at 3 or 6 GB, $0.03/month at 12 GB, or
$0.21/month at 24 GB, assuming the full 10 GB allowance is otherwise unused.
These examples exclude requests, Worker charges, domain registration and build
compute. Cloudflare averages daily peak stored bytes over the billing period;
old/new release overlap and backups also consume storage. See
[storage billing](https://developers.cloudflare.com/r2/pricing/#storage-usage).

For a conservative zero-storage-charge target, keep all hosted objects below
8 GB and leave the remaining allowance for release overlap and other usage.
For six equal layers that is about 1.33 GB each for one release or 0.67 GB each
when keeping two releases continuously. This is a proposed budget, not proof
that the selected US data fits. Keep source ZIPs and intermediate databases
locally; only publish the final tiles and a small version manifest.

Example request arithmetic: if a viewing session makes 100 Worker tile
requests, 1,000 sessions exhaust a 100,000-request day. At 500 requests per
session, only 200 sessions do. Those are hypothetical workloads, before other
Workers on the account, retries, metadata requests or preflights. Measure actual
map sessions rather than equating one pan or visitor to one request.

## Recommended deployment and next measurement

```text
FCC authenticated bulk downloads
  → local machine or separate CI build
  → versioned PMTiles + manifest in R2 Standard
  → tile-serving Worker + edge cache
  → Leaflet / MapLibre clients
```

[Protomaps documents this exact R2/Worker architecture](https://docs.protomaps.com/deploy/cloudflare).
Build the tiles offline; the free Worker should locate and serve prebuilt bytes,
not unzip and tile state-sized datasets. The documented Protomaps guide budgets
Workers Paid at $5/month. Starting with Workers Free is conditional on the
quota and CPU checks above; deployment compatibility with the free plan has not
been proven by our local build.

Use an owned custom domain for the production cache. Protomaps documents that
its Worker cache needs a zone rather than `workers.dev`, and Cloudflare marks
public `r2.dev` URLs as rate-limited development endpoints. Domain registration
may be an additional cost if no suitable domain is already owned. For a browser
that reads PMTiles directly, verify byte-range HTTP 206 and CORS, including
Range/If-Match and exposed ETag. Direct R2 through a custom domain avoids Worker
invocations, but huge archives have cache constraints: Cloudflare's Free/Pro/
Business CDN maximum cacheable object size is 512 MB, and requesting a small
range does not bypass the complete-object limit. Serving small extracted MVT
responses through the Worker avoids relying on caching the entire archive.
See [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[range behavior](https://developers.cloudflare.com/cache/reference/range-requests/)
and [cache limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).

The next useful source measurement is one official Washington carrier/LTE
archive, followed by representative larger/fragmented states and finally the
complete selected US build. Record source vintage, bytes, peak build disk/RAM,
zoom/detail policy, total PMTiles bytes and largest tile. Verify source identity
and geometry behavior rather than selecting settings only to hit a size target.
The previous FCC access restriction remains: no valid account token was
available, and anonymous requests hit an edge 403. National storage cannot be
confirmed until the actual selected corpus is built.

Before a hosted trial, review the source download terms, preserve attribution
and dates, make the FCC token a build-only secret, serve only allowlisted
archives, configure caching/CORS, and account for viewed-area network requests
in the product's privacy documentation. Set usage alerts and verify any
available hard spending control before promising a permanent zero-dollar
service. A free allowance alone does not impose a spending cap. No account,
subscription, bucket, DNS, Worker or external publication was changed here.

## Reproduce the local measurement

Build `tippecanoe` and `tippecanoe-decode` from
[the official 2.79.0 release](https://github.com/felt/tippecanoe/releases/tag/2.79.0)
in a disposable directory (`make -j 3 tippecanoe tippecanoe-decode`, without
`make install`). From the repository root, with the earlier retained sample:

```sh
tile_output=$(mktemp -d /tmp/bpb-fcc-tiles.XXXXXX)
python3 docs/plans/experiments/fcc-browser-coverage/measure-tiles.py \
  browser-evidence/fcc-browser-coverage-2026-10-24/sample.zip \
  "$tile_output" /absolute/path/to/temporary/tippecanoe
```

An empty output directory and the earlier exact ZIP hash are required. Missing
source archives, wrong schemas, failed builds, empty output and lost IDs fail
the run. To test with newly obtained FCC originals, first implement and validate
their actual schema; this fixture reader deliberately rejects them.
