# Active plans

- [Codebase size and redundancy reduction](codebase-reduction-2026-11-13.md)
  — phase 1 (archive removal) is done; phases 2–5 are not started.

- [November 11 bugs, performance, engineering and UX audit](codebase-audit-2026-11-11.md)
  — 18 findings, remediated and reviewed except where its ledger says otherwise
  (the worker was converted to TypeScript first). F1, F2, F6b and F18 wait on
  browser measurements.

- [Release pipeline reliability and turnaround](release-pipeline-reliability.md)
  — early store readiness, permanent capture evidence, exact package promotion,
  parallel browser checks and a protected post-upload Chrome checkpoint.

- [Repository follow-up ledger](follow-ups.md)
  — the single list of what completed audits left open: the unpatched deepmerge
  advisory (tooling only, no longer a release blocker), terrain warming timing, Linux backup widths, hosted CI and manual
  release checks. Includes the latest full acceptance run.


- [Modern stack adoption with legacy compatibility](modern-stack-adoption.md)
  — goal, milestones and current progress. M0–M3 are done; next are the Units
  panel's typed boundary and the DOM test environment, then Svelte compilation,
  a Units panel pilot, converting all remaining JavaScript and optional WXT/Vite
  cutover; retiring jsdom is its own milestone after that conversion.

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

## Completed plans

Once a plan is implemented or abandoned, update the maintained architecture or
focused design note with the resulting runtime behavior, then delete the plan
from the tree with its closure ledger intact in that final version. Add one line
below linking the GitHub permalink of that final version: name the parent of the
deleting commit, never the deleting commit itself, and never rebase that parent
before it is on the pushed `main`, or every permalink to it breaks. Carry anything it
left open to the [follow-up ledger](follow-ups.md). Plans are decision and
execution records, never the source of truth for shipped code.

