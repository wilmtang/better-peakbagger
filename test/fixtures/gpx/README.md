# GPX regression fixtures

`capitol-2021-segment-order.gpx.gz.b64` is a frozen, sanitized copy of the
public Capitol Peak track from Peakbagger ascent `1716791`. It retains all
2,911 recorded trackpoints and the four original segment containers because
their source order (`0, 1, 2, 3`) differs from their safe chronological order
(`0, 2, 3, 1`).

Metadata, author identity, waypoints, and track names were removed. The GPX is
gzip-compressed and base64-encoded to keep the repository fixture compact and
text-reviewable. Tests load it through `test/helpers/gpx-fixtures.mjs`.

`test/helpers/fixture-privacy-manifest.mjs` registers the encoded format and
decoder used by the release-gate privacy test. That test scans the decoded XML
for known private identifiers and rejects creator/author metadata, track names,
waypoints, and other identity-bearing GPX elements. A new fixture extension
must be registered there rather than silently bypassing the scan.
