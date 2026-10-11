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
    const entry = manifest.content_scripts.find(script => script.js?.includes('content/sentinel-map.js'));
    assert.equal(entry.world, 'MAIN');
    assert.equal(entry.all_frames, true);
    assert.ok(entry.matches.every(pattern => /mastermap\.aspx/i.test(pattern) && pattern.startsWith('https:')));
    assert.deepEqual(entry.css, ['css/sentinel.css']);
    assert.deepEqual(ENTRIES.find(bundle => bundle.out === 'content/sentinel-map.js').sources, ['maps/sentinel-map.js']);
    assert.ok(COPY_FILES.some(([source, destination]) => source === 'src/maps/sentinel.css' && destination === 'css/sentinel.css'));
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
    select.value = select.options[2].value;
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
        search: async () => sentinelCaptures([feature('new'), feature('old', { date: '2026-10-03T19:02:59Z' })], view) });
    try {
        const select = layer.element.querySelector('select');
        const metadata = layer.element.querySelector('.bpb-sentinel-metadata');
        const summary = metadata.querySelector('.bpb-sentinel-summary');
        const stats = metadata.querySelector('.bpb-sentinel-stats');
        assert.equal(select.selectedOptions[0].textContent, 'Latest capture');
        layer.activate();
        assert.equal(summary.textContent, 'Finding captures…');
        await tick();
        const date = new Date(captureTime).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        assert.equal(select.selectedOptions[0].textContent, `Latest · ${date}`);
        assert.equal(summary.hidden, true, 'the capture date is not duplicated in a third row');
        assert.match(stats.textContent, /Coverage 100% · Clouds 41%/);
        select.value = select.options[2].value;
        select.dispatchEvent(new dom.window.Event('change'));
        assert.equal(summary.hidden, true, 'pinned and latest captures use the same layout');
        layer.refresh();
        assert.equal(summary.hidden, false);
        assert.equal(summary.textContent, 'Finding captures…');
        assert.equal(stats.textContent, '');
        assert.equal(summary.parentElement, stats.parentElement, 'loading and coverage share one stable slot');
    } finally { layer.dispose(); dom.window.close(); }
});

test('Leaflet Sentinel intercepts only its own option, preserves native layers, and cleans up', async () => {
    const dom = new JSDOM('<!doctype html><select id="selmap"><option value="L_OS">OSM</option></select>');
    const win = dom.window;
    let nativeChanges = 0, fetches = 0;
    const select = win.document.getElementById('selmap');
    select.addEventListener('change', () => nativeChanges++);
    const native = { native: true };
    let currentBounds = bounds;
    let catalog = [feature()];
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
    captureSelect.value = captureSelect.options[1].value;
    captureSelect.dispatchEvent(new win.Event('change'));
    oldTile.tileError();
    assert.doesNotMatch(win.document.body.textContent, /tiles are unavailable/, 'a removed capture cannot report a tile failure on its replacement');
    const capture = JSON.parse(select.selectedOptions[0].dataset.bpbSentinelCapture);
    assert.equal(capture.time, captureTime);
    assert.deepEqual(Object.keys(capture).sort(), ['orbit', 'platform', 'time']);
    select.value = 'L_OS';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.equal(nativeChanges, 1);
    assert.deepEqual([...layers], [native]);
    currentBounds = { ...bounds, getWest: () => 179, getEast: () => 181 };
    catalog = [{ ...feature(), geometry: { type: 'Polygon', coordinates: [ring(179, -179)] } }];
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
