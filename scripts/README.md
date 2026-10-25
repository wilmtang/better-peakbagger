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

- [build-config.mjs](build-config.mjs)
- [build.mjs](build.mjs)
- [generate-map-overlay-regions.mjs](generate-map-overlay-regions.mjs)
- [install-git-hooks.mjs](install-git-hooks.mjs)
- [maplibre-terrain-lod-patch.mjs](maplibre-terrain-lod-patch.mjs)
- [run-development.mjs](run-development.mjs)
- [run-firefox.mjs](run-firefox.mjs)

## Release, dependencies and repository checks

- [build-firefox-package.mjs](build-firefox-package.mjs)
- [check-amo-version.mjs](check-amo-version.mjs)
- [check-changelog-history.mjs](check-changelog-history.mjs)
- [check-npm-audit.mjs](check-npm-audit.mjs)
- [check-web-ext-lint.mjs](check-web-ext-lint.mjs)
- [copied-runtime-impact.mjs](copied-runtime-impact.mjs)
- [create-amo-metadata.mjs](create-amo-metadata.mjs)
- [create-chrome-description.mjs](create-chrome-description.mjs)
- [dependency-metadata.mjs](dependency-metadata.mjs)
- [privacy-guard.mjs](privacy-guard.mjs)
- [publish-chrome.mjs](publish-chrome.mjs)
- [release-bump.mjs](release-bump.mjs)
- [release-changelog.mjs](release-changelog.mjs)
- [release-check.mjs](release-check.mjs)
- [release-package-identity.mjs](release-package-identity.mjs)
- [release-preflight.mjs](release-preflight.mjs)
- [select-release-artifact.mjs](select-release-artifact.mjs)
- [third-party-notices.mjs](third-party-notices.mjs)
- [verify-release-archive.mjs](verify-release-archive.mjs)
- [verify-store-packages.mjs](verify-store-packages.mjs)

## Browser infrastructure and shared diagnostics

- [browser-verification-evidence.mjs](browser-verification-evidence.mjs)
- [browser-verification-fixtures.mjs](browser-verification-fixtures.mjs)
- [chrome-launch-guard.mjs](chrome-launch-guard.mjs)
- [firefox-content-viewport.mjs](firefox-content-viewport.mjs)
- [firefox-verifier-processes.mjs](firefox-verifier-processes.mjs)
- [peak-map-links-verification.mjs](peak-map-links-verification.mjs)
- [resource-stack.mjs](resource-stack.mjs)
- [verification-browser-identity.mjs](verification-browser-identity.mjs)
- [verification-repetitions.mjs](verification-repetitions.mjs)
- [verify.mjs](verify.mjs)

## Complete extension and package verification

- [verify-extension.mjs](verify-extension.mjs)
- [verify-firefox-extension.mjs](verify-firefox-extension.mjs)
- [verify-packaged-extensions.mjs](verify-packaged-extensions.mjs)

## Capture and providers

- [verify-capture-flow.mjs](verify-capture-flow.mjs)
- [verify-capture-popup.mjs](verify-capture-popup.mjs)
- [verify-garmin-ui.mjs](verify-garmin-ui.mjs) — Garmin connection, inbox and popup geometry, recovery and keyboard checks in hidden Chrome and Firefox.
- [jszip-csp-patch.mjs](jszip-csp-patch.mjs) — Version-checked removal of JSZip's legacy string-evaluation scheduler fallback.
- [verify-capture-readiness.mjs](verify-capture-readiness.mjs)
- [verify-draft-recovery.mjs](verify-draft-recovery.mjs)
- [verify-multi-summit.mjs](verify-multi-summit.mjs)
- [verify-provider-contracts.mjs](verify-provider-contracts.mjs)
- [verify-provider-performance.mjs](verify-provider-performance.mjs)

## Maps, terrain and GPX

- [terrain-dem-fixture.mjs](terrain-dem-fixture.mjs)
- [terrain-lod-probe.mjs](terrain-lod-probe.mjs)
- [terrain-readiness-diagnostics.mjs](terrain-readiness-diagnostics.mjs)
- [verify-gpx-header.mjs](verify-gpx-header.mjs)
- [verify-gpx-segments.mjs](verify-gpx-segments.mjs)
- [verify-map-controls.mjs](verify-map-controls.mjs)
- [verify-map-handoffs.mjs](verify-map-handoffs.mjs)
- [verify-map-layer-control.mjs](verify-map-layer-control.mjs)
- [verify-map-layers.mjs](verify-map-layers.mjs)
- [verify-map-location-cases.mjs](verify-map-location-cases.mjs)
- [verify-peak-link-order.mjs](verify-peak-link-order.mjs)
- [verify-peak-map-layout.mjs](verify-peak-map-layout.mjs)
- [verify-terrain-cache-owners.mjs](verify-terrain-cache-owners.mjs)
- [verify-terrain-lod.mjs](verify-terrain-lod.mjs)
- [verify-terrain-popup.mjs](verify-terrain-popup.mjs)
- [verify-terrain-provider-ui.mjs](verify-terrain-provider-ui.mjs)
- [verify-terrain-visual.mjs](verify-terrain-visual.mjs)

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

## Weather and snow

- [verify-air-quality.mjs](verify-air-quality.mjs) — lazy AQI requests and refresh stability through the weather browser harness.

- [verify-ascent-weather.mjs](verify-ascent-weather.mjs)
- [verify-peak-cards.mjs](verify-peak-cards.mjs)
- [verify-peak-snow-cases.mjs](verify-peak-snow-cases.mjs)
- [verify-peak-weather-3d.mjs](verify-peak-weather-3d.mjs)
- [verify-peak-weather-cases.mjs](verify-peak-weather-cases.mjs)
- [verify-peak-weather-interactions.mjs](verify-peak-weather-interactions.mjs)
- [verify-peak-weather-refresh.mjs](verify-peak-weather-refresh.mjs)
- [verify-snotel-options.mjs](verify-snotel-options.mjs)
- [verify-snow-map-cases.mjs](verify-snow-map-cases.mjs)
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
- [verify-layout-stability.mjs](verify-layout-stability.mjs)
- [verify-ascent-column-widths.mjs](verify-ascent-column-widths.mjs) — nested summary/map and card edge alignment, run by `layout-stability`.
- [verify-photo-backup-status.mjs](verify-photo-backup-status.mjs)
- [verify-photo-editor.mjs](verify-photo-editor.mjs)
- [verify-photo-library-status.mjs](verify-photo-library-status.mjs)
- [verify-photo-report-edit.mjs](verify-photo-report-edit.mjs)
- [verify-report-caption-stability.mjs](verify-report-caption-stability.mjs)
- [verify-report-draft-ownership.mjs](verify-report-draft-ownership.mjs)
- [verify-report-photos.mjs](verify-report-photos.mjs)
- [verify-climber-files.mjs](verify-climber-files.mjs) — standalone list JSON downloads and guarded import transitions, run by `layout-stability`.
- [verify-settings-actions.mjs](verify-settings-actions.mjs) — held Settings actions and restore focus, run by `layout-stability`.
- [verify-settings-navigation.mjs](verify-settings-navigation.mjs)
- [verify-signed-out.mjs](verify-signed-out.mjs) — signed-out recovery and held filter retries in Chrome/Firefox; run with `npm run verify -- signed-out`.

