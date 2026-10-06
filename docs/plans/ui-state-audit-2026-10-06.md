# UI state audit remediation — 2026-10-06

Baseline: `ced896c`, version 3.8.0. Follow-up to the 2026-10-05 findings-only
audit. Repair each independent defect in a focused commit, preserve privacy
and manual Save boundaries, and retain evidence gaps separately from fixes.

## Findings and remaining work

| ID | Priority | Required outcome | Status |
| --- | --- | --- | --- |
| F1 | P1 | Stale report-draft cleanup preserves newer same-key saves | Fixed locally |
| F2 | P1 | Photo project switches settle outgoing autosave before replacement | Fixed locally |
| F3 | P2 | Photo replacement ends old route/drawing/drag sessions | Fixed locally |
| F4 | P2 | Obsolete capture replies cannot repaint cancelled/replaced UI | Fixed locally |
| F5 | P2 | Favorite Climbers follows authoritative settings changes | Fixed locally |
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
- F2: file selection and Edit as new version freeze mutations, await in-flight
  writes, and flush the outgoing dirty draft before reading/replacing projects.
  Failed saves keep the outgoing editor available; new versions read the fresh
  saved title/caption/project. Five regressions cover both switch destinations,
  failure retention, and edits newer than an in-flight snapshot. 104 focused
  photo tests, scoped ESLint, and diff checks passed. Hidden Chrome at 1280×900
  preserved both the edited original and its revision in IndexedDB; the rendered
  editor screenshot was inspected.
- F3: the two photo replacement entry points settle gestures before locking
  mutations and flushing the outgoing draft. Two-point routes and moved objects
  remain saved on the outgoing photo; single-point/freehand/resize previews end
  without crossing the project boundary. Six new regressions cover file/library
  replacement and late pointer events. 110 focused photo tests passed; the final
  pointer-capture guard also passed the six transition regressions after rebuild.
  Scoped ESLint/diff checks passed. Hidden Chrome at 1280×900 kept the new portrait
  project at 600×800 after Escape, with no route preview or false save conflict;
  its rendered screenshot was inspected.
- F4: popup operations invalidate pending status/start replies and deferred
  units-result painting. Poll scheduling and success/error handlers check their
  operation revision; cancel failure with a worker job resumes status checks.
  Four regressions cover obsolete progress/failure after cancellation and late
  start results after Clear/Open. 40 popup tests, scoped ESLint, and diff checks
  passed. Hidden Chrome at 400×650 retained the cancellation card and Start again
  after delayed replies, without a spinner; its screenshot was inspected.
- F5: Favorite Climbers subscribes through shared settings and guards initial
  reads/write replies against newer events. Failure rollback uses the latest
  confirmed preferences and does not emit an unhandled fire-and-forget rejection.
  Four regressions cover external updates in both directions, delayed startup,
  rollback, and obsolete write replies. 66 focused favorites/options UI tests,
  scoped ESLint, and diff checks passed. Two hidden Chrome extension tabs at
  1024×900 stayed synchronized; the dark rendered panel was inspected.

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
