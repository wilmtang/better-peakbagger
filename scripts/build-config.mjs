// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — build configuration (single source of truth).
//
// This module is the authority on how the extension is assembled: which source
// modules go into which bundle, in what order, and which static assets are
// copied. scripts/build.mjs consumes it to produce dist/, and the test suite
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
export const srcFile = f => path.join(root, 'src', f);

// Page bundles (options, popup) mix shared src/ modules with page-local files.
// Page-local names resolve here; every other name falls back to src/.
const PAGE_LOCAL = {
    'options-main.js': path.join(root, 'options', 'options.js'),
    'options-drafts.js': path.join(root, 'options', 'drafts.js'),
    'options-drafts-page.js': path.join(root, 'options', 'drafts-page.js'),
    'options-favorites.js': path.join(root, 'options', 'favorites.js'),
    'options-favorites-page.js': path.join(root, 'options', 'favorites-page.js'),
    'options-favorites-backup.js': path.join(root, 'options', 'favorites-backup.js'),
    'options-utils.js': path.join(root, 'options', 'options-utils.js'),
    'popup-main.js': path.join(root, 'popup', 'popup.js'),
    'photos-main.js': path.join(root, 'photos', 'photos.js'),
    'photos-guide.js': path.join(root, 'photos', 'guide.js'),
};
export function resolvePageSource(name) {
    return PAGE_LOCAL[name] || srcFile(name);
}

