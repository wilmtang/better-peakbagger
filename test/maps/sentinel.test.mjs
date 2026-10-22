// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { searchSentinel, sentinelCaptures, sentinelTileUrl, sentinelView } from '../../src/maps/sentinel-core.js';
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

test('catalog limits name the provider without reading refused bodies', async () => {
    await assert.rejects(searchSentinel(view, { fetchImpl: async () => ({ status: 429,
        headers: new Headers({ 'retry-after': '60' }), text() { throw new Error('must not read'); } }) }),
    error => error.code === 'rate-limit' && /Microsoft Planetary Computer request limit reached/.test(error.message));
});
