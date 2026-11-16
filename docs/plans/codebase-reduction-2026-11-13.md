# Codebase size and redundancy reduction — 2026-11-13

Status: in progress. Phase 1 is done; see the closure ledger.

Baseline: clean `main` at `0ee05171`, 1,313 tracked files, about 340,000 tracked
text lines.

## Goal

Cut the repository's volume without changing shipped behavior or weakening a
privacy or correctness gate. The target is redundancy: the same setup written
per file, checks that restate source text, and records git history already
keeps. Line count is the measure, not the purpose; a phase that only moves
lines is not done.

## Method and limits

Counts come from `git ls-files` and `wc -l`, plus three throwaway scans that
were not checked in: an exact-clone detector (8 normalized lines, 200+
characters), a same-name helper count, and an export-reference scan.

- The clone detector finds literal copies only. Parameterized near-copies are
  invisible to it, so the 1% figure below is a floor.
- The export scan matches identifiers by name; a name reused elsewhere hides a
  dead export.
- Tests were counted and sampled, not read. Which source-text assertions are
  redundant is unknown until phase 3 reads each file.
- No test, build or verifier was run for this review.
- Every saving below is an estimate from these counts, corrected once; see
  the review section.

## Findings

| Area | Lines | Finding |
| --- | --- | --- |
| `test/` | 98,400 | 1.3 times the runtime. `test/project/` is 10,300 lines about tooling, workflows and docs. 36 files read source text, with about 290 regex assertions on source or prose. Local helpers recur per file: `setup` in 23 files, `harness` in 16, `tick` in 13, `waitFor` in 9. |
| `src/`, `options/`, `popup/`, `photos/` | 75,000 | Four files hold 13,400 lines: `background.ts` (4,358), `photos.ts` (4,327), `terrain-frame-runtime.ts` (2,698), `github-routes.js` (2,019). Five exports are never referenced. Comments are 8% of lines. |
| `.agents/skills/ui-ux-pro-max` | 63,300 | Vendored upstream skill data. |
| `docs/` | 55,100 | docs/archive/ is 32,800 lines in 115 files. `docs/plans/experiments`, `evidence` and `mocks` add 5,560. `architecture.md` and `development.md` are 17,600 and 14,500 words. |
| `scripts/` | 48,200 | 93 `verify-*` scripts. 65 import `browser-verification-fixtures.mjs`, yet 43 call `launchPersistentContext` themselves, 44 hand-write the host-resolver rule, 56 create their own temporary profile and 24 their own server. `verify-extension.mts` is 6,790 lines and `verify-firefox-extension.mts` 3,379. |

Exact copy-paste is about 1% of authored code (test 1,159 lines, scripts 538,
runtime 203). The largest clone pairs are `verify-terrain-lod.mts` with
`verify-terrain-visual.mts`, `verify-extension.mts` with its Firefox twin, and
`big-map-bridge.js` with `peak-map-bridge.js`.

The five unreferenced exports: `UNIT_MEASUREMENTS`
(`options/unit-settings-contract.ts`), `readFitUnsignedField`
(`src/garmin/fit-message-reader.ts` (then `.js`)), `GARMIN_KEY_PAGE`
(`src/garmin/garmin-api.ts` (then `.js`)), `validImportDate` (`src/garmin/garmin-imports.ts`)
and `relayResource` (`src/maps/custom-overlay-private.ts` (then `.js`)).

## Boundaries

- No runtime behavior change in any phase. Phase 4 moves code; it does not
  rewrite it.
- A check is removed only when a named surviving check covers the same defect.
  Record the pair in the ledger. Guards that exist because a breakage shipped
  stay: `manifest-capture`, `fixtures-privacy`, `typescript-policy`, the
  settings-schema structural scan and the HTTPS-fixture pin in `showcase`.
- The TypeScript policy applies: a legacy `.js`/`.mjs` file that is
  substantively edited is converted in the same change. Phases 2–4 will
  therefore convert files as they touch them, which adds churn but not scope.
- The vendored skill stays. Removing it trades inert data for a setup step that
  fresh clones, worktrees and cloud agents would each need. A
  `linguist-vendored` attribute is enough to keep it out of language statistics
  and diffs.

