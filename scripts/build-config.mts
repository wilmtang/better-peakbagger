// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — build configuration (single source of truth).
//
// This module is the authority on how the extension is assembled: which source
// modules go into which bundle, in what order, and which static assets are
// copied. scripts/build.mts consumes it to produce dist/, and the test suite
// imports it to assert bundle composition, load order, and execution world
// without re-encoding the layout in each test.
//
// ES imports define dependency evaluation order. The order here remains
// significant for independent side-effect roots, and is pinned by tests.
// Vendor globals (Chart and marked) are still delivered as separate copied
// scripts loaded ahead of the bundles that read them — see the manifest — so
// they are not listed as bundle sources here. tz-lookup is bundled into its
// consumers, while the extension-owned terrain frame imports MapLibre as ESM.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distDir = path.join(root, 'dist');
export const srcFile = (f: string, projectRoot?: string | number) =>
    path.join(typeof projectRoot === 'string' ? projectRoot : root, 'src', f);

// Page bundles (options, popup) mix shared src/ modules with page-local files.
// Page-local names resolve here; every other name falls back to src/.
const PAGE_LOCAL_RELATIVE: Record<string, readonly [string, string]> = {
    'options-main.js': ['options', 'options.ts'],
    'garmin-settings-page.js': ['options', 'garmin.ts'],
    'garmin-inbox-page.js': ['options', 'inbox.ts'],
    'inbox-toolbar-setting-page.js': ['options', 'inbox-toolbar-setting.ts'],
    'options-drafts.js': ['options', 'drafts.ts'],
    'options-drafts-page.js': ['options', 'drafts-page.ts'],
    'options-favorites.js': ['options', 'favorites.ts'],
    'options-favorites-page.js': ['options', 'favorites-page.ts'],
    'options-buddy-refresh.js': ['options', 'buddy-refresh.ts'],
    'options-ignored.js': ['options', 'ignored.ts'],
    'options-favorites-backup.js': ['options', 'favorites-backup.ts'],
    'options-utils.js': ['options', 'options-utils.ts'],
    'popup-main.js': ['popup', 'popup.ts'],
    'photos-main.js': ['photos', 'photos.ts'],
    'photos-guide.js': ['photos', 'guide.ts'],
};
export function resolvePageSource(name: string, projectRoot?: string | number) {
    const base = typeof projectRoot === 'string' ? projectRoot : root;
    const relative = PAGE_LOCAL_RELATIVE[name];
    return relative ? path.join(base, ...relative) : srcFile(name, base);
}

