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
  [pipeline design](../profile-backup-pipeline.md).
- [Options-page sidebar](options-sidebar.md) — completed investigation,
  execution plan, and deviations recorded during implementation.
- [Codebase audit — 2026-07-19](codebase-audit-2026-07-19.md) — point-in-time
  audit and remediation plan.
