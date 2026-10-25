# Server repository boundary

The independent local server repository is `~/Dev/better-peakbagger-server`.
It has its own Git history, dependency lockfile, setup instructions and tests.
No GitHub repository or remote was created by this extraction.

The server repository owns FCC downloads, conversion and compaction, national
assembly, catalogs, data audits, browser verification tooling and future hosting
infrastructure. This extension repository owns overlay UI, preferences,
attribution, loading/failure states and integration with native and terrain maps.
The proposed connection is a versioned data catalog; cloud serving and quota
controls still require implementation and verification.

## Extraction and completed ownership transfer

Six FCC-directory commits through extension commit `d7bae265` were extracted
with `git subtree split`. Authors and messages are preserved; extracted commit
IDs differ because the directory becomes the new repository root. The server's
extraction record maps each original commit to its extracted counterpart.

The follow-up transfer ports the final compaction policy, service template,
installer and deployment evidence from extension commit `08098e95`. Server
commit `7f53451` records hashes for all 61 source-directory files and the full
research report, preserving standalone browser-harness adaptations. The
extension's duplicate scripts, tests, images and receipts have been retired;
the [FCC directory](plans/experiments/fcc-browser-coverage/README.md) retains a
pointer and the [coverage plan](plans/cell-coverage-cloudflare-hosting.md) keeps
client integration requirements.

In the server checkout, `full-conversion/README.md` is the runbook,
`~/Dev/better-peakbagger-server/docs/research.md` contains the complete hosting investigation, and
`comparison/README.md` contains the rendered comparison. The provenance record
is `~/Dev/better-peakbagger-server/docs/ownership-transfer.json`. Unqualified paths are server-relative. The two
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
