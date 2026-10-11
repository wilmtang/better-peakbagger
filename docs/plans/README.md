# Active plans

- [New features and UI audit — 2026-10-10](new-features-ui-audit-2026-10-10.md) —
  two reproduced open UI findings since 3.9.2: Sentinel capture selection on
  3D resume and climber-card keyboard focus during row cleanup. Current unit,
  Chrome/Firefox, responsive visual evidence and proof limits are recorded.
- [Climber hover card](climber-hover-card.md) — direct Favorite, Ignore, and
  Buddy actions implemented with fixture verification; authenticated live Buddy
  mutation remains a release proof gap.
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
