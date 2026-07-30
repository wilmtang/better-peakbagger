import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsSchema } from '../../src/settings/settings-schema.js';
import { settingsTransfer } from '../../src/settings/settings-transfer.js';
import {
    loadOptions, el, waitFor, withGithubBackground, registerCleanup, root,
    makeCacheStorage
} from '../helpers/options-helpers.mjs';

registerCleanup();

test('settings GitHub controls back up, confirm restore, and persist automatic backup', async () => {
    const messages = [];
    const status = {
        connected: true,
        hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const restored = settingsTransfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    const dom = await loadOptions({ theme: 'dark', units: 'imperial' }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                messages.push(structuredClone(message));
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_SETTINGS_BACKUP') reply = {
                    ok: true,
                    result: { path: 'settings.json', commitUrl: 'https://github.com/ada/peaks/commit/settings123' }
                };
                if (message.type === 'GITHUB_SETTINGS_RESTORE') reply = {
                    ok: true,
                    content: settingsTransfer.serialize(restored)
                };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        }
    });

    await waitFor(dom, () => !el(dom, 'settings-backup-github-actions').hidden);
    assert.match(el(dom, 'settings-backup-github-status').textContent, /settings\.json.*ada\/peaks/);

    el(dom, 'settings-backup-github-backup').click();
    await waitFor(dom, () => messages.some(message => message.type === 'GITHUB_SETTINGS_BACKUP'));
    assert.deepEqual(messages.find(message => message.type === 'GITHUB_SETTINGS_BACKUP'), {
        type: 'GITHUB_SETTINGS_BACKUP'
    });
    await waitFor(dom, () => /Settings backed up ✓/.test(el(dom, 'settings-backup-github-status').textContent));
    const commitLink = el(dom, 'settings-backup-github-status').querySelector('a');
    assert.equal(commitLink.textContent, 'View commit');
    assert.equal(commitLink.getAttribute('href'), 'https://github.com/ada/peaks/commit/settings123');
    assert.equal(commitLink.getAttribute('target'), '_blank');
    assert.equal(commitLink.getAttribute('rel'), 'noopener noreferrer');
    await waitFor(dom, () => !el(dom, 'settings-backup-github-restore').disabled);

    el(dom, 'settings-backup-github-restore').click();
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);
    assert.match(el(dom, 'settings-backup-confirmation').textContent,
        /settings\.json from ada\/peaks.*Replaces your current settings/s);
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');

    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden);
    assert.equal(dom.chrome._store.bpbSettings.units, 'metric');
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-github-restore'));
    await waitFor(dom, () => /Stored as settings\.json/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-status').querySelector('a'), null,
        'changing settings must clear the success state for the older payload');

    const auto = el(dom, 'settings-backup-auto');
    auto.checked = true;
    auto.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.autoSettingsBackup === true);
});

test('settings backup reports in-row progress before its persistent success state', async () => {
    let finishBackup;
    const backupResponse = new Promise(resolve => { finishBackup = resolve; });
    const status = {
        connected: true,
        hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ theme: 'dark' }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = message => {
                if (message.type === 'GITHUB_AUTH_STATUS') return Promise.resolve(status);
                if (message.type === 'GITHUB_SETTINGS_BACKUP') return backupResponse;
                return Promise.resolve({});
            };
        },
    });

    await waitFor(dom, () => !el(dom, 'settings-backup-github-actions').hidden);
    el(dom, 'settings-backup-github-backup').click();
    await waitFor(dom, () => /Backing up settings to GitHub/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-backup').disabled, true);
    assert.equal(el(dom, 'settings-backup-github-restore').disabled, true);
    assert.equal(el(dom, 'settings-backup-auto').disabled, true);

    finishBackup({
        ok: true,
        result: { path: 'settings.json', commitUrl: 'https://github.com/ada/peaks/commit/settings456' },
    });
    await waitFor(dom, () => /Settings backed up ✓/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-backup').disabled, false);
    assert.equal(el(dom, 'settings-backup-github-status').querySelector('a').textContent, 'View commit');
});

