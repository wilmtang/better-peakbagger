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
- [build.mts](build.mts)
- [generate-map-overlay-regions.mts](generate-map-overlay-regions.mts)
- [install-git-hooks.mts](install-git-hooks.mts)
- [maplibre-terrain-lod-patch.mts](maplibre-terrain-lod-patch.mts)
- [run-development.mts](run-development.mts)
- [run-firefox.mts](run-firefox.mts)

## Release, dependencies and repository checks

- [build-firefox-package.mts](build-firefox-package.mts)
- [check-amo-version.mts](check-amo-version.mts)
- [check-changelog-history.mts](check-changelog-history.mts)
- [check-npm-audit.mts](check-npm-audit.mts)
- [dependabot-queue-sweep.mts](dependabot-queue-sweep.mts)
- [dependabot-branch-cleanup.mts](dependabot-branch-cleanup.mts)
- [check-web-ext-lint.mts](check-web-ext-lint.mts)
- [copied-runtime-impact.mts](copied-runtime-impact.mts)
- [create-amo-metadata.mts](create-amo-metadata.mts)
- [create-chrome-description.mts](create-chrome-description.mts)
- [dependency-metadata.mts](dependency-metadata.mts)
- [privacy-guard.mts](privacy-guard.mts)
- [dom-tier.mts](dom-tier.mts) — Browser DOM tier harness for `.dom.mts` suites under `test/dom/`, with routed fixtures, extension stubs, and selection by suite or case.
- [svelte-build.mts](svelte-build.mts) — The shared Svelte compiler settings and esbuild plugin every bundle receives.
- [typecheck-node.mts](typecheck-node.mts) — Checks the Node TypeScript project as two programs: jsdom/DOM-driving files with the DOM library (`tsconfig.dom.check.json`), everything else without DOM globals.
- [typescript-policy.mts](typescript-policy.mts) — Rejects new or modified authored JavaScript in the staged index or a committed comparison; preserves generated/vendor formats.
- [publish-chrome.mts](publish-chrome.mts)
- [release-bump.mts](release-bump.mts)
- [release-changelog.mts](release-changelog.mts)
- [release-check.mts](release-check.mts)
- [release-package-identity.mts](release-package-identity.mts)
- [release-evidence.mts](release-evidence.mts)
- [release-preflight.mts](release-preflight.mts)
- [release-readiness.mts](release-readiness.mts) — Prepares permission disclosures and reports bounded optional public service probes; authentication and Google's uploaded-draft validation remain manual.
- [select-release-artifact.mts](select-release-artifact.mts)
- [stage-ui-ux-skill-update.mts](stage-ui-ux-skill-update.mts) — Enforces the checked skill-only patch and prepares the direct-main automation commit without executing downloaded helpers.
- [third-party-notices.mts](third-party-notices.mts)
- [update-ui-ux-skill.mts](update-ui-ux-skill.mts) — Pinned upstream skill updates with local-guidance preservation; `--check` previews without writing.
- [verify-release-archive.mts](verify-release-archive.mts)
- [verify-store-packages.mts](verify-store-packages.mts)

## Browser infrastructure and shared diagnostics

- [browser-verification-evidence.mts](browser-verification-evidence.mts)
- [browser-verification-fixtures.mts](browser-verification-fixtures.mts)
- [browser-verification-png.mts](browser-verification-png.mts)
- [chrome-launch-guard.mts](chrome-launch-guard.mts)
- [firefox-content-viewport.mts](firefox-content-viewport.mts)
- [firefox-verifier-processes.mts](firefox-verifier-processes.mts)
- [image-download-completion.mts](image-download-completion.mts)
- [layout-verification-plan.mts](layout-verification-plan.mts) — Exact-once browser/theme/viewport partitions and focused preflight selection.
- [peak-map-links-verification.mts](peak-map-links-verification.mts)
- [probe-chrome-extension-load.mts](probe-chrome-extension-load.mts) — Manual diagnostic probe comparing command-line and pipe-CDP (`Extensions.loadUnpacked`) unpacked-extension loading in Chrome for Testing against a disposable HTTPS Peakbagger fixture.
- [resource-stack.mts](resource-stack.mts)
- [verification-launch.mts](verification-launch.mts) — The one launch definition for hidden Playwright verifiers: disposable root, Seatbelt preflight, Chrome for Testing or an exact binary, exclusive extension and host-resolver flags, Firefox local DNS and deferred teardown.
- [verification-browser-identity.mts](verification-browser-identity.mts)
- [verification-repetitions.mts](verification-repetitions.mts)
- [verify.mts](verify.mts)
- [verify-dom.mts](verify-dom.mts) — `npm run verify -- dom`: runs the browser DOM tier in Chromium and Firefox.
- [verify-fixture-preflight.mts](verify-fixture-preflight.mts) — Early locale, evidence, worker authorization and shipped-fixture checks.

