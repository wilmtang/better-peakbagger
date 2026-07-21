// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ENTRIES } from '../scripts/build-config.mjs';

const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

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
        ['gpx-metrics.js', 'capture-core.js', 'provider-url.js', 'terrain-tiles.js', 'terrain-cache.js', 'settings-schema.js', 'settings.js', 'github-auth.js', 'github-client.js', 'background.js']);
    assert.deepEqual(bundleSources('provider-page.js'), ['provider-url.js', 'gpx-parse.js', 'provider-page.js']);
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['locationInfo']);
});

test('the canonical unpacked extension opens Chrome settings in a full tab', () => {
    assert.deepEqual(manifest.options_ui, {
        page: 'options/options.html',
        open_in_tab: true
    });
});

test('3D terrain is isolated from Peakbagger globals in an extension-owned frame', async () => {
    const analyzerEntry = contentEntry('content/gpx-analyzer.js');
    assert.ok(analyzerEntry);
    assert.equal(analyzerEntry.world, 'MAIN');
    assert.deepEqual(bundleSources('content/gpx-analyzer.js'),
        ['gpx-metrics.js', 'terrain-basemap.js', 'terrain-camera.js', 'terrain-compass.js', 'terrain-coordinator.js', 'terrain-failure.js', 'peak-markers.js', 'settings-schema.js', 'gpx-analyzer.js']);

    const terrainEntry = manifest.content_scripts.find(entry =>
        entry.js.includes('content/terrain-map.js') && entry.matches.some(pattern => /ascent\.aspx/i.test(pattern)));
    assert.ok(terrainEntry);
    assert.equal(terrainEntry.world, undefined, 'terrain should run in the default isolated extension world');
    assert.deepEqual(terrainEntry.js, ['content/terrain-map.js']);
    assert.deepEqual(terrainEntry.css, ['css/terrain-map.css']);
    assert.deepEqual(bundleSources('content/terrain-map.js'), ['terrain-camera.js', 'settings-schema.js', 'settings.js', 'terrain-map.js']);
    assert.ok(terrainEntry.matches.every(pattern => /peakbagger\.com\/climber\/(?:a|A)scent\.aspx/.test(pattern)));

    assert.deepEqual(manifest.web_accessible_resources, [{
        resources: ['terrain/terrain.html'],
        matches: ['https://*.peakbagger.com/*']
    }]);
    // The frame loads MapLibre (a copied vendor script) then the frame bundle,
    // which composes the shared camera/schema helpers, terrain cache, and frame.
    const terrainFrame = await fs.readFile(new URL('../terrain/terrain.html', import.meta.url), 'utf8');
    assert.match(terrainFrame, /vendor\/maplibre-gl-csp\.js/);
    assert.match(terrainFrame, /terrain-frame\.js/);
    assert.deepEqual(bundleSources('terrain/terrain-frame.js'), ['terrain-camera.js', 'settings-schema.js', 'terrain-cache.js', 'terrain-frame.js']);
    assert.ok(manifest.host_permissions.every(pattern => !pattern.includes('mapterhorn.com')),
        'public CORS tiles must not broaden persistent extension host access');
});

