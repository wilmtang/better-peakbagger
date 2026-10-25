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

## Extraction and retained research

Six FCC-directory commits through extension commit `d7bae265` were extracted
with `git subtree split`. Authors and messages are preserved; extracted commit
IDs differ because the directory becomes the new repository root. The server's
extraction record maps each original commit to its extracted counterpart.

The [hosting research](plans/cell-coverage-cloudflare-hosting.md) and
[rendered comparison](plans/experiments/fcc-browser-coverage/comparison/README.md)
remain available here. Existing FCC experiment paths were retained because
concurrent compaction work was still changing the shared checkout during the
extraction. The two repositories are not automatically synchronized: subsequent
changes here must be reviewed and ported before retiring the original tooling.
New server work should use the independent repository.

## Running jobs and data

The extraction did not modify or restart the VPS services. Their deployed code
remains under `~/Dev/fcc-tiles/code`, with data under `/mnt/fcc-tiles`. A checkout
move is separate from deploying a new revision to a running service.

Credentials, raw source archives, generated PMTiles and build caches stay outside
Git. Retained JSON receipts and small comparison fixtures are research evidence,
not a copy of the national dataset. No Cloudflare deployment, DNS change or new
paid resource was part of creating the local server repository.