## Complete extension and package verification

- [verify-extension.mts](verify-extension.mts)
- [verify-firefox-extension.mts](verify-firefox-extension.mts)
- [verify-packaged-extensions.mts](verify-packaged-extensions.mts)

## Capture and providers

- [capture-preview-diagnostics.mts](capture-preview-diagnostics.mts)
- [verify-capture-flow.mts](verify-capture-flow.mts)
- [verify-capture-popup.mts](verify-capture-popup.mts)
- [verify-garmin-ui.mts](verify-garmin-ui.mts) — Garmin connection, inbox and popup geometry, recovery and keyboard checks in hidden Chrome and Firefox.
- [verify-connections.mts](verify-connections.mts) — Packaged Garmin, ImgBB and GitHub disconnect states, focus, duplicate activation and geometry in hidden Chrome and Firefox.
- [jszip-csp-patch.mts](jszip-csp-patch.mts) — Version-checked removal of JSZip's legacy string-evaluation scheduler fallback.
- [verify-capture-readiness.mts](verify-capture-readiness.mts)
- [verify-draft-recovery.mts](verify-draft-recovery.mts)
- [verify-multi-summit.mts](verify-multi-summit.mts)
- [verify-provider-contracts.mts](verify-provider-contracts.mts)
- [verify-provider-performance.mts](verify-provider-performance.mts)

## Maps, terrain and GPX

- [terrain-cdp.mts](terrain-cdp.mts) — Chrome DevTools Protocol plumbing shared by the terrain verifiers: debugging-port wait, WebSocket connection and page evaluation.
- [terrain-dem-fixture.mts](terrain-dem-fixture.mts)
- [terrain-lod-criteria.mts](terrain-lod-criteria.mts)
- [terrain-lod-probe.mts](terrain-lod-probe.mts)
- [terrain-readiness-diagnostics.mts](terrain-readiness-diagnostics.mts)
- [verify-gpx-header.mts](verify-gpx-header.mts)
- [verify-gpx-segments.mts](verify-gpx-segments.mts)
- [verify-map-controls.mts](verify-map-controls.mts)
- [verify-map-handoffs.mts](verify-map-handoffs.mts)
- [verify-onx.mts](verify-onx.mts)
- [verify-map-layer-control.mts](verify-map-layer-control.mts)
- [verify-map-layers.mts](verify-map-layers.mts)
- [verify-vector-map.mts](verify-vector-map.mts)
- [verify-map-location-cases.mts](verify-map-location-cases.mts)
- [verify-peak-link-order.mts](verify-peak-link-order.mts)
- [verify-peak-map-layout.mts](verify-peak-map-layout.mts)
- [verify-terrain-cache-owners.mts](verify-terrain-cache-owners.mts)
- [verify-terrain-lod.mts](verify-terrain-lod.mts)
- [verify-terrain-popup.mts](verify-terrain-popup.mts)
- [verify-terrain-provider-ui.mts](verify-terrain-provider-ui.mts)
- [terrain-toggle-readiness.mts](terrain-toggle-readiness.mts)
- [terrain-frame-creation.mts](terrain-frame-creation.mts)
- [verify-terrain-visual.mts](verify-terrain-visual.mts)

## Climbers and profiles

- [buddy-tab-diagnostics.mts](buddy-tab-diagnostics.mts)
- [climber-card-close-diagnostics.mts](climber-card-close-diagnostics.mts)
- [climber-regression-baseline.mts](climber-regression-baseline.mts)
- [signed-out-extension-verification.mts](signed-out-extension-verification.mts) — real-manifest Buddy recovery and signed-out local Favorite persistence in both browser gates.
- [verify-climber-hover-card.mts](verify-climber-hover-card.mts)
- [verify-climber-list-ui.mts](verify-climber-list-ui.mts)
- [verify-climber-membership.mts](verify-climber-membership.mts)
- [verify-climber-transitions.mts](verify-climber-transitions.mts)
- [verify-inline-buddies.mts](verify-inline-buddies.mts)
- [verify-profile-editor.mts](verify-profile-editor.mts)
- [verify-profile-preparation.mts](verify-profile-preparation.mts)
- [verify-profile-units.mts](verify-profile-units.mts)

## Weather and snow

- [verify-wildfires.mts](verify-wildfires.mts) — real Leaflet and hardware MapLibre wildfire rendering and recovery through the weather fixture harness.

