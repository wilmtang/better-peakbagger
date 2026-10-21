// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { searchSentinel, sentinelCaptures, sentinelTileUrl, sentinelView } from '../../src/maps/sentinel-core.js';
import { createSentinelLayer } from '../../src/maps/sentinel-layer.js';
import { installSentinelMap } from '../../src/maps/sentinel-map.js';
import { ENTRIES, COPY_FILES } from '../../scripts/build-config.mjs';

const view = { west: -122, east: -121, south: 46, north: 47 };
const bounds = { getWest: () => -122, getEast: () => -121, getSouth: () => 46, getNorth: () => 47 };
const ring = (west = -122, east = -121) => [[west, 46], [east, 46], [east, 47], [west, 47], [west, 46]];
const captureTime = Date.now() - 2 * 86400000;
const feature = (id = 'scene_1', { date = new Date(captureTime).toISOString(), cloud = 41, west = -122, east = -121, orbit = 13 } = {}) => ({
    id, collection: 'sentinel-2-l2a', geometry: { type: 'Polygon', coordinates: [ring(west, east)] },
    properties: { datetime: date, platform: 'Sentinel-2B', 'sat:relative_orbit': orbit, 'eo:cloud_cover': cloud }
});
const response = features => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ features }) });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the shipped Sentinel adapter runs in the native map MAIN world and carries its stylesheet', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
    const entry = manifest.content_scripts.find(script => script.js?.includes('content/map-layers.js'));
    assert.equal(entry.world, 'MAIN');
    assert.equal(entry.all_frames, true);
    assert.ok(entry.matches.every(pattern => pattern.startsWith('https:')));
    assert.ok(entry.matches.some(pattern => /mastermap\.aspx/i.test(pattern)));
    assert.deepEqual(entry.css, ['css/map-layers.css']);
    assert.deepEqual(ENTRIES.find(bundle => bundle.out === 'content/map-layers.js').sources, ['maps/map-layers.js']);
    assert.ok(COPY_FILES.some(([source, destination]) => source === 'src/maps/map-layers.css' && destination === 'css/map-layers.css'));
    assert.equal(manifest.host_permissions.some(pattern => pattern.includes('planetarycomputer')), false, 'direct CORS needs no new persistent provider access');
});

test('Sentinel groups one pass, measures only rendered footprints, and does not prefer older clear scenes', () => {
    const features = [feature('west', { east: -121.5 }), feature('east', { west: -121.5, cloud: 59 }),
        feature('older', { date: '2026-10-03T19:02:59Z', cloud: 0 }), feature('west', { cloud: 99 })];
    const captures = sentinelCaptures(features, view);
    assert.equal(captures.length, 2);
    assert.equal(captures[0].coverage, 1);
    assert.equal(captures[0].cloud, 50);
    assert.deepEqual(captures[0].scenes.map(scene => scene.id), ['east', 'west']);
    assert.equal(captures[1].cloud, 0);
    assert.equal(sentinelCaptures([feature('partial', { east: -121.5 })], view)[0].coverage < 1, true);
    const unknown = feature();
    unknown.properties['eo:cloud_cover'] = null;
    assert.equal(sentinelCaptures([unknown], view)[0].cloud, null);
});

test('Sentinel accounts for polygon holes and dateline-crossing footprints and rejects malformed scenes', () => {
    const hole = feature();
    hole.geometry.coordinates.push(ring(-121.8, -121.2));
    assert.ok(sentinelCaptures([hole], view)[0].coverage < 0.5);
    const dateline = feature();
    dateline.geometry.coordinates = [ring(179, -179)];
    assert.equal(sentinelCaptures([dateline], { ...view, west: 179, east: 181 })[0].coverage, 1);
    const bad = feature('https://evil.example/scene');
    assert.deepEqual(sentinelCaptures([bad, { ...feature(), collection: 'other' }], view), []);
    assert.throws(() => sentinelTileUrl('../secret'));
    assert.match(sentinelTileUrl('scene_1'), /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/tiles\/WebMercatorQuad/);
    assert.throws(() => sentinelView(bounds, 8), /Zoom in/);
});

