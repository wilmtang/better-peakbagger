// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('capture permissions are explicit and provider access remains activeTab-only', () => {
    assert.equal(manifest.version, '1.4.0');
    for (const permission of ['activeTab', 'scripting', 'tabGroups', 'storage', 'alarms']) {
        assert.ok(manifest.permissions.includes(permission));
    }
    assert.ok(manifest.host_permissions.every(pattern => pattern.includes('peakbagger.com')));
    assert.ok(manifest.host_permissions.every(pattern => !/garmin|strava/i.test(pattern)));
    assert.equal(manifest.action.default_popup, 'popup/popup.html');
});

test('Chrome and Firefox background declarations share the same fail-closed coordinator', () => {
    assert.equal(manifest.background.service_worker, 'src/background.js');
    assert.deepEqual(manifest.background.scripts, ['src/capture-core.js', 'src/settings.js', 'src/background.js']);
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['locationInfo']);
});

test('settings are embedded in the browser add-on manager', () => {
    assert.deepEqual(manifest.options_ui, {
        page: 'options/options.html',
        open_in_tab: false
    });
});

test('3D terrain is isolated from Peakbagger globals and exposes only its packaged worker', () => {
    const terrainEntry = manifest.content_scripts.find(entry => entry.js.includes('src/terrain-map.js'));
    assert.ok(terrainEntry);
    assert.equal(terrainEntry.world, undefined, 'terrain should run in the default isolated extension world');
    assert.deepEqual(terrainEntry.js, ['vendor/maplibre-gl-csp.js', 'src/terrain-map.js']);
    assert.deepEqual(terrainEntry.css, ['vendor/maplibre-gl.css', 'src/terrain-map.css']);
    assert.ok(terrainEntry.matches.every(pattern => /peakbagger\.com\/climber\/(?:a|A)scent\.aspx/.test(pattern)));

    assert.deepEqual(manifest.web_accessible_resources, [{
        resources: ['vendor/maplibre-gl-csp-worker.js'],
        matches: ['*://*.peakbagger.com/*']
    }]);
    assert.ok(manifest.host_permissions.every(pattern => !pattern.includes('mapterhorn.com')),
        'public CORS tiles must not broaden persistent extension host access');
});

test('ascent editor integration is isolated to Peakbagger and runtime code never names a Save control', async () => {
    const draftEntry = manifest.content_scripts.find(entry => entry.js.includes('src/ascent-draft.js'));
    assert.ok(draftEntry);
    assert.ok(draftEntry.matches.every(pattern => pattern.includes('peakbagger.com/climber/')));
    const runtimeSource = await Promise.all([
        'src/ascent-draft.js',
        'src/background.js',
        'popup/popup.js'
    ].map(path => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
    assert.doesNotMatch(runtimeSource.join('\n'), /SaveButton|SaveButton2/);
});
