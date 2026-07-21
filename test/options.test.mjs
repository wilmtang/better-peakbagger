// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drives the real options page (options.html + settings.js + options.js) in
// jsdom against a chrome.storage stub, so the settings UI is exercised end to
// end without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub, waitFor, evalBundle } from './helpers/load-page.mjs';
import { settingsSchema } from '../src/settings-schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const makeCacheStorage = (initial = {}) => {
    const entries = new Map(Object.entries(initial));
    const cache = {
        async keys() { return Array.from(entries.keys(), url => ({ url })); },
        async match(request) {
            const size = entries.get(typeof request === 'string' ? request : request.url);
            if (size === undefined) return undefined;
            return { headers: { get: name => name === 'x-bpb-size' && size !== null ? String(size) : null } };
        }
    };
    return {
        entries,
        keyCalls: 0,
        async keys() {
            this.keyCalls++;
            return entries.size ? ['bpb-mapterhorn-dem-v1'] : [];
        },
        async open() { return cache; }
    };
};

const loadOptions = async (settings = {}, {
    cacheStorage = makeCacheStorage(),
    local = {},
    cachedTheme = null,
    hash = '',
    prepareChrome = null
} = {}) => {
    const html = await readFile(path.join(root, 'options', 'options.html'), 'utf8');
    const dom = new JSDOM(html, {
        // jsdom treats extension URLs as opaque origins, unlike real browsers,
        // so use a stable test origin to exercise the synchronous theme mirror.
        // A hash lets a test load the page as a deep link (#section).
        url: `https://options.better-peakbagger.test/options/options.html${hash}`,
        runScripts: 'outside-only'
    });
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local);
    if (prepareChrome) prepareChrome(dom.chrome);
    dom.window.chrome = dom.chrome;
    dom.window.caches = cacheStorage;
    if (cachedTheme !== null) dom.window.localStorage.setItem('bpbThemePref', cachedTheme);
    // The options page loads the head bundle (settings + theme, pre-paint) then
    // the tail bundle (terrain-cache + the settings UI), as options.html does.
    await evalBundle(dom.window, 'options/options-head.js');
    dom.initialTheme = dom.window.document.documentElement.getAttribute('data-bpb-theme');
    await evalBundle(dom.window, 'options/options.js');
    await new Promise(r => dom.window.setTimeout(r, 20)); // S.get().then(populate)
    return dom;
};

const el = (dom, id) => dom.window.document.getElementById(id);
const draftRow = (dom, key) => Array.from(dom.window.document.querySelectorAll('.draft-item'))
    .find(row => row.dataset.draftKey === key);

test('theme bootstrap loads before the options stylesheet', async () => {
    const dom = await loadOptions({});
    const resources = Array.from(dom.window.document.head.querySelectorAll('script[src], link[rel="stylesheet"]'))
        .map(node => node.getAttribute('src') || node.getAttribute('href'));
    assert.deepEqual(resources, ['options-head.js', 'options.css']);
});

test('cached dark theme is applied before the asynchronous settings read', async () => {
    const dom = await loadOptions({ theme: 'dark' }, { cachedTheme: 'dark' });
    assert.equal(dom.initialTheme, 'dark');
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
});

test('the authoritative theme refreshes the pre-paint cache', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
});