test('Sentinel searches split dateline bounds without credentials and refuses truncated catalogs', async () => {
    const requests = [];
    await searchSentinel({ ...view, west: 179, east: 181 }, { now: Date.parse('2026-10-10'), fetchImpl: async (url, options) => {
        requests.push({ url, ...options, body: JSON.parse(options.body) });
        return response([]);
    } });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(request => request.body.bbox), [[179, 46, 180, 47], [-180, 46, -179, 47]]);
    assert.ok(requests.every(request => request.credentials === 'omit' && request.method === 'POST'));
    assert.deepEqual(requests[0].body.collections, ['sentinel-2-l2a']);
    await assert.rejects(searchSentinel(view, { fetchImpl: async () => ({ ...response([]),
        text: async () => JSON.stringify({ features: [], links: [{ rel: 'next', href: 'https://evil.example' }] }) }) }), /Zoom in/);
    await assert.rejects(searchSentinel(view, { fetchImpl: async () => ({ ...response([]), headers: { get: () => 5e6 } }) }), /too large/);
});

test('Sentinel deadlines cover stalled body reads and cancellation settles a transport that ignores abort', async () => {
    await assert.rejects(searchSentinel(view, { timeoutMs: 15, fetchImpl: async () => ({ ...response([]), text: () => new Promise(() => {}) }) }), { name: 'TimeoutError' });
    const controller = new AbortController();
    const pending = searchSentinel(view, { signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(searchSentinel(view, { signal: controller.signal, fetchImpl: () => { throw new Error('must not fetch'); } }), { name: 'AbortError' });
});

test('shared Sentinel UI guards late responses, dates, unknown clouds, and disposal', async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const applied = [];
    const requests = [];
    let cleared = 0;
    const layer = createSentinelLayer({ document: dom.window.document, readView: () => ({ bounds, zoom: 13 }),
        replaceScenes: scenes => applied.push(scenes.map(scene => scene.id)), clearScenes: () => cleared++, debounceMs: 0,
        search: (area, { signal }) => new Promise(resolve => requests.push({ resolve, signal })) });
    dom.window.document.body.append(layer.element);
    assert.equal(requests.length, 0, 'installing the UI makes no provider request');
    layer.activate();
    layer.activate();
    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve(sentinelCaptures([feature('new'), feature('old', { date: '2026-10-03T19:02:59Z', cloud: null })], view));
    await tick();
    requests[0].resolve(sentinelCaptures([feature('stale')], view));
    await tick();
    assert.deepEqual(applied, [['new']]);
    const select = layer.element.querySelector('select');
    select.value = select.options[1].value;
    select.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(applied.at(-1), ['old'], 'a late catalog cannot overwrite current capture choices');
    assert.match(layer.element.textContent, /Clouds unknown/);
    layer.refresh();
    assert.equal(layer.element.querySelector('.bpb-sentinel-stats').textContent, '', 'old coverage is cleared when the view changes');
    layer.dispose();
    assert.equal(layer.element.isConnected, false);
    assert.ok(cleared > 0);
    dom.window.close();
});

test('compact Sentinel keeps the capture date in the selector and reuses one metadata row', async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const layer = createSentinelLayer({ document: dom.window.document,
        readView: () => ({ bounds, zoom: 13 }), replaceScenes() {}, clearScenes() {},
        search: async () => sentinelCaptures([feature('new', { date: '2026-10-08T01:27:00Z' }), feature('old', { date: '2026-10-03T19:02:59Z' })], view) });
    try {
        const select = layer.element.querySelector('select');
        const metadata = layer.element.querySelector('.bpb-sentinel-metadata');
        const summary = metadata.querySelector('.bpb-sentinel-summary');
        const stats = metadata.querySelector('.bpb-sentinel-stats');
        assert.equal(select.selectedOptions[0].textContent, 'Latest capture');
        layer.activate();
        assert.equal(summary.textContent, 'Finding captures…');
        await tick();
        assert.equal(select.selectedOptions[0].textContent, 'Latest · 10-07 18:27 · ☁ 41%');
        assert.equal(select.title, 'Latest · 2026-10-07 18:27 PDT · Clouds 41%');
        assert.equal(summary.hidden, true, 'the capture date is not duplicated in a third row');
        assert.match(stats.textContent, /Coverage 100% · Clouds 41%/);
        select.value = select.options[1].value;
        select.dispatchEvent(new dom.window.Event('change'));
        assert.equal(summary.hidden, true, 'pinned and latest captures use the same layout');
        layer.refresh();
        assert.equal(summary.hidden, false);
        assert.equal(summary.textContent, 'Finding captures…');
        assert.equal(stats.textContent, '');
        assert.equal(summary.parentElement, stats.parentElement, 'loading and coverage share one stable slot');
    } finally { layer.dispose(); dom.window.close(); }
});

