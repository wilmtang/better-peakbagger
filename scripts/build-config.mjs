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
    'options-theme.js': path.join(root, 'options', 'theme.js'),
    'options-main.js': path.join(root, 'options', 'options.js'),
    'options-drafts.js': path.join(root, 'options', 'drafts.js'),
    'popup-main.js': path.join(root, 'popup', 'popup.js'),
};
export function resolvePageSource(name) {
    return PAGE_LOCAL[name] || srcFile(name);
}

// One record per bundle. `out` is the dist-relative output path; `sources` are
// its explicit roots, ordered where sibling side effects depend on that order.
export const ENTRIES = [
    { out: 'background.js', sources: ['gpx-metrics.js', 'capture-core.js', 'provider-url.js', 'terrain-tiles.js', 'terrain-cache.js', 'settings-schema.js', 'settings.js', 'github-auth.js', 'github-client.js', 'background.js'] },
    { out: 'provider-page.js', sources: ['provider-url.js', 'gpx-parse.js', 'provider-page.js'] },

    { out: 'content/ascent-editor.js', sources: ['ascent-draft.js', 'gpx-parse.js', 'settings-schema.js', 'settings.js', 'ascent-upload.js', 'ascent-saved.js', 'report-markup.js', 'report-drafts.js', 'report-editor.js'] },
    { out: 'content/ascent-backup.js', sources: ['profile-backup-core.js', 'report-markup.js', 'ascent-snapshot.js', 'ascent-backup-source.js', 'ascent-page.js', 'ascent-backup.js'] },
    { out: 'content/theme.js', sources: ['settings-schema.js', 'settings.js', 'site-dark-css.js', 'theme.js'] },
    { out: 'content/ascent-bridge.js', sources: ['settings-schema.js', 'settings.js', 'bridge.js'] },
    { out: 'content/gpx-analyzer.js', sources: ['gpx-metrics.js', 'terrain-basemap.js', 'terrain-camera.js', 'terrain-compass.js', 'terrain-coordinator.js', 'terrain-failure.js', 'peak-markers.js', 'settings-schema.js', 'gpx-analyzer.js'] },
    { out: 'content/terrain-map.js', sources: ['terrain-camera.js', 'settings-schema.js', 'settings.js', 'terrain-map.js'] },
    { out: 'content/ascent-filter.js', sources: ['settings-schema.js', 'settings.js', 'ascent-filter.js'] },
    { out: 'content/profile-backup.js', sources: ['profile-backup-core.js', 'ascent-snapshot.js', 'report-markup.js', 'ascent-backup-source.js', 'profile-backup.js'] },
    { out: 'content/peak-map-bridge.js', sources: ['settings-schema.js', 'settings.js', 'peak-map-bridge.js'] },
    { out: 'content/peak-links.js', sources: ['peak-links.js'] },
    { out: 'content/peak-map.js', sources: ['terrain-basemap.js', 'terrain-camera.js', 'terrain-compass.js', 'terrain-coordinator.js', 'terrain-failure.js', 'peak-markers.js', 'settings-schema.js', 'peak-map.js'] },
    { out: 'content/big-map-bridge.js', sources: ['settings-schema.js', 'settings.js', 'big-map-bridge.js'] },
    { out: 'content/big-map.js', sources: ['gpx-metrics.js', 'terrain-basemap.js', 'terrain-camera.js', 'terrain-compass.js', 'terrain-coordinator.js', 'terrain-failure.js', 'peak-markers.js', 'settings-schema.js', 'big-map.js'] },

    { out: 'terrain/terrain-frame.js', sources: ['terrain-camera.js', 'settings-schema.js', 'terrain-cache.js', 'terrain-frame.js'] },
    // The options page keeps its head/tail split: the head bundle applies the
    // theme before first paint, the tail bundle runs the settings UI.
    { out: 'options/options-head.js', sources: ['settings-schema.js', 'settings.js', 'options-theme.js'], page: true },
    { out: 'options/options.js', sources: ['terrain-cache.js', 'report-markup.js', 'report-drafts.js', 'options-main.js', 'options-drafts.js'], page: true },
    { out: 'popup/popup.js', sources: ['popup-main.js'], page: true },
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
    ['src/report-editor.css', 'css/report-editor.css'],
    ['src/ascent-upload.css', 'css/ascent-upload.css'],
    ['src/ascent-backup.css', 'css/ascent-backup.css'],
    ['src/profile-backup.css', 'css/profile-backup.css'],
    ['src/terrain-map.css', 'css/terrain-map.css'],
    ['src/peak-links.css', 'css/peak-links.css'],
    ['terrain/terrain.html', 'terrain/terrain.html'],
    ['options/options.html', 'options/options.html'],
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
