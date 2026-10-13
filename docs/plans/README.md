# Active plans


- [Avalanche forecast links and regional layer](avalanche-forecast-links-and-layer.md)
  — proposed; worldwide issuing-service links first, then opt-in regional
  overlays with verified provider contracts, coverage, and expiry handling.
- [CI, UX, and maintainability audit](ci-ux-maintainability-audit-2026-10-03.md) —
  in progress; release recovery, verifier timing, focused UI simplification,
  and removal of duplicated runtime code, with an explicit closure ledger.
- [Imgur uploads and media-host selection](imgur-media-hosting.md) — proposed;
  host dropdown, user-owned Imgur Client IDs with guided account connection,
  and a dedicated MP4 upload path.

Once a plan is implemented or abandoned, move it to [archive/](../archive/) and
update the maintained architecture or focused design note with the resulting
runtime behavior. Plans are decision and execution records, never the source of
truth for shipped code.

The [climber hover card](../archive/climber-hover-card.md) is complete locally:
direct Buddy, Favorite and Ignore actions are implemented, and direct Buddy POST
coverage now passes in hidden Chrome and Firefox. The archive retains the live
Buddy mutation and native accessibility release checks; those proof limits no
longer keep a completed implementation in the active-plan list.

The [October 12 repository audit](../archive/codebase-audit-2026-10-12.md)
is closed locally: eight new findings, preparation cancellation, and the two
carried [October 10 UI findings](../archive/new-features-ui-audit-2026-10-10.md)
are implemented in focused commits. The closure ledger records 2,708 passing
tests, 14 scale checks, real Chrome/Firefox and Metal rendering evidence, and
retained upstream advisory/native/live verification gaps.

The [peak weather location audit](../archive/peak-weather-location-audit-2026-10-12.md)
is closed locally: twelve reproduced state, focus, map lifecycle, keyboard and
fixture findings are corrected in seven focused commits. Its ledger records
2,666 passing tests, Chrome/Firefox and Metal evidence, retained boundaries and
manual proof limits.

The [peak-page presentation follow-up](../archive/peak-page-presentation-2026-10-12.md)
corrects the map/legend/weather order, weather actions and source coordinates,
Settings presentation, and BPB map links. It records the earlier fixture and
assertion gaps, 2,712 passing tests, rendered Chrome/Firefox evidence, and an
earlier Chrome helper-adoption smoke failure. The final Chrome and Firefox
checks in the layout-stability audit below both pass.

The [repository layout-stability audit](../archive/repository-layout-stability-2026-10-12.md)
is closed locally: thirteen confirmed finding groups have focused fixes and a
new CI transition-geometry gate. Its ledger records 2,720 passing runtime tests,
96 hidden Chrome/Firefox matrix cases, real-manifest verification, deliberate
layout changes and remaining live/native proof limits.

The [weather feature audit](../archive/weather-feature-audit-2026-10-11.md)
has eight implemented fixes and local browser/regression evidence. Its closure
ledger retains screen-reader/live-provider proof gaps and two pre-existing
README test failures.

The [code-removal audit](../archive/code-removal-audit-2026-10-09.md) is closed
locally with its removal evidence, retained boundaries, and verification limits.
The [historical ascent-weather implementation](../archive/ascent-historical-weather.md)
is complete locally, with its browser/model evidence and remaining live-site and
accessibility proof gaps retained. [Ascent weather](../ascent-weather.md) owns the
runtime design.
The [CI, UI, and maintainability follow-up](../archive/ci-ux-maintainability-audit-2026-10-10.md)
is closed locally with three consecutive packaged-browser pairs; hosted CI and
external proof gaps remain explicit.
