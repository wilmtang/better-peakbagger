# Peak column regression audit — 2026-10-22

Scope: missing Gaia GPS, AllTrails and onX Backcountry links on Mount Thomson
(`pid=2096`), the peak-column layout that caused the regression, and neighboring
features that consume those native tables. This is a focused layout integration
audit, not a claim that every extension feature has been re-audited.

## Findings and why the tests missed them

1. **P1: column initialization suppressed the BPB map links.**
   `src/ui/peak-table-split.js` (lines 14–22) moves the two native tables into
   separate column wrappers. `src/maps/peak-links.js` required the map table and
   coordinate table to share an immediate parent. When the column owner ran
   first, that requirement failed and the link feature silently skipped its
   additions. The general planning links remained present. The existing live
   Chrome tab confirmed the separate parents and missing map-link group.
2. **P2: isolated feature tests omitted the interaction.**
   `test/maps/peak-links.test.mjs` loaded only the link bundle. The card-layout
   tests constructed card controls without requiring the BPB map-link group.
   Each feature could pass while their combined startup behavior was broken.
3. **P2: broad browser smoke coverage could not observe the missing feature.**
   The simplified peak fixture in `scripts/browser-verification-fixtures.mjs`
   lacked the native Web Map Links row and native table class/alignment. Both
   smoke verifiers required the general planning links but never required the
   separate BPB map links. The card interaction matrix loaded a faithful page
   but likewise did not assert that group.

The missing safeguard was an assertion about the combined user-visible result,
not an absence of a test runner. Passing the former checks did not establish
that all peak-page features survived the layout change.

## Fixed and verified

- The link injector recognizes either the original shared parent or the exact
  details/map wrappers inside the owning BPB split. Coordinate validation,
  native section identity, duplicate-row rejection and idempotence remain.
- Three integration tests cover both bundle startup orders on the Rainier and
  Garibaldi fixtures, mapless pages, unrelated tables, ambiguous rows and an
  unrelated wrapper. They also compare weather summit metadata, nation values,
  selected-report records and native frame identity before/after the split.
- The startup-order assertion was run before the fix and failed because
  `bpb-peak-map-links` was absent after the real column bundle initialized.
  It then passed with the fix. No working-tree reset was used for this proof.
- A shared browser probe requires one correctly placed BPB group, all three
  labels, safe anchor attributes, summit-specific URL coordinates/bounds and
  preservation of native CalTopo. Both generic extension smoke verifiers and
  the card matrix use it. The generic fixture now includes its native row.
- The card matrix checks link wrapping and keyboard focus without changing the
  group, cell, link or scroll geometry. Screenshots were visually inspected at
  desktop/narrow widths and 200% zoom. Transient card pending/error/retry,
  resize, movement, navigation and saved-state checks also passed.

Commands actually run:

| Check | Result |
| --- | --- |
| `npm run build` followed by the links/cards/map/weather/snow test files | 154 passed |
| `node --test test/maps/peak-links.test.mjs` after extending neighboring-reader assertions | 15 passed |
| `node --test 'test/**/*.test.mjs'` | 3,296 passed, zero failures |
| Focused project fixture, inventory, documentation and placement checks | 21 passed |
| ESLint on every changed JavaScript module/test | Passed |
| `node scripts/check-web-ext-lint.mjs` | Passed with the eight existing owner-reviewed warnings |
| `node scripts/verify-extension.mjs` | Hidden Chrome for Testing 156.0.8078.4 passed, base viewport 1000×760, BFCache and teardown passed |
| `node scripts/verify-firefox-extension.mjs` | Hidden Firefox 158.0.1 passed, base viewport 1000×760, BFCache and teardown passed |
| `node scripts/verify-ascent-weather.mjs --cards` and the same command with `--firefox` | Both passed at 1440×1100 and 375×1100, light/dark, plus 200% browser zoom; teardown passed |
| `git diff --check` | Passed |

The first full Node run passed 3,295/3,296: the inventory guard correctly rejected
the newly added, unregistered verifier helper. Registering it in
`scripts/README.md` resolved that failure; the complete run then passed.
The first expanded Chrome smoke failed because the old fixture omitted the
native row. The faithful fixture and complete smoke checks subsequently passed.
These failures were corrected at their causes rather than retried unchanged.

The inspected render uses native HTML/CSS and the fixture's 2D map, not a 3D
WebGL rendering claim. Evidence is retained under
`/tmp/bpb-peak-links-evidence/` as the Chrome/Firefox `*-map-links.png` images.
Task-owned process-command inspection found no remaining verification browsers;
the four exact card-matrix profile directories were removed by teardown.

## Intentionally not changed

- A source scan of native-table/sibling assumptions covered peak weather,
  nearby snow, avalanche nation parsing, general link ordering, peak-map/frame
  ownership, selected-report detection and theme selectors. No additional
  peak-column runtime regression was reproduced. Weather/snow anchor through
  the native frame's table; mapless pages do not mount the column split.
- The separate ascent summary/map width mismatch is being repaired and verified
  in the coordinated chat “Find blank card placeholders.” Its runtime files
  and evidence belong to that independent work, not this map-link repair.
- Native links, external destination formats, permissions, privacy settings,
  country gating, provider requests and final manual Save remain unchanged.
- Concurrent SNOTEL/map-overlay work is preserved and excluded from this unit.

## Changed but not fully proven

- The original live page was inspected read-only. The repaired extension was
  verified with masked HTTPS Peakbagger fixtures; the user's installed
  extension was not reloaded or modified. A live page reload after updating the
  local extension remains the user's normal installation step.
- Forecasts, station observations and native map responses in the card matrix
  are fixture data. These checks do not prove authenticated Gaia/AllTrails/onX
  destination rendering, live provider compatibility, store publication,
  screen-reader speech, physical touch or native window/focus behavior.
- No push, release or store submission was performed.