- [verify-air-quality.mts](verify-air-quality.mts) — lazy AQI requests and refresh stability through the weather browser harness.
- [verify-air-quality-refresh.mts](verify-air-quality-refresh.mts) — deterministic DST refresh, UTC viewport anchoring and equal-reading live announcements in hidden Chrome and Firefox; time/provider responses are stubbed beside native markup and shipped CSS.

- [verify-ascent-weather.mts](verify-ascent-weather.mts)
- [verify-custom-overlays.mts](verify-custom-overlays.mts) — real unpacked editor, 18 transition and 24 keyboard-help cases at asserted content widths/zoom, negative geometry checks, direct HTTPS/CORS tiles, packaged workers and hardware 2D/3D rendering. `--loading-only` explicitly excludes editor/help matrices; unknown or duplicate selections fail before launch.
- [verify-custom-overlay-lifecycle.mts](verify-custom-overlay-lifecycle.mts) — `chrome|firefox startup|lifetime|cache`: real Leaflet and bundled renderer, fresh asynchronous startup, bounded canvas/listener ownership and real HTTP-cache revalidation with changed pixels, conditional responses and ordinary reuse at desktop/narrow widths; controlled providers, without the Settings editor or worker.
- [verify-custom-overlay-replacement.mts](verify-custom-overlay-replacement.mts) — hidden hardware Chrome at 1000×760: real MapLibre raster pixels through held replacement, viewport cancellation, rendered acceptance and source/listener teardown; controlled HTTPS provider, without the Settings editor or worker.
- [verify-custom-layer-settings.mts](verify-custom-layer-settings.mts) — `chrome|firefox` checks saved-source actions, alignment, long names, light/dark narrow layouts, enlarged text, guarded reorder/error/retry and delete cancellation. Twelve disclosure cases at 900/540 px heights check matching compact headers, Space/Enter expansion, retained focus, a pinned footer, reachable final content and scroll-aware keyboard tooltips. Opacity remains a map-only control.
- [verify-custom-layer-menu.mts](verify-custom-layer-menu.mts) — `chrome|firefox` compares built-in/custom row alignment, fonts, colors, checkbox/chevron dimensions, keyboard opacity/disclosure and anchored loading/error/retry/overzoom states at 736/320 × 800, both themes and normal/1.5x text. Presentation fixtures stub I/O; the unpacked integration verifiers cover real loading.
- [verify-private-layers.mts](verify-private-layers.mts) — protected query parameters and automatic TileJSON detection in real Settings, private map settings-file round-trip, private worker GETs without provider CORS, per-map approval, forged destination rejection and hardware 2D/3D in hidden Chrome/Firefox; test-only host pregrant does not prove native permission prompts.
- [custom-overlay-editor-verification.mts](custom-overlay-editor-verification.mts) — 18 shared Chrome/Firefox editor cases for compact spacing, field help, name/URL-only source setup, metadata/manual overrides and stable Save/detection pending/error/retry status; invoked by the custom-overlay verifier. The broader Firefox terrain GeoJSON proof gap is tracked in the private-relay closure ledger.
- [verify-peak-cards.mts](verify-peak-cards.mts)
- [verify-summit-cloud.mts](verify-summit-cloud.mts) — hidden Chrome/Firefox
  forecast-card interactions, full-hour navigation and layout stability; run with `npm run verify -- summit-cloud`.
- [verify-peak-snow-cases.mts](verify-peak-snow-cases.mts)
- [verify-peak-weather-3d.mts](verify-peak-weather-3d.mts)
- [verify-peak-weather-cases.mts](verify-peak-weather-cases.mts)
- [verify-peak-weather-interactions.mts](verify-peak-weather-interactions.mts)
- [verify-peak-weather-refresh.mts](verify-peak-weather-refresh.mts)
- [verify-snotel-options.mts](verify-snotel-options.mts)
- [verify-snow-map-cases.mts](verify-snow-map-cases.mts)
- [verify-snow-depth.mts](verify-snow-depth.mts) — Real-extension snow depth, opacity, keyboard recovery and enlarged layout.
- [verify-snow-map-fixture.mts](verify-snow-map-fixture.mts)
- [verify-weather-card-drag.mts](verify-weather-card-drag.mts)
- [verify-weather-clouds.mts](verify-weather-clouds.mts)
- [verify-weather-day-switches.mts](verify-weather-day-switches.mts)
- [verify-weather-intervals.mts](verify-weather-intervals.mts)
- [verify-weather-location.mts](verify-weather-location.mts)
- [verify-weather-model-refresh.mts](verify-weather-model-refresh.mts)
- [weather-verification-types.mts](weather-verification-types.mts) — typed controls shared by weather browser assertions.
- [verify-weather-tab-styles.mts](verify-weather-tab-styles.mts)