test('settings are grouped by the surface they affect', async () => {
    const dom = await loadOptions({});
    const sections = Array.from(dom.window.document.querySelectorAll('.settings-section'));
    assert.deepEqual(sections.map(section => section.querySelector('h2').textContent), [
        'General',
        'Activity creation',
        'Map & GPX chart',
        'Ascent beta filter',
        'TR drafts',
        'Settings for nerds',
        'About'
    ]);

    const [general, capture, mapChart, beta, drafts, github, about] = sections;
    assert.ok(github.querySelector('#enable-github-backup'));
    assert.ok(github.querySelector('#github-panel'));
    assert.match(github.querySelector('.desc').textContent, /every ascent from every year/);
    // Every settings section is labelled by its heading and carries at least
    // one card; About is informational, not a card.
    for (const section of [general, capture, mapChart, beta, github, drafts]) {
        const heading = section.querySelector('h2');
        assert.equal(section.getAttribute('aria-labelledby'), heading.id);
        assert.ok(section.querySelector('.card'), 'the section carries a settings card');
    }
    assert.equal(about.getAttribute('aria-labelledby'), about.querySelector('h2').id);
    assert.ok(about.querySelector('.about-version'));
    assert.ok(drafts.querySelector('#drafts-list'));
    assert.ok(drafts.querySelector('#drafts-delete-all'));

    assert.ok(general.querySelector('#theme'));
    assert.ok(general.querySelector('#enable-3d-map'));
    assert.equal(general.querySelector('#units'), null);
    // The trip-report controls moved out of General into Activity creation.
    assert.equal(general.querySelector('#enable-report-editor'), null);
    assert.equal(general.querySelector('#add-report-credit'), null);

    // Activity creation → GPX capture / Trip report editor
    for (const id of ['retain-waypoints', 'fill-ascent-details', 'fill-trip-info', 'fill-wilderness-nights', 'fill-external-url']) {
        assert.ok(capture.querySelector(`#capture-gpx #${id}`), `${id} should belong to GPX capture`);
    }
    for (const id of ['enable-report-editor', 'add-report-credit']) {
        assert.ok(capture.querySelector(`#capture-report #${id}`), `${id} should belong to Trip report editor`);
    }
    // Map & GPX chart → GPX chart / Map
    for (const id of ['units', 'chart-series']) {
        assert.ok(mapChart.querySelector(`#map-chart-chart #${id}`), `${id} should belong to GPX chart`);
    }
    for (const id of ['map-route-color', 'remember-map-layer', 'terrain-cache-limit', 'map-viewport-width']) {
        assert.ok(mapChart.querySelector(`#map-chart-map #${id}`), `${id} should belong to Map`);
    }
    for (const id of ['beta-tr', 'beta-tr-words', 'beta-gps', 'beta-link', 'beta-sort-date-desc']) {
        assert.ok(beta.querySelector(`#${id}`), `${id} should belong to Ascent beta filter`);
    }
    assert.ok(github.querySelector('#github-backup #enable-github-backup'), 'GitHub backup lives in its subsection');
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

test('report drafts render newest-first with labels, fallbacks, and edit links', async () => {
    const now = Date.now();
    const local = {
        'bpbReportDraft:900001:a123': {
            text: '[b]Newest report[/b]', mode: 'rich', savedAt: now - 1000,
            label: { peak: 'Glacier Peak', date: '7/12/2026' }
        },
        'bpbReportDraft:900001:p456': {
            text: 'Peak draft', mode: 'rich', savedAt: now - 2000
        },
        'bpbReportDraft:900001:new': {
            text: 'New ascent draft', mode: 'markdown', source: 'New ascent draft', savedAt: now - 3000
        },
        'bpbReportDraft:900001:a999': {
            text: 'Expired', mode: 'rich', savedAt: now - 14 * 24 * 60 * 60 * 1000 - 1
        }
    };
    const dom = await loadOptions({}, { local });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.draft-item').length === 3);

    const rows = Array.from(dom.window.document.querySelectorAll('.draft-item'));
    assert.deepEqual(rows.map(row => row.querySelector('.draft-title').textContent), [
        'Glacier Peak · 7/12/2026',
        'New ascent · peak #456',
        'New ascent'
    ]);
    assert.deepEqual(rows.map(row => row.querySelector('.draft-mode').textContent), ['Rich', 'Rich', 'Markdown']);
    assert.equal(rows[0].querySelector('.draft-excerpt').textContent, '**Newest report**');
    assert.deepEqual(rows.map(row => row.querySelector('a.secondary').href), [
        'https://peakbagger.com/climber/ascentedit.aspx?aid=123&cid=900001',
        'https://peakbagger.com/climber/ascentedit.aspx?pid=456&cid=900001',
        'https://peakbagger.com/climber/ascentedit.aspx?cid=900001'
    ]);
    assert.equal('bpbReportDraft:900001:a999' in dom.chrome._localStore, false,
        'opening the manager should prune expired drafts');
    assert.equal(el(dom, 'drafts-empty').hidden, true);
    assert.equal(el(dom, 'drafts-delete-all').hidden, false);
});

test('copy Markdown preserves exact source or converts the stored bracket report', async () => {
    const now = Date.now();
    const richKey = 'bpbReportDraft:900001:a123';
    const markdownKey = 'bpbReportDraft:900001:a124';
    const dom = await loadOptions({}, { local: {
        [richKey]: { text: '[u]under[/u]', mode: 'rich', savedAt: now },
        [markdownKey]: {
            text: '[b]normalized[/b]', mode: 'markdown', source: 'exact  **source**', savedAt: now - 1
        }
    } });
    const writes = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { writes.push(value); } }
    });

    draftRow(dom, markdownKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => writes.length === 1);
    draftRow(dom, richKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => writes.length === 2);
    assert.deepEqual(writes, ['exact  **source**', '<u>under</u>']);
    await waitFor(dom, () => el(dom, 'status').textContent === 'Copied');
    assert.equal(el(dom, 'status').textContent, 'Copied');

    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('denied'); } }
    });
    draftRow(dom, richKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => el(dom, 'status').textContent === 'Couldn’t copy Markdown');
});

