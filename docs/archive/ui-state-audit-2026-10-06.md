# UI state audit remediation — 2026-10-06

Baseline: `ced896c`, version 3.8.0. Follow-up to the 2026-10-05 findings-only
audit. Repair each independent defect in a focused commit, preserve privacy
and manual Save boundaries, and retain evidence gaps separately from fixes.

Local remediation completed on 2026-10-06: all seven reproduced defects have
regression and hidden-browser evidence. The optional editor-bundle migration
remains intentionally deferred, and native/live-service proof gaps remain below.
Current behavior is maintained in [architecture](../architecture.md),
[trip-report editor](../trip-report-editor.md), and
[photo topo editor](../photo-topo-editor.md).

## Finding dispositions

| ID | Priority | Required outcome | Status |
| --- | --- | --- | --- |
| F1 | P1 | Stale report-draft cleanup preserves newer same-key saves | Fixed locally |
| F2 | P1 | Photo project switches settle outgoing autosave before replacement | Fixed locally |
| F3 | P2 | Photo replacement ends old route/drawing/drag sessions | Fixed locally |
| F4 | P2 | Obsolete capture replies cannot repaint cancelled/replaced UI | Fixed locally |
| F5 | P2 | Favorite Climbers follows authoritative settings changes | Fixed locally |
| F6 | P2 | Favorite and report-draft list updates retain meaningful keyboard focus | Fixed locally |
| F7 | P2 | Report controls fit naturally narrow native forms | Fixed locally |
| B1 | P3 | Assess a safe boundary for the always-loaded enhanced editor bundle | Assessed; split deferred |

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
  Final review also found that a failed-Save metadata rewrite renewed the
  generation without renewing its recovery offer. That rewrite now compares
  its read snapshot and the offer uses the returned generation, so Delete works
  without consuming another tab's newer record. Both new regressions failed
  before repair; 47 worker/editor tests and scoped ESLint passed afterward.
  A targeted hidden Chrome check at 390×900 deleted the detached recovery copy
  while preserving native text; its screenshot was inspected, and the complete
  Chrome extension verifier passed again after the worker change.
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
- F6: a shared options helper preserves logical row/action focus through
  replacement and sorting, uses nearby controls or a meaningful empty/search
  fallback for disappearing rows, and ignores focus outside the list. Draft
  delete/restore completion no longer redirects focus from unrelated controls.
  Five regressions cover removal/Undo, reordering, expiry/disappearance, empty
  lists, and unrelated fields. 79 focused options tests, scoped ESLint, and diff
  checks passed. Hidden Chrome retained Favorite Undo at 390×900 and draft Copy
  after another tab's autosave at 1000×900; dark screenshots were inspected.
- F7: the extension-owned editor is bounded by the viewport as well as its
  native form. Container queries now see the natural narrow surface; the browser
  verifier no longer injects a width that masked the defect, and checks the
  editor and mode buttons against the viewport. The full hidden Chrome verifier,
  scoped ESLint, build, and diff checks passed. Targeted screenshots and geometry
  checks covered Rich, Markdown, and Plain at 390×900 and 1000×900 in both themes,
  including draft recovery and lossy-conversion warnings. Narrow controls fit
  within a 358px editor without overflow. The native page/textarea can still be
  wider than the window; this fix deliberately scopes layout to extension UI.
- Verification fixture: local-photo message delegates no longer re-enter their
  captured routed dispatcher for unhandled messages. A new invalidation-route
  regression failed with a stack overflow before repair; all nine local-photo
  tests passed afterward without that error. This is a test-harness correction,
  not an additional runtime defect.

### Intentionally not changed

- B1: the final in-memory minified ascent-editor build measures 1,199,197 bytes,
  before the separate Markdown vendor script. CodeMirror/ProseMirror/TipTap,
  Lezer parsers, and the offline timezone raster dominate the dependency cost.
  The measurement establishes loaded code, not startup or interaction latency.
  `report-editor.js` installs native local-photo upload/Save protection before
  the editor feature gate; it also owns synchronous postback flushing and
  failed-Save recovery. Removing or delaying the whole manifest entry would
  delay required native behavior. A safe lazy split needs a separate small
  always-running controller, dependency-load failure behavior, and early-Save
  proofs in both browser execution environments. That architectural migration
  is deferred; this audit does not claim bundle-size reduction.