Historical weather records are consolidated in the
[weather closure ledger](../weather.md#audit-closure-ledger).

### Archived records

The former archive directory was removed after commit
`9bcb42a3e0572218f7fe244eeaacf6197fab54f1`; browse it whole at
[that commit](https://github.com/wilmtang/better-peakbagger/tree/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive).
Each record is a point-in-time note: its code paths, line references and file
names may be stale.

- [External API rate-limit feedback audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/2026-10-11-external-api-rate-limit-audit.md)
- [OSM terrain policy and recovery](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/2026-10-24-osm-terrain-policy.md)
- [Drape resolution on tilt, and verifying on the real GPU](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/3d-drape-resolution-and-gpu-verification.md)
- [3D map audit — findings and fix plan (2026-07-21)](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/3d-map-audit-2026-07-21.md)
- [3D map audit and zoom-flicker remediation — October 22, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/3d-map-audit-2026-10-22.md)
- [3D map: the layer drape usually fails to load](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/3d-map-basemap-drape-cors.md)
- [Plan: stop the 3D map blinking when you tilt it](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/3d-tilt-detail-blink.md)
- [Vector basemaps for the 3D terrain view](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/3d-vector-basemap-investigation.md)
- [Better Peakbagger — 5-feature implementation plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/5-feature%20implementation%20plan.md)
- [Bug audit remediation — 2026-10-14](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/bug-audit-remediation-2026-10-14.md)
- [Chrome capture validation — 2026-09-29](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/capture-chrome-validation-2026-09-29.md)
- [Capture trip recovery audit remediation](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/capture-trip-recovery-2026-10-17.md)
- [Capture trust and recovery audit remediation](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/capture-trust-recovery-audit-2026-10-17.md)
- [Peak and ascent card reuse audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/card-reuse-audit-2026-10-24.md)
- [Dependency verification latency — 2026-10-25](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ci-latency-2026-10-25.md)
- [CI, UX, and maintainability audit — 2026-10-03](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ci-ux-maintainability-audit-2026-10-03.md)
- [CI, UI, and maintainability follow-up — 2026-10-10](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ci-ux-maintainability-audit-2026-10-10.md)
- [Climber hover card](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/climber-hover-card.md)
- [Climber interaction and layout re-audit — 2026-10-14](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/climber-layout-reaudit-2026-10-14.md)
- [Climber membership delivery ledger — 2026-10-04](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/climber-membership-2026-10-04.md)
- [Code-removal audit — 2026-10-09](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/code-removal-audit-2026-10-09.md)
- [Code and UX audit — 2026-10-09](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/code-ux-audit-2026-10-09.md)
- [Codebase audit — 2026-07-19](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-07-19.md)
- [Codebase audit — 2026-07-22 follow-up](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-07-22-followup.md)
- [Codebase audit — 2026-07-22](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-07-22.md)
- [Codebase audit — 2026-07-23 (ascent sync UX round)](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-07-23.md)
- [Codebase audit — 2026-07-26 (privacy, transactions, lifecycle, and recovery)](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-07-26.md)
- [Codebase audit — 2026-07-30](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-07-30.md)
- [Codebase audit — 2026-08-08](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-08-08.md)
- [Code, performance, and UX audit — 2026-08-12](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-08-12.md)
- [Code, performance, and UX audit — 2026-08-19](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-08-19.md)
- [Code, performance, and UX audit plan — 2026-08-29](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-08-29.md)
- [Codebase audit — 2026-09-13](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-09-13.md)
- [Codebase audit — 2026-09-25](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-09-25.md)
- [Repository bugs, engineering, and UX audit — 2026-10-12](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-12.md)
- [Repository bugs, engineering, and UX audit — 2026-10-19](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-19.md)
- [Repository audit and remediation — 2026-10-21](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-21.md)
- [Repository bugs, performance, engineering, and UX audit — October 22 follow-up](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-22-followup.md)
- [Codebase Audit & Remediation Plan — 2026-10-22](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-22.md)
- [Repository audit and remediation — October 24, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-24.md)
- [Code, performance, engineering and UX audit — October 27, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-27.md)
- [Code, performance, engineering and UX re-audit — October 28, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-28.md)
- [Codebase audit remediation — 2026-07-31](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-remediation-2026-07-31.md)
- [Codebase audit remediation — 2026-08-01](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-remediation-2026-08-01.md)
- [Codebase audit remediation — 2026-08-03](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-remediation-2026-08-03.md)
- [Cross-browser extension verification: execution plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/cross-browser-verification.md)
- [Private custom-layer relay — October 26, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/custom-layer-private-relay-2026-10-26.md)
- [Custom layer Options and backup audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/custom-layer-settings-audit-2026-10-25.md)
- [Custom map overlays: direct raster and vector sources](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/custom-map-overlays-2026-10-25.md)
- [Dependabot auto-merge investigation — 2026-10-25](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/dependabot-auto-merge-2026-10-25.md)
- [Dependabot auto-merge audit — 2026-08-02](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/dependabot-auto-merge-audit-2026-08-02.md)
- [Dependabot integration and recurrence investigation — 2026-09-08](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/dependabot-integration-2026-09-08.md)
- [Dependabot integration and 3.8 release preparation — 2026-09-29](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/dependabot-integration-2026-09-29.md)
- [Dependency integration — 2026-10-17](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/dependabot-integration-2026-10-17.md)
- [esbuild + ES-module migration — plan & progress](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/esbuild-migration-plan.md)
- [Favorite climbers](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/favorite-climbers.md)
- [Firefox Android 3.8 validation — 2026-09-30](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/firefox-android-validation-2026-09-30.md)
- [Full profile backup: design](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/full-profile-backup.md)
- [Garmin inbox implementation audit — October 23, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/garmin-inbox-audit.md)
- [Garmin Personal API and automatic draft inbox](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/garmin-personal-api-draft-inbox.md)
- [Garmin/Strava capture reliability, performance, and UX audit — 2026-09-03](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/garmin-strava-capture-audit-2026-09-03.md)
- [GitHub ascent backup: implementation record](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/github-ascent-backup-plan.md)
- [Fix plan: profile backup "repository changed" conflict from HTTP-cached ref reads](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/github-ref-cache-conflict-fix.md)
- [GitHub sync controls audit — 2026-10-04](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/github-sync-controls-2026-10-04.md)
- [Suspect GPX segments: cause analysis and remedy plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/gpx-suspect-segments.md)
- [Plan: Process an uploaded GPX on the ascent form](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/gpx-upload-processing.md)
- [Climber lists and report visibility — UX specification](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ignored-climbers-ux.md)
- [Ignored climbers and report filtering](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ignored-climbers.md)
- [ImgBB photo editor: implementation record](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/imgbb-photo-editor.md)
- [Instagram embed display audit — October 26, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/instagram-embed-audit-2026-10-26.md)
- [Instagram embeds and trip-report script protection](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/instagram-embeds-and-report-security-2026-10-25.md)
- [Mainline and dependency integration — 2026-10-03](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/mainline-dependency-integration-2026-10-03.md)
- [Map code audit, 2026-11-08](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/map-audit-2026-11-08.md)
- [Shared map Layers menu and overlays](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/map-layers-and-overlays-2026-10-21.md)
- [Shared map overlays audit — October 21, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/map-overlays-audit-2026-10-21.md)
- [MapLibre GL JS 6 migration plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/maplibre-6-migration.md)
- [Maptoolkit basemap integration — October 31](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/maptoolkit-basemap-2026-10-31.md)
- [Maptoolkit branch audit — November 6](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/maptoolkit-branch-audit-2026-11-06.md)
- [Maptoolkit performance and picker audit — October 31](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/maptoolkit-performance-audit-2026-10-31.md)
- [Modern stack adoption evidence — through November 6, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/modern-stack-adoption-evidence-2026-11-06.md)
- [Native Peakbagger table widths — 2026-10-25](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/native-table-width-audit-2026-10-25.md)
- [New features and UI audit — 2026-10-10](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/new-features-ui-audit-2026-10-10.md)
- [onX export reliability](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/onx-export-reliability-2026-10-27.md)
- [Options page sidebar navigation — investigation and execution plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/options-sidebar.md)
- [Comparing the pan-end zoom jolt](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/pan-jolt-comparison.md)
- [Panel button audit — October 23, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/panel-button-audit.md)
- [Peak column regression audit — 2026-10-22](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/peak-column-regression-audit-2026-10-22.md)
- [Peak-page presentation follow-up — 2026-10-12](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/peak-page-presentation-2026-10-12.md)
- [Peakbagger GPX Ascent Logger](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/peakbagger-gpx-ascent-detection-research.md)
- [Polish audit — 2026-07-24 (feedback, dark mode, and shared-idiom round)](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/polish-audit-2026-07-24.md)
- [Profile backup "Peakbagger returned HTTP 200" failures — root cause and fix plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/profile-backup-gpx-endpoint.md)
- [Release hardening — 2026-09-30](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/release-hardening-2026-09-30.md)
- [Release verification reliability](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/release-verification-reliability-2026-10-08.md)
- [Report image captions](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/report-image-captions.md)
- [Report image display size](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/report-image-display-size.md)
- [Report protection remediation](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/report-protection-remediation-2026-11-07.md)
- [Repository layout-stability audit — 2026-10-12](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/repository-layout-stability-2026-10-12.md)
- [Connected-service disconnect audit — October 31](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/service-disconnect-audit-2026-10-31.md)
- [Settings and favorites transfer: completed implementation record](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/settings-export-import-github-backup.md)
- [Settings hierarchy audit — October 25, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/settings-hierarchy-audit-2026-10-25.md)
- [Settings portability remediation](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/settings-portability-remediation.md)
- [Signed-out Peakbagger users: feature gates and remediation plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/signed-out-peakbagger-audit-2026-10-23.md)
- [SNOTEL map camera audit — 2026-10-22](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/snotel-map-camera-audit-2026-10-22.md)
- [SNOTEL timeout and recovery UX audit — October 20, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/snotel-timeout-ux-audit-2026-10-20.md)
- [Summit Cloud Cover audit (November 8, 2026)](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/summit-cloud-audit-2026-11-08.md)
- [Sun position code, performance, and UX audit — 2026-08-25](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/sun-position-audit-2026-08-25.md)
- [Sun position calculator execution plan](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/sun-position-calculator.md)
- [Trip Info audit remediation](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/trip-info-audit-remediation-2026-10-17.md)
- [Trip-report color conversion: CSSOM canonicalization or raw tokens](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/trip-report-color-conversion-spike.md)
- [Better Peakbagger — trip-report drafts manager](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/trip-report-drafts-manager.md)
- [UI state audit remediation — 2026-10-06](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ui-state-audit-2026-10-06.md)
- [UX audit — October 22, 2026](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ux-audit-2026-10-22.md)
- [UX and engineering audit follow-up — 2026-08-08](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ux-engineering-audit-2026-08-08.md)
- [2D vector map audit remediation — October 31](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/vector-map-audit-2026-10-31.md)
- [2D vector zoom audit — November 1](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/vector-zoom-audit-2026-11-01.md)