test('Full Screen GPS maps get a narrow read-only bridge and a MAIN-world Leaflet enhancer', () => {
    const bridgeEntry = contentEntry('content/big-map-bridge.js');
    const pageEntry = contentEntry('content/big-map.js');
    assert.ok(bridgeEntry);
    assert.deepEqual(bridgeEntry.js, ['content/big-map-bridge.js']);
    assert.deepEqual(bundleSources('content/big-map-bridge.js'), ['settings-schema.js', 'settings.js', 'big-map-bridge.js']);
    assert.equal(bridgeEntry.world, undefined);
    assert.ok(pageEntry);
    // The MAIN-world enhancer also bundles the shared metrics + basemap +
    // peak-feed and failure-semantics modules the 3D coordinator depends on,
    // before big-map.js.
    assert.deepEqual(pageEntry.js, ['content/big-map.js']);
    assert.equal(pageEntry.world, 'MAIN');
    assert.deepEqual(bundleSources('content/big-map.js'),
        ['gpx-metrics.js', 'terrain-basemap.js', 'terrain-camera.js', 'terrain-compass.js', 'terrain-coordinator.js', 'terrain-failure.js', 'peak-markers.js', 'settings-schema.js', 'big-map.js']);
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
    // The Markdown parser and the offline tz-lookup raster (copied vendor
    // scripts) must load before the bundle that reads them.
    assert.deepEqual(draftEntry.js, ['vendor/marked.umd.js', 'vendor/tz-lookup.js', 'content/ascent-editor.js']);
    assert.deepEqual(draftEntry.css, ['css/report-editor.css', 'css/ascent-upload.css']);
    assert.deepEqual(bundleSources('content/ascent-editor.js'),
        ['ascent-draft.js', 'gpx-parse.js', 'settings-schema.js', 'settings.js', 'ascent-upload.js', 'ascent-saved.js', 'report-markup.js', 'report-drafts.js', 'report-editor.js']);
    const runtimeSource = await Promise.all([
        'src/ascent-draft.js',
        'src/background.js',
        'popup/popup.js'
    ].map(path => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
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

test('Peak-page 3D uses a narrow settings bridge, MAIN coordinator, and isolated renderer bridge', () => {
    const settingsBridge = contentEntry('content/peak-map-bridge.js');
    const pageCoordinator = contentEntry('content/peak-map.js');
    const terrainBridge = manifest.content_scripts.find(entry =>
        entry.js.includes('content/terrain-map.js')
        && entry.matches.every(pattern => /peakbagger\.com\/(?:P|p)eak\.aspx/.test(pattern)));

    assert.ok(settingsBridge);
    assert.deepEqual(settingsBridge.js, ['content/peak-map-bridge.js']);
    assert.deepEqual(bundleSources('content/peak-map-bridge.js'), ['settings-schema.js', 'settings.js', 'peak-map-bridge.js']);
    assert.equal(settingsBridge.run_at, 'document_start');
    assert.equal(settingsBridge.world, undefined);

    assert.ok(pageCoordinator);
    assert.deepEqual(pageCoordinator.js, ['content/peak-map.js']);
    assert.deepEqual(bundleSources('content/peak-map.js'),
        ['terrain-basemap.js', 'terrain-camera.js', 'terrain-compass.js', 'terrain-coordinator.js', 'terrain-failure.js', 'peak-markers.js', 'settings-schema.js', 'peak-map.js']);
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
    assert.deepEqual(entry.sources, ['profile-backup-core.js', 'ascent-snapshot.js', 'report-markup.js', 'ascent-backup-source.js', 'profile-backup.js']);
});

test('individual and profile backups bundle the same Peakbagger source reader', () => {
    const individual = contentEntry('content/ascent-backup.js');
    assert.ok(individual);
    assert.deepEqual(individual.css, ['css/ascent-backup.css']);
    assert.deepEqual(bundleSources('content/ascent-backup.js'),
        ['profile-backup-core.js', 'report-markup.js', 'ascent-snapshot.js', 'ascent-backup-source.js', 'ascent-page.js', 'ascent-backup.js']);
    assert.ok(bundleSources('content/profile-backup.js').includes('ascent-backup-source.js'));
});

// The MV3 service worker resolves its dependencies through the bundle, not
// importScripts. Boot the bundled worker and require that it comes up with its
// coordinator wired and its message listener registered.
test('the bundled service worker boots and registers its listener', async () => {
    const workerBundle = new URL('../dist/background.js', import.meta.url);
    let bundleSource;
    try {
        bundleSource = readFileSync(workerBundle, 'utf8');
    } catch {
        assert.fail('dist/background.js is missing — run `npm run build` before the tests');
    }
    const context = vm.createContext({
        console, Math, Date, URL, URLSearchParams, structuredClone,
        fetch: async () => ({ ok: true, text: async () => '' })
    });
    context.globalThis = context;
    context.self = context;
    let registeredListener = false;
    context.chrome = {
        storage: { sync: { get: async () => ({}) }, session: { get: async () => ({}) } },
        runtime: { onMessage: { addListener: () => { registeredListener = true; } } },
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