## Editors, backups, settings and layout

- [render-showcase.mts](render-showcase.mts)
- [report-table-selection.mts](report-table-selection.mts)
- [verify-api-rate-limits.mts](verify-api-rate-limits.mts)
- [verify-ascent-backup-lifecycle.mts](verify-ascent-backup-lifecycle.mts)
- [verify-firefox-terrain.mts](verify-firefox-terrain.mts)
- [verify-layout-stability.mts](verify-layout-stability.mts)
- [verify-ascent-column-widths.mts](verify-ascent-column-widths.mts) — native peak/ascent metadata widths, nested map containment and card edge alignment, run by `layout-stability`.
- [verify-ascent-filters.mts](verify-ascent-filters.mts) — native ascent filtering, visible counts and table-width stability, run by `layout-stability`.
- [verify-photo-backup-status.mts](verify-photo-backup-status.mts)
- [verify-photo-editor.mts](verify-photo-editor.mts)
- [verify-photo-output.mts](verify-photo-output.mts)
- [verify-popup-photo-entry.mts](verify-popup-photo-entry.mts)
- [verify-photo-library-status.mts](verify-photo-library-status.mts)
- [verify-photo-report-edit.mts](verify-photo-report-edit.mts)
- [verify-report-caption-stability.mts](verify-report-caption-stability.mts)
- [verify-report-security.mts](verify-report-security.mts) — real response protection, hostile reports, native map scripts, Quick Search and Cloudflare exceptions in hidden Chrome/Firefox.
- [verify-report-routes.mts](verify-report-routes.mts) — compiled-rule validation, encoded report/profile/editor routes, priority exclusions and native/encoded map children under the real report policy.
- [generate-report-protection.mts](generate-report-protection.mts) — readable source for the generated report-response rules; use `--write` to regenerate or `--check` to reject drift.
- [verify-instagram.mts](verify-instagram.mts) — packaged per-post grants, native captions, bounded player sizing, compact placeholders, consent, error/retry/cancel geometry and Rich paste in hidden Chrome/Firefox. Includes same-origin lazy-video playback and sandbox isolation. `npm run verify -- instagram`; `--live` checks public post/Reel samples and all slides plus decoded video playback in the reported mixed carousel. `--display` pregrants the optional host only in a disposable test copy, then checks native terminal navigation, identical pending/loaded viewport widths and live light/dark transitions with unchanged media colors/geometry. It does not prove the native permission prompt. `BPB_INSTAGRAM_LIVE_POST` adds one validated public sample.
- [verify-report-image-help.mts](verify-report-image-help.mts) — image-popover Instagram help: hover, keyboard dismissal, tooltip bounds and stable geometry at desktop/narrow widths in both themes and enlarged text; invoked by the Instagram verifier.
- [verify-report-draft-ownership.mts](verify-report-draft-ownership.mts)
- [verify-report-photos.mts](verify-report-photos.mts)
- [verify-climber-files.mts](verify-climber-files.mts) — standalone list JSON downloads and guarded import transitions, run by `layout-stability`.
- [verify-settings-actions.mts](verify-settings-actions.mts) — held Settings actions and restore focus, run by `layout-stability`.
- [settings-fragment-verification.mts](settings-fragment-verification.mts) — shared assertions for the packaged Settings anchor verifier.
- [verify-settings-navigation.mts](verify-settings-navigation.mts)
- [verify-settings-fragments.mts](verify-settings-fragments.mts) — real packaged Chrome/Firefox Settings anchors, refresh, keyboard navigation, Back/Forward and manual reading positions; run `npm run verify -- settings-navigation`.
- [verify-signed-out.mts](verify-signed-out.mts) — signed-out recovery and held filter retries in Chrome/Firefox; run with `npm run verify -- signed-out`.


- [verify-layer-inspection.mts](verify-layer-inspection.mts) — hidden Chrome/Firefox
  HTTPS fixtures for compact right-click overlay readings, pending/success/error
  geometry, keyboard retry, layer invalidation and 18-pixel square legend
  swatches beside complete depth ranges.
  Run with exactly `chrome` or `firefox`; `BPB_INSPECTION_SCREENSHOT_DIR` retains
  the desktop/narrow, light/dark and enlarged-text renders.

  `BPB_INSPECTION_CSS` can select a read-only historical stylesheet to prove that
  the swatch regression assertion rejects the previous full-width bars.