- Shared validation, browser execution worlds, raw-provider privacy, offline
  timezone data, and final user-owned Peakbagger Save remain required boundaries.
- Large file size alone does not justify a controller or worker rewrite.

### Changed but not fully proven

- Local unit and hidden-browser evidence does not establish native window/focus
  behavior, screen-reader speech, live provider exports, or actual Peakbagger Save.
- Remote CI, browser stores, and release behavior require separate evidence;
  no push, release, store submission, or merge is part of this request.

## Focused local commits

| Commit | Completed unit |
| --- | --- |
| `07e44c0` | F1 snapshot-safe removal |
| `f4d28ff` | F2 outgoing autosave preservation |
| `cf8b378` | F3 outgoing gesture settlement |
| `b15be0a` | F4 capture operation revisions |
| `73949b1` | F5 authoritative favorite settings |
| `cf2c79d` | F6 logical list focus |
| `6608f12` | F7 natural narrow form sizing and browser regression |
| `33ac723` | F1 failed-Save metadata/recovery generation follow-up |
| `d2caf8e` | Local-photo verification fixture dispatch repair |

## Verification environment

- Final `npm test`: 2,280 passed, 0 failed/skipped; 31 regressions added over
  the 2,249-test audit baseline. The fixture stack-overflow output is resolved.
- Final `npm run lint`: ESLint/build passed; web-ext lint passed with the six
  existing owned warnings for the cross-browser manifest and upstream libraries.
- Final `npm run verify:chrome`: passed after the last worker change, hidden
  Chrome for Testing 153.0.8010.12 in new headless, real unpacked `dist/`,
  isolated disposable profile, masked HTTPS Peakbagger fixtures, base viewport
  1000×760 plus responsive cases including the natural 390×760 report check.
- Final `npm run verify:firefox`: passed after the last worker change, hidden
  Firefox 157.0, isolated derived-extension profile, base 1000×760 plus its
  responsive and 200%-text editor cases. This verifier covers real manifest,
  worker, storage, form/editor, and trusted-action behavior; the targeted new
  race probes and natural 390px screenshot matrix ran in Chrome only.
- Targeted Chrome screenshots inspected: photo switches/routes at 1280×900;
  popup cancellation at 400×650; Favorite Climbers settings at 1024×900 and
  list focus at 390×900; draft focus at 1000×900; report Rich/Markdown/Plain,
  draft recovery, and conversion at 390×900 and 1000×900 in both themes;
  detached pending-Save recovery deletion at 390×900.
- These UI/extension checks do not claim a hardware WebGL renderer result,
  native window/focus behavior, browser chrome, prompts, or screen-reader speech.
- Final process inspection found no matching owned verifier/browser process;
  all matching disposable profile roots were absent. Targeted helpers closed
  their contexts and HTTPS servers in `finally`. Evidence logs/screenshots are
  intentionally retained as Codex task artifacts; the user's browsers were
  never used or closed.
- Documentation links and diff checks passed. Commits are local; no remote CI,
  release, or store proof is claimed.

## Bloat follow-up

At `b4147fd`, replacing Markdown's full HTML authoring initializer with upstream
GFM, key bindings, and URL paste reduced the minified ascent-editor bundle from
1,199,197 to 1,012,146 bytes: 187,051 bytes (15.6%) removed. HTML/CSS/JavaScript
authoring parsers no longer contribute to that bundle. All 165 report tests,
scoped lint, documentation checks, and full hidden Chrome 153/Firefox 157 checks
passed; rendered Chrome Markdown and narrow controls were inspected. Raw HTML
block tags no longer auto-close; supported report conversion remains unchanged.
Lazy loading the remaining Rich/Markdown libraries is still deferred; no
startup-latency improvement is inferred from the byte reduction.

Draft mutations now share one snapshot validator and no longer use a redundant
removal wrapper: nine source lines and 442 minified worker bytes removed.
Final verification passed 2,282 tests, full lint with six existing owned
warnings, and hidden Chrome 153/Firefox 157 checks at the verifier viewports.
All 16 malformed snapshot probes preserved the draft. These two changes remove
six net production source lines and 187,493 shipped bytes; tests and the concise
verification record remain. Native/live-service proof limits above still apply.
