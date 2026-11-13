# Codebase size and redundancy reduction — 2026-11-13

Status: plan only. Nothing has been removed or changed by this review.

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
- Every saving below is an estimate from these counts.

## Findings

| Area | Lines | Finding |
| --- | --- | --- |
| `test/` | 98,400 | 1.3 times the runtime. `test/project/` is 10,300 lines about tooling, workflows and docs. 36 files read source text, with about 290 regex assertions on source or prose. Local helpers recur per file: `setup` in 23 files, `harness` in 16, `tick` in 13, `waitFor` in 9. |
| `src/`, `options/`, `popup/`, `photos/` | 75,000 | Four files hold 13,400 lines: `background.ts` (4,358), `photos.ts` (4,327), `terrain-frame-runtime.ts` (2,698), `github-routes.js` (2,019). Five exports are never referenced. Comments are 8% of lines. |
| `.agents/skills/ui-ux-pro-max` | 63,300 | Vendored upstream skill data. |
| `docs/` | 55,100 | `docs/archive/` is 32,800 lines in 115 files. `docs/plans/experiments`, `evidence` and `mocks` with `scripts/prototypes` add 11,100. `architecture.md` and `development.md` are 17,600 and 14,500 words. |
| `scripts/` | 48,200 | 93 `verify-*` scripts. 65 import `browser-verification-fixtures.mjs`, yet 43 call `launchPersistentContext` themselves, 44 hand-write the host-resolver rule, 56 create their own temporary profile and 24 their own server. `verify-extension.mts` is 6,790 lines and `verify-firefox-extension.mts` 3,379. |

Exact copy-paste is about 1% of authored code (test 1,159 lines, scripts 538,
runtime 203). The largest clone pairs are `verify-terrain-lod.mts` with
`verify-terrain-visual.mts`, `verify-extension.mts` with its Firefox twin, and
`big-map-bridge.js` with `peak-map-bridge.js`.

The five unreferenced exports: `UNIT_MEASUREMENTS`
(`options/unit-settings-contract.ts`), `readFitUnsignedField`
(`src/garmin/fit-message-reader.js`), `GARMIN_KEY_PAGE`
(`src/garmin/garmin-api.js`), `validImportDate` (`src/garmin/garmin-imports.ts`)
and `relayResource` (`src/maps/custom-overlay-private.js`).

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

## Phases

Each phase is independent and lands as focused commits. Estimates are net
tracked lines.

### Phase 1 — Remove records git already keeps (about −44,000)

1. Tag the last commit that contains `docs/archive/`, then delete the directory.
2. Delete `docs/plans/experiments/`, `docs/plans/evidence/`, `docs/plans/mocks/`
   and `scripts/prototypes/` after confirming nothing maintained reads them.
3. Repair what pointed there: `docs/plans/README.md` (most of its body is
   archive summaries), `follow-ups.md`, `test/project/documentation.test.mjs`
   and the archive reference in `scripts/verify-terrain-lod.mts`.
4. Reword the archiving rule in `AGENTS.md` and `docs/plans/README.md` to match
   the decision below.
5. Mark `.agents/skills/ui-ux-pro-max` as `linguist-vendored`.

Checks: `node --test "test/project/*.test.m[jt]s"`, `npm run lint`.

### Phase 2 — One browser verification harness (about −12,000)

1. Add one helper that owns the temporary profile, fixture certificate, HTTPS
   fixture server, launch flags, the Chrome launch guard and teardown. It
   extends `browser-verification-fixtures.mjs` and `resource-stack.mjs` rather
   than adding a third layer.
2. Migrate the 43 self-launching scripts in small batches by surface.
3. Express `verify-extension.mts` and `verify-firefox-extension.mts` as one case
   table with a Chrome driver and a Firefox driver.
4. Extract the shared part of `verify-terrain-lod.mts` and
   `verify-terrain-visual.mts`.

Checks: each migrated verifier run alone, in every browser it covers, with the
same case count before and after; `npm run verify -- browsers` after step 3.
State hidden or visible, renderer and viewport per the verification rules.

### Phase 3 — Prune and share test code (about −15,000)

1. Read each of the 36 source-text test files. Delete an assertion only when a
   behavior test covers it; convert what is really a lint rule into one.
2. Reduce `test/project/` to guards with a recorded breakage or a release
   consequence. List each removed file with its reason.
3. Move the repeated `setup`, `harness`, `tick` and `waitFor` into
   `test/helpers/`.
4. Make the largest files table-driven where cases differ only in data:
   `background-capture`, `photo-editor`, `terrain-map`,
   `github-backup-integration`.

Checks: `npm test` with the executed-test count recorded before and after each
commit; the count may fall only by the cases the ledger names.

### Phase 4 — Runtime structure (few lines, less sprawl)

1. Remove the five unreferenced exports after confirming each by search.
2. Split `background.ts` along the existing `*-routes` pattern, one route family
   per commit, with the bundle composition unchanged in
   `scripts/build-config.mts`.
3. Share the common core of `big-map-bridge.js` and `peak-map-bridge.js`.
4. Trim comments that narrate history; keep those that state a constraint.

Checks: `npm test`, `npm run typecheck`, `npm run lint`, and
`npm run verify -- chrome` after any worker or content-script change.

### Phase 5 — Maintained prose and regrowth guards

1. Cut incident narratives from `AGENTS.md`, `docs/architecture.md` and
   `docs/development.md` down to the rule each one supports.
2. Add `knip` (unused files and exports) and `jscpd` (clones) to `npm run lint`
   with thresholds set at the post-reduction level.

Checks: `node --test "test/project/*.test.m[jt]s"`, `npm run lint`.

## Owner decisions

1. **Archive deletion.** `AGENTS.md` requires closure ledgers to be preserved
   when a plan is archived. Phase 1 assumes "preserved in git history under a
   tag" satisfies that. If it does not, phase 1 shrinks to step 2 and step 5
   (about −11,000).
2. **Order.** Recommended: 1, 2, 3, 4, 5. Phase 1 is the largest cut and touches
   no code; phase 2 removes the setup that makes every later verifier change
   expensive.

## Closure ledger

### Fixed and verified

Nothing yet.

### Intentionally not changed

- `.agents/skills/ui-ux-pro-max` stays vendored; see Boundaries.

### Changed but not fully proven

Nothing yet.

### Not started

Phases 1–5.
