# Script inventory

Use `npm run verify -- --help` to select a browser check; the dispatcher builds
once and stops on the first failure. [Development](../docs/development.md) owns
the command and coverage reference. Build/release commands stay in `package.json`.

This directory contains both executable drivers and imported case/fixture
modules. A `verify-` prefix does not mean a file launches its own browser.
The shared diagnostics below are used by current verifiers and focused tests;
they are not abandoned debugging scripts. `showcase/` contains the masked HTTPS
pages and synthetic terrain assets shared by verifiers and store rendering.

The October 22 audit found no byte-identical duplicate scripts. The obsolete
Sentinel alias was removed in favor of `map-layers`. The old weather audit driver
was reduced to `weather-intervals`: its native GPS restoration, tab styling and
day-switch cases already run in the maintained weather verifiers. The retained
interval check uniquely verifies a 24-hour precipitation sum across Nepal's
45-minute civil-day boundaries. `api-rate-limits` no longer waits for the removed
legacy Buddy-refresh banner. `peak-map-layout` blocks unrelated external reads.

Every current root module is listed once below. The inventory test rejects
missing files, stale entries and duplicate registrations. Keep related case
helpers with their driver; add a focused verifier only when its coverage is
independent of the existing targets.

## Build and local development

- [build-config.mts](build-config.mts)
- [build.mjs](build.mjs)
- [generate-map-overlay-regions.mjs](generate-map-overlay-regions.mjs)
- [install-git-hooks.mjs](install-git-hooks.mjs)
- [maplibre-terrain-lod-patch.mts](maplibre-terrain-lod-patch.mts)
- [run-development.mjs](run-development.mjs)
- [run-firefox.mjs](run-firefox.mjs)

## Release, dependencies and repository checks

- [build-firefox-package.mjs](build-firefox-package.mjs)
- [check-amo-version.mjs](check-amo-version.mjs)
- [check-changelog-history.mjs](check-changelog-history.mjs)
- [check-npm-audit.mts](check-npm-audit.mts)
- [dependabot-queue-sweep.mts](dependabot-queue-sweep.mts)
- [check-web-ext-lint.mjs](check-web-ext-lint.mjs)
- [copied-runtime-impact.mjs](copied-runtime-impact.mjs)
- [create-amo-metadata.mts](create-amo-metadata.mts)
- [create-chrome-description.mjs](create-chrome-description.mjs)
- [dependency-metadata.mjs](dependency-metadata.mjs)
- [privacy-guard.mjs](privacy-guard.mjs)
- [typescript-policy.mts](typescript-policy.mts) — Rejects new or modified authored JavaScript in the staged index or a committed comparison; preserves generated/vendor formats.
- [publish-chrome.mjs](publish-chrome.mjs)
- [release-bump.mjs](release-bump.mjs)
- [release-changelog.mjs](release-changelog.mjs)
- [release-check.mjs](release-check.mjs)
- [release-package-identity.mjs](release-package-identity.mjs)
- [release-preflight.mts](release-preflight.mts)
- [select-release-artifact.mjs](select-release-artifact.mjs)
- [stage-ui-ux-skill-update.mjs](stage-ui-ux-skill-update.mjs) — Enforces the checked skill-only patch and prepares the direct-main automation commit without executing downloaded helpers.
- [third-party-notices.mjs](third-party-notices.mjs)
- [update-ui-ux-skill.mjs](update-ui-ux-skill.mjs) — Pinned upstream skill updates with local-guidance preservation; `--check` previews without writing.
- [verify-release-archive.mjs](verify-release-archive.mjs)
- [verify-store-packages.mjs](verify-store-packages.mjs)

## Browser infrastructure and shared diagnostics

- [browser-verification-evidence.mjs](browser-verification-evidence.mjs)
- [browser-verification-fixtures.mjs](browser-verification-fixtures.mjs)
- [browser-verification-png.mts](browser-verification-png.mts)
- [chrome-launch-guard.mjs](chrome-launch-guard.mjs)
- [firefox-content-viewport.mjs](firefox-content-viewport.mjs)
- [firefox-verifier-processes.mjs](firefox-verifier-processes.mjs)
- [layout-verification-plan.mjs](layout-verification-plan.mjs) — Exact-once browser/theme/viewport partitions and focused preflight selection.
- [peak-map-links-verification.mjs](peak-map-links-verification.mjs)
- [resource-stack.mjs](resource-stack.mjs)
- [verification-browser-identity.mjs](verification-browser-identity.mjs)
- [verification-repetitions.mjs](verification-repetitions.mjs)
- [verify.mjs](verify.mjs)
- [verify-fixture-preflight.mjs](verify-fixture-preflight.mjs) — Early locale, evidence, worker authorization and shipped-fixture checks.