test('deleting one draft is reversible and its Undo survives a live refresh', async () => {
    const key = 'bpbReportDraft:900001:a123';
    const otherKey = 'bpbReportDraft:900001:p456';
    const record = { text: 'Held verbatim', mode: 'rich', savedAt: Date.now() };
    const dom = await loadOptions({}, { local: { [key]: record } });
    await waitFor(dom, () => draftRow(dom, key));

    draftRow(dom, key).querySelector('[data-action="delete"]').click();
    await waitFor(dom, () => !(key in dom.chrome._localStore));
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/);

    await dom.chrome.storage.local.set({
        [otherKey]: { text: 'Arrived from another tab', mode: 'rich', savedAt: Date.now() + 1 }
    });
    await waitFor(dom, () => draftRow(dom, otherKey));
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/,
        'storage.onChanged must not strip an active Undo row');

    draftRow(dom, key).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => key in dom.chrome._localStore && draftRow(dom, key)?.querySelector('.draft-title'));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[key])), record);
});

test('delete all drafts has one undo that restores every record', async () => {
    const firstKey = 'bpbReportDraft:900001:a123';
    const secondKey = 'bpbReportDraft:900001:p456';
    const records = {
        [firstKey]: { text: 'First', mode: 'rich', savedAt: Date.now() },
        [secondKey]: { text: 'Second', mode: 'markdown', source: 'Second', savedAt: Date.now() - 1 }
    };
    const dom = await loadOptions({}, { local: records });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.draft-item').length === 2);

    el(dom, 'drafts-delete-all').click();
    await waitFor(dom, () => !(firstKey in dom.chrome._localStore) && !(secondKey in dom.chrome._localStore));
    assert.equal(el(dom, 'drafts-undo-all').hidden, false);
    assert.match(el(dom, 'drafts-undo-all').textContent, /All drafts deleted\s*Undo/);

    el(dom, 'drafts-undo-all-button').click();
    await waitFor(dom, () => firstKey in dom.chrome._localStore && secondKey in dom.chrome._localStore);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore)), records);
});

test('the drafts manager shows an empty state and refreshes when another tab autosaves', async () => {
    const dom = await loadOptions({}, { local: { unrelated: 'preserved' } });
    assert.equal(el(dom, 'drafts-empty').hidden, false);
    assert.equal(el(dom, 'drafts-list').hidden, true);
    assert.equal(el(dom, 'drafts-delete-all').hidden, true);

    const key = 'bpbReportDraft:900001:new';
    await dom.chrome.storage.local.set({
        [key]: { text: 'Live draft', mode: 'rich', savedAt: Date.now() }
    });
    await waitFor(dom, () => draftRow(dom, key));
    assert.equal(el(dom, 'drafts-empty').hidden, true);
    assert.equal(draftRow(dom, key).querySelector('.draft-title').textContent, 'New ascent');
    assert.equal(dom.chrome._localStore.unrelated, 'preserved');
});

test('the sidebar links every settings section, in order', async () => {
    const dom = await loadOptions({});
    const doc = dom.window.document;
    const nav = doc.querySelector('.side-nav');
    assert.ok(nav, 'the sidebar nav exists');
    assert.equal(nav.getAttribute('aria-label'), 'Settings sections');

    const links = Array.from(nav.querySelectorAll('a.nav-item'));
    // Every link points at an existing settings section...
    for (const link of links) {
        const id = link.getAttribute('href').slice(1);
        const target = doc.getElementById(id);
        assert.ok(target, `sidebar link #${id} resolves to an element`);
        assert.ok(target.classList.contains('settings-section'), `#${id} is a settings section`);
    }
    // ...and the links cover every section, in document order — this guards
    // against a section being added, removed, or renamed without its link.
    const linkTargets = links.map(link => link.getAttribute('href').slice(1));
    const sectionIds = Array.from(doc.querySelectorAll('.content .settings-section'), section => section.id);
    assert.deepEqual(linkTargets, sectionIds);
    assert.deepEqual(linkTargets, ['general', 'capture', 'map-chart', 'beta', 'drafts', 'github', 'about']);
});

