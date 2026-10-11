# Active plans

- [Weather feature audit — 2026-10-11](weather-feature-audit-2026-10-11.md) —
  eight data, interaction, accessibility and styling findings under remediation;
  focused fixes and an explicit closure ledger.
- [New features and UI audit — 2026-10-10](new-features-ui-audit-2026-10-10.md) —
  two reproduced open UI findings since 3.9.2: Sentinel capture selection on
  3D resume and climber-card keyboard focus during row cleanup. Current unit,
  Chrome/Firefox, responsive visual evidence and proof limits are recorded.
- [Climber hover card](climber-hover-card.md) — local Favorite/Ignore card
  implemented; Buddy management opens the native profile. Inline Buddy mutation
  remains deferred until its form and transaction coordination are verified.
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

The [code-removal audit](../archive/code-removal-audit-2026-10-09.md) is closed
locally with its removal evidence, retained boundaries, and verification limits.
The [historical ascent-weather implementation](../archive/ascent-historical-weather.md)
is complete locally, with its browser/model evidence and remaining live-site and
accessibility proof gaps retained. [Ascent weather](../ascent-weather.md) owns the
runtime design.
The [CI, UI, and maintainability follow-up](../archive/ci-ux-maintainability-audit-2026-10-10.md)
is closed locally with three consecutive packaged-browser pairs; hosted CI and
external proof gaps remain explicit.