## Complete extension and package verification

- [verify-extension.mts](verify-extension.mts)
- [verify-firefox-extension.mts](verify-firefox-extension.mts)
- [verify-packaged-extensions.mjs](verify-packaged-extensions.mjs)

## Capture and providers

- [verify-capture-flow.mjs](verify-capture-flow.mjs)
- [verify-capture-popup.mts](verify-capture-popup.mts)
- [verify-garmin-ui.mts](verify-garmin-ui.mts) — Garmin connection, inbox and popup geometry, recovery and keyboard checks in hidden Chrome and Firefox.
- [verify-connections.mjs](verify-connections.mjs) — Packaged Garmin, ImgBB and GitHub disconnect states, focus, duplicate activation and geometry in hidden Chrome and Firefox.
- [jszip-csp-patch.mjs](jszip-csp-patch.mjs) — Version-checked removal of JSZip's legacy string-evaluation scheduler fallback.
- [verify-capture-readiness.mjs](verify-capture-readiness.mjs)
- [verify-draft-recovery.mjs](verify-draft-recovery.mjs)
- [verify-multi-summit.mjs](verify-multi-summit.mjs)
- [verify-provider-contracts.mjs](verify-provider-contracts.mjs)
- [verify-provider-performance.mjs](verify-provider-performance.mjs)

## Maps, terrain and GPX

- [terrain-dem-fixture.mjs](terrain-dem-fixture.mjs)
- [terrain-lod-criteria.mts](terrain-lod-criteria.mts)
- [terrain-lod-probe.mjs](terrain-lod-probe.mjs)
- [terrain-readiness-diagnostics.mjs](terrain-readiness-diagnostics.mjs)
- [verify-gpx-header.mjs](verify-gpx-header.mjs)
- [verify-gpx-segments.mjs](verify-gpx-segments.mjs)
- [verify-map-controls.mjs](verify-map-controls.mjs)
- [verify-map-handoffs.mjs](verify-map-handoffs.mjs)
- [verify-onx.mjs](verify-onx.mjs)
- [verify-map-layer-control.mjs](verify-map-layer-control.mjs)
- [verify-map-layers.mjs](verify-map-layers.mjs)
- [verify-vector-map.mts](verify-vector-map.mts)
- [verify-map-location-cases.mjs](verify-map-location-cases.mjs)
- [verify-peak-link-order.mjs](verify-peak-link-order.mjs)
- [verify-peak-map-layout.mjs](verify-peak-map-layout.mjs)
- [verify-terrain-cache-owners.mjs](verify-terrain-cache-owners.mjs)
- [verify-terrain-lod.mts](verify-terrain-lod.mts)
- [verify-terrain-popup.mjs](verify-terrain-popup.mjs)
- [verify-terrain-provider-ui.mjs](verify-terrain-provider-ui.mjs)
- [verify-terrain-visual.mts](verify-terrain-visual.mts)

## Climbers and profiles

- [buddy-tab-diagnostics.mjs](buddy-tab-diagnostics.mjs)
- [climber-card-close-diagnostics.mjs](climber-card-close-diagnostics.mjs)
- [climber-regression-baseline.mjs](climber-regression-baseline.mjs)
- [signed-out-extension-verification.mjs](signed-out-extension-verification.mjs) — real-manifest Buddy recovery and signed-out local Favorite persistence in both browser gates.
- [verify-climber-hover-card.mjs](verify-climber-hover-card.mjs)
- [verify-climber-list-ui.mjs](verify-climber-list-ui.mjs)
- [verify-climber-membership.mjs](verify-climber-membership.mjs)
- [verify-climber-transitions.mjs](verify-climber-transitions.mjs)
- [verify-inline-buddies.mjs](verify-inline-buddies.mjs)
- [verify-profile-editor.mjs](verify-profile-editor.mjs)
- [verify-profile-preparation.mjs](verify-profile-preparation.mjs)
- [verify-profile-units.mjs](verify-profile-units.mjs)