test('settings GitHub controls point disconnected users to the shared connection', async () => {
    const dom = await loadOptions({}, {
        prepareChrome: withGithubBackground({ connected: false, hasToken: false })
    });
    await waitFor(dom, () => /Connect GitHub above/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-actions').hidden, true);
});

test('settings GitHub controls refresh after an in-page repository selection', async () => {
    let status = { connected: false, hasToken: false };
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_STATUS' ? status : {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        }
    });
    await waitFor(dom, () => /Connect GitHub above/.test(el(dom, 'settings-backup-github-status').textContent));

    status = {
        connected: true,
        hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    await dom.chrome.storage.local.set({ bpbGithubAuth: { repo: status.repo } });

    await waitFor(dom, () => !el(dom, 'settings-backup-github-actions').hidden);
    assert.match(el(dom, 'settings-backup-github-status').textContent, /settings\.json.*ada\/peaks/);
});

test('settings GitHub controls hide when the optional host permission is revoked', async () => {
    const dom = await loadOptions({}, {
        prepareChrome: withGithubBackground({
            connected: true,
            hasToken: true,
            repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        }, { grant: false })
    });
    await waitFor(dom, () => /Connect GitHub above/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-actions').hidden, true);
});

test('trip report credit is off by default and persists as an explicit opt-in', async () => {
    const dom = await loadOptions({});
    const checkbox = el(dom, 'add-report-credit');
    const row = checkbox.closest('.row');

    assert.equal(checkbox.checked, false);
    assert.match(row.querySelector('.title').textContent, /^Credit Better Peakbagger in trip reports$/);
    assert.match(row.querySelector('.desc').textContent, /small, editable store link.*change or remove/i);
    const invalidDom = await loadOptions({ addReportCredit: 'yes' });
    assert.equal(el(invalidDom, 'add-report-credit').checked, false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.addReportCredit === true);
});

test('experimental 3D map is off by default and discloses external DEM requests', async () => {
    const defaultDom = await loadOptions({});
    const checkbox = el(defaultDom, 'enable-3d-map');
    const row = checkbox.closest('.row');
    assert.equal(checkbox.checked, false);
    assert.match(row.querySelector('.title').textContent, /^Enable experimental 3D map$/);
    assert.match(row.querySelector('.experimental-badge').textContent, /^Experimental$/);
    assert.match(row.querySelector('.desc').textContent, /ascent maps.*Full Screen GPS maps.*Peak pages/i);
    assert.match(row.querySelector('.desc').textContent, /Mapterhorn.*OpenFreeMap.*viewed map area and request metadata/i);
    assert.deepEqual(Array.from(row.querySelectorAll('.desc a'), link => new URL(link.href).hostname), [
        'mapterhorn.com',
        'openfreemap.org'
    ]);

    const invalidDom = await loadOptions({ enable3dMap: 'yes' });
    assert.equal(el(invalidDom, 'enable-3d-map').checked, false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new defaultDom.window.Event('change'));
    await new Promise(r => defaultDom.window.setTimeout(r, 10));
    assert.equal(defaultDom.chrome._store.bpbSettings.enable3dMap, true);
});

test('activity capture settings have documented defaults and persist changes', async () => {
    const dom = await loadOptions({});
    assert.equal(el(dom, 'retain-waypoints').checked, true);
    assert.equal(el(dom, 'fill-ascent-details').checked, true);
    assert.equal(el(dom, 'fill-trip-info').checked, true);
    assert.equal(el(dom, 'fill-wilderness-nights').checked, true);
    assert.equal(el(dom, 'fill-external-url').checked, true);

    el(dom, 'retain-waypoints').checked = false;
    el(dom, 'retain-waypoints').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-ascent-details').checked = false;
    el(dom, 'fill-ascent-details').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-trip-info').checked = false;
    el(dom, 'fill-trip-info').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-wilderness-nights').checked = false;
    el(dom, 'fill-wilderness-nights').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-external-url').checked = false;
    el(dom, 'fill-external-url').dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 20));

    assert.equal(dom.chrome._store.bpbSettings.retainWaypoints, false);
    assert.equal(dom.chrome._store.bpbSettings.fillAscentDetails, false);
    assert.equal(dom.chrome._store.bpbSettings.fillTripInfo, false);
    assert.equal(dom.chrome._store.bpbSettings.fillWildernessNights, false);
    assert.equal(dom.chrome._store.bpbSettings.fillExternalUrl, false);
});