test('Sentinel keeps retry visible and disabled until its pending request settles', async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const requests = [];
    const layer = createSentinelLayer({ document: dom.window.document,
        readView: () => ({ bounds, zoom: 13 }), replaceScenes() {}, clearScenes() {},
        search: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) });
    try {
        const retry = layer.element.querySelector('button');
        layer.activate();
        requests[0].reject(new Error('Satellite service is unavailable. Try again.'));
        await tick();
        assert.equal(retry.hidden, false);
        assert.equal(retry.disabled, false);
        retry.click();
        assert.equal(retry.hidden, false, 'the pointer and keyboard target remains visible while retrying');
        assert.equal(retry.disabled, true);
        assert.equal(layer.element.querySelector('.bpb-sentinel-summary').textContent, 'Finding captures…');
        retry.click();
        assert.equal(requests.length, 2, 'a pending retry cannot start another request');
        requests[1].reject(new Error('Still unavailable.'));
        await tick();
        assert.equal(retry.hidden, false);
        assert.equal(retry.disabled, false);
        retry.click();
        requests[2].resolve(sentinelCaptures([feature()], view));
        await tick();
        assert.equal(retry.hidden, true, 'successful loading returns to the compact control');
        assert.equal(layer.element.querySelector('.bpb-sentinel-summary').hidden, true);
    } finally { layer.dispose(); dom.window.close(); }
});

test('camera refresh updates coverage without rebuilding the same scenes or their reordered tile cache', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM('<!doctype html><body></body>'), applied = [];
    let cleared = 0, searches = 0;
    const original = sentinelCaptures([feature()], view)[0];
    let capture = { ...original, scenes: [original.scenes[0], { ...original.scenes[0], id: 'scene_2' }] };
    const layer = createSentinelLayer({ document: dom.window.document, readView: () => ({ bounds, zoom: 13 }),
        replaceScenes: scenes => applied.push(scenes), clearScenes: () => cleared++, search: async () => { searches++; return [capture]; } });
    try {
        layer.activate(); await tick();
        capture = { ...capture, coverage: .25, scenes: [...capture.scenes].reverse().map(scene => ({ ...scene, bounds: [...scene.bounds] })) };
        layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(searches, 2, 'a changed view still searches for current coverage');
        assert.equal(applied.length, 1, 'the same image IDs and bounds retain their existing sources');
        assert.equal(cleared, 0);
        assert.match(layer.element.textContent, /Coverage 25%/);
        const select = layer.element.querySelector('select');
        select.value = 'latest'; select.dispatchEvent(new dom.window.Event('change'));
        assert.equal(applied.length, 1, 'choosing the already displayed capture also preserves tiles');
        capture = { ...capture, scenes: capture.scenes.map(scene => ({ ...scene, bounds: [179, 46, 181, 47] })) };
        layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(applied.length, 2, 'changed wrapped source bounds are applied');
        layer.deactivate(); layer.activate(); await tick();
        assert.equal(applied.length, 3, 'reactivation rebuilds imagery cleared by suspension');
    } finally { layer.dispose(); dom.window.close(); }
});