## Weather and snow

- [verify-wildfires.mjs](verify-wildfires.mjs) — real Leaflet and hardware MapLibre wildfire rendering and recovery through the weather fixture harness.

- [verify-air-quality.mjs](verify-air-quality.mjs) — lazy AQI requests and refresh stability through the weather browser harness.

- [verify-ascent-weather.mjs](verify-ascent-weather.mjs)
- [verify-custom-overlays.mts](verify-custom-overlays.mts) — real unpacked editor, 18 transition and 24 keyboard-help cases at asserted content widths/zoom, negative geometry checks, direct HTTPS/CORS tiles, packaged workers and hardware 2D/3D rendering. `--loading-only` explicitly excludes editor/help matrices; unknown or duplicate selections fail before launch.
- [verify-custom-overlay-lifecycle.mjs](verify-custom-overlay-lifecycle.mjs) — `chrome|firefox startup|lifetime|cache`: real Leaflet and bundled renderer, fresh asynchronous startup, bounded canvas/listener ownership and real HTTP-cache revalidation with changed pixels, conditional responses and ordinary reuse at desktop/narrow widths; controlled providers, without the Settings editor or worker.
- [verify-custom-overlay-replacement.mjs](verify-custom-overlay-replacement.mjs) — hidden hardware Chrome at 1000×760: real MapLibre raster pixels through held replacement, viewport cancellation, rendered acceptance and source/listener teardown; controlled HTTPS provider, without the Settings editor or worker.
- [verify-custom-layer-settings.mjs](verify-custom-layer-settings.mjs) — `chrome|firefox` checks saved-source actions, alignment, long names, light/dark narrow layouts, enlarged text, guarded reorder/error/retry and delete cancellation. Twelve disclosure cases at 900/540 px heights check matching compact headers, Space/Enter expansion, retained focus, a pinned footer, reachable final content and scroll-aware keyboard tooltips. Opacity remains a map-only control.
- [verify-custom-layer-menu.mjs](verify-custom-layer-menu.mjs) — `chrome|firefox` compares built-in/custom row alignment, fonts, colors, checkbox/chevron dimensions, keyboard opacity/disclosure and anchored loading/error/retry/overzoom states at 736/320 × 800, both themes and normal/1.5x text. Presentation fixtures stub I/O; the unpacked integration verifiers cover real loading.
- [verify-private-layers.mjs](verify-private-layers.mjs) — protected query parameters and automatic TileJSON detection in real Settings, private map settings-file round-trip, private worker GETs without provider CORS, per-map approval, forged destination rejection and hardware 2D/3D in hidden Chrome/Firefox; test-only host pregrant does not prove native permission prompts.
- [custom-overlay-editor-verification.mjs](custom-overlay-editor-verification.mjs) — 18 shared Chrome/Firefox editor cases for compact spacing, field help, name/URL-only source setup, metadata/manual overrides and stable Save/detection pending/error/retry status; invoked by the custom-overlay verifier. The broader Firefox terrain GeoJSON proof gap is tracked in the private-relay closure ledger.
- [verify-peak-cards.mjs](verify-peak-cards.mjs)
- [verify-summit-cloud.mjs](verify-summit-cloud.mjs) — hidden Chrome/Firefox
  forecast-card interactions, full-hour navigation and layout stability; run with `npm run verify -- summit-cloud`.
- [verify-peak-snow-cases.mjs](verify-peak-snow-cases.mjs)
- [verify-peak-weather-3d.mjs](verify-peak-weather-3d.mjs)
- [verify-peak-weather-cases.mjs](verify-peak-weather-cases.mjs)
- [verify-peak-weather-interactions.mjs](verify-peak-weather-interactions.mjs)
- [verify-peak-weather-refresh.mjs](verify-peak-weather-refresh.mjs)
- [verify-snotel-options.mjs](verify-snotel-options.mjs)
- [verify-snow-map-cases.mjs](verify-snow-map-cases.mjs)
- [verify-snow-depth.mjs](verify-snow-depth.mjs) — Real-extension snow depth, opacity, keyboard recovery and enlarged layout.
- [verify-snow-map-fixture.mjs](verify-snow-map-fixture.mjs)
- [verify-weather-card-drag.mjs](verify-weather-card-drag.mjs)
- [verify-weather-clouds.mjs](verify-weather-clouds.mjs)
- [verify-weather-day-switches.mjs](verify-weather-day-switches.mjs)
- [verify-weather-intervals.mjs](verify-weather-intervals.mjs)
- [verify-weather-location.mjs](verify-weather-location.mjs)
- [verify-weather-model-refresh.mjs](verify-weather-model-refresh.mjs)
- [verify-weather-tab-styles.mjs](verify-weather-tab-styles.mjs)