// One record per bundle. `out` is the dist-relative output path; `sources` are
// its explicit roots, ordered where sibling side effects depend on that order.
export const ENTRIES: BundleEntry[] = [
    { out: 'reports/instagram-frame.js', sources: ['reports/instagram-frame.ts'] },
    { out: 'content/instagram-provider.js', sources: ['reports/instagram-provider.ts'] },
    { out: 'content/report-protection.js', sources: ['reports/report-protection.ts'] },
    { out: 'content/map-discovery.js', sources: ['maps/map-discovery.ts'] },
    { out: 'custom-overlay/worker.js', sources: ['maps/custom-overlay-worker.ts'] },
    { out: 'custom-overlay/editor.js', sources: ['maps/custom-overlay-editor.ts'] },
    { out: 'custom-overlay/access.js', sources: ['maps/custom-layer-access.ts'] },
    { out: 'custom-overlay/access-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'] },
    { out: 'content/custom-overlays-bridge.js', sources: ['maps/custom-overlay-bridge.ts'] },
    { out: 'options/garmin.js', sources: ['garmin-settings-page.js'], page: true },
    { out: 'options/inbox.js', sources: ['garmin-inbox-page.js'], page: true },
    { out: 'options/inbox-toolbar-setting.js', sources: ['inbox-toolbar-setting-page.js'], page: true },
    { out: 'content/profile-editor.js', sources: ['reports/report-editor.ts'] },
    { out: 'content/profile-units.js', sources: ['profile/profile-units.ts'] },
    { out: 'content/climber-hover-card.js', sources: ['favorites/climber-hover-card.ts'] },
    { out: 'background.js', patchJsZip: true, sources: ['ui/units.ts', 'gpx/map-route-limits.ts', 'gpx/gpx-metrics.ts', 'capture/upload-limits.ts', 'capture/capture-core.ts', 'capture/capture-phases.ts', 'capture/capture-error-policy.ts', 'capture/capture-diagnostics.ts', 'capture/provider-url.ts', 'capture/provider-timing.ts', 'terrain/terrain-tiles.ts', 'terrain/terrain-cache.ts', 'settings/settings-schema.ts', 'settings/settings.ts', 'settings/settings-transfer.ts', 'favorites/favorite-climbers.ts', 'github/github-errors.ts', 'github/github-api.ts', 'github/github-auth.ts', 'github/github-client.ts', 'github/github-write-queue.ts', 'photos/imgbb-client.ts', 'photos/imgbb-auth.ts', 'photos/photo-project.ts', 'photos/photo-library.ts', 'photos/photo-store.ts', 'photos/photo-backup.ts', 'photos/report-photo.ts', 'reports/report-markup.ts', 'peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'caltopo/caltopo-import.ts', 'alltrails/alltrails-import.ts', 'gaia/gaia-import.ts', 'gpx/saved-gpx-source.ts', 'onx/onx-import.ts', 'background/public-errors.ts', 'background/peakbagger-request-scheduler.ts', 'background/favorites-store.ts', 'background/github-routes.ts', 'background/report-photo-service.ts', 'background/photo-routes.ts', 'background/settings-file-routes.ts', 'background/terrain-activation.ts', 'background/trusted-actions.ts', 'background/gpx-handoff-routes.ts', 'background/caltopo-routes.ts', 'background/alltrails-routes.ts', 'background/gaia-routes.ts', 'background/onx-routes.ts', 'background/terrain-prefetch.ts', 'garmin/fit-message-reader.ts', 'garmin/fit-activity.ts', 'garmin/garmin-api.ts', 'garmin/garmin-store.ts', 'garmin/garmin-imports.ts', 'background/options-tab-routes.ts', 'background/background.ts'] },
    { out: 'provider-page.js', sources: ['capture/provider-url.ts', 'capture/provider-response.ts', 'capture/capture-error-policy.ts', 'capture/provider-timing.ts', 'gpx/gpx-parse.ts', 'net/request-deadline.ts', 'capture/provider-page.ts'] },
    { out: 'peakbagger-page.js', sources: ['peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'peakbagger/peakbagger-page.ts'] },

    { out: 'content/ascent-editor.js', sources: ['ui/units.ts', 'ui/page-lifecycle.ts', 'capture/match-confidence.ts', 'capture/upload-limits.ts', 'peakbagger/peakbagger-origin.ts', 'ascent/ascent-draft.ts', 'gpx/gpx-parse.ts', 'gpx/map-route-limits.ts', 'gpx/gpx-metrics.ts', 'settings/settings-schema.ts', 'settings/settings.ts', 'gpx/gpx-timestamps.ts', 'ascent/ascent-upload.ts', 'ascent/ascent-saved.ts', 'ascent/ascent-delete.ts', 'reports/report-markup.ts', 'reports/report-drafts.ts', 'ui/dom.ts', 'ui/runtime-message.ts', 'photos/report-photo.ts', 'photos/photo-project.ts', 'reports/report-local-photos.ts', 'reports/report-editor.ts'] },
    { out: 'content/ascent-backup.js', sources: ['peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'profile/profile-backup-core.ts', 'reports/report-markup.ts', 'ascent/ascent-snapshot.ts', 'ascent/ascent-backup-source.ts', 'ascent/ascent-page.ts', 'ui/dom.ts', 'ui/runtime-message.ts', 'ui/trusted-action.ts', 'ascent/ascent-backup.ts'] },
    { out: 'content/ascent-gaia.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'ascent/ascent-page.ts', 'caltopo/caltopo-import.ts', 'alltrails/alltrails-import.ts', 'gaia/gaia-import.ts', 'gpx/saved-gpx-source.ts', 'onx/onx-import.ts', 'ui/dom.ts', 'ui/page-lifecycle.ts', 'ui/runtime-message.ts', 'ui/trusted-action.ts', 'ui/stable-text.ts', 'ascent/ascent-gaia.ts'] },
    { out: 'content/ascent-report-visibility.js', sources: ['ascent/ascent-report-visibility.ts'] },
    { out: 'content/ascent-layout.js', sources: ['ui/dom.ts', 'ascent/ascent-table-split.ts', 'ascent/ascent-layout.ts'] },
    { out: 'content/ascent-weather.js', sources: ['ascent/ascent-weather.ts'] },
    { out: 'content/peak-weather.js', sources: ['weather/peak-weather.ts'] },
    { out: 'content/summit-cloud.js', sources: ['weather/summit-cloud.ts'] },
    { out: 'content/peak-snow.js', sources: ['snow/peak-snow.ts', 'maps/map-layer-bridge.ts'] },
    { out: 'content/peak-cards.js', sources: ['maps/peak-cards.ts'] },
    { out: 'content/theme-early.js', sources: ['theme/theme-resolve.ts', 'theme/theme-bootstrap.ts', 'theme/theme-early.ts'] },
    { out: 'content/theme.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/theme-bootstrap.ts', 'theme/dynamic-inline-colors.ts', 'theme/site-dark-css.ts', 'theme/theme.ts'] },
    { out: 'content/ascent-bridge.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'settings/bridge.ts'] },
    { out: 'content/gpx-analyzer.js', sources: ['ui/units.ts', 'ui/dom.ts', 'ui/page-lifecycle.ts', 'gpx/gpx-parse.ts', 'gpx/gpx-time-cursor.ts', 'gpx/map-route-limits.ts', 'gpx/gpx-metrics.ts', 'gpx/gpx-segment-diagnostics.ts', 'gpx/map-frame-lifecycle.ts', 'gpx/map-viewport.ts', 'gpx/map-overlay.ts', 'gpx/gpx-panel-css.ts', 'terrain/terrain-basemap.ts', 'terrain/terrain-camera.ts', 'terrain/terrain-compass.ts', 'terrain/terrain-coordinator.ts', 'terrain/terrain-failure.ts', 'maps/peak-markers.ts', 'peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'settings/settings-schema.ts', 'settings/page-settings-client.ts', 'theme/theme-resolve.ts', 'ascent/ascent-page.ts', 'time/mountain-time.ts', 'sun/sun-position.ts', 'sun/sun-state.ts', 'sun/sun-calculator.ts', 'gpx/gpx-analyzer.ts'] },
    { out: 'content/terrain-map.js', sources: ['terrain/terrain-camera.ts', 'terrain/terrain-failure.ts', 'terrain/terrain-lifecycle.ts', 'settings/settings-schema.ts', 'settings/settings.ts', 'terrain/terrain-map.ts'] },
    { out: 'content/ascent-filter.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'favorites/favorite-climbers.ts', 'peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'profile/profile-backup-core.ts', 'ui/trusted-action.ts', 'ascent/ascent-filter.ts'] },
    { out: 'content/climber-favorite.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'favorites/favorite-climbers.ts', 'peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'profile/profile-backup-core.ts', 'favorites/climber-favorite.ts', 'favorites/climber-ignore.ts'] },
    { out: 'content/profile-backup.js', sources: ['peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'profile/profile-backup-core.ts', 'ascent/ascent-snapshot.ts', 'reports/report-markup.ts', 'ascent/ascent-backup-source.ts', 'ui/dom.ts', 'ui/runtime-message.ts', 'ui/trusted-action.ts', 'profile/profile-backup.ts'] },
    { out: 'content/peak-map-bridge.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'maps/map-settings-bridge.ts', 'maps/peak-map-bridge.ts'] },
    { out: 'content/peak-links.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'avalanche/avalanche-location.ts', 'avalanche/avalanche-links.ts', 'maps/peak-link-order.ts', 'maps/peak-links.ts'] },
    { out: 'content/map-layers.js', sources: ['maps/map-layers.ts'] },
    { out: 'content/vector-map.js', sources: ['maps/vector-map.ts'] },
    { out: 'content/vector-map-bridge.js', sources: ['maps/vector-map-bridge.ts'] },
    { out: 'terrain/vector-map-frame.js', sources: ['maps/vector-map-frame.ts'], format: 'esm',
        browserImports: { 'maplibre-gl': '../vendor/maplibre-gl.mjs' } },
    { out: 'content/peak-report-filter.js', sources: ['favorites/peak-report-filter.ts'] },
    { out: 'content/peak-map.js', sources: ['ui/page-lifecycle.ts', 'peakbagger/peakbagger-origin.ts', 'terrain/terrain-basemap.ts', 'terrain/terrain-camera.ts', 'terrain/terrain-compass.ts', 'terrain/terrain-coordinator.ts', 'terrain/terrain-failure.ts', 'maps/peak-markers.ts', 'settings/settings-schema.ts', 'theme/theme-resolve.ts', 'time/mountain-time.ts', 'sun/sun-position.ts', 'sun/sun-state.ts', 'sun/sun-calculator.ts', 'maps/peak-map.ts'] },
    { out: 'content/big-map-bridge.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'maps/map-settings-bridge.ts', 'maps/big-map-bridge.ts'] },
    { out: 'content/big-map.js', sources: ['ui/page-lifecycle.ts', 'gpx/map-route-limits.ts', 'gpx/gpx-metrics.ts', 'gpx/map-frame-lifecycle.ts', 'terrain/terrain-basemap.ts', 'terrain/terrain-camera.ts', 'terrain/terrain-compass.ts', 'terrain/terrain-coordinator.ts', 'terrain/terrain-failure.ts', 'maps/peak-markers.ts', 'settings/settings-schema.ts', 'theme/theme-resolve.ts', 'maps/big-map.ts'] },
    { out: 'gaia/access-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'] },
    { out: 'bc-land/access-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'] },
    { out: 'bc-land/access.js', sources: ['maps/bc-land-access.ts'] },
    { out: 'gaia/access.js', sources: ['gaia/gaia-import.ts', 'gaia/access.ts'] },
    { out: 'onx/access-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'] },
    { out: 'onx/access.js', sources: ['onx/onx-import.ts', 'onx/access.ts'] },
    { out: 'caltopo/access-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'] },
    { out: 'caltopo/access.js', sources: ['caltopo/caltopo-import.ts', 'caltopo/access.ts'] },
    { out: 'alltrails/access-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'] },
    { out: 'alltrails/access.js', sources: ['alltrails/alltrails-import.ts', 'alltrails/access.ts'] },

    {
        out: 'terrain/terrain-frame.js',
        sources: ['gpx/map-route-limits.ts', 'peakbagger/peakbagger-origin.ts', 'terrain/terrain-camera.ts', 'settings/settings-schema.ts', 'settings/settings.ts', 'terrain/terrain-cache.ts', 'terrain/terrain-tiles.ts', 'terrain/terrain-frame-runtime.ts', 'terrain/terrain-frame.ts'],
        format: 'esm',
        browserImports: { 'maplibre-gl': '../vendor/maplibre-gl.mjs' }
    },
    // The options page keeps its head/tail split: the head bundle applies the
    // theme before first paint, the tail bundle runs the settings UI.
    { out: 'options/drafts-page.js', sources: ['peakbagger/peakbagger-origin.ts', 'reports/report-drafts.ts', 'reports/report-markup.ts', 'options-utils.js', 'options-drafts.js', 'options-drafts-page.js'], page: true },
    // The custom-list workspace ships as its own page bundle; only its GitHub
    // backup (options-favorites-backup.js) stays in the options bundle below.
    { out: 'options/favorites-page.js', sources: ['favorites/favorite-climbers.ts', 'peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'profile/profile-backup-core.ts', 'ui/runtime-message.ts', 'settings/settings-schema.ts', 'settings/settings.ts', 'options-utils.js', 'options-favorites.js', 'options-ignored.js', 'options-favorites-page.js'], page: true },
    { out: 'options/buddy-refresh.js', sources: ['favorites/favorite-climbers.ts', 'peakbagger/peakbagger-origin.ts', 'options-buddy-refresh.js'], page: true },
    { out: 'options/options-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'], page: true },
    { out: 'options/options.js', sources: ['terrain/terrain-cache.ts', 'reports/report-markup.ts', 'reports/report-drafts.ts', 'favorites/favorite-climbers.ts', 'peakbagger/peakbagger-origin.ts', 'peakbagger/peakbagger-cloudflare.ts', 'peakbagger/peakbagger-response.ts', 'peakbagger/peakbagger-error.ts', 'peakbagger/peakbagger-request.ts', 'profile/profile-backup-core.ts', 'ui/dom.ts', 'ui/runtime-message.ts', 'ui/section-nav.ts', 'options-utils.js', 'options-main.js', 'options-favorites-backup.js'], page: true },
    { out: 'popup/popup-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'], page: true },
    { out: 'popup/popup.js', sources: ['capture/provider-url.ts', 'capture/capture-phases.ts', 'capture/capture-error-policy.ts', 'capture/match-confidence.ts', 'peakbagger/peakbagger-origin.ts', 'settings/settings-schema.ts', 'settings/settings.ts', 'ui/units.ts', 'ui/stable-text.ts', 'popup-main.js'], page: true },
    { out: 'photos/photos-head.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts'], page: true },
    { out: 'photos/photos.js', sources: ['settings/settings-schema.ts', 'settings/settings.ts', 'photos/photo-project.ts', 'photos/photo-renderer.ts', 'photos/photo-library.ts', 'photos/photo-store.ts', 'photos/photo-archive.ts', 'photos/imgbb-client.ts', 'photos/photo-report-size.ts', 'photos/photo-upload-transaction.ts', 'photos/report-photo.ts', 'photos-main.js'], page: true },
    // The guide paints its symbol legend from the renderer so what it teaches
    // cannot drift from what the export draws; nothing else on it is dynamic.
    { out: 'photos/guide.js', sources: ['photos/photo-project.ts', 'photos/photo-renderer.ts', 'ui/section-nav.ts', 'photos-guide.js'], page: true },
];

// Absolute source paths for one entry's bundle, in order.
export interface BundleEntry {
    out: string; sources: string[]; page?: boolean; format?: string; browserImports?: Record<string, string>; [field: string]: unknown;
}

export function entrySources(entry: Pick<BundleEntry, 'page' | 'sources'>, projectRoot?: string | number) {
    const base = typeof projectRoot === 'string' ? projectRoot : root;
    return entry.sources.map(source => entry.page
        ? resolvePageSource(source, base)
        : srcFile(source, base));
}

// Reviewer metadata must name every authored top-level source root. Derive the
// list from the same resolved entry graph the build consumes so adding another
// page-local root cannot leave the AMO instructions behind.
export const AUTHORED_SOURCE_ROOTS = Object.freeze([...new Set(
    ENTRIES.flatMap(entry => entrySources(entry)).map(source => {
        const relative = path.relative(root, source);
        if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Bundle source is outside the repository: ${source}`);
        }
        return relative.split(path.sep)[0];
    })
)].sort());

// Static files copied verbatim into dist. [from (root-relative), to (dist-relative)].
export const COPY_FILES = [
    ['src/maps/custom-overlay-editor.html', 'custom-overlay/editor.html'],
    ['src/maps/custom-overlay-editor.css', 'custom-overlay/editor.css'],
    ['src/maps/custom-layer-access.html', 'custom-overlay/access.html'],
    ['src/maps/custom-layer-access.css', 'custom-overlay/access.css'],
    ['options/inbox.html', 'options/inbox.html'],
    ['options/garmin.css', 'css/garmin.css'],
    ['third_party/fit-file-parser-LICENSE.txt', 'vendor/fit-file-parser-LICENSE.txt'],
    ['src/favorites/climber-hover-card.css', 'css/climber-hover-card.css'],
    ['ACKNOWLEDGEMENTS.md', 'ACKNOWLEDGEMENTS.md'],
    ['LICENSE', 'LICENSE'],
    ['PRIVACY.md', 'PRIVACY.md'],
    ['README.md', 'README.md'],
    ['third_party/betacreator-LICENSE.txt', 'vendor/betacreator-LICENSE.txt'],
    ['manifest.json', 'manifest.json'],
    ['src/reports/instagram.css', 'css/instagram.css'],
    ['src/reports/report-protection.css', 'css/report-protection.css'],
    ['src/reports/instagram-provider.css', 'css/instagram-provider.css'],
    ['src/reports/instagram.html', 'reports/instagram.html'],
    ['src/reports/instagram-frame.css', 'reports/instagram-frame.css'],
    ['src/reports/report-protection.json', 'rules/report-protection.json'],
    ['src/reports/report-media.json', 'rules/report-media.json'],
    ['src/capture/draft-tab.html', 'capture/draft-tab.html'],
    // The panel design language, shared by every extension-owned page and the
    // popup; each page stylesheet below is loaded after it and only adds its
    // own layout.
    ['src/theme/panel.css', 'css/panel.css'],
    ['src/reports/report-editor.css', 'css/report-editor.css'],
    ['src/ascent/ascent-upload.css', 'css/ascent-upload.css'],
    ['src/ascent/ascent-backup.css', 'css/ascent-backup.css'],
    ['src/ascent/ascent-gaia.css', 'css/ascent-gaia.css'],
    ['src/gaia/access.css', 'css/gaia-access.css'],
    ['src/maps/bc-land-access.html', 'bc-land/access.html'],
    ['src/maps/bc-land-access.css', 'css/bc-land-access.css'],
    ['src/gaia/access.html', 'gaia/access.html'],
    ['src/onx/access.html', 'onx/access.html'],
    ['src/caltopo/access.html', 'caltopo/access.html'],
    ['src/alltrails/access.html', 'alltrails/access.html'],
    ['src/ascent/ascent-layout.css', 'css/ascent-layout.css'],
    ['src/ui/column-resize.css', 'css/column-resize.css'],
    ['src/ui/card-drag.css', 'css/card-drag.css'],
    ['src/ui/card.css', 'css/card.css'],
    ['src/ui/peak-card-layout.css', 'css/peak-card-layout.css'],
    ['src/ascent/ascent-weather.css', 'css/ascent-weather.css'],
    ['src/weather/peak-weather.css', 'css/peak-weather.css'],
    ['src/weather/summit-cloud.css', 'css/summit-cloud.css'],
    ['src/snow/peak-snow.css', 'css/peak-snow.css'],
    ['src/weather/weather-hourly-table.css', 'css/weather-hourly-table.css'],
    ['src/profile/profile-backup.css', 'css/profile-backup.css'],
    ['src/terrain/terrain-map.css', 'css/terrain-map.css'],
    ['src/maps/peak-links.css', 'css/peak-links.css'],
    ['src/maps/map-layers.css', 'css/map-layers.css'],
    ['src/sun/sun-calculator.css', 'css/sun-calculator.css'],
    ['terrain/terrain.html', 'terrain/terrain.html'],
    ['terrain/vector.html', 'terrain/vector.html'],
    ['src/maps/vector-map.css', 'css/vector-map.css'],
    ['src/maps/maptoolkit-attribution.png', 'images/maptoolkit-attribution.png'],
    ['options/options.html', 'options/options.html'],
    ['options/drafts.html', 'options/drafts.html'],
    ['options/favorites.html', 'options/favorites.html'],
    ['options/buddy-refresh.html', 'options/buddy-refresh.html'],
    ['options/options.css', 'options/options.css'],
    ['popup/popup.html', 'popup/popup.html'],
    ['popup/popup.css', 'popup/popup.css'],
    ['photos/photos.html', 'photos/photos.html'],
    ['photos/guide.html', 'photos/guide.html'],
    ['photos/photos.css', 'photos/photos.css'],
];

export const COPY_DIRS = [
    ['icons', 'icons'],
];

// Generated artifacts are derived during every build and shipped alongside
// copied assets. They are part of the exact release inventory.
export const GENERATED_FILES = [
    'THIRD_PARTY_NOTICES.txt',
];

// Reviewed overrides are reserved for shipped material that has no npm package
// root for the metafile inventory to discover.
export const NON_PACKAGE_NOTICES = [
    { key: 'maptoolkit-attribution-logo', name: 'Maptoolkit attribution logo', version: '2026-10-31',
        license: 'LicenseRef-Maptoolkit-Community-Attribution', noticeFile: 'third_party/maptoolkit-attribution-NOTICE.txt' },
    { key: 'fit-file-parser-raw', name: 'fit-file-parser raw reader (locally modified)', version: '6.2.3',
        license: 'MIT', noticeFile: 'third_party/fit-file-parser-LICENSE.txt' },
    {
        key: 'natural-earth-canadian-land-routing',
        name: 'Natural Earth overlay coverage outlines',
        version: 'ca96624a56bd078437bca8184e78163e5039ad19',
        license: 'LicenseRef-Natural-Earth-Public-Domain',
        noticeFile: 'third_party/natural-earth-NOTICE.txt',
    },
    {
        key: 'betacreator-symbol-geometry',
        name: 'BetaCreator symbol geometry',
        version: '2a3b7898f009fbf4cf116673e121cf16202a5498',
        license: 'Apache-2.0',
        noticeFile: 'third_party/betacreator-LICENSE.txt',
    },
];

export const nodeModule = (f: string) => path.join(root, 'node_modules', f);

// Vendor browser builds sourced from npm into dist/vendor. marked and Chart.js
// ship browser-ready UMD/global builds. MapLibre 6's main module, module worker,
// and shared module are local copies; the main module receives the guarded
// terrain LOD correction in maplibre-terrain-lod-patch.mts. Worker/shared code
// stays byte-identical. terrain-frame.js imports the main module directly.
// [from (node_modules), to (dist)].
export const VENDOR_COPY = [
    ['marked/lib/marked.umd.js', 'vendor/marked.umd.js'],
    ['chart.js/dist/chart.umd.min.js', 'vendor/chart.umd.min.js'],
    ['maplibre-gl/dist/maplibre-gl.mjs', 'vendor/maplibre-gl.mjs'],
    ['maplibre-gl/dist/maplibre-gl-worker.mjs', 'vendor/maplibre-gl-worker.mjs'],
    ['maplibre-gl/dist/maplibre-gl-shared.mjs', 'vendor/maplibre-gl-shared.mjs'],
    ['maplibre-gl/dist/maplibre-gl.css', 'vendor/maplibre-gl.css'],
    ['marked/LICENSE', 'vendor/marked-LICENSE.txt'],
    ['chart.js/LICENSE.md', 'vendor/chart-LICENSE.txt'],
    ['maplibre-gl/LICENSE.txt', 'vendor/maplibre-LICENSE.txt'],
    ['tz-lookup/LICENSE', 'vendor/tz-lookup-LICENSE.txt'],
];