test('failed imagery retries rebuild identical scenes while camera refresh retains the failure', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM('<!doctype html><body></body>');
    let applied = 0;
    const layer = createSentinelLayer({ document: dom.window.document, readView: () => ({ bounds, zoom: 13 }),
        replaceScenes: () => applied++, clearScenes() {}, search: async () => sentinelCaptures([feature()], view) });
    try {
        layer.activate(); await tick();
        layer.tileError();
        layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(applied, 1);
        assert.equal(layer.element.querySelector('.bpb-sentinel-summary').hidden, false);
        assert.match(layer.element.textContent, /tiles are unavailable/);
        layer.element.querySelector('button').click(); await tick();
        assert.equal(applied, 2);
        assert.equal(layer.element.querySelector('.bpb-sentinel-summary').hidden, true);
        layer.tileError({ status: 429, retryAt: Date.now() + 60000 });
        layer.element.querySelector('button').click(); await tick();
        assert.equal(applied, 2, 'rate-limit cooldown still gates imagery retries');
    } finally { layer.dispose(); dom.window.close(); }
});

test('temporary catalog failures retain loaded imagery with unknown coverage, but unsupported views clear it', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM('<!doctype html><body></body>');
    let failure = false, zoom = 13, applied = 0, cleared = 0;
    const layer = createSentinelLayer({ document: dom.window.document, readView: () => ({ bounds, zoom }),
        replaceScenes: () => applied++, clearScenes: () => cleared++, search: async () => {
            if (failure) throw new Error('Satellite service is unavailable. Try again.');
            return sentinelCaptures([feature()], view);
        } });
    try {
        layer.activate(); await tick();
        failure = true; layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(cleared, 0, 'service failure does not erase valid decoded imagery');
        assert.match(layer.element.querySelector('.bpb-sentinel-summary').textContent, /Showing previous imagery/);
        assert.equal(layer.element.querySelector('.bpb-sentinel-stats').textContent, '', 'old coverage is not presented as current');
        assert.equal(layer.element.querySelector('select').disabled, true, 'stale catalog choices stay unavailable');
        failure = false; layer.element.querySelector('button').click(); await tick();
        assert.equal(applied, 1, 'retrying an unchanged capture keeps the imagery');
        assert.equal(layer.element.querySelector('.bpb-sentinel-summary').hidden, true);
        zoom = 8; layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(cleared, 1);
        assert.match(layer.element.textContent, /Zoom in/);
        assert.doesNotMatch(layer.element.textContent, /Showing previous imagery/);
        zoom = 13; layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(applied, 2, 'returning to a supported view remounts the cleared sources');
    } finally { layer.dispose(); dom.window.close(); }
});

test('confirmed missing captures clear old imagery instead of retaining a different date', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM('<!doctype html><body></body>');
    let captures = sentinelCaptures([feature()], view), cleared = 0, applied = 0;
    const layer = createSentinelLayer({ document: dom.window.document, readView: () => ({ bounds, zoom: 13 }),
        replaceScenes: () => applied++, clearScenes: () => cleared++, search: async () => captures });
    try {
        layer.activate(captures[0]); await tick();
        const select = layer.element.querySelector('select');
        captures = []; layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(cleared, 1);
        assert.equal(select.value, 'missing');
        assert.match(layer.element.textContent, /does not cover/);
        captures = sentinelCaptures([feature()], view); layer.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(applied, 2);
    } finally { layer.dispose(); dom.window.close(); }
});

test('Sentinel options include rounded cloud percentages and honest unknowns without changing capture identity', async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const changes = [];
    const captures = [3.4, 0, 100, null].map((cloud, index) => ({ key: `capture-${index}`,
        time: Date.parse('2026-10-08T01:27:00Z') - index * 86400000, platform: 'Sentinel-2B', orbit: '13',
        scenes: [], coverage: 1, cloud }));
    let searches = 0;
    const layer = createSentinelLayer({ document: dom.window.document, readView: () => ({ bounds, zoom: 13 }),
        search: async () => { searches++; return captures; }, replaceScenes() {}, clearScenes() {},
        onCaptureChange: capture => changes.push(capture) });
    try {
        layer.activate();
        await tick();
        const select = layer.element.querySelector('select');
        assert.deepEqual(Array.from(select.options, option => option.textContent), [
            'Latest · 10-07 18:27 · ☁ 3%', '2026-10-06 18:27 · ☁ 0%',
            '2026-10-05 18:27 · ☁ 100%', '2026-10-04 18:27 · ☁ ?'
        ]);
        for (const capture of captures) {
            select.value = capture === captures[0] ? 'latest' : capture.key;
            select.dispatchEvent(new dom.window.Event('change'));
            const option = select.selectedOptions[0];
            assert.equal(option.getAttribute('aria-label'), select.title);
            assert.match(select.title, /PDT · Clouds (?:3%|0%|100%|unknown)$/);
            assert.deepEqual(changes.at(-1), capture === captures[0] ? null
                : { time: capture.time, platform: capture.platform, orbit: capture.orbit });
        }
        assert.equal(searches, 1, 'changing captures reuses cloud metadata from the existing catalog');
    } finally { layer.dispose(); dom.window.close(); }
});

