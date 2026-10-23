# FIT decoder evaluation — October 23, 2026

**Recommendation: use a narrow adapter over `fit-file-parser/raw`, after resolving
its compatibility gaps. Do not adopt `fit-decoder` 1.0.5.** This experiment changes
no extension runtime, permissions or dependencies. The adapter here projects
record fields for comparison; it is not the proposed production import pipeline.

## What actually ran

- Pinned npm releases `fit-file-parser@6.2.3` and `fit-decoder@1.0.5`, installed in
  a disposable directory with lifecycle scripts disabled. Both releases contain
  MIT license files. Registry publication dates are October 20, 2026 and February
  25, 2021 respectively: [first registry entry](https://registry.npmjs.org/fit-file-parser/6.2.3),
  [second registry entry](https://registry.npmjs.org/fit-decoder/1.0.5).
- Twelve public recordings: Garmin Fenix 6/7, Forerunner 310XT/645, Edge 500/1050/
  MTB, Suunto Vertical and Karoo 2; hiking, walking, running, cycling and swimming;
  files from 2010–2026. Exact URLs, sizes and SHA-256 hashes are in
  [corpus-manifest.json](corpus-manifest.json). These are a small selected sample,
  not a statistical estimate of device coverage.
- Twenty-two independent generated fixtures: twelve valid semantic cases and ten
  malformed/ambiguous inputs that our single-recording importer should reject.
  They cover both header sizes, absent header CRC, both byte orders, interleaved
  definitions, developer/unknown fields, invalid sentinels, indoor activity,
  enhanced altitude, two compressed timestamp forms, CRC corruption, truncation,
  bad signature/length/field width, undefined local messages, reserved bits,
  concatenation and trailing bytes. No candidate encoder generated the fixtures.
- Node worker isolation with a five-second deadline and 256 MiB old-generation
  limit per decode. Browser bundles were then exercised in **hidden Chromium
  156.0.8078.4 and Firefox 157.0**, using dedicated Web Workers, an isolated HTTPS
  fixture, and a restrictive CSP without `unsafe-eval`. Each browser ran 66
  synthetic and 36 public-file executions; acceptance and synthetic value checks
  matched Node, as did public record/GPS/elevation/timestamp counts.
- Two authorized live Garmin downloads were decoded locally in process memory:
  one recent recording and the oldest listed recording. Only aggregate counts
  and differences were logged. Neither credentials nor ZIP/FIT files, activity
  identities, names, coordinates, health data or device IDs were written to disk.

The official Garmin SDK was **not executed or benchmarked**. Its custom license
and the reasons for excluding it remain in the
[integration plan](../../garmin-personal-api-draft-inbox.md#decoder-licensing-and-selection).

## Results

| Candidate / configuration | Valid semantic fixtures | Reject malformed / ambiguous inputs | Public files decoded | Two private files decoded | Minified browser bundle / gzip |
| --- | ---: | ---: | ---: | ---: | ---: |
| `fit-file-parser/raw` + narrow projection | 11/12 | 10/10 | 11/12 | 2/2 | 5,166 / 2,164 bytes |
| `fit-file-parser` `{ force: false, strict: true }` + projection | 12/12 | 9/10 | 12/12 | 2/2 | 296,824 / 62,396 bytes |
| `fit-decoder` `fit2json` → `parseRecords` + projection | 1/12 | 4/10 | 12/12 | 2/2 | 106,644 / 31,951 bytes |

**Reading a file is not the same as decoding a correct route.** The public-file
column only measures acceptance. Byte sizes include the selected parser, our
small projection and a Worker message handler; they exclude ZIP support, tests,
the rest of the extension and production segmentation. esbuild 0.28.2 generated
minified browser IIFEs targeting Chrome 120 / Firefox 121. Gzip is a comparison
measure, not the installed extension's memory use.

The raw and full paths agreed exactly on every latitude, longitude, elevation and
timestamp in **56,465 record messages across their eleven shared public files**.
They also agreed across **10,027 records from the two private files** (4,284 and
5,743 records, with 4,253 and 5,735 valid coordinate pairs). Agreement between
related implementations is supporting evidence; the independently specified
synthetic values supply the stronger check for the selected fields.

Machine-readable public outcomes are in [results.json](results.json) and
[browser-results.json](browser-results.json). Per-file Node elapsed times are
single observations, excluding worker startup, not a performance benchmark or
latency guarantee. A successful harness run means the experiment finished; it
does not mean all candidate behavior passed.

### `fit-decoder`: reject for this integration

Confirmed against the published release, not just its README:

1. **Wrong altitude scaling.** A known enhanced-altitude field representing
   **1,000 m becomes 75 m**. `src/semantics.js` divides altitude by 100, whereas
   the field requires division by 5 followed by subtraction of 500. Every
   elevation in both private recordings differed; the largest differences were
   about 555 m and 1,380 m. That would corrupt ascent/descent analysis.
2. **Coordinate precision is needlessly lost.** The semantic conversion performs
   integer division before multiplying by 180. Public comparisons showed errors
   up to roughly 0.000018 degrees. Both invalid GPS and timestamp sentinels also
   need handling that its semantic output does not provide.
3. **Byte order leaks between local message definitions.** The mixed-endian
   fixture's first point becomes `(0, 0)` instead of `(45, -90)`, with incorrect
   time and elevation. The implementation uses a mutable file-wide byte order
   instead of the definition associated with the current message.
4. **Compressed timestamps fail.** The declared-timestamp fixture throws; the
   omitted-timestamp form produces a record without its reconstructed time.
5. **Incomplete structural validation.** CRC errors are correctly rejected, but
   a wrong `.FIT` signature with valid CRC and an exaggerated declared length
   are accepted. Concatenated files are merged rather than refused by our
   single-activity policy. Invalid field width and trailing-byte cases also fail
   the rejection requirement.

Using only its binary API would avoid the altitude/coordinate conversion bugs,
but would retain the structural and byte-order work. Repairing it offers little
advantage over the smaller raw reader.

### `fit-file-parser/raw`: best fit, with explicit adoption gates

It validates framing/CRC and copies selected message fields without importing the
large semantic profile. Our projection explicitly handles semicircle positions,
FIT epoch time, invalid values and enhanced-altitude precedence. Missing GPS stays
in the sequence so a future adapter can break the route instead of joining across
the gap. The selected message set includes file, session, lap, record, event and
activity messages; this prototype only projects record fields.

Two compatibility findings prevent calling it ready to ship:

- **Compressed timestamp without a declared timestamp field:** the raw reader
  rejects it as `invalid_structure`, while the full parser produces the expected
  rollover time. Garmin's published
  [protocol, Figure 10](https://developer.garmin.com/fit/articles/fit-protocol/fit_protocol.html)
  describes a separate local definition containing only data fields. The raw
  reader instead requires field 253 to be first in that definition. Retain both
  forms as regression fixtures and resolve this upstream or in a narrowly
  maintained fork before adoption; do not silently discard these activities.
- **Legacy protocol version:** the 2010 Edge 500 file declares protocol byte
  `0x00`, profile version 60. Its size and signature are consistent, and the full
  parser accepts it with CRC checking. The raw reader only accepts protocol
  majors 1 and 2. Decide whether to support this legacy version with appropriate
  fixtures or return an explicit unsupported-format result. Do not just rewrite
  the header or bypass integrity checks to make it parse.

The full parser is a useful comparison implementation and a possible larger
alternative, but its `strict` mode **accepts the deliberately malformed
three-byte `sint32` field fixture**, returning an empty-coordinate record. A
production boundary would still need field-shape validation and resource caps.
Do not fall back from a strict-reader rejection to a more permissive parser
without classifying the reason; that can undo the integrity boundary.

MIT license notices must remain with redistributed code. The raw entry's bundle
does not import the semantic profile. This reduces the amount of profile code to
review; it does not replace provenance review or settle the independent Personal
API agreement. License sources:
[fit-file-parser](https://github.com/jimmykane/fit-parser/blob/main/LICENSE),
[fit-decoder](https://github.com/ask77nl/fit-decoder/blob/main/LICENSE).

## How hard is an owned decoder?

A **route-only decoder** is feasible because we need a handful of FIT fields,
not the full fitness profile. Unknown messages and developer payloads can be
skipped using their declared sizes, but their framing still needs validation.
We must reconstruct timestamps even in skipped messages because later compressed
timestamps can depend on them. Byte order belongs to each local definition.

These are engineering estimates for one engineer familiar with this codebase,
not measured delivery times. They exclude API synchronization, inbox storage,
summit lookup and draft UX:

| Scope | Approximate work | What the estimate includes |
| --- | --- | --- |
| Narrow adapter over the raw reader | 2–4 working days, after reader fixes | Field validation/scaling, segment and session handling, caps, sanitized output, focused fixtures; upstream response time is separate |
| Independent happy-path route reader | 1–2 working days | Header/definitions, ordinary coordinate/elevation/time records and simple CRC; a prototype only |
| Independent robust route reader | 1–2 weeks | Compressed timestamps, per-definition byte order, sentinel/gap semantics, developer payload skipping, strict framing, resource budgets, corpus comparison and malformed-input tests |
| Production hardening of an owned reader | Another 1–2 weeks | Streaming/allocation profiling, cancellation/isolation on the actual extension surface, fuzz/property tests, long and multisport recordings, Chrome/Firefox integration and regression evidence |
| General FIT SDK replacement | Months plus maintenance | Broad message profiles, developer-field interpretation, component expansion, encoding and ongoing device compatibility; unnecessary for this feature |

The field projection in [projection.mjs](projection.mjs) is deliberately short.
The difficult work is guaranteeing that an apparently plausible route is correct
and that damaged or unusual files cannot freeze the extension or join unrelated
activity legs. The raw reader already supplies much of that framing work. My
preference is to own the small **activity-to-track adapter**, with a pinned MIT
reader underneath, instead of owning a complete binary-format implementation.

## What remains unproven

- Real multisport transitions, pause/start/stop events, late summaries, duplicate
  timestamps and activity/session identity. Neither a full segment adapter nor
  a production file-type gate was implemented. Do not infer these guarantees
  from record-field parity.
- Waypoints/course points, permitted activity names, GPX-versus-FIT agreement and
  downstream summit/distance/gain parity. No Garmin GPX conversion endpoint was
  assumed or used.
- Large/hostile-file allocation behavior, decoded message/point caps, fuzzing,
  timeout recovery and cancellation. The harness uses bounded workers; it does
  not prove the raw reader's memory use is bounded by its input-byte cap. It
  copies every field of retained messages, including fields we later discard.
- Actual MV3 lifecycle, extension-origin CSP/permissions, Chrome service-worker
  execution and Firefox background behavior. Dedicated browser Workers establish
  browser/ArrayBuffer compatibility, not extension integration. The processing
  owner must be chosen explicitly; do not assume a Chrome extension service worker
  can create the same dedicated Worker used by this test.
- No UI changed. Browser verification was hidden at 800 × 600, JavaScript only,
  without WebGL; it provides no native-focus, permission-prompt or UI-layout proof.
- Historical code/table provenance and Personal API distribution terms still
  need their own review. No SDK license was treated as covering the API.

## Reproduce

Use an external temporary directory; do not install these candidates into the
extension's dependency tree. Example commands from the repository root:

```sh
FIT_EVAL_DIR=$(mktemp -d /tmp/bpb-fit-evaluation-XXXXXX)
npm install --prefix "$FIT_EVAL_DIR" --ignore-scripts --no-audit --no-fund fit-file-parser@6.2.3 fit-decoder@1.0.5
node docs/plans/experiments/fit-decoders/download-corpus.mjs "$FIT_EVAL_DIR"
node docs/plans/experiments/fit-decoders/evaluate.mjs "$FIT_EVAL_DIR"
node docs/plans/experiments/fit-decoders/browser.mjs "$FIT_EVAL_DIR"
```

The browser command must use the approved execution path outside macOS Seatbelt;
its launch guard fails before launching inside that sandbox. It uses the existing
Playwright browser installations, closes its browsers/server, and removes its
temporary certificate. Inspect remaining processes/profiles after a run.

`private-probe.mjs "$FIT_EVAL_DIR"` is an **optional manual live request**, requiring
the account owner's authorization. It reads the key from stdin with terminal
echo disabled, requests one newest and one oldest activity, and prints aggregate
results only. Do not put the key in a command argument, source file or checked-in
fixture. Close the process when done. No private recordings are needed to rerun
the public evaluation.

Public binaries are downloaded only temporarily from a pinned corpus commit.
No redistribution license was established for that corpus, so its FIT files are
not vendored here. After collecting aggregate results, remove the disposable
directory you created, including packages and downloaded recordings.
