// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const readFile = fs.readFile;
const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('capture permissions are explicit and provider access remains activeTab-only', () => {
    assert.equal(manifest.version, packageJson.version);
    for (const permission of ['activeTab', 'scripting', 'tabGroups', 'storage', 'alarms']) {
        assert.ok(manifest.permissions.includes(permission));
    }
    assert.ok(manifest.host_permissions.every(pattern => pattern.includes('peakbagger.com')));
    assert.ok(manifest.host_permissions.every(pattern => !/garmin|strava/i.test(pattern)));
    assert.equal(manifest.action.default_popup, 'popup/popup.html');
});

test('Chrome and Firefox background declarations share the same fail-closed coordinator', () => {
    assert.equal(manifest.background.service_worker, 'src/background.js');
    assert.deepEqual(manifest.background.scripts, ['src/gpx-metrics.js', 'src/capture-core.js', 'src/settings-schema.js', 'src/settings.js', 'src/background.js']);
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['locationInfo']);
});

test('the canonical unpacked extension opens Chrome settings in a full tab', () => {
    assert.deepEqual(manifest.options_ui, {
        page: 'options/options.html',
        open_in_tab: true
    });
});

test('3D terrain is isolated from Peakbagger globals in an extension-owned frame', async () => {
    const terrainEntry = manifest.content_scripts.find(entry => entry.js.includes('src/terrain-map.js'));
    assert.ok(terrainEntry);
    assert.equal(terrainEntry.world, undefined, 'terrain should run in the default isolated extension world');
    assert.deepEqual(terrainEntry.js, ['src/settings-schema.js', 'src/settings.js', 'src/terrain-map.js']);
    assert.deepEqual(terrainEntry.css, ['src/terrain-map.css']);
    assert.ok(terrainEntry.matches.every(pattern => /peakbagger\.com\/climber\/(?:a|A)scent\.aspx/.test(pattern)));

    assert.deepEqual(manifest.web_accessible_resources, [{
        resources: ['terrain/terrain.html'],
        matches: ['*://*.peakbagger.com/*']
    }]);
    const terrainFrame = await fs.readFile(new URL('../terrain/terrain.html', import.meta.url), 'utf8');
    assert.match(terrainFrame, /vendor\/maplibre-gl-csp\.js/);
    assert.match(terrainFrame, /src\/terrain-frame\.js/);
    assert.ok(manifest.host_permissions.every(pattern => !pattern.includes('mapterhorn.com')),
        'public CORS tiles must not broaden persistent extension host access');
});

test('Full Screen GPS maps get a narrow read-only bridge and a MAIN-world Leaflet enhancer', () => {
    const bridgeEntry = manifest.content_scripts.find(entry => entry.js.includes('src/big-map-bridge.js'));
    const pageEntry = manifest.content_scripts.find(entry => entry.js.includes('src/big-map.js'));
    assert.ok(bridgeEntry);
    assert.deepEqual(bridgeEntry.js, ['src/settings-schema.js', 'src/settings.js', 'src/big-map-bridge.js']);
    assert.equal(bridgeEntry.world, undefined);
    assert.ok(pageEntry);
    // The MAIN-world enhancer also loads the shared metrics + basemap +
    // peak-feed modules the 3D coordinator depends on, before big-map.js.
    assert.deepEqual(pageEntry.js, ['src/gpx-metrics.js', 'src/terrain-basemap.js', 'src/peak-markers.js', 'src/settings-schema.js', 'src/big-map.js']);
    assert.equal(pageEntry.world, 'MAIN');
    assert.ok(pageEntry.matches.every(pattern => /bigmap/i.test(pattern)));

    // The shared 3D terrain bridge is injected on BigMap too (isolated world,
    // with the terrain stylesheet) so the Full Screen map can flip to 3D.
    const bigMapTerrain = manifest.content_scripts.find(entry =>
        entry.js.includes('src/terrain-map.js') && entry.matches.every(pattern => /bigmap/i.test(pattern)));
    assert.ok(bigMapTerrain, 'BigMap should inject the terrain bridge');
    assert.deepEqual(bigMapTerrain.js, ['src/settings-schema.js', 'src/settings.js', 'src/terrain-map.js']);
    assert.deepEqual(bigMapTerrain.css, ['src/terrain-map.css']);
    assert.equal(bigMapTerrain.world, undefined);

    // Both document_end bundles name settings-schema.js, but in different
    // worlds. Chrome skipped it from the later MAIN bundle when the isolated
    // terrain bundle came first, so big-map.js hit its fail-closed guard and
    // never created the toggle. Match the working ascent-page order.
    assert.ok(manifest.content_scripts.indexOf(pageEntry) < manifest.content_scripts.indexOf(bigMapTerrain),
        'the BigMap MAIN bundle must run before the isolated terrain bundle');
});