test('Sentinel lists each capture once while latest follows the view and pinned dates retain their identity', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM('<!doctype html><body></body>');
    const changes = [], applied = [];
    const [newest, older] = sentinelCaptures([
        feature('newest', { date: '2026-10-08T01:27:00Z' }),
        feature('older', { date: '2026-10-03T19:02:59Z' })
    ], view);
    let catalog = [newest, older];
    const layer = createSentinelLayer({ document: dom.window.document,
        readView: () => ({ bounds, zoom: 13 }), clearScenes() {},
        search: async () => catalog, replaceScenes: scenes => applied.push(scenes.map(scene => scene.id)),
        onCaptureChange: capture => changes.push(capture) });
    const refresh = async () => { layer.refresh(); t.mock.timers.tick(300); await tick(); };
    try {
        layer.activate(); await tick();
        const select = layer.element.querySelector('select');
        assert.deepEqual(Array.from(select.options, option => option.value), ['latest', older.key]);
        assert.deepEqual(applied.at(-1), ['newest']);
        catalog = [older]; await refresh();
        assert.equal(select.options.length, 1);
        assert.equal(select.value, 'latest');
        assert.deepEqual(applied.at(-1), ['older'], 'automatic latest follows the current view');
        catalog = [newest, older]; await refresh();
        select.value = older.key; select.dispatchEvent(new dom.window.Event('change'));
        assert.deepEqual(changes.at(-1), { time: older.time, platform: older.platform, orbit: older.orbit });
        catalog = [older]; await refresh();
        assert.equal(select.options.length, 1, 'a pinned capture that becomes newest is not duplicated');
        assert.equal(select.value, 'latest');
        catalog = [newest, older]; await refresh();
        assert.equal(select.value, older.key, 'sharing the latest row did not discard the pinned date');
        assert.deepEqual(applied.at(-1), ['older']);
        select.value = 'latest'; select.dispatchEvent(new dom.window.Event('change'));
        assert.equal(changes.at(-1), null, 'choosing latest explicitly clears the pin');
        assert.deepEqual(applied.at(-1), ['newest']);
        catalog = []; await refresh();
        assert.equal(select.options.length, 1);
        assert.equal(select.value, 'latest');
    } finally { layer.dispose(); dom.window.close(); }
});