test('chart-series select populates from the stored setting', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'time' });
    assert.equal(el(dom, 'chart-series').value, 'time');
});

test('changing chart-series saves it to chrome.storage', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'both' });
    const sel = el(dom, 'chart-series');
    sel.value = 'distance';
    sel.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.chartDefaultSeries, 'distance');
});

test('an invalid chartDefaultSeries is cleaned to the default', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'bogus' });
    assert.equal(el(dom, 'chart-series').value, 'both');
});

test('map route appearance populates, enforces a visible casing, and saves edits', async () => {
    const dom = await loadOptions({
        mapRouteColor: '#2457A7',
        mapRouteWidth: 8,
        mapRouteCasingColor: 'not-a-color',
        mapRouteCasingWidth: 4
    });

    assert.equal(el(dom, 'map-route-color').value, '#2457a7');
    assert.equal(el(dom, 'map-route-width').value, '8');
    assert.equal(el(dom, 'map-route-casing-color').value, '#ffffff');
    assert.equal(el(dom, 'map-route-casing-width').value, '10');
    assert.equal(el(dom, 'map-route-casing-width').min, '10');

    const routeWidth = el(dom, 'map-route-width');
    routeWidth.value = '11';
    routeWidth.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapRouteWidth, 11);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingWidth, 13);
    assert.equal(el(dom, 'map-route-casing-width').min, '13');

    const casingColor = el(dom, 'map-route-casing-color');
    casingColor.value = '#efe8d5';
    casingColor.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingColor, '#efe8d5');
});

test('map route appearance resets every style control to its default', async () => {
    const defaults = settingsSchema.DEFAULTS;
    const dom = await loadOptions({
        mapRouteColor: '#2457a7',
        mapRouteWidth: 11,
        mapRouteCasingColor: '#efe8d5',
        mapRouteCasingWidth: 20
    });

    el(dom, 'map-route-reset').dispatchEvent(new dom.window.Event('click'));

    await waitFor(dom, () => dom.chrome._store.bpbSettings.mapRouteColor === defaults.mapRouteColor);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteWidth, defaults.mapRouteWidth);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingColor, defaults.mapRouteCasingColor);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingWidth, defaults.mapRouteCasingWidth);
    assert.equal(el(dom, 'map-route-color').value, defaults.mapRouteColor);
    assert.equal(el(dom, 'map-route-width').value, String(defaults.mapRouteWidth));
    assert.equal(el(dom, 'map-route-casing-color').value, defaults.mapRouteCasingColor);
    assert.equal(el(dom, 'map-route-casing-width').value, String(defaults.mapRouteCasingWidth));
    assert.equal(el(dom, 'map-route-casing-width').min, String(defaults.mapRouteWidth + 2));
    assert.equal(el(dom, 'status').textContent, 'Route appearance reset');
});

test('map viewport settings preserve and reset to Peakbagger\'s original size', async () => {
    const dom = await loadOptions({ mapViewportWidth: 100, mapViewportHeight: 2000 });
    assert.equal(el(dom, 'map-viewport-width').value, '450');
    assert.equal(el(dom, 'map-viewport-height').value, '720');

    const width = el(dom, 'map-viewport-width');
    width.value = '900';
    width.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapViewportWidth, 900);

    const height = el(dom, 'map-viewport-height');
    height.value = '560';
    height.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapViewportHeight, 560);

    el(dom, 'map-viewport-reset').dispatchEvent(new dom.window.Event('click'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapViewportWidth, 450);
    assert.equal(dom.chrome._store.bpbSettings.mapViewportHeight, 450);
    assert.equal(el(dom, 'status').textContent, 'Map size reset');
});

