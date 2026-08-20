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
- [MapLibre GL JS 6 migration](maplibre-6-migration.md) — completed runtime,
  packaging, asynchronous source-update, WebGL2 fallback, and Chrome/Firefox
  verification record for the locally packaged 6.2 renderer and module worker.
- [Peakbagger GPX Ascent Logger](peakbagger-gpx-ascent-detection-research.md) —
  research note on ascent/summit detection.
- [Vector basemaps for the 3D terrain view](3d-vector-basemap-investigation.md) —
  July 2026 provider evaluation that led to the experimental OpenFreeMap style.
- [Trip-report color conversion spike](trip-report-color-conversion-spike.md) —
  comparison of CSSOM color canonicalization with raw-token preservation and
  the resulting sanitizer boundary decision.
- [ImgBB-backed topo photo editor and photo library](imgbb-photo-editor.md) —
  completed product and implementation plan for non-destructive photo
  annotation, direct bring-your-own-key upload, the device-local catalog,
  report insertion, and metadata-only GitHub recovery. Current behavior lives
  in the maintained [photo topo design](../photo-topo-editor.md).
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
- [Codebase audit — 2026-07-30](codebase-audit-2026-07-30.md) — completed
  remediation of photo upload consistency and resource bounds, provider capture
  cancellation, ImgBB disclosure, library scalability, and maintained-document
  drift, with a final closure ledger.
- [Codebase audit remediation — 2026-07-31](codebase-audit-remediation-2026-07-31.md) —
  completed source-grounded fixes for capture admission, detached cleanup,
  page-world settings validation, analyzer coordinate bounds, options labels,
  theme schema ownership, and dead inline-color code, with explicit proof gaps.
- [Codebase audit remediation — 2026-08-01](codebase-audit-remediation-2026-08-01.md) —
  completed fixes for popup error boundaries, capture trip naming, schema and
  route ownership, canonical URLs, showcase contracts, and Garmin redirects,
  with hidden-browser evidence and explicit live-service and terrain LOD gaps.
- [Dependabot auto-merge audit — 2026-08-02](dependabot-auto-merge-audit-2026-08-02.md) —
  source-grounded hardening of the trusted workflow boundary, full-branch
  provenance, head-bound queueing, and manual review for GitHub Actions updates,
  with the remaining live-event proof gap kept explicit.
- [Codebase audit remediation — 2026-08-03](codebase-audit-remediation-2026-08-03.md) —
  ten focused fixes for GPX segment/time correctness, stable chart selection,
  photo autosave and delivery, GitHub authorization cancellation, and
  provider-capture identity, with broader transaction, storage-concurrency,
  live-service, and native-UI gaps kept explicit.
- [Codebase audit — 2026-08-08](codebase-audit-2026-08-08.md) — completed
  remediation of 21 release, GPX, terrain authorization, transaction,
  persistence, accessibility, verifier, metadata, and fixture-privacy findings,
  with legal, live-service, abrupt-shutdown, native-UI, device, and store-review
  proof gaps preserved in the closure ledger.
- [Codebase audit — 2026-08-12](codebase-audit-2026-08-12.md) — completed
  remediation of 12 photo-recovery, response-budget, terrain-transaction,
  settings-import, recovery-UX, cancellation, and Chrome-publication findings,
  with crash-durability, native/assistive UI, live-service, dependency-policy,
  and store-publication proof gaps preserved in the closure ledger.
- [Code, performance, and UX audit — 2026-08-19](codebase-audit-2026-08-19.md) —
  completed remediation of 14 trusted-action, capture/draft lease, privacy,
  photo-recovery, terrain/time correctness, interaction-performance, atomic
  build, and AMO-metadata findings, with native/assistive UI, abrupt-loss,
  live-service, dependency-policy, hardware breadth, and store-review proof
  gaps preserved in the closure ledger.
- [UX and engineering audit follow-up — 2026-08-08](ux-engineering-audit-2026-08-08.md) —
  completed remediation of 17 release, transaction, GPX, recovery UX, resource,
  compatibility, and first-use findings, with remote-policy, crash-durability,
  legal, live-service, native-UI, assistive-technology, mobile-device, and store
  proof gaps preserved in the closure ledger.
- [Codebase audit — 2026-07-19](codebase-audit-2026-07-19.md) — point-in-time
  audit and remediation plan.
- [Codebase audit — 2026-07-22](codebase-audit-2026-07-22.md) and its
  [follow-up](codebase-audit-2026-07-22-followup.md) — executed audit rounds
  over the refactored worker, options modules, and GitHub domain.
- [Codebase audit — 2026-07-23](codebase-audit-2026-07-23.md) — ascent sync UX
  round: saved-ascent navigation identity, opt-in GitHub deletion mirroring,
  truthful backup status, draft peak names, and the worker-owned settings and
  favorites mutation boundaries, with its closure ledger.
- [Polish audit — 2026-07-24](polish-audit-2026-07-24.md) — completed
  feedback, dark-mode, and shared-idiom round covering truthful capture state,
  destructive confirmations, shared units/theme/DOM ownership, analyzer
  extraction, and condition-based map retries, with its closure ledger.
- [3D map audit — 2026-07-21](3d-map-audit-2026-07-21.md) — completed audit and
  implementation record for compass continuity, progressive drape boot,
  cancelable loading, visible/fatal renderer recovery, shared lifecycle,
  prefetch startup, and final browser/GPU verification. Current behavior lives
  in the maintained [3D map design](../3d-map.md).
- [3D tilt detail collapse](3d-tilt-detail-blink.md) and its
  [pan-jolt comparison](pan-jolt-comparison.md) — completed implementation and
  measurement record for the elevation detail ladder, bounded tilt warming,
  tile retention, drape level-of-detail choice, and fixed-scale pan behavior.
  Current behavior lives in the maintained [3D map design](../3d-map.md).
- [Profile backup HTTP-cached ref conflict fix](github-ref-cache-conflict-fix.md) —
  completed root-cause and fix for the "repository changed" pause: the GitHub
  client now sets `cache: 'no-store'`, folded into the living
  [GitHub backup design](../github-ascent-backup.md#why-every-github-request-bypasses-browser-cache).
- [Profile backup GPS-track endpoint rename fix](profile-backup-gpx-endpoint.md) —
  completed root-cause and fix for the "Peakbagger returned HTTP 200" failures:
  the profile backup now fetches tracks from `GPXFile.aspx`, with honest failure
  reasons, folded into the living [GitHub backup design](../github-ascent-backup.md#gpx-semantics).
