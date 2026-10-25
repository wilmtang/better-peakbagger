# FCC coverage tooling moved to the server repository

The executable FCC experiments, downloader, conversion pipeline, delivery
compaction, systemd templates, tests, receipts and rendered comparison now live
in the independent `~/Dev/better-peakbagger-server` checkout.

- `full-conversion/README.md`: conversion, compaction and VPS operations.
- `comparison/README.md`: the rendered FCC polygon versus H3 comparison.
- `browser-experiment.md`: the original browser feasibility experiment.
- `docs/research.md`: storage, hosting measurements and verification limits.
- `docs/ownership-transfer.json`: source commits, paths and retained-file hashes.

The [server repository boundary](../../../server-repository.md) describes
ownership. The [extension integration plan](../../cell-coverage-cloudflare-hosting.md)
records the client requirements. This directory retains this pointer only;
conversion tools are maintained in the server repository.
