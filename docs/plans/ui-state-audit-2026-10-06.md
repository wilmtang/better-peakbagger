# UI state audit remediation — 2026-10-06

Baseline: `ced896c`, version 3.8.0. Follow-up to the 2026-10-05 findings-only
audit. Repair each independent defect in a focused commit, preserve privacy
and manual Save boundaries, and retain evidence gaps separately from fixes.

## Findings and remaining work

| ID | Priority | Required outcome | Status |
| --- | --- | --- | --- |
| F1 | P1 | Stale report-draft cleanup preserves newer same-key saves | Fixed locally |
| F2 | P1 | Photo project switches settle outgoing autosave before replacement | Open |
| F3 | P2 | Photo replacement ends old route/drawing/drag sessions | Open |
| F4 | P2 | Obsolete capture replies cannot repaint cancelled/replaced UI | Open |
| F5 | P2 | Favorite Climbers follows authoritative settings changes | Open |
| F6 | P2 | Favorite and report-draft list updates retain meaningful keyboard focus | Open |
| F7 | P2 | Report controls fit naturally narrow native forms | Open |
| B1 | P3 | Assess a safe boundary for the always-loaded enhanced editor bundle | Open |

## Closure ledger

### Fixed and verified

- F1: `REPORT_DRAFT_REMOVE` accepts optional expected generation and saved time,
  comparing inside the existing worker mutation queue. Draft-manager expiry,
  editor expiry/empty cleanup, and recovery-offer deletion supply the snapshot;
  terminal Save/Delete removals intentionally remain unconditional. Regressions
  cover stale manager/editor reads, equal-timestamp newer generations, and
  malformed expectations. 88 focused worker/options/editor tests passed,
  scoped ESLint and diff checks passed, and the full hidden Chrome verifier
  passed using the real unpacked extension and masked HTTPS fixtures.

### Intentionally not changed

- Shared validation, browser execution worlds, raw-provider privacy, offline
  timezone data, and final user-owned Peakbagger Save remain required boundaries.
- Large file size alone does not justify a controller or worker rewrite.

### Changed but not fully proven

- Local unit and hidden-browser evidence does not establish native window/focus
  behavior, screen-reader speech, live provider exports, or actual Peakbagger Save.
- Remote CI, browser stores, and release behavior require separate evidence;
  no push, release, store submission, or merge is part of this request.

## Verification environment

Initial full Chrome check: hidden Chrome for Testing 153.0.8010.12, isolated
disposable profile, real `dist/`, masked HTTPS Peakbagger fixtures, base viewport
1000×760 plus verifier responsive cases. This UI/extension check does not claim
a hardware WebGL renderer result. Final browser/viewport evidence and teardown
will be recorded as the remaining fixes land.