## Review of this plan — 2026-11-13

The first version of this plan was checked against the repository after it was
committed. Its phase 2 and phase 3 savings were overstated by roughly ten times
and several steps were wrong. The phases below are the corrected version.

- scripts/prototypes/ has no tracked files. The 11,100-line figure for
  experiments, evidence, mocks and prototypes counted PNG bytes as lines; the
  text is 5,560 lines.
- `docs/plans/experiments/` is read by `test/garmin/fit-activity.test.mjs` and
  `test/garmin/zip-csp.test.mjs`. `docs/plans/evidence/` is referenced by
  `src/weather/summit-cloud-models.ts`, `test/weather/summit-cloud.test.mts` and
  the TypeScript policy. Neither can simply be deleted.
- 77 links in 20 maintained documents point into docs/archive/, not the four
  files first listed.
- 49 verify scripts already use `resource-stack.mjs`. What each still repeats
  is 10–15 lines of profile, launch and deferral, so a shared launcher saves
  about 600 lines, not 12,000.
- `verify-extension.mts` drives Chrome through Playwright and
  `verify-firefox-extension.mts` drives Firefox through Selenium WebDriver.
  Merging them is a rewrite of 10,000 lines of proven checks, not a
  deduplication. Dropped.
- The repeated test `setup` helpers are 5–19 lines each and file-specific.
  Sharing them saves a few hundred lines at most.
- Every `verify-*` script is reachable from `scripts/verify.mts`, a workflow or
  another script. There are no orphan verifiers.
- `scripts/build-config.mts` lists every source file of the worker bundle, and
  `test/project/manifest-capture.test.mts` pins that list. Splitting
  `background.ts` changes both; three tests also read its source text.
- The five unreferenced exports were re-confirmed: one occurrence each.

The conclusion that follows: the mechanically removable redundancy is about
34,000 lines of documents and 1,000–2,000 lines of code. The remaining volume
is verification and features. Shrinking it further means deleting coverage or
functionality, which is an owner decision and not a cleanup.

## Phases

Each phase is independent and lands as focused commits. Estimates are net
tracked lines.

### Phase 1 — Remove records git already keeps (about −34,000)

1. Record the last commit on `main` that contains docs/archive/ (the
   "archive commit"), then delete the directory (32,800 lines, 115 files). No
   tag is created: `v*` tags drive the release workflows, and a commit on
   `main` is already a permanent address.
2. Delete docs/plans/mocks/ (1,280 lines and 32 images); nothing references
   it. Keep `experiments/` and `evidence/`.
3. Point every one of the 77 archive links in 20 maintained documents at its
   GitHub permalink,
   `https://github.com/wilmtang/better-peakbagger/blob/<archive commit>/docs/archive/<file>`,
   keeping any `#fragment`. No link is dropped. `docs/plans/README.md` keeps
   one line per archived record with its permalink and loses the summary
   paragraphs; it also names the archive commit so the whole directory can be
   browsed at
   `https://github.com/wilmtang/better-peakbagger/tree/<archive commit>/docs/archive`.
4. Update `test/project/documentation.test.mts` (then `.mjs`) and the archive comment in
   `scripts/verify-terrain-lod.mts`.
5. Reword the archiving rule in `AGENTS.md` and `docs/plans/README.md`: a
   completed plan is removed from the tree and its index line points at the
   permalink of its final version, ledger intact.
6. Mark `.agents/skills/ui-ux-pro-max` as `linguist-vendored`.

Checks: `node --test "test/project/*.test.m[jt]s"`, `npm run lint`, and a
scripted check that all 77 permalinks name a path that exists at the archive
commit (`git cat-file -e <archive commit>:<path>`). The permalinks resolve on
GitHub only once that commit is pushed; the documentation test checks relative
links and will not see them.

### Phase 2 — Shared verifier launch (about −700)

1. Add one launcher to `browser-verification-fixtures.mjs` that owns the
   temporary profile, the launch guard, the extension and host-resolver flags
   and the deferred teardown.