// One record per bundle. `out` is the dist-relative output path; `sources` are
// its explicit roots, ordered where sibling side effects depend on that order.
export const ENTRIES = [
    { out: 'background.js', sources: ['ui/units.js', 'gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'capture/upload-limits.js', 'capture/capture-core.js', 'capture/capture-phases.js', 'capture/provider-url.js', 'terrain/terrain-tiles.js', 'terrain/terrain-cache.js', 'settings/settings-schema.js', 'settings/settings.js', 'settings/settings-transfer.js', 'favorites/favorite-climbers.js', 'github/github-errors.js', 'github/github-api.js', 'github/github-auth.js', 'github/github-client.js', 'github/github-write-queue.js', 'photos/imgbb-client.js', 'photos/imgbb-auth.js', 'photos/photo-project.js', 'photos/photo-library.js', 'photos/photo-store.js', 'photos/photo-backup.js', 'reports/report-markup.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'background/public-errors.js', 'background/favorites-store.js', 'background/github-routes.js', 'background/photo-routes.js', 'background/settings-file-routes.js', 'background/terrain-activation.js', 'background/trusted-actions.js', 'background/terrain-prefetch.js', 'background/background.js'] },
    { out: 'provider-page.js', sources: ['capture/provider-url.js', 'gpx/gpx-parse.js', 'net/request-deadline.js', 'capture/provider-page.js'] },
    { out: 'peakbagger-page.js', sources: ['peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'peakbagger/peakbagger-page.js'] },

    { out: 'content/ascent-editor.js', sources: ['ui/units.js', 'capture/match-confidence.js', 'capture/upload-limits.js', 'peakbagger/peakbagger-origin.js', 'ascent/ascent-draft.js', 'gpx/gpx-parse.js', 'gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'settings/settings-schema.js', 'settings/settings.js', 'ascent/ascent-upload.js', 'ascent/ascent-saved.js', 'ascent/ascent-delete.js', 'reports/report-markup.js', 'reports/report-drafts.js', 'ui/dom.js', 'ui/runtime-message.js', 'reports/report-editor.js'] },
    { out: 'content/ascent-backup.js', sources: ['peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'reports/report-markup.js', 'ascent/ascent-snapshot.js', 'ascent/ascent-backup-source.js', 'ascent/ascent-page.js', 'ui/dom.js', 'ui/runtime-message.js', 'ui/trusted-action.js', 'ascent/ascent-backup.js'] },
    { out: 'content/theme-early.js', sources: ['theme/theme-resolve.js', 'theme/theme-bootstrap.js', 'theme/theme-early.js'] },
    { out: 'content/theme.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'theme/theme-bootstrap.js', 'theme/dynamic-inline-colors.js', 'theme/site-dark-css.js', 'theme/theme.js'] },
    { out: 'content/ascent-bridge.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'settings/bridge.js'] },
    { out: 'content/gpx-analyzer.js', sources: ['ui/units.js', 'ui/dom.js', 'gpx/gpx-parse.js', 'gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'gpx/map-frame-lifecycle.js', 'gpx/map-viewport.js', 'gpx/map-overlay.js', 'gpx/gpx-panel-css.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'settings/settings-schema.js', 'settings/page-settings-client.js', 'theme/theme-resolve.js', 'time/mountain-time.js', 'sun/sun-position.js', 'sun/sun-state.js', 'sun/sun-calculator.js', 'gpx/gpx-analyzer.js'] },
    { out: 'content/terrain-map.js', sources: ['terrain/terrain-camera.js', 'terrain/terrain-failure.js', 'terrain/terrain-lifecycle.js', 'settings/settings-schema.js', 'settings/settings.js', 'terrain/terrain-map.js'] },
    { out: 'content/ascent-filter.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ui/trusted-action.js', 'ascent/ascent-filter.js'] },
    { out: 'content/climber-favorite.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'favorites/climber-favorite.js'] },
    { out: 'content/profile-backup.js', sources: ['peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ascent/ascent-snapshot.js', 'reports/report-markup.js', 'ascent/ascent-backup-source.js', 'ui/dom.js', 'ui/runtime-message.js', 'ui/trusted-action.js', 'profile/profile-backup.js'] },
    { out: 'content/peak-map-bridge.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'maps/peak-map-bridge.js'] },
    { out: 'content/peak-links.js', sources: ['maps/peak-links.js'] },
    { out: 'content/peak-map.js', sources: ['peakbagger/peakbagger-origin.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'settings/settings-schema.js', 'theme/theme-resolve.js', 'time/mountain-time.js', 'sun/sun-position.js', 'sun/sun-state.js', 'sun/sun-calculator.js', 'maps/peak-map.js'] },
    { out: 'content/big-map-bridge.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'maps/big-map-bridge.js'] },
    { out: 'content/big-map.js', sources: ['gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'gpx/map-frame-lifecycle.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'settings/settings-schema.js', 'theme/theme-resolve.js', 'maps/big-map.js'] },

    {
        out: 'terrain/terrain-frame.js',
        sources: ['gpx/map-route-limits.js', 'peakbagger/peakbagger-origin.js', 'terrain/terrain-camera.js', 'settings/settings-schema.js', 'settings/settings.js', 'terrain/terrain-cache.js', 'terrain/terrain-tiles.js', 'terrain/terrain-frame-runtime.js', 'terrain/terrain-frame.js'],
        format: 'esm',
        browserImports: { 'maplibre-gl': '../vendor/maplibre-gl.mjs' }
    },
    // The options page keeps its head/tail split: the head bundle applies the
    // theme before first paint, the tail bundle runs the settings UI.
    { out: 'options/drafts-page.js', sources: ['peakbagger/peakbagger-origin.js', 'reports/report-drafts.js', 'reports/report-markup.js', 'options-utils.js', 'options-drafts.js', 'options-drafts-page.js'], page: true },
    // The custom-list workspace ships as its own page bundle; only its GitHub
    // backup (options-favorites-backup.js) stays in the options bundle below.
    { out: 'options/favorites-page.js', sources: ['favorites/favorite-climbers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ui/runtime-message.js', 'settings/settings-schema.js', 'settings/settings.js', 'options-utils.js', 'options-favorites.js', 'options-favorites-page.js'], page: true },
    { out: 'options/options-head.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js'], page: true },
    { out: 'options/options.js', sources: ['terrain/terrain-cache.js', 'reports/report-markup.js', 'reports/report-drafts.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ui/dom.js', 'ui/runtime-message.js', 'ui/section-nav.js', 'options-utils.js', 'options-main.js', 'options-favorites-backup.js'], page: true },
    { out: 'popup/popup-head.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js'], page: true },
    { out: 'popup/popup.js', sources: ['capture/capture-phases.js', 'capture/match-confidence.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-origin.js', 'settings/settings-schema.js', 'settings/settings.js', 'ui/units.js', 'popup-main.js'], page: true },
    { out: 'photos/photos-head.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js'], page: true },
    { out: 'photos/photos.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'photos/photo-project.js', 'photos/photo-renderer.js', 'photos/photo-library.js', 'photos/photo-store.js', 'photos/photo-archive.js', 'photos/imgbb-client.js', 'photos/photo-report-size.js', 'photos/photo-upload-transaction.js', 'photos-main.js'], page: true },
    // The guide paints its symbol legend from the renderer so what it teaches
    // cannot drift from what the export draws; nothing else on it is dynamic.
    { out: 'photos/guide.js', sources: ['photos/photo-project.js', 'photos/photo-renderer.js', 'ui/section-nav.js', 'photos-guide.js'], page: true },
];

// Absolute source paths for one entry's bundle, in order.
export function entrySources(entry) {
    const resolve = entry.page ? resolvePageSource : srcFile;
    return entry.sources.map(resolve);
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
    ['ACKNOWLEDGEMENTS.md', 'ACKNOWLEDGEMENTS.md'],
    ['LICENSE', 'LICENSE'],
    ['PRIVACY.md', 'PRIVACY.md'],
    ['README.md', 'README.md'],
    ['third_party/betacreator-LICENSE.txt', 'vendor/betacreator-LICENSE.txt'],
    ['manifest.json', 'manifest.json'],
    // The panel design language, shared by every extension-owned page and the
    // popup; each page stylesheet below is loaded after it and only adds its
    // own layout.
    ['src/theme/panel.css', 'css/panel.css'],
    ['src/reports/report-editor.css', 'css/report-editor.css'],
    ['src/ascent/ascent-upload.css', 'css/ascent-upload.css'],
    ['src/ascent/ascent-backup.css', 'css/ascent-backup.css'],
    ['src/profile/profile-backup.css', 'css/profile-backup.css'],
    ['src/terrain/terrain-map.css', 'css/terrain-map.css'],
    ['src/maps/peak-links.css', 'css/peak-links.css'],
    ['src/sun/sun-calculator.css', 'css/sun-calculator.css'],
    ['terrain/terrain.html', 'terrain/terrain.html'],
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
    {
        key: 'betacreator-symbol-geometry',
        name: 'BetaCreator symbol geometry',
        version: '2a3b7898f009fbf4cf116673e121cf16202a5498',
        license: 'Apache-2.0',
        noticeFile: 'third_party/betacreator-LICENSE.txt',
    },
];

export const nodeModule = f => path.join(root, 'node_modules', f);

// Vendor browser builds sourced from npm into dist/vendor. marked and Chart.js
// ship browser-ready UMD/global builds. MapLibre 6's main module, module worker,
// and shared module remain byte-identical local copies; terrain-frame.js imports
// the main module directly instead of depending on a generated page global.
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