test('map layer memory is opt-in and disabling it forgets the saved layer', async () => {
    const defaultDom = await loadOptions({});
    assert.equal(el(defaultDom, 'remember-map-layer').checked, false);
    const invalidDom = await loadOptions({ rememberMapLayer: true, mapLastLayer: 'javascript:bad' });
    assert.equal(settingsSchema.clean(invalidDom.chrome._store.bpbSettings).mapLastLayer, '');

    const dom = await loadOptions({ rememberMapLayer: true, mapLastLayer: 'L_OT' });
    const checkbox = el(dom, 'remember-map-layer');
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.rememberMapLayer, false);
    assert.equal(dom.chrome._store.bpbSettings.mapLastLayer, '');
});

test('3D terrain cache stays hidden until enabled and reports current device usage', async () => {
    const css = await readFile(path.join(root, 'options', 'options.css'), 'utf8');
    assert.match(css, /#terrain-cache-row\[hidden\]\s*{\s*display:\s*none;\s*}/);

    const emptyCache = makeCacheStorage();
    const defaultDom = await loadOptions({}, { cacheStorage: emptyCache });
    const row = el(defaultDom, 'terrain-cache-row');
    assert.equal(row.hidden, true);
    assert.equal(emptyCache.keyCalls, 0, 'hidden cache settings should not inspect CacheStorage');

    const enable = el(defaultDom, 'enable-3d-map');
    enable.checked = true;
    enable.dispatchEvent(new defaultDom.window.Event('change'));
    await waitFor(defaultDom, () => el(defaultDom, 'terrain-cache-usage').textContent === 'Current cache: Empty');
    assert.equal(row.hidden, false);

    enable.checked = false;
    enable.dispatchEvent(new defaultDom.window.Event('change'));
    assert.equal(row.hidden, true, 'the cache row should hide immediately when 3D is disabled');

    const firstUrl = 'https://tiles.mapterhorn.com/14/2651/5947.webp';
    const secondUrl = 'https://tiles.mapterhorn.com/14/2651/5948.webp';
    const cacheStorage = makeCacheStorage({
        [firstUrl]: 1024 * 1024,
        [secondUrl]: 512 * 1024
    });
    const usageDom = await loadOptions({ enable3dMap: true }, { cacheStorage });
    await waitFor(usageDom, () => el(usageDom, 'terrain-cache-usage').textContent === 'Current cache: 1.5 MB');
    assert.equal(el(usageDom, 'terrain-cache-row').hidden, false);
    assert.match(usageDom.window.document.querySelector('.cache-limit').textContent, /Limit\s*MB/);
    assert.equal(el(usageDom, 'terrain-cache-limit').value, '512');

    cacheStorage.entries.set('https://tiles.mapterhorn.com/14/2651/5949.webp', 512 * 1024);
    await usageDom.chrome.storage.local.set({ bpbMapterhornDemIndexV1: {} });
    await waitFor(usageDom, () => el(usageDom, 'terrain-cache-usage').textContent === 'Current cache: 2.0 MB');
});

test('3D terrain cache limit remains bounded and persists edits', async () => {
    const defaultDom = await loadOptions({ enable3dMap: true });
    assert.equal(el(defaultDom, 'terrain-cache-limit').value, '512');

    const invalidDom = await loadOptions({ enable3dMap: true, terrainCacheLimitMb: 9000 });
    assert.equal(el(invalidDom, 'terrain-cache-limit').value, '2048');

    const dom = await loadOptions({ enable3dMap: true, terrainCacheLimitMb: 768 });
    const limit = el(dom, 'terrain-cache-limit');
    assert.equal(limit.value, '768');
    limit.value = '0';
    limit.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.terrainCacheLimitMb, 0);
});

test('the removed "minimum trip-report words" control is gone', async () => {
    const dom = await loadOptions({});
    assert.equal(el(dom, 'minwords'), null);
});