## Editors, backups, settings and layout

- [render-showcase.mjs](render-showcase.mjs)
- [report-table-selection.mjs](report-table-selection.mjs)
- [verify-api-rate-limits.mjs](verify-api-rate-limits.mjs)
- [verify-ascent-backup-lifecycle.mjs](verify-ascent-backup-lifecycle.mjs)
- [verify-firefox-terrain.mjs](verify-firefox-terrain.mjs)
- [verify-layout-stability.mts](verify-layout-stability.mts)
- [verify-ascent-column-widths.mjs](verify-ascent-column-widths.mjs) — native peak/ascent metadata widths, nested map containment and card edge alignment, run by `layout-stability`.
- [verify-ascent-filters.mjs](verify-ascent-filters.mjs) — native ascent filtering, visible counts and table-width stability, run by `layout-stability`.
- [verify-photo-backup-status.mjs](verify-photo-backup-status.mjs)
- [verify-photo-editor.mts](verify-photo-editor.mts)
- [verify-photo-library-status.mjs](verify-photo-library-status.mjs)
- [verify-photo-report-edit.mjs](verify-photo-report-edit.mjs)
- [verify-report-caption-stability.mts](verify-report-caption-stability.mts)
- [verify-report-security.mjs](verify-report-security.mjs) — real response protection, hostile reports, native map scripts, Quick Search and Cloudflare exceptions in hidden Chrome/Firefox.
- [verify-instagram.mjs](verify-instagram.mjs) — packaged per-post grants, native captions, bounded player sizing, compact placeholders, consent, error/retry/cancel geometry and Rich paste in hidden Chrome/Firefox. Includes same-origin lazy-video playback and sandbox isolation. `npm run verify -- instagram`; `--live` checks public post/Reel samples and all slides plus decoded video playback in the reported mixed carousel. `--display` pregrants the optional host only in a disposable test copy, then checks native terminal navigation, identical pending/loaded viewport widths and live light/dark transitions with unchanged media colors/geometry. It does not prove the native permission prompt. `BPB_INSTAGRAM_LIVE_POST` adds one validated public sample.
- [verify-report-image-help.mjs](verify-report-image-help.mjs) — image-popover Instagram help: hover, keyboard dismissal, tooltip bounds and stable geometry at desktop/narrow widths in both themes and enlarged text; invoked by the Instagram verifier.
- [verify-report-draft-ownership.mjs](verify-report-draft-ownership.mjs)
- [verify-report-photos.mjs](verify-report-photos.mjs)
- [verify-climber-files.mjs](verify-climber-files.mjs) — standalone list JSON downloads and guarded import transitions, run by `layout-stability`.
- [verify-settings-actions.mjs](verify-settings-actions.mjs) — held Settings actions and restore focus, run by `layout-stability`.
- [settings-fragment-verification.mjs](settings-fragment-verification.mjs) — shared assertions for the packaged Settings anchor verifier.
- [verify-settings-navigation.mts](verify-settings-navigation.mts)
- [verify-settings-fragments.mjs](verify-settings-fragments.mjs) — real packaged Chrome/Firefox Settings anchors, refresh, keyboard navigation, Back/Forward and manual reading positions; run `npm run verify -- settings-navigation`.
- [verify-signed-out.mjs](verify-signed-out.mjs) — signed-out recovery and held filter retries in Chrome/Firefox; run with `npm run verify -- signed-out`.


- [verify-layer-inspection.mts](verify-layer-inspection.mts) — hidden Chrome/Firefox
  HTTPS fixtures for compact right-click overlay readings, pending/success/error
  geometry, keyboard retry, layer invalidation and full-width legend swatches.
  Run with exactly `chrome` or `firefox`; `BPB_INSPECTION_SCREENSHOT_DIR` retains
  the desktop/narrow, light/dark and enlarged-text renders.

  `BPB_INSPECTION_CSS` can select a read-only historical stylesheet to prove that
  the swatch regression assertion rejects the previous small samples.
