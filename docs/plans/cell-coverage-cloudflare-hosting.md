# FCC cell coverage: server ownership and extension integration

The FCC download, conversion, delivery-compaction and verification pipeline is
maintained in the independent **`~/Dev/better-peakbagger-server`** repository.
See the [server repository boundary](../server-repository.md).

The complete hosting investigation, measured sizes, conversion policy, proof
limits and rendered comparison moved with the tooling:

- `~/Dev/better-peakbagger-server/docs/research.md`: the full research and hosting report.
- `full-conversion/README.md`: conversion and VPS runbook.
- `full-conversion/compaction-deployment.json`: deployed-policy and benchmark evidence.
- `comparison/README.md`: Snoqualmie Pass comparison and reproduction.
- `~/Dev/better-peakbagger-server/docs/ownership-transfer.json`: source-path and checksum provenance.

Unqualified paths above are relative to the server checkout. The server currently has no
configured Git remote. Earlier versions remain in this repository's Git history;
there is one maintained executable pipeline in the server repository.

## Extension integration requirements

The extension owns overlay UI, preferences, attribution, loading/failure states
and integration with native 2D and terrain maps. A future layer should consume a
versioned server catalog with archive URLs, source dates, bounds, zooms, fields,
sizes and checksums. FCC build credentials must never enter the client or catalog.

Direct PMTiles delivery requires verified CORS and HTTP range support. Partial
builds remain marked incomplete. Outdoor coverage includes FCC environment
codes **0 and 1**; in-vehicle coverage selects **1**. Approximate overview tiles
must not be presented as exact point-coverage queries, and finer geometry does
not establish more accurate real-world reception predictions.

Public hosting, runtime integration, low-zoom performance and complete-country
size remain separate verification obligations. The repository move did not
start, stop, redeploy or restart any VPS service, move the data disk, copy
credentials, or ship an extension map layer.