test('the sidebar exposes always-visible sub-links for the grouped sections', async () => {
    const dom = await loadOptions({});
    const doc = dom.window.document;
    const subLinks = Array.from(doc.querySelectorAll('.side-nav a.nav-subitem'));
    assert.deepEqual(subLinks.map(link => link.getAttribute('href')),
        ['#capture-gpx', '#capture-report', '#map-chart-chart', '#map-chart-map', '#github-backup']);
    for (const link of subLinks) {
        const target = doc.getElementById(link.getAttribute('href').slice(1));
        assert.ok(target && target.classList.contains('subsection'),
            `${link.getAttribute('href')} resolves to a subsection group`);
        assert.equal(target.getAttribute('role'), 'group');
        assert.equal(target.getAttribute('aria-labelledby'), target.querySelector('h3').id);
    }
});

const activeLinks = dom =>
    Array.from(dom.window.document.querySelectorAll('.nav-item[aria-current], .nav-subitem[aria-current]'));

test('the sidebar marks the first section active on load', async () => {
    const dom = await loadOptions({});
    const active = activeLinks(dom);
    assert.equal(active.length, 1, 'exactly one link is active');
    assert.equal(active[0].getAttribute('href'), '#general');
});

test('a deep-link hash is the active section on load', async () => {
    const dom = await loadOptions({}, { hash: '#map-chart' });
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#map-chart');
});

test('a drafts deep link activates the TR-drafts manager', async () => {
    const dom = await loadOptions({}, { hash: '#drafts' });
    dom.window.document.querySelector('.content').dispatchEvent(new dom.window.Event('scrollend'));
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#drafts');
    assert.equal(active[0].textContent, 'TR drafts');
});

test('hash navigation moves the active sidebar link', async () => {
    const dom = await loadOptions({});
    dom.window.location.hash = '#beta';
    dom.window.dispatchEvent(new dom.window.Event('hashchange'));
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#beta');
});

test('a deep link to a subsection activates its sub-item and marks the parent', async () => {
    const dom = await loadOptions({}, { hash: '#capture-gpx' });
    const doc = dom.window.document;
    const current = activeLinks(dom);
    assert.equal(current.length, 1, 'exactly one link is current');
    assert.equal(current[0].getAttribute('href'), '#capture-gpx');
    assert.ok(current[0].classList.contains('nav-subitem'));
    // The parent nav-item is highlighted (accent) but not itself "current".
    const parent = doc.querySelector('.side-nav a.nav-item[href="#capture"]');
    assert.ok(parent.classList.contains('nav-parent-active'));
    assert.equal(parent.hasAttribute('aria-current'), false);
});

test('the scroll-spy survives jsdom\'s zero-layout world', async () => {
    // jsdom reports every offset/rect as 0 and nothing scrolls; the scroll
    // handler must not throw and must keep exactly one link active. The offset
    // math itself is only provable in a real browser (see the plan's step 5).
    const dom = await loadOptions({});
    const content = dom.window.document.querySelector('.content');
    assert.doesNotThrow(() => content.dispatchEvent(new dom.window.Event('scroll')));
    assert.equal(activeLinks(dom).length, 1);
});

// ---- GitHub backup setup --------------------------------------------------

// Wire the options page's GITHUB_AUTH_* messages to a scripted background and a
// grantable optional-permission request, so the setup panel can be driven in
// jsdom without a browser or network.
const withGithubBackground = (status, { grant = true } = {}) => chrome => {
    chrome.permissions = { request: async () => grant, contains: async () => grant, remove: async () => true };
    chrome.runtime.sendMessage = (message, callback) => {
        const reply = message.type === 'GITHUB_AUTH_STATUS' ? status : {};
        if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
        return Promise.resolve(reply);
    };
};