2. Migrate the 43 self-launching scripts in small batches by surface.
3. Extract the shared part of `verify-terrain-lod.mts` and
   `verify-terrain-visual.mts`.

Checks: each migrated verifier run alone, in every browser it covers, with the
same case count before and after. State hidden or visible, renderer and
viewport per the verification rules.

The saving is small against the cost of re-running 43 verifiers. Do this only
if a single launch definition is wanted for its own sake.

### Phase 3 — Test and verifier coverage review (no estimate)

This is a coverage decision, not a cleanup, and has no estimate until the
files are read.

1. Read `test/project/` (10,300 lines). For each file record the breakage it
   guards. Propose removals to the owner; delete nothing unprompted.
2. Read the 36 source-text test files. Propose removing an assertion only when
   a named behavior test covers the same defect.
3. Propose table-driven rewrites only where cases differ in data alone.

Checks: `npm test` with the executed-test count recorded before and after each
commit; the count may fall only by the cases the ledger names.

### Phase 4 — Runtime structure (about −100, less sprawl)

1. Remove the five unreferenced exports.
2. Split `background.ts` along the existing `*-routes` pattern, one route family
   per commit. Each commit updates the `background.js` source list in
   `scripts/build-config.mts`, the pin in `manifest-capture.test.mts` and the
   three tests that read the worker's source.
3. Share the common core of `big-map-bridge.js` and `peak-map-bridge.js`.

Comment trimming is dropped: it is a judgement call per comment and the
repository forbids unrelated refactors.

Checks: `npm test`, `npm run typecheck`, `npm run lint`, and
`npm run verify -- chrome` after every worker change.

### Phase 5 — Maintained prose

Cut incident narratives from `AGENTS.md`, `docs/architecture.md` and
`docs/development.md` down to the rule each one supports. Each cut needs the
owner's eye, because those narratives are why the rules exist.

A clone checker is dropped: exact duplication is already about 1%. `knip` is
optional and would add a tracked development dependency for five findings.

Checks: `node --test "test/project/*.test.m[jt]s"`, `npm run lint`.

## Owner decisions

1. **Archive deletion.** `AGENTS.md` requires closure ledgers to be preserved
   when a plan is archived. Decided 2026-11-13: deletion is acceptable
   provided every reference points at the git permalink of the removed file.
   Phase 1 step 3 implements that condition.
2. **How far to go.** Phases 1 and 4 are cleanup. Phase 3 is the only route to
   a materially smaller test and script tree, and it removes coverage.
3. **Whether phase 2 is worth its verification cost.**

## Closure ledger

### Fixed and verified

- Phase 1. Archive commit `9bcb42a3e0572218f7fe244eeaacf6197fab54f1`.
  docs/archive/ (116 files including its README) and docs/plans/mocks/ (33
  files) are deleted. 65 inline archive links in 17 documents now use GitHub
  permalinks with fragments kept; the other 12 hits of the original count were
  prose, code blocks, the deleted mock guide or this plan. Two backticked paths
  and the `verify-terrain-lod.mts` comment became permalinks. The plans index
  lists all 115 records by permalink. `documentation.test.mts` (converted from
  `.mjs`) no longer scans the archive. Checks: project tests 537/537, lint,
  typecheck, TypeScript policy, and every permalink path and fragment checked
  with `git cat-file -e` and the heading list at the archive commit. The links
  resolve on GitHub only once that commit is pushed. A review fix dropped
  `-diff` from `.gitattributes`, which made git treat the skill as binary.
- Phase 4 step 1. The five unreferenced exports are removed, plus the
  `FIT_UNSIGNED_SCALAR_BASE_TYPES` table only the removed reader used. The
  three edited legacy modules (`fit-message-reader`, `garmin-api`,
  `custom-overlay-private`) are converted to TypeScript under the policy; the
  worker source list and its pin in `manifest-capture.test.mts` name the new
  files. Checks: `npm test` (4,193 pass), typecheck, lint, TypeScript policy.

### Intentionally not changed

- `.agents/skills/ui-ux-pro-max` stays vendored; see Boundaries.

### Changed but not fully proven

Nothing yet.

### Not started

Phases 2, 3 and 5; phase 4 steps 2 and 3.