test('ascent editor integration is isolated to Peakbagger and runtime code never names a Save control', async () => {
    const draftEntry = manifest.content_scripts.find(entry => entry.js.includes('src/ascent-draft.js'));
    assert.ok(draftEntry);
    assert.ok(draftEntry.matches.every(pattern => pattern.includes('peakbagger.com/climber/')));
    assert.deepEqual(draftEntry.js, [
        'src/ascent-draft.js',
        'vendor/marked.umd.js',
        'src/report-markup.js',
        'src/report-editor.js'
    ], 'the Markdown parser must load before the conversion and editor scripts');
    const runtimeSource = await Promise.all([
        'src/ascent-draft.js',
        'src/background.js',
        'popup/popup.js'
    ].map(path => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
    assert.doesNotMatch(runtimeSource.join('\n'), /SaveButton|SaveButton2/);
});

test('peak planning links are isolated to Peak.aspx in the extension world', () => {
    const peakLinks = manifest.content_scripts.find(entry => entry.js.includes('src/peak-links.js'));
    assert.ok(peakLinks);
    assert.deepEqual(peakLinks.css, ['src/peak-links.css']);
    assert.equal(peakLinks.run_at, 'document_end');
    assert.equal(peakLinks.world, undefined);
    assert.ok(peakLinks.matches.every(pattern => /peakbagger\.com\/(?:P|p)eak\.aspx/.test(pattern)));
});

test('Peak-page 3D uses a narrow settings bridge, MAIN coordinator, and isolated renderer bridge', () => {
    const settingsBridge = manifest.content_scripts.find(entry => entry.js.includes('src/peak-map-bridge.js'));
    const pageCoordinator = manifest.content_scripts.find(entry => entry.js.includes('src/peak-map.js'));
    const terrainBridge = manifest.content_scripts.find(entry =>
        entry.js.includes('src/terrain-map.js')
        && entry.matches.every(pattern => /peakbagger\.com\/(?:P|p)eak\.aspx/.test(pattern)));

    assert.ok(settingsBridge);
    assert.deepEqual(settingsBridge.js, ['src/settings-schema.js', 'src/settings.js', 'src/peak-map-bridge.js']);
    assert.equal(settingsBridge.run_at, 'document_start');
    assert.equal(settingsBridge.world, undefined);

    assert.ok(pageCoordinator);
    assert.deepEqual(pageCoordinator.js,
        ['src/terrain-basemap.js', 'src/peak-markers.js', 'src/settings-schema.js', 'src/peak-map.js']);
    assert.equal(pageCoordinator.run_at, 'document_end');
    assert.equal(pageCoordinator.world, 'MAIN');

    assert.ok(terrainBridge);
    assert.deepEqual(terrainBridge.css, ['src/terrain-map.css']);
    assert.deepEqual(terrainBridge.js, ['src/settings-schema.js', 'src/settings.js', 'src/terrain-map.js']);
    assert.equal(terrainBridge.world, undefined);
    assert.ok(manifest.content_scripts.indexOf(pageCoordinator) < manifest.content_scripts.indexOf(terrainBridge),
        'the Peak MAIN coordinator must run before the isolated terrain bundle');
});

// Chrome runs src/background.js as the MV3 service worker and ignores
// manifest.background.scripts (web-ext lint reports the property as
// Firefox-unsupported). Asserting that list therefore proves nothing about
// Chrome: the worker resolves its dependencies through its own importScripts.
// Boot the worker the way Chrome does and require that it comes up.
test('the Chrome service worker boots from its own importScripts and registers its listener', async () => {
    const context = vm.createContext({
        console, Math, Date, URL, URLSearchParams, structuredClone,
        fetch: async () => ({ ok: true, text: async () => '' })
    });
    context.globalThis = context;
    let registeredListener = false;
    context.chrome = {
        storage: { sync: { get: async () => ({}) }, session: { get: async () => ({}) } },
        runtime: { onMessage: { addListener: () => { registeredListener = true; } } },
        tabs: { onRemoved: { addListener: () => {} } },
        action: {},
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
    };
    const srcDir = new URL('../src/', import.meta.url);
    context.importScripts = (...files) => {
        for (const file of files) {
            vm.runInContext(readFileSync(new URL(file, srcDir), 'utf8'), context, { filename: file });
        }
    };
    vm.runInContext(readFileSync(new URL('background.js', srcDir), 'utf8'), context, { filename: 'background.js' });

    assert.equal(typeof context.BPBSettings, 'object',
        'settings.js bailed out — the worker is missing one of its importScripts');
    assert.equal(typeof context.BPBCaptureCore, 'object', 'capture-core.js bailed out');
    assert.ok(registeredListener,
        'the worker never registered its message listener, so capture is dead in Chrome');
});

// The Firefox list and the Chrome imports must not drift apart.
test('manifest background.scripts matches the worker importScripts order', async () => {
    const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
    const imported = [...background.matchAll(/importScripts\('([^']+)'\)/g)].map(match => `src/${match[1]}`);
    const declared = manifest.background.scripts.filter(script => script !== 'src/background.js');
    assert.deepEqual(imported, declared,
        'Firefox loads background.scripts and Chrome loads importScripts; they must list the same modules in the same order');
});
