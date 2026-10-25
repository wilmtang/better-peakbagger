# Active plans

- [Peak and ascent card reuse audit — October 24](card-reuse-audit-2026-10-24.md)
  — implemented in focused commits: collapsed-read/calm-axis fixes, shared
  eligibility, chart math, card styles, pointer gestures and latest-read ownership.
  Full suite and hidden Chrome/Firefox matrices passed; external proof limits
  and intentionally separate policies remain in the closure ledger.

- [Weather guide and open API optimizations](../weather.md)
  — consolidated feature/request documentation and historical weather audits;
  cloud usage and cross-card/page cache work remain open in its ledger.

- [Cell coverage storage and Cloudflare hosting](cell-coverage-cloudflare-hosting.md)
  — conversion code, actual national-layer sizes and a rendered raw-polygon/H3
  comparison; local batch stopped at 122/460 sources, then resumed on build-host.
  Full US size, production settings and live Cloudflare behavior remain unverified.

- [Cell coverage in-browser feasibility experiment](experiments/fcc-browser-coverage/README.md)
  — bounded FCC-derived sample decoded and rendered in hidden Chrome/Firefox;
  later authenticated downloads and national-layer rendering are linked in the plan.
  Records authentication requirements, parser compatibility, timings and proof gaps.

- [Wildfire map overlay](wildfire-map-overlay.md)
  — US implementation verified locally; opt-in reported locations and perimeters in the
  shared native/3D Overlays menu, followed by Canadian locations after proving
  the new service's current-record queries. Includes source probes, bounded
  request design, lifecycle/UX checks and explicit live/browser proof gaps.

- [Repository bugs, performance, engineering, and UX audit — October 24](codebase-audit-2026-10-24.md)
  — confirmed runtime fixes implemented in focused commits after independent
  verification and local checks. The closure ledger retains intentional
  behavior, the reviewed dependency exception and browser/live proof gaps.

- [Signed-out Peakbagger feature gates and remediation](signed-out-peakbagger-audit-2026-10-23.md)
  — all four findings implemented and locally verified: Buddy-filter recovery,
  shared account parsing, cached Buddy feedback and My Ascents session checks.
  Includes the feature inventory, live reproduction, Chrome/Firefox evidence
  and closure ledger; live cookie isolation and native-UI proof gaps remain.

- [Garmin Personal API and automatic draft inbox](garmin-personal-api-draft-inbox.md)
  — researched and proposed; live token, activity and deep-history FIT reads
  verified, with a four-hour editable schedule, opt-in key export, persistent
  inbox snapshots, incremental discovery rules and decoder-license comparison.
  Includes visual workflow mocks and an interactive documentation prototype.
  Business terms, production decoding and runtime/UX verification remain open.

- [Repository bugs, performance, engineering, and UX audit — October 22 follow-up](codebase-audit-2026-10-22-followup.md)
  — four runtime findings fixed and verified locally in focused commits:
  capture cooldown, keyboard focus, metadata stability and chart efficiency.
  The upstream dependency advisory remains open with its existing October 24
  expiry; regression evidence and native/live proof gaps are retained.

- [Owned activity export from Garmin and Strava feeds](activity-feed-export.md)
  — proposed; optional per-service access, owner-only activity buttons, an
  anchored review panel, and leased extraction tabs with explicit privacy,
  lifecycle, layout-stability, and live-provider verification gates.

- [Repository bugs, engineering, and UX audit — October 19](codebase-audit-2026-10-19.md)
  — all seven fixes and both engineering improvements implemented; local
  verification and independent commits recorded, with terrain warming,
  native Firefox BFCache and hosted CI proof gaps retained.

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

The [settings portability remediation](../archive/settings-portability-remediation.md)
is complete locally: guarded GitHub root replacements, portable weather/overlay/
photo-tool preferences, device-local transfer consent and standalone list files.
The ledger retains live multi-device/GitHub and native chooser proof gaps; the
[storage report](../settings-storage-and-sync.md) describes current policy.

The [peak-column regression audit](../archive/peak-column-regression-audit-2026-10-22.md)
restores BPB map links after column initialization, adds combined startup-order
coverage, repairs the generic native fixture and requires the links in both
browser smoke checks and the card matrix. It records the earlier test gaps,
neighboring-feature audit and retained live/native proof limits.

The [October 22 UX audit](../archive/ux-audit-2026-10-22.md)
records seven confirmed findings fixed in six focused runtime commits: capture
state and focus, map permission/transfer focus, Settings recovery, photo backup
and sticky-header readability. Its ledger retains native/live accessibility
limits and an intermittent existing climber-card verifier timeout.

The [October 22 Gemini code audit and script review](../archive/codebase-audit-2026-10-22.md)
records six validated fixes, an additional long-feedback Retry shift, obsolete
map/verifier removal and a complete script inventory. Its closure ledger retains
live/native authorization-order and dependency proof limits.

The [October 22 3D map audit](../archive/3d-map-audit-2026-10-22.md)
records four runtime fixes, the restored GPU provenance probe and Firefox
terrain verification repair. Forty fixed-angle Rainier-centered zoom cases
pass across both drape settings; its ledger retains the strict full-detail
tilt-timing, live-provider and native-UI proof gaps.

The [October 21 repository audit](../archive/codebase-audit-2026-10-21.md)
fixes four reproduced provider-cooldown, unread-response and remote-photo
filename findings in independent commits. Its closure ledger retains the
upstream dependency advisory and explicit live/native/LOD verification limits.

The [shared map Overlays implementation](../archive/map-layers-and-overlays-2026-10-21.md)
is complete locally: a collapsed overlay menu, a separate basemap selector, independent opacity,
Sentinel mosaics, viewport SNOTEL, USGS slope and public lands across native and
supported 3D maps. Its ledger records browser/pixel/geometry evidence and the
unchanged broader Chrome spacing assertion. [Map layers](../map-layers.md)
owns the runtime contract.
The [October 21 overlay audit](../archive/map-overlays-audit-2026-10-21.md)
adds truthful zoom feedback, preserves SNOTEL startup intent and updates popup
actions without closing an unchanged station's popup. Its closure ledger records
regression, Chrome/Firefox focus/layout and real-extension hardware evidence,
with live-provider and native accessibility proof gaps retained.

The [SNOTEL timeout and recovery UX audit](../archive/snotel-timeout-ux-audit-2026-10-20.md)
adds explicit timeout feedback and verifies stable, immediately available Refresh
in hidden Chrome, Firefox and Brave. Its ledger preserves the documented failed
station retry history and records the follow-up aligning Refresh with the
restored station, plus existing-profile/live-provider proof gaps.

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

Historical weather implementation, feature/UX and location audit outcomes now
live in the single [weather closure ledger](../weather.md#audit-closure-ledger),
including focused commits, dated evidence and retained external proof limits.

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

The [code-removal audit](../archive/code-removal-audit-2026-10-09.md) is closed
locally with its removal evidence, retained boundaries, and verification limits.
The [CI, UI, and maintainability follow-up](../archive/ci-ux-maintainability-audit-2026-10-10.md)
is closed locally with three consecutive packaged-browser pairs; hosted CI and
external proof gaps remain explicit.