test('the GitHub backup section is off by default and hides its detail panel', async () => {
    const dom = await loadOptions({}, { prepareChrome: withGithubBackground({ enabled: false }) });
    assert.equal(el(dom, 'enable-github-backup').checked, false);
    assert.equal(el(dom, 'github-detail').hidden, true);
});

test('enabling GitHub backup requests the github host permissions and persists the gate', async () => {
    let requested = null;
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            withGithubBackground({ enabled: true, connected: false, hasToken: false })(chrome);
            const request = chrome.permissions.request;
            chrome.permissions.request = async arg => { requested = arg; return request(arg); };
        }
    });
    const toggle = el(dom, 'enable-github-backup');
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    // Compare by value: the requested object originates in the jsdom realm.
    assert.equal(JSON.stringify(requested), JSON.stringify({ origins: ['https://github.com/*', 'https://api.github.com/*'] }));
    assert.equal(dom.chrome._store.bpbSettings.enableGithubBackup, true);
});

test('a denied host-permission request reverts the toggle and leaves the gate off', async () => {
    const dom = await loadOptions({}, { prepareChrome: withGithubBackground({ enabled: false }, { grant: false }) });
    const toggle = el(dom, 'enable-github-backup');
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(toggle.checked, false);
    assert.notEqual(dom.chrome._store.bpbSettings.enableGithubBackup, true);
    assert.equal(el(dom, 'github-detail').hidden, false);
    assert.match(el(dom, 'github-panel').textContent, /GitHub access wasn’t granted/);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));

    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.match(el(dom, 'github-panel').textContent, /GitHub access wasn’t granted/,
        'the actionable permission error must survive focus changes');
});

test('a lost device flow stops polling and offers to reconnect', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900,
                };
                else if (message.type === 'GITHUB_AUTH_STATE') reply = { phase: 'idle' };
                else reply = {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => /connection was lost/i.test(el(dom, 'github-panel').textContent), 3000);

    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Reconnect GitHub'));
});

test('the device code is copyable and shows its remaining lifetime', async () => {
    const startedAt = Date.now();
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device',
                    expiresIn: 125, startedAt,
                };
                else reply = { phase: 'polling' };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    let copied = '';
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { copied = value; } },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));
    const codeButton = el(dom, 'github-panel').querySelector('.github-code');
    assert.match(codeButton.getAttribute('aria-label'), /Copy device code ABCD-EFGH/);
    assert.match(el(dom, 'github-panel').textContent, /Expires in 2:0[45]/);

    codeButton.click();
    await waitFor(dom, () => /Copied/.test(codeButton.textContent));
    assert.equal(copied, 'ABCD-EFGH');
    dom.window.close();
});

test('repository setup offers a prefilled private GitHub repository', async () => {
    const status = {
        enabled: true, connected: false, hasToken: true,
        account: { login: 'ada' }, installUrl: 'https://github.com/apps/better-peakbagger-backup/installations/new',
    };
    const repo = { owner: 'ada', name: 'existing', fullName: 'ada/existing', defaultBranch: 'main', installationId: 11 };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_DISCOVER' ? { repos: [repo] } : status;
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Create repository on GitHub'));
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/existing'), 'a sole granted repository must still be inspected by an explicit choice');

    let opened = null;
    dom.window.open = url => { opened = url; };
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Create repository on GitHub').click();
    const url = new URL(opened);
    assert.equal(url.origin + url.pathname, 'https://github.com/new');
    assert.equal(url.searchParams.get('name'), 'better-peakbagger-backup');
    assert.equal(url.searchParams.get('owner'), 'ada');
    assert.equal(url.searchParams.get('visibility'), 'private');
    assert.match(url.searchParams.get('description'), /Peakbagger ascent backups/);
});

