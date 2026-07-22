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
// Vendor globals (Chart, tzlookup, marked, maplibregl) are still delivered as
// separate copied scripts loaded ahead of the bundle that reads them — see the
// manifest and terrain.html — so they are not listed as bundle sources here.

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
    'options-favorites.js': path.join(root, 'options', 'favorites.js'),
    'options-utils.js': path.join(root, 'options', 'options-utils.js'),
    'popup-main.js': path.join(root, 'popup', 'popup.js'),
};
export function resolvePageSource(name) {
    return PAGE_LOCAL[name] || srcFile(name);
}

// One record per bundle. `out` is the dist-relative output path; `sources` are
// its explicit roots, ordered where sibling side effects depend on that order.
export const ENTRIES = [
    { out: 'background.js', sources: ['gpx/gpx-metrics.js', 'capture/capture-core.js', 'capture/capture-phases.js', 'capture/provider-url.js', 'terrain/terrain-tiles.js', 'terrain/terrain-cache.js', 'settings/settings-schema.js', 'settings/settings.js', 'settings/settings-transfer.js', 'favorites/favorite-climbers.js', 'github/github-errors.js', 'github/github-api.js', 'github/github-auth.js', 'github/github-client.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'background/github-routes.js', 'background/terrain-prefetch.js', 'background/background.js'] },
    { out: 'provider-page.js', sources: ['capture/provider-url.js', 'gpx/gpx-parse.js', 'capture/provider-page.js'] },

    { out: 'content/ascent-editor.js', sources: ['ascent/ascent-draft.js', 'gpx/gpx-parse.js', 'settings/settings-schema.js', 'settings/settings.js', 'ascent/ascent-upload.js', 'ascent/ascent-saved.js', 'reports/report-markup.js', 'reports/report-drafts.js', 'ui/dom.js', 'reports/report-editor.js'] },
    { out: 'content/ascent-backup.js', sources: ['peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'reports/report-markup.js', 'ascent/ascent-snapshot.js', 'ascent/ascent-backup-source.js', 'ascent/ascent-page.js', 'ui/dom.js', 'ascent/ascent-backup.js'] },
    { out: 'content/theme.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'theme/site-dark-css.js', 'theme/theme.js'] },
    { out: 'content/ascent-bridge.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'settings/bridge.js'] },
    { out: 'content/gpx-analyzer.js', sources: ['gpx/gpx-metrics.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'settings/settings-schema.js', 'gpx/gpx-analyzer.js'] },
    { out: 'content/terrain-map.js', sources: ['terrain/terrain-camera.js', 'settings/settings-schema.js', 'settings/settings.js', 'terrain/terrain-map.js'] },
    { out: 'content/ascent-filter.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ascent/ascent-filter.js'] },
    { out: 'content/climber-favorite.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'favorites/climber-favorite.js'] },
    { out: 'content/profile-backup.js', sources: ['peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ascent/ascent-snapshot.js', 'reports/report-markup.js', 'ascent/ascent-backup-source.js', 'ui/dom.js', 'profile/profile-backup.js'] },
    { out: 'content/peak-map-bridge.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'maps/peak-map-bridge.js'] },
    { out: 'content/peak-links.js', sources: ['maps/peak-links.js'] },
    { out: 'content/peak-map.js', sources: ['terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'settings/settings-schema.js', 'maps/peak-map.js'] },
    { out: 'content/big-map-bridge.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'maps/big-map-bridge.js'] },
    { out: 'content/big-map.js', sources: ['gpx/gpx-metrics.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'settings/settings-schema.js', 'maps/big-map.js'] },

    { out: 'terrain/terrain-frame.js', sources: ['terrain/terrain-camera.js', 'settings/settings-schema.js', 'terrain/terrain-cache.js', 'terrain/terrain-frame.js'] },
    // The options page keeps its head/tail split: the head bundle applies the
    // theme before first paint, the tail bundle runs the settings UI.
    { out: 'options/options-head.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js'], page: true },
    { out: 'options/options.js', sources: ['terrain/terrain-cache.js', 'reports/report-markup.js', 'reports/report-drafts.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ui/dom.js', 'options-utils.js', 'options-main.js', 'options-drafts.js', 'options-favorites.js'], page: true },
    { out: 'popup/popup-head.js', sources: ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js'], page: true },
    { out: 'popup/popup.js', sources: ['capture/capture-phases.js', 'popup-main.js'], page: true },
];

// Absolute source paths for one entry's bundle, in order.
export function entrySources(entry) {
    const resolve = entry.page ? resolvePageSource : srcFile;
    return entry.sources.map(resolve);
}

// Static files copied verbatim into dist. [from (root-relative), to (dist-relative)].
export const COPY_FILES = [
    ['ACKNOWLEDGEMENTS.md', 'ACKNOWLEDGEMENTS.md'],
    ['LICENSE', 'LICENSE'],
    ['PRIVACY.md', 'PRIVACY.md'],
    ['README.md', 'README.md'],
    ['manifest.json', 'manifest.json'],
    ['src/reports/report-editor.css', 'css/report-editor.css'],
    ['src/ascent/ascent-upload.css', 'css/ascent-upload.css'],
    ['src/ascent/ascent-backup.css', 'css/ascent-backup.css'],
    ['src/profile/profile-backup.css', 'css/profile-backup.css'],
    ['src/terrain/terrain-map.css', 'css/terrain-map.css'],
    ['src/maps/peak-links.css', 'css/peak-links.css'],
    ['terrain/terrain.html', 'terrain/terrain.html'],
    ['options/options.html', 'options/options.html'],
    ['options/buddy-refresh.html', 'options/buddy-refresh.html'],
    ['options/options.css', 'options/options.css'],
    ['popup/popup.html', 'popup/popup.html'],
    ['popup/popup.css', 'popup/popup.css'],
];

export const COPY_DIRS = [
    ['icons', 'icons'],
];

export const nodeModule = f => path.join(root, 'node_modules', f);

// Vendor browser builds sourced from npm into dist/vendor. marked, Chart.js, and
// MapLibre ship browser-ready UMD/global builds (byte-identical to the files that
// were previously hand-copied into vendor/). [from (node_modules), to (dist)].
export const VENDOR_COPY = [
    ['marked/lib/marked.umd.js', 'vendor/marked.umd.js'],
    ['chart.js/dist/chart.umd.min.js', 'vendor/chart.umd.min.js'],
    ['maplibre-gl/dist/maplibre-gl-csp.js', 'vendor/maplibre-gl-csp.js'],
    ['maplibre-gl/dist/maplibre-gl-csp-worker.js', 'vendor/maplibre-gl-csp-worker.js'],
    ['maplibre-gl/dist/maplibre-gl.css', 'vendor/maplibre-gl.css'],
    ['marked/LICENSE', 'vendor/marked-LICENSE.txt'],
    ['chart.js/LICENSE.md', 'vendor/chart-LICENSE.txt'],
    ['maplibre-gl/LICENSE.txt', 'vendor/maplibre-LICENSE.txt'],
    ['tz-lookup/LICENSE', 'vendor/tz-lookup-LICENSE.txt'],
];

// tz-lookup ships CommonJS only, so esbuild wraps it into a browser global
// (var tzlookup = …) that the MAIN-world GPX analyzer reads as globalThis.tzlookup.
export const VENDOR_TZ = { entry: 'tz-lookup/tz.js', out: 'vendor/tz-lookup.js', globalName: 'tzlookup' };
