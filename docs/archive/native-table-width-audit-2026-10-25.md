# Native Peakbagger table widths — 2026-10-25

Scope: extension overrides of **Peakbagger-created tables**. The user's final
scope explicitly excludes BPB-created tables. This audit follows the Selected
Trip Reports repair in `ddbd615d`; the native metadata repair is `177fe723`.

## Findings

| Finding | Source and cause | Result |
| --- | --- | --- |
| N1: Selected Trip Reports divided into equal columns | `src/favorites/report-controls.js` forced fixed layout, full width, a 38em minimum and arbitrary word breaking on the native report table. | Removed in `ddbd615d`; native content sizing and the accessible horizontal region remain. |
| N2: Native peak metadata labels consumed half each row | `src/ui/peak-card-layout.css` applied fixed layout to both native tables moved by `src/ui/peak-table-split.js`. | Fixed in `177fe723`: remove fixed layout; contain the map region's intrinsic inline size instead. |
| N3: Saved-ascent summary labels and values split evenly | `src/ascent/ascent-layout.css` used fixed layout to stop a preferred map width from expanding the summary. | Fixed in `177fe723`: contain only the full-width paragraph/div hosting the frame. The native label/value table uses automatic layout. |

The audit scanned authored runtime CSS/JavaScript in `src/`, `options/`,
`popup/` and `photos/` for table-layout overrides, column groups, cell width
assignments, percentage widths and inline dimension writes. The ascent filter
and theme do not impose additional data-column widths. No further native-table
equal-width override was found in that source scan.

## Fixed and verified

- N1 retains its prior regression proof and 16 hidden Chrome/Firefox filter
  cases. The new assertion failed on six equal 82px columns before that fix.
- N2: the new native peak-column assertion was run against historical CSS from
  `ddbd615d` in a disposable runner, without resetting the worktree. It failed
  on equal 170px label/value columns. The fixed CSS passes all 16 cases.
- N3: the new assertion failed on equal 176px summary columns before the fix.
  All 16 fixed cases pass, including map containment, divider extremes,
  cancelled divider movement and weather pending/error/retry geometry.
- Both matrices use hidden Chrome for Testing 156.0.8078.4 and Playwright
  Firefox 157.0: light/dark, 390×900 and 1280×900, plus simulated 150% zoom at
  260×600 and 853×600. The rounding tolerance is one CSS pixel.
- `npm run build`, the 34 focused peak-layout/ascent-split tests, changed-script
  ESLint and `git diff --check` passed. Desktop and narrow peak screenshots
  and ascent summary screenshots were visually inspected. Frame contents, storage and provider responses are
  fixture-owned; these are HTML/CSS checks, not WebGL renderer claims.
- The final rebuilt real unpacked-extension smoke passed in hidden Chrome
  156.0.8078.4 at 1000×760, including BFCache restoration and teardown.
  Documentation/development checks passed all 20 tests. The additional native
  ascent screenshot run passed eight Chrome cases.

## Intentionally not changed

- All BPB-created tables: snow observations, hourly weather, forecast update
  metadata, air quality, editor tables and card-placement containers. The
  exploratory snow/forecast CSS edits and their test helpers were reverted
  before delivery following the user's scope correction.
- The user's resizable outer page-column split, native width attributes,
  safe image shrinking, maps, links and final manual Save behavior remain.
- Unrelated concurrent options, custom-overlay, settings-transfer and worker
  changes are excluded from the audit commits.

## Changed but not fully proven

- Live Peakbagger pages and the user's installed extension were not reloaded.
  Native window placement/focus and actual browser zoom are not established by
  hidden fixtures and simulated zoom.
- Broader exploratory snow/weather checks stopped on existing fixture
  expectations before reaching the proposed BPB-table checks: snow expected
  the weather row as its immediate sibling despite the cloud card, and weather
  expected the location label inside the old header structure. Those separate
  checks were not repaired as part of this native-table audit.