test('Sentinel capture labels use the viewed mountain date, DST, unusual offsets, and wrapped dateline bounds', async () => {
    for (const { area = view, time, expected, missing } of [
        { time: '2026-10-08T01:27:00Z', expected: '2026-10-07 18:27 PDT', missing: '2026-10-06 18:27 PDT' },
        { time: '2026-01-08T01:27:00Z', expected: '2026-01-07 17:27 PST', missing: '2026-01-06 17:27 PST' },
        { area: { west: 85, east: 85.6, south: 27.4, north: 28 }, time: '2026-10-08T01:27:00Z',
            expected: '2026-10-08 07:12 GMT+5:45', missing: '2026-10-07 07:12 GMT+5:45' },
        { area: { west: 539, east: 541, south: -17, north: -16 }, time: '2026-10-08T01:27:00Z',
            expected: '2026-10-08 13:27 GMT+12', missing: '2026-10-07 13:27 GMT+12' },
    ]) {
        const dom = new JSDOM('<!doctype html><body></body>');
        const capture = { key: 'capture', time: Date.parse(time), platform: 'Sentinel-2B', orbit: '13', scenes: [], coverage: 1, cloud: 3 };
        const layer = createSentinelLayer({ document: dom.window.document,
            readView: () => ({ bounds: { getWest: () => area.west, getEast: () => area.east,
                getSouth: () => area.south, getNorth: () => area.north }, zoom: 13 }),
            search: async () => [capture], replaceScenes() {}, clearScenes() {} });
        try {
            layer.activate();
            await tick();
            const select = layer.element.querySelector('select');
            assert.equal(select.options[0].textContent, `Latest · ${expected.slice(5, 16)} · ☁ 3%`);
            assert.equal(select.options[0].title, `Latest · ${expected} · Clouds 3%`);
            assert.equal(select.options.length, 1, 'a single capture appears only once');
            layer.activate(capture);
            await tick();
            assert.equal(select.value, 'latest', 'a pinned newest capture uses its existing option');
            assert.equal(select.title, `Latest · ${expected} · Clouds 3%`);
            assert.equal(layer.element.querySelector('.bpb-sentinel-summary').textContent, expected);
            layer.activate({ ...capture, time: capture.time - 86400000 });
            await tick();
            assert.equal(select.value, 'missing');
            assert.equal(select.selectedOptions[0].textContent, `${missing.slice(0, 16)} · ☁ ?`, 'missing captures retain the mountain date and clock');
            assert.equal(select.title, `${missing} · Clouds unknown`);
        } finally { layer.dispose(); dom.window.close(); }
    }
});

test('Sentinel timezone fallback is labelled and stale catalogs cannot change the current zone', async t => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const pending = [];
    let area = bounds;
    const capture = { key: 'capture', time: Date.parse('2026-10-08T01:27:00Z'), platform: 'Sentinel-2B', orbit: '13', scenes: [], coverage: 1, cloud: 3 };
    const layer = createSentinelLayer({ document: dom.window.document,
        readView: () => ({ bounds: area, zoom: 13 }), search: () => new Promise(resolve => pending.push(resolve)),
        replaceScenes() {}, clearScenes() {} });
    try {
        layer.activate();
        area = { getWest: () => 85, getEast: () => 85.6, getSouth: () => 27.4, getNorth: () => 28 };
        layer.activate();
        pending[1]([capture]);
        await tick();
        pending[0]([capture]);
        await tick();
        const select = layer.element.querySelector('select');
        assert.equal(select.title, 'Latest · 2026-10-08 07:12 GMT+5:45 · Clouds 3%');
        const OriginalFormatter = Intl.DateTimeFormat;
        t.mock.method(Intl, 'DateTimeFormat', function (locales, options) {
            if (options.timeZone !== 'UTC') throw new RangeError('unsupported timezone');
            return new OriginalFormatter(locales, options);
        });
        area = bounds;
        layer.activate();
        pending[2]([capture]);
        await tick();
        assert.equal(select.selectedOptions[0].textContent, 'Latest · 10-07 17:27 · ☁ 3%');
        assert.equal(select.title, 'Latest · 2026-10-07 17:27 UTC−8, estimated from longitude · Clouds 3%',
            'the full estimated label remains available in the tooltip');
        t.mock.restoreAll();
        t.mock.method(Intl, 'DateTimeFormat', function (locales, options) {
            const formatter = new OriginalFormatter(locales, options);
            return { formatToParts(time) {
                if (options.timeZone !== 'UTC' && time !== 0) throw new RangeError('capture formatting failed');
                return formatter.formatToParts(time);
            } };
        });
        layer.activate();
        pending[3]([capture]);
        await tick();
        assert.equal(select.title, 'Latest · 2026-10-07 17:27 UTC−8, estimated from longitude · Clouds 3%',
            'a formatter that fails after timezone resolution also uses the labelled estimate');
    } finally { t.mock.restoreAll(); layer.dispose(); dom.window.close(); }
});

