// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    COPY_FILES,
    ENTRIES,
    VENDOR_COPY
} from '../../scripts/build-config.mjs';

const manifest = JSON.parse(await fs.readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));

// The build config is the single source of truth for what each bundle contains.
// The manifest only names bundle files; these helpers cross-check the two so a
// bundle can't silently lose a module or reorder its dependencies.
const bundle = out => ENTRIES.find(entry => entry.out === out);
const bundleSources = out => bundle(out)?.sources;
const contentEntry = js => manifest.content_scripts.find(entry => entry.js.includes(js));

test('capture permissions are explicit and provider access remains activeTab-only', () => {
    assert.equal(manifest.version, packageJson.version);
    for (const permission of ['activeTab', 'scripting', 'tabGroups', 'storage', 'alarms']) {
        assert.ok(manifest.permissions.includes(permission));
    }
    assert.ok(manifest.host_permissions.every(pattern => pattern.includes('peakbagger.com')));
    assert.ok(manifest.host_permissions.every(pattern => !/garmin|strava/i.test(pattern)));
    const declarativeMatches = [
        ...manifest.content_scripts.flatMap(entry => entry.matches),
        ...manifest.web_accessible_resources.flatMap(entry => entry.matches),
    ];
    assert.ok(declarativeMatches.every(pattern => pattern.startsWith('https://')),
        'content scripts and exposed resources must stay inside the HTTPS permission boundary');
    // One host convention, and it is the one host_permissions already states.
    // The manifest used to mix two: most entries enumerated www and the apex
    // while the theme, BigMap, and web-accessible entries used
    // https://*.peakbagger.com/*, which reaches subdomains the extension holds
    // no host permission for -- a content script injected where its own fetches
    // would be refused.
    const permittedHosts = manifest.host_permissions.map(pattern => pattern.replace(/\/\*$/, ''));
    assert.deepEqual(permittedHosts.slice().sort(),
        ['https://peakbagger.com', 'https://www.peakbagger.com']);
    for (const pattern of declarativeMatches) {
        assert.ok(permittedHosts.some(host => pattern.startsWith(`${host}/`)),
            `${pattern} reaches outside host_permissions`);
    }
    assert.equal(manifest.action.default_popup, 'popup/popup.html');
});

test('the worker ships as one bundle for both Chrome and Firefox', () => {
    // Chrome runs background.service_worker; Firefox runs background.scripts.
    // Both now point at the single bundled worker, so the two-list drift that
    // used to be possible (a module added to one array only) cannot happen.
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.deepEqual(manifest.background.scripts, ['background.js']);
    // The fail-closed coordinator is composed from these modules, in order.
    assert.deepEqual(bundleSources('background.js'),
        ['ui/units.js', 'gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'capture/upload-limits.js', 'capture/capture-core.js', 'capture/capture-phases.js', 'capture/provider-url.js', 'terrain/terrain-tiles.js', 'terrain/terrain-cache.js', 'settings/settings-schema.js', 'settings/settings.js', 'settings/settings-transfer.js', 'favorites/favorite-climbers.js', 'github/github-errors.js', 'github/github-api.js', 'github/github-auth.js', 'github/github-client.js', 'github/github-write-queue.js', 'photos/imgbb-client.js', 'photos/imgbb-auth.js', 'photos/photo-project.js', 'photos/photo-library.js', 'photos/photo-store.js', 'photos/photo-backup.js', 'reports/report-markup.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'background/public-errors.js', 'background/favorites-store.js', 'background/github-routes.js', 'background/photo-routes.js', 'background/settings-file-routes.js', 'background/terrain-activation.js', 'background/terrain-prefetch.js', 'background/background.js']);
    assert.deepEqual(bundleSources('provider-page.js'), [
        'capture/provider-url.js',
        'gpx/gpx-parse.js',
        'net/request-deadline.js',
        'capture/provider-page.js',
    ]);
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['locationInfo']);
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '152.0');
    assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, '142.0');
    assert.equal(manifest.minimum_chrome_version, '128');
});

test('ImgBB upload access is optional and scoped to its API origin', () => {
    assert.ok(manifest.optional_host_permissions.includes('https://api.imgbb.com/*'));
    assert.ok(!manifest.host_permissions.some(pattern => pattern.includes('imgbb.com')));
});

