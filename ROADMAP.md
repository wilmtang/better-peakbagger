# Roadmap

[GitHub Issues](https://github.com/wilmtang/better-peakbagger/issues) is the
living backlog. This file records product direction that is not yet concrete
enough for an issue; shipped work belongs in [CHANGELOG.md](CHANGELOG.md).

## Candidate work

- Reconcile the GitHub ascent backup with Peakbagger's own CSV export, so a
  user can diff what the backup holds against what Peakbagger reports without
  matching rows by hand. The backup itself shipped in 3.0.0 — see
  [docs/github-ascent-backup.md](docs/github-ascent-backup.md) — and already
  covers trip reports and GPX attachments; what is missing is the shared
  identifier and the comparison.

## Not currently planned

- A parallel social graph, climber ratings, or tipping. These ideas add privacy,
  abuse, moderation, and Peakbagger-load risks without a clear user outcome.