test('a populated repository requires an explicit confirmation before connection', async () => {
    const repo = { owner: 'ada', name: 'project', fullName: 'ada/project', defaultBranch: 'main', installationId: 11 };
    let connected = false;
    const selectMessages = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    reply = {
                        enabled: true, connected, hasToken: true, account: { login: 'ada' },
                        repo: connected ? repo : null, installUrl: 'https://github.com/apps/example/installations/new',
                    };
                } else if (message.type === 'GITHUB_AUTH_DISCOVER') {
                    reply = { repos: [repo] };
                } else if (message.type === 'GITHUB_AUTH_SELECT_REPO') {
                    selectMessages.push(message);
                    if (!message.confirmExisting) reply = { connected: false, needsConfirmation: true, repo };
                    else { connected = true; reply = { connected: true, hasToken: true, account: { login: 'ada' }, repo }; }
                } else reply = {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/project'));
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'ada/project').click();
    await waitFor(dom, () => /already contains files/.test(el(dom, 'github-panel').textContent));
    assert.match(el(dom, 'github-panel').textContent, /Existing files will stay in place/);
    assert.equal(connected, false);

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Use this repository').click();
    await waitFor(dom, () => /backing up to ada\/project/.test(el(dom, 'github-panel').textContent));
    assert.deepEqual(selectMessages.map(message => !!message.confirmExisting), [false, true]);
});

test('repository setup shows the specific GitHub failure instead of generic copy', async () => {
    const status = {
        enabled: true, connected: false, hasToken: true, account: { login: 'ada' },
        installUrl: 'https://github.com/apps/example/installations/new',
    };
    const repo = { owner: 'ada', name: 'backup', fullName: 'ada/backup', defaultBranch: 'main', installationId: 11 };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = status;
                if (message.type === 'GITHUB_AUTH_DISCOVER') reply = { repos: [repo] };
                if (message.type === 'GITHUB_AUTH_SELECT_REPO') {
                    reply = { connected: false, error: { code: 'unknown', message: 'Repository service is temporarily unavailable.' } };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/backup'));
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'ada/backup').click();
    await waitFor(dom, () => /Repository service is temporarily unavailable/.test(el(dom, 'github-panel').textContent));
    assert.doesNotMatch(el(dom, 'github-panel').textContent, /something went wrong/i);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));
});

test('a connected status renders the account and repository', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: withGithubBackground({
            enabled: true, connected: true, hasToken: true,
            account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        })
    });
    await new Promise(r => dom.window.setTimeout(r, 40));
    assert.equal(el(dom, 'github-detail').hidden, false);
    const panelText = el(dom, 'github-panel').textContent;
    assert.match(panelText, /@ada/);
    assert.match(panelText, /ada\/peaks/);
    // The connected state offers a disconnect control.
    const buttons = Array.from(el(dom, 'github-panel').querySelectorAll('button'), b => b.textContent);
    assert.ok(buttons.includes('Disconnect'));
});

test('the connected state opens the signed-in climber\'s all-years My Ascents page', async () => {
    let opened = null;
    const target = 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999&sort=AscentDate';
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { opened = details.url; } };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'PEAKBAGGER_MY_ASCENTS'
                    ? { ok: true, url: target }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Open My Ascents'));
    assert.match(el(dom, 'github-panel').textContent, /always includes every year/);

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open My Ascents').click();
    await waitFor(dom, () => opened);
    assert.equal(opened, target);
});

test('the My Ascents action explains when Peakbagger is signed out', async () => {
    const opened = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { opened.push(details.url); } };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'PEAKBAGGER_MY_ASCENTS'
                    ? {
                        ok: false,
                        error: {
                            code: 'peakbagger-signed-out',
                            message: 'Peakbagger could not find a signed-in account. Sign in to Peakbagger, then try again.',
                        },
                    }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Open My Ascents'));
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open My Ascents').click();
    await waitFor(dom, () => /could not find a signed-in account/i.test(el(dom, 'github-panel').textContent));

    assert.match(el(dom, 'github-panel').textContent, /Sign in to Peakbagger, then try again/);
    assert.doesNotMatch(el(dom, 'github-panel').textContent, /something went wrong/i);
    const signIn = Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Sign in to Peakbagger');
    assert.ok(signIn, 'the signed-out error offers a direct recovery action');
    signIn.click();
    await waitFor(dom, () => opened.length > 0);
    assert.equal(opened[0], 'https://www.peakbagger.com/Climber/Login.aspx');
});

test('the connected state exposes the auto-backup toggle and persists it', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: withGithubBackground({
            enabled: true, connected: true, hasToken: true, auto: false,
            account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        }),
    });
    await new Promise(r => dom.window.setTimeout(r, 40));
    const autoEl = el(dom, 'github-auto-backup');
    assert.ok(autoEl, 'the auto-backup checkbox is present when connected');
    assert.equal(autoEl.checked, false);

    autoEl.checked = true;
    autoEl.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(dom.chrome._store.bpbSettings.autoGithubBackup, true);
});