test('the canonical unpacked extension opens Chrome settings in a full tab', () => {
    assert.deepEqual(manifest.options_ui, {
        page: 'options/options.html',
        open_in_tab: true
    });
});

test('extension panels share one pre-paint theme bootstrap', () => {
    assert.deepEqual(bundleSources('options/options-head.js'),
        ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js']);
    assert.deepEqual(bundleSources('popup/popup-head.js'),
        ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js']);
    assert.deepEqual(bundleSources('popup/popup.js'), ['capture/capture-phases.js', 'capture/match-confidence.js', 'peakbagger/peakbagger-origin.js', 'settings/settings-schema.js', 'settings/settings.js', 'ui/units.js', 'popup-main.js']);
});

test('the site theme runs its tiny fallback before the full dynamic bundle', () => {
    const themeEntry = contentEntry('content/theme.js');
    assert.ok(themeEntry);
    assert.equal(themeEntry.run_at, 'document_start');
    assert.deepEqual(themeEntry.js, ['content/theme-early.js', 'content/theme.js']);
    assert.deepEqual(bundleSources('content/theme-early.js'),
        ['theme/theme-resolve.js', 'theme/theme-bootstrap.js', 'theme/theme-early.js']);
    assert.deepEqual(bundleSources('content/theme.js'), [
        'settings/settings-schema.js',
        'settings/settings.js',
        'theme/theme-bootstrap.js',
        'theme/dynamic-inline-colors.js',
        'theme/site-dark-css.js',
        'theme/theme.js',
    ]);
});

test('the Buddy refresh helper is a fixed first-party navigation', async () => {
    assert.ok(COPY_FILES.some(([source, target]) =>
        source === 'options/buddy-refresh.html' && target === 'options/buddy-refresh.html'));
    const html = await fs.readFile(new URL('../../options/buddy-refresh.html', import.meta.url), 'utf8');
    assert.match(html,
        /<meta http-equiv="refresh" content="0;url=https:\/\/www\.peakbagger\.com\/report\/report\.aspx\?r=b">/);
    assert.doesNotMatch(html, /<script\b/i);
});

test('3D terrain is isolated from Peakbagger globals in an extension-owned frame', async () => {
    const analyzerEntry = contentEntry('content/gpx-analyzer.js');
    assert.ok(analyzerEntry);
    assert.equal(analyzerEntry.world, 'MAIN');
    assert.deepEqual(analyzerEntry.js, ['vendor/chart.umd.min.js', 'content/gpx-analyzer.js']);
    assert.deepEqual(bundleSources('content/gpx-analyzer.js'),
        ['ui/units.js', 'ui/dom.js', 'gpx/gpx-parse.js', 'gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'gpx/map-frame-lifecycle.js', 'gpx/map-viewport.js', 'gpx/map-overlay.js', 'gpx/gpx-panel-css.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'settings/settings-schema.js', 'settings/page-settings-client.js', 'theme/theme-resolve.js', 'gpx/gpx-analyzer.js']);

    const terrainEntry = manifest.content_scripts.find(entry =>
        entry.js.includes('content/terrain-map.js') && entry.matches.some(pattern => /ascent\.aspx/i.test(pattern)));
    assert.ok(terrainEntry);
    assert.equal(terrainEntry.world, undefined, 'terrain should run in the default isolated extension world');
    assert.deepEqual(terrainEntry.js, ['content/terrain-map.js']);
    assert.deepEqual(terrainEntry.css, ['css/terrain-map.css']);
    // terrain-failure.js is in this bundle because the bridge validates the
    // failure reason it relays against that module's set rather than a local
    // copy of it; a copy is how a reason the bridge had not heard of reached
    // the user as the wrong message. terrain-lifecycle.js likewise keeps the
    // parked-frame TTL shared with reviewer metadata instead of duplicating it.
    assert.deepEqual(bundleSources('content/terrain-map.js'), ['terrain/terrain-camera.js', 'terrain/terrain-failure.js', 'terrain/terrain-lifecycle.js', 'settings/settings-schema.js', 'settings/settings.js', 'terrain/terrain-map.js']);
    assert.ok(terrainEntry.matches.every(pattern => /peakbagger\.com\/climber\/(?:a|A)scent\.aspx/.test(pattern)));

    // Both entries are pages a Peakbagger tab has to be able to reach: the
    // terrain frame is embedded, and the photo guide is opened from the trip
    // report editor's image popover.
    assert.deepEqual(manifest.web_accessible_resources, [{
        resources: ['terrain/terrain.html', 'photos/guide.html'],
        matches: ['https://www.peakbagger.com/*', 'https://peakbagger.com/*']
    }]);
    // The extension-owned frame is a native module that imports the unmodified
    // local MapLibre ESM distribution. There is no page global or script-order
    // dependency for renderer startup.
    const terrainFrame = await fs.readFile(new URL('../../terrain/terrain.html', import.meta.url), 'utf8');
    assert.match(terrainFrame, /<script\s+type=["']module["']\s+src=["']terrain-frame\.js["']/);
    assert.doesNotMatch(terrainFrame, /vendor\/maplibre-gl\.js|\bmaplibregl\b/);
    for (const artifact of [
        ['maplibre-gl/dist/maplibre-gl.mjs', 'vendor/maplibre-gl.mjs'],
        ['maplibre-gl/dist/maplibre-gl-worker.mjs', 'vendor/maplibre-gl-worker.mjs'],
        ['maplibre-gl/dist/maplibre-gl-shared.mjs', 'vendor/maplibre-gl-shared.mjs'],
        ['maplibre-gl/dist/maplibre-gl.css', 'vendor/maplibre-gl.css'],
        ['maplibre-gl/LICENSE.txt', 'vendor/maplibre-LICENSE.txt']
    ]) {
        assert.ok(VENDOR_COPY.some(entry => entry[0] === artifact[0] && entry[1] === artifact[1]),
            `${artifact[1]} must be packaged from MapLibre's local npm distribution`);
    }
    const [frameSource, rendererSource, workerSource] = await Promise.all([
        fs.readFile(new URL('../../dist/terrain/terrain-frame.js', import.meta.url), 'utf8'),
        fs.readFile(new URL('../../dist/vendor/maplibre-gl.mjs', import.meta.url), 'utf8'),
        fs.readFile(new URL('../../dist/vendor/maplibre-gl-worker.mjs', import.meta.url), 'utf8'),
        fs.access(new URL('../../dist/vendor/maplibre-gl-shared.mjs', import.meta.url)),
    ]);
    const staticImports = source => [...source.matchAll(/^\s*import(?:[^"'`;]*from\s*)?["']([^"']+)["']/gm)]
        .map(match => match[1]);
    assert.deepEqual(staticImports(frameSource), ['../vendor/maplibre-gl.mjs'],
        'the terrain entry must resolve MapLibre only from its packaged ESM file');
    assert.deepEqual(staticImports(rendererSource), ['./maplibre-gl-shared.mjs'],
        'the copied renderer must resolve only its packaged shared sibling');
    assert.deepEqual(staticImports(workerSource), ['./maplibre-gl-shared.mjs'],
        'the module worker must resolve only its packaged shared sibling');
    assert.doesNotMatch(terrainFrame, /<script[^>]+src=["']https?:/i,
        'the terrain frame must load renderer code only from the extension origin');
    const terrainBundle = ENTRIES.find(entry => entry.out === 'terrain/terrain-frame.js');
    assert.equal(terrainBundle.format, 'esm');
    assert.deepEqual(terrainBundle.browserImports, { 'maplibre-gl': '../vendor/maplibre-gl.mjs' });
    assert.deepEqual(bundleSources('terrain/terrain-frame.js'), ['gpx/map-route-limits.js', 'peakbagger/peakbagger-origin.js', 'terrain/terrain-camera.js', 'settings/settings-schema.js', 'settings/settings.js', 'terrain/terrain-cache.js', 'terrain/terrain-tiles.js', 'terrain/terrain-frame-runtime.js', 'terrain/terrain-frame.js']);
    const frameEntrySource = await fs.readFile(new URL('../../src/terrain/terrain-frame.js', import.meta.url), 'utf8');
    assert.match(frameEntrySource, /import \* as maplibre from ['"]maplibre-gl['"]/);
    assert.match(frameEntrySource, /settings\.requireCurrent\(\)/,
        'the web-accessible frame must re-check the feature gate itself');
    assert.doesNotMatch(frameEntrySource, /globalThis\.maplibregl/);
    assert.ok(manifest.host_permissions.every(pattern => !pattern.includes('mapterhorn.com')),
        'public CORS tiles must not broaden persistent extension host access');
});

test('Full Screen GPS maps get a narrow read-only bridge and a MAIN-world Leaflet enhancer', () => {
    const bridgeEntry = contentEntry('content/big-map-bridge.js');
    const pageEntry = contentEntry('content/big-map.js');
    assert.ok(bridgeEntry);
    assert.deepEqual(bridgeEntry.js, ['content/big-map-bridge.js']);
    assert.deepEqual(bundleSources('content/big-map-bridge.js'), ['settings/settings-schema.js', 'settings/settings.js', 'maps/big-map-bridge.js']);
    assert.equal(bridgeEntry.world, undefined);
    assert.ok(pageEntry);
    // The MAIN-world enhancer also bundles the shared metrics + basemap +
    // peak-feed and failure-semantics modules the 3D coordinator depends on,
    // before big-map.js.
    assert.deepEqual(pageEntry.js, ['content/big-map.js']);
    assert.equal(pageEntry.world, 'MAIN');
    assert.deepEqual(bundleSources('content/big-map.js'),
        ['gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'gpx/map-frame-lifecycle.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'settings/settings-schema.js', 'theme/theme-resolve.js', 'maps/big-map.js']);
    assert.ok(pageEntry.matches.every(pattern => /bigmap/i.test(pattern)));

    // The shared 3D terrain bridge is injected on BigMap too (isolated world,
    // with the terrain stylesheet) so the Full Screen map can flip to 3D.
    const bigMapTerrain = manifest.content_scripts.find(entry =>
        entry.js.includes('content/terrain-map.js') && entry.matches.every(pattern => /bigmap/i.test(pattern)));
    assert.ok(bigMapTerrain, 'BigMap should inject the terrain bridge');
    assert.deepEqual(bigMapTerrain.js, ['content/terrain-map.js']);
    assert.deepEqual(bigMapTerrain.css, ['css/terrain-map.css']);
    assert.equal(bigMapTerrain.world, undefined);

    // Preserve production order: the MAIN coordinator runs before the isolated
    // terrain bundle on the same page.
    assert.ok(manifest.content_scripts.indexOf(pageEntry) < manifest.content_scripts.indexOf(bigMapTerrain),
        'the BigMap MAIN bundle must run before the isolated terrain bundle');
});

test('ascent editor integration is isolated to Peakbagger and runtime code never names a Save control', async () => {
    const draftEntry = contentEntry('content/ascent-editor.js');
    assert.ok(draftEntry);
    assert.ok(draftEntry.matches.every(pattern => pattern.includes('peakbagger.com/climber/')));
    // The Markdown parser remains a separately loaded vendor script; the
    // offline tz-lookup raster is bundled into the consumer below.
    assert.deepEqual(draftEntry.js, ['vendor/marked.umd.js', 'content/ascent-editor.js']);
    assert.deepEqual(draftEntry.css, ['css/report-editor.css', 'css/ascent-upload.css']);
    assert.deepEqual(bundleSources('content/ascent-editor.js'),
        ['ui/units.js', 'capture/match-confidence.js', 'capture/upload-limits.js', 'peakbagger/peakbagger-origin.js', 'ascent/ascent-draft.js', 'gpx/gpx-parse.js', 'gpx/map-route-limits.js', 'gpx/gpx-metrics.js', 'settings/settings-schema.js', 'settings/settings.js', 'ascent/ascent-upload.js', 'ascent/ascent-saved.js', 'ascent/ascent-delete.js', 'reports/report-markup.js', 'reports/report-drafts.js', 'ui/dom.js', 'ui/runtime-message.js', 'reports/report-editor.js']);
    const timezoneConsumers = await Promise.all([
        'src/ascent/ascent-upload.js',
        'src/gpx/gpx-analyzer.js'
    ].map(path => fs.readFile(new URL(`../../${path}`, import.meta.url), 'utf8')));
    for (const source of timezoneConsumers) {
        assert.match(source, /import tzlookup from ['"]tz-lookup['"]/);
        assert.doesNotMatch(source, /globalThis\.tzlookup/);
    }
    const runtimeSource = await Promise.all([
        'src/ascent/ascent-draft.js',
        'src/background/background.js',
        'popup/popup.js'
    ].map(path => fs.readFile(new URL(`../../${path}`, import.meta.url), 'utf8')));
    assert.doesNotMatch(runtimeSource.join('\n'), /SaveButton|SaveButton2/);
});

test('peak planning links are isolated to Peak.aspx in the extension world', () => {
    const peakLinks = contentEntry('content/peak-links.js');
    assert.ok(peakLinks);
    assert.deepEqual(peakLinks.css, ['css/peak-links.css']);
    assert.equal(peakLinks.run_at, 'document_end');
    assert.equal(peakLinks.world, undefined);
    assert.ok(peakLinks.matches.every(pattern => /peakbagger\.com\/(?:P|p)eak\.aspx/.test(pattern)));
});

test('the ascent sorter also reaches the Buddy List and Peak List endpoints', () => {
    const sorter = contentEntry('content/ascent-filter.js');
    assert.ok(sorter);
    assert.equal(sorter.run_at, 'document_start');
    assert.equal(sorter.world, undefined);
    assert.deepEqual(bundleSources('content/ascent-filter.js'),
        ['settings/settings-schema.js', 'settings/settings.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ascent/ascent-filter.js']);
    for (const host of ['https://www.peakbagger.com', 'https://peakbagger.com']) {
        assert.ok(sorter.matches.includes(`${host}/report/report.aspx*`));
        assert.ok(sorter.matches.includes(`${host}/List.aspx*`));
        assert.ok(sorter.matches.includes(`${host}/list.aspx*`));
    }
});

test('climber pages get the favorite toggle and confirmed Buddy refresh in the extension world', () => {
    const script = contentEntry('content/climber-favorite.js');
    assert.ok(script);
    assert.equal(script.run_at, 'document_end');
    assert.equal(script.world, undefined);
    assert.deepEqual(bundleSources('content/climber-favorite.js'),
        ['settings/settings-schema.js', 'settings/settings.js', 'favorites/favorite-climbers.js', 'peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'favorites/climber-favorite.js']);
    assert.equal(script.matches.length, 4);
    assert.ok(script.matches.every(pattern => /peakbagger\.com\/climber\/(?:C|c)limber\.aspx/.test(pattern)));
});

test('Peak-page 3D uses a narrow settings bridge, MAIN coordinator, and isolated renderer bridge', () => {
    const settingsBridge = contentEntry('content/peak-map-bridge.js');
    const pageCoordinator = contentEntry('content/peak-map.js');
    const terrainBridge = manifest.content_scripts.find(entry =>
        entry.js.includes('content/terrain-map.js')
        && entry.matches.every(pattern => /peakbagger\.com\/(?:P|p)eak\.aspx/.test(pattern)));

    assert.ok(settingsBridge);
    assert.deepEqual(settingsBridge.js, ['content/peak-map-bridge.js']);
    assert.deepEqual(bundleSources('content/peak-map-bridge.js'), ['settings/settings-schema.js', 'settings/settings.js', 'maps/peak-map-bridge.js']);
    assert.equal(settingsBridge.run_at, 'document_start');
    assert.equal(settingsBridge.world, undefined);

    assert.ok(pageCoordinator);
    assert.deepEqual(pageCoordinator.js, ['content/peak-map.js']);
    assert.deepEqual(bundleSources('content/peak-map.js'),
        ['peakbagger/peakbagger-origin.js', 'terrain/terrain-basemap.js', 'terrain/terrain-camera.js', 'terrain/terrain-compass.js', 'terrain/terrain-coordinator.js', 'terrain/terrain-failure.js', 'maps/peak-markers.js', 'settings/settings-schema.js', 'theme/theme-resolve.js', 'maps/peak-map.js']);
    assert.equal(pageCoordinator.run_at, 'document_end');
    assert.equal(pageCoordinator.world, 'MAIN');

    assert.ok(terrainBridge);
    assert.deepEqual(terrainBridge.css, ['css/terrain-map.css']);
    assert.deepEqual(terrainBridge.js, ['content/terrain-map.js']);
    assert.equal(terrainBridge.world, undefined);
    assert.ok(manifest.content_scripts.indexOf(pageCoordinator) < manifest.content_scripts.indexOf(terrainBridge),
        'the Peak MAIN coordinator must run before the isolated terrain bundle');
});

// Every bundle the manifest and the HTML pages reference must be a real build
// output. This is the replacement for hand-pinning src/ script arrays: if the
// manifest names a bundle the build config never produces, the load is dead.
test('every manifest and page bundle reference is a declared build output', () => {
    const outputs = new Set(ENTRIES.map(entry => entry.out));
    const referenced = new Set();
    for (const entry of manifest.content_scripts) {
        for (const js of entry.js) if (!js.startsWith('vendor/')) referenced.add(js);
    }
    referenced.add(manifest.background.service_worker);
    for (const js of referenced) {
        assert.ok(outputs.has(js), `manifest references ${js}, which the build config never emits`);
    }
});

test('full-profile backup is isolated to ClimbListC with its own bundled surface', () => {
    const script = manifest.content_scripts.find(entry => entry.js?.includes('content/profile-backup.js'));
    assert.ok(script);
    assert.deepEqual(script.js, ['content/profile-backup.js']);
    assert.deepEqual(script.css, ['css/profile-backup.css']);
    assert.ok(script.matches.every(match => /climblistc\.aspx/i.test(match)));
    const entry = ENTRIES.find(candidate => candidate.out === 'content/profile-backup.js');
    assert.deepEqual(entry.sources, ['peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'ascent/ascent-snapshot.js', 'reports/report-markup.js', 'ascent/ascent-backup-source.js', 'ui/dom.js', 'ui/runtime-message.js', 'profile/profile-backup.js']);
});

test('individual and profile backups bundle the same Peakbagger source reader', () => {
    const individual = contentEntry('content/ascent-backup.js');
    assert.ok(individual);
    assert.deepEqual(individual.css, ['css/ascent-backup.css']);
    assert.deepEqual(bundleSources('content/ascent-backup.js'),
        ['peakbagger/peakbagger-origin.js', 'peakbagger/peakbagger-cloudflare.js', 'peakbagger/peakbagger-response.js', 'peakbagger/peakbagger-error.js', 'peakbagger/peakbagger-request.js', 'profile/profile-backup-core.js', 'reports/report-markup.js', 'ascent/ascent-snapshot.js', 'ascent/ascent-backup-source.js', 'ascent/ascent-page.js', 'ui/dom.js', 'ui/runtime-message.js', 'ascent/ascent-backup.js']);
    assert.ok(bundleSources('content/profile-backup.js').includes('ascent/ascent-backup-source.js'));
});

// The MV3 service worker resolves its dependencies through the bundle, not
// importScripts. Boot the bundled worker and require that it comes up with its
// coordinator wired and its message listener registered.
test('the bundled service worker boots and registers its listener', async () => {
    const workerBundle = new URL('../../dist/background.js', import.meta.url);
    let bundleSource;
    try {
        bundleSource = readFileSync(workerBundle, 'utf8');
    } catch {
        assert.fail('dist/background.js is missing — run `npm run build` before the tests');
    }
    const context = vm.createContext({
        console, Math, Date, URL, URLSearchParams, structuredClone, btoa,
        fetch: async () => ({ ok: true, text: async () => '' })
    });
    context.globalThis = context;
    context.self = context;
    let registeredListener = false;
    context.chrome = {
        storage: {
            sync: { get: async () => ({}) },
            session: { get: async () => ({}) },
            local: { get: async () => ({}), set: async () => {} },
            onChanged: { addListener: () => {} },
        },
        runtime: {
            getURL: path => `chrome-extension://test-extension/${path}`,
            onMessage: { addListener: () => { registeredListener = true; } },
        },
        tabs: { onRemoved: { addListener: () => {} } },
        action: {},
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
    };
    vm.runInContext(bundleSource, context, { filename: 'dist/background.js' });

    // The bundle publishes no globals (zero-globals ESM); the worker is alive iff
    // it registered its capture message listener.
    assert.ok(registeredListener,
        'the worker never registered its message listener, so capture is dead');
});
