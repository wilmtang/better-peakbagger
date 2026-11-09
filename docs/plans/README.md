# Active plans

- [Release pipeline reliability and turnaround](release-pipeline-reliability.md)
  — early store readiness, permanent capture evidence, exact package promotion,
  parallel browser checks and a protected post-upload Chrome checkpoint.

- [Repository follow-up ledger](follow-ups.md)
  — the single list of what completed audits left open: the deepmerge release
  blocker, terrain warming timing, Linux backup widths, hosted CI and manual
  release checks. Includes the latest full acceptance run.


- [Modern stack adoption with legacy compatibility](modern-stack-adoption.md)
  — goal, milestones and current progress. M0 and M1 are done; next are the small
  helper conversions, then watch/boundary support, Svelte compilation, a Units
  panel pilot, converting all remaining JavaScript and optional WXT/Vite cutover.

- [Weather guide and open API optimizations](../weather.md)
  — cloud-request cost and cross-card/page caching remain open in its ledger.

- [Cell coverage storage and Cloudflare hosting](cell-coverage-cloudflare-hosting.md)
  — extension integration and delivery/rendering verification. Conversion and
  measurement belong to the [independent server repository](../server-repository.md).

- [Wildfire map overlay](wildfire-map-overlay.md)
  — US implementation verified locally; Canadian locations are deferred until the
  new service's current-record queries are proven.

- [Avalanche forecast links and regional layer](avalanche-forecast-links-and-layer.md)
  — source links implemented; exact zone links and regional overlays remain proposed.

- [Owned activity export from Garmin and Strava feeds](activity-feed-export.md)
  — proposed; implementation has not started.

- [Imgur uploads and media-host selection](imgur-media-hosting.md)
  — proposed; implementation has not started.

The [FCC tooling pointer](experiments/fcc-browser-coverage/README.md) records that
executable experiments and their evidence moved to map-server.

Once a plan is implemented or abandoned, move it to [archive/](../archive/) and
update the maintained architecture or focused design note with the resulting
runtime behavior. Plans are decision and execution records, never the source of
truth for shipped code.

The [report protection remediation](../archive/report-protection-remediation-2026-11-07.md)
is implemented in two independently reviewed commits. Its closure ledger retains
native-picker, browser-zoom and live-provider proof limits; remaining manual
checks are carried in the [follow-up ledger](follow-ups.md).

The [November 6 archive pass](follow-ups.md) moved 18 completed audit and
implementation records to the archive. Their ledgers stay intact, and everything
they left open is now in the follow-up ledger.

The [October 28 code/performance/UX re-audit](../archive/codebase-audit-2026-10-28.md)
is implemented in seven focused fix commits covering six findings and a
transition defect caught during final independent review. Its ledger records
import conflicts, HTTP revalidation, rendered replacement readiness, committed
Save/Delete feedback, enlarged keyboard help and restored full verification.
The reviewed dependency exception and native/live/hosted-CI proof gaps remain.

The [October 27 code/performance/UX audit](../archive/codebase-audit-2026-10-27.md)
is implemented in seven focused commits. Its closure ledger records credential
conflicts, map refresh/recovery, renderer lifetime, restored local gates and
Chrome/Firefox evidence. The expiring low development-tool advisory, unrelated
editor/hover timing concerns and native/live/hosted-CI proof gaps remain explicit.

The [native table-width audit](../archive/native-table-width-audit-2026-10-25.md)
restores content-based columns on native peak metadata and ascent summaries,
following the Selected Trip Reports repair. Its ledger records regression
proof, Chrome/Firefox layout coverage and the explicit exclusion of BPB-created
tables.

The [custom map overlay implementation](../archive/custom-map-overlays-2026-10-25.md)
adds direct raster, GeoJSON and MVT sources across native and supported 3D maps.
Its ledger records Chrome/Firefox fixture evidence, the separate cross-origin
request budgets, live/native proof limits and the existing dependency-audit failure.

The [settings hierarchy audit](../archive/settings-hierarchy-audit-2026-10-25.md)
is complete locally: readable subsection headings, a Features group under
General, consistent spacing, and card-width responsive controls. Its ledger
records browser/zoom stability checks and retained native-UI proof limits.

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

The [Instagram and trip-report security implementation](../archive/instagram-embeds-and-report-security-2026-10-25.md)
records the October 26 implementation, current browser/provider evidence and
closure ledger, including the existing lint warning and external review limits.
The maintained behavior is documented in [the editor guide](../trip-report-editor.md#instagram-posts).