test('Leaflet Sentinel intercepts only its own option, preserves native layers, and cleans up', async () => {
    const dom = new JSDOM('<!doctype html><select id="selmap"><option value="L_OS">OSM</option></select>');
    const win = dom.window;
    let nativeChanges = 0, fetches = 0;
    const select = win.document.getElementById('selmap');
    select.addEventListener('change', () => nativeChanges++);
    const native = { native: true };
    let currentBounds = bounds;
    let catalog = [feature(), feature('older', { date: '2026-10-03T19:02:59Z' })];
    const layers = new Set([native]);
    const handlers = new Map();
    win.mapsPlaceholder = { getBounds: () => currentBounds, getZoom: () => 13,
        on: (type, callback) => handlers.set(type, callback), off: type => handlers.delete(type),
        removeLayer: layer => layers.delete(layer) };
    win.fetch = async () => { fetches++; return response(catalog); };
    win.L = { DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} },
        control: () => ({ addTo() { win.document.body.append(this.onAdd()); }, remove() {} }),
        tileLayer: (url, options) => ({ url, options, on(type, callback) { this.tileError = callback; }, addTo() { layers.add(this); } }) };
    const owner = installSentinelMap(win);
    assert.equal(fetches, 0);
    select.value = 'BPB_SENTINEL';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    assert.equal(nativeChanges, 0);
    assert.equal(layers.size, 2);
    assert.ok(layers.has(native));
    const oldTile = [...layers].find(layer => layer !== native);
    assert.match(win.document.body.textContent, /Coverage 100% · Clouds 41%/);
    const captureSelect = win.document.querySelector('.bpb-sentinel select');
    captureSelect.value = 'latest';
    captureSelect.dispatchEvent(new win.Event('change'));
    assert.ok(layers.has(oldTile), 'selecting the displayed capture keeps its loaded tiles');
    captureSelect.value = captureSelect.options[1].value;
    captureSelect.dispatchEvent(new win.Event('change'));
    oldTile.tileError();
    assert.doesNotMatch(win.document.body.textContent, /tiles are unavailable/, 'a removed capture cannot report a tile failure on its replacement');
    const capture = JSON.parse(select.selectedOptions[0].dataset.bpbSentinelCapture);
    assert.equal(capture.time, Date.parse('2026-10-03T19:02:59Z'));
    assert.deepEqual(Object.keys(capture).sort(), ['orbit', 'platform', 'time']);
    select.value = 'L_OS';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.equal(nativeChanges, 1);
    assert.deepEqual([...layers], [native]);
    currentBounds = { ...bounds, getWest: () => 179, getEast: () => 181 };
    catalog = [{ ...feature('older', { date: '2026-10-03T19:02:59Z' }), geometry: { type: 'Polygon', coordinates: [ring(179, -179)] } }];
    select.value = 'BPB_SENTINEL';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    assert.equal([...layers].find(layer => layer !== native).options.bounds, undefined,
        'a dateline scene must not hide its wrapped half behind an unwrapped Leaflet bounds rectangle');
    owner.dispose();
    assert.equal(handlers.size, 0);
    assert.equal(select.options.length, 1);
    dom.window.close();
});

test('catalog limits name the provider, preserve status through unreadable bodies and stop camera retries', async () => {
    await assert.rejects(searchSentinel(view, { fetchImpl: async () => ({ status: 429,
        headers: new Headers({ 'retry-after': '60' }), text() { throw new Error('must not read'); } }) }),
    error => error.code === 'rate-limit' && /Microsoft Planetary Computer request limit reached/.test(error.message));
    const dom = new JSDOM('<!doctype html>');
    let requests = 0;
    const layer = createSentinelLayer({ document: dom.window.document, readView: () => ({ bounds, zoom: 13 }),
        clearScenes() {}, replaceScenes() {}, debounceMs: 0, search: async () => {
            requests++; throw Object.assign(new Error('limit'), { code: 'rate-limit', retryAt: Date.now() + 60000 });
        } });
    try {
        layer.activate(); await new Promise(resolve => setImmediate(resolve));
        assert.match(layer.element.textContent, /Microsoft Planetary Computer request limit reached/);
        assert.equal(layer.element.querySelector('button').disabled, true);
        layer.refresh(); layer.refresh();
        await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 1);
        layer.tileError(); assert.match(layer.element.textContent, /request limit reached/);
        layer.deactivate(); layer.activate(); assert.equal(requests, 1);
    } finally { layer.dispose(); dom.window.close(); }
});
