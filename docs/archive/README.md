# Archived notes

Point-in-time investigation and research notes, kept for history. Each was
written against a specific commit and is **not maintained** — code paths, line
references, and file names in these documents may be stale. Read them for the
reasoning and background they captured, not as a description of current behavior.

For current behavior, see the top-level [`README.md`](../../README.md) and the
living docs in [`docs/`](../).

- [3D map: the layer drape usually fails to load](3d-map-basemap-drape-cors.md) —
  why a draped 2D layer often falls back to terrain-only in 3D (cross-origin tile
  restrictions).
- [3D drape resolution and GPU verification](3d-drape-resolution-and-gpu-verification.md) —
  investigation into blurry drapes at high tilt and MapLibre LOD tuning.
- [Peakbagger GPX Ascent Logger](peakbagger-gpx-ascent-detection-research.md) —
  research note on ascent/summit detection.
- [Vector basemaps for the 3D terrain view](3d-vector-basemap-investigation.md) —
  July 2026 provider evaluation that led to the experimental OpenFreeMap style.
- [Trip-report color conversion spike](trip-report-color-conversion-spike.md) —
  comparison of CSSOM color canonicalization with raw-token preservation and
  the resulting sanitizer boundary decision.
- [esbuild + ES-module migration](esbuild-migration-plan.md) — completed plan
  and step-by-step migration log.
- [Cross-browser extension verification](cross-browser-verification.md) —
  completed rollout plan for the Chrome, Firefox, and packaged-extension gates.
- [GPX upload processing](gpx-upload-processing.md) — completed design and
  implementation plan for processing a local file on the ascent form.
- [GitHub ascent backup](github-ascent-backup-plan.md) — completed
  implementation record and remaining manual live checks.
- [Full-profile backup](full-profile-backup.md) — original completed backfill
  design, superseded for batching and backpressure by the living
  [GitHub backup design](../github-ascent-backup.md#full-profile-producer-consumer-pipeline).
- [Favorite climbers](favorite-climbers.md) — completed implementation plan for
  Buddy List/custom filtering, local management, climber-page toggles, and
  explicit GitHub backup/restore. Current behavior lives in the maintained
  [architecture guide](../architecture.md#deep-dive-favorite-climbers).
- [Settings and favorites transfer](settings-export-import-github-backup.md) —
  completed implementation plan for settings file transfer, fixed-root GitHub
  settings backup, and automatic settings/favorites backup. Current behavior
  lives in the maintained [GitHub backup design](../github-ascent-backup.md).
- [Options-page sidebar](options-sidebar.md) — completed investigation,
  execution plan, and deviations recorded during implementation.
- [Trip-report drafts manager](trip-report-drafts-manager.md) — completed plan
  for the device-wide manager in Settings and its editor discovery link.
- [Codebase audit — 2026-07-19](codebase-audit-2026-07-19.md) — point-in-time
  audit and remediation plan.
- [3D map audit — 2026-07-21](3d-map-audit-2026-07-21.md) — completed audit and
  implementation record for compass continuity, progressive drape boot,
  cancelable loading, visible/fatal renderer recovery, shared lifecycle,
  prefetch startup, and final browser/GPU verification. Current behavior lives
  in the maintained [3D map design](../3d-map.md).
- [Profile backup HTTP-cached ref conflict fix](github-ref-cache-conflict-fix.md) —
  completed root-cause and fix for the "repository changed" pause: the GitHub
  client now sets `cache: 'no-store'`, folded into the living
  [GitHub backup design](../github-ascent-backup.md#why-every-github-request-bypasses-browser-cache).
- [Profile backup GPS-track endpoint rename fix](profile-backup-gpx-endpoint.md) —
  completed root-cause and fix for the "Peakbagger returned HTTP 200" failures:
  the profile backup now fetches tracks from `GPXFile.aspx`, with honest failure
  reasons, folded into the living [GitHub backup design](../github-ascent-backup.md#gpx-semantics).
