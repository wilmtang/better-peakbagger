# Active plans

- [Repository bugs, engineering, and UX audit — October 19](codebase-audit-2026-10-19.md)
  — remediation in progress; capture Save/readiness and BFCache gaps, automatic units,
  two failing verification contracts, stream cleanup and terrain planning
  bounds, with optional catalog/CI improvements and explicit proof limits.

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

The [Trip Info audit remediation](../archive/trip-info-audit-remediation-2026-10-17.md)
fixes incomplete-form handling before GPS Preview and corrects the Settings
description. Its ledger records regression and hidden Chrome/Firefox evidence,
with live Peakbagger persistence and native accessibility proof still open.

The [October 17 capture trust and recovery audit](../archive/capture-trust-recovery-audit-2026-10-17.md)
closes the confirmed sender, draft-reload, ordering, payload-recovery and provider
allowlist findings locally. Its ledger records 2,880 passing tests, hidden
Chrome/Firefox and layout evidence, archive validation, the unchanged advisory
deadline, and retained live/native proof limits.

The [October 14 bug audit remediation](../archive/bug-audit-remediation-2026-10-14.md)
closes three reproduced Buddy-cache, capture-save identity, and saved-favorites
findings locally, with focused commits, regression tests, and Chrome/Firefox
extension checks. Its ledger retains live-server and native verification limits.

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
records the historical thirteen-group implementation and CI geometry gate,
not universal UX closure. The [October 14 climber re-audit](../archive/climber-layout-reaudit-2026-10-14.md)
corrects eight profile/card/gate findings and two carried GPX/report regressions
in focused commits. Its stronger assertions reject the audited code; 24 climber
variants and 112 integrated layout cases pass on the fixed build. The archive
retains native/live proof gaps and the two unchanged README test failures.
Earlier counts and browser results remain historical evidence.

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
