# Server repository boundary

The independent local server repository is `~/Dev/map-server`.
It has its own Git history, dependency lockfile, setup instructions and tests.
No GitHub repository or remote was created by this extraction.

The server repository owns FCC downloads, conversion and compaction, national
assembly, catalogs, data audits, browser verification tooling and future hosting
infrastructure. This extension repository owns overlay UI, preferences,
attribution, loading/failure states and integration with native and terrain maps.
The proposed connection is a versioned data catalog; cloud serving and quota
controls still require implementation and verification.

## Extraction and completed ownership transfer

Six FCC-directory commits through extension commit `58b557e0` were extracted
with `git subtree split`. Authors and original changes are preserved. Extracted
commit IDs differ because the directory becomes the repository root; the later privacy rewrite
also redacts host identifiers from messages and content. The server's
extraction record maps each original commit to its extracted counterpart.

The follow-up transfer ports the final compaction policy, service template,
installer and deployment evidence from extension commit `e6d750e5`. Server
commit `82dac32` records hashes for all 61 source-directory files and the full
research report, preserving standalone browser-harness adaptations. The
extension's duplicate scripts, tests, images and receipts have been retired;
the [FCC directory](plans/experiments/fcc-browser-coverage/README.md) retains a
pointer and the [coverage plan](plans/cell-coverage-cloudflare-hosting.md) keeps
client integration requirements.

In the server checkout, `full-conversion/README.md` is the runbook,
`~/Dev/map-server/docs/research.md` contains the complete hosting investigation, and
`comparison/README.md` contains the rendered comparison. The provenance record
is `~/Dev/map-server/docs/ownership-transfer.json`. Unqualified paths are server-relative. The two
repositories are not automatically synchronized; new backend work belongs in
the server repository, with no executable copy maintained here.

## Running jobs and data

The extraction did not modify or restart the VPS services. Their deployed code
remains under `~/Dev/fcc-tiles/code`, with data under `/mnt/fcc-tiles`. A checkout
move is separate from deploying a new revision to a running service.

Credentials, raw source archives, generated PMTiles and build caches stay outside
Git. Retained JSON receipts and small comparison fixtures are research evidence,
not a copy of the national dataset. No Cloudflare deployment, DNS change or new
paid resource was part of creating the local server repository.

## Redacted history

Private host identifiers were removed from the local histories of both
repositories. Current provenance records use rewritten commit IDs; the mapping
for earlier references is in
`~/Dev/map-server/docs/history-redaction.json`. Tracked host names
are documentation placeholders. Live SSH configuration and VPS services remain
unchanged, and no GitHub refs were rewritten.
