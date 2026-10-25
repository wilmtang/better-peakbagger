// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { parseCustomData, readCustomGeoJSON } from '../../src/maps/custom-overlay-data.js';
import { createCustomClient, customTileAt, customFailure } from '../../src/maps/custom-overlay-client.js';
const definition = () => ({ id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Trails', kind: 'mvt',
    source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.pbf'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz' },
    approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [{ sourceLayer: 'trails', geometry: 'line', color: '#26734d' }] } });
const mvt = () => fromGeojsonVt({ trails: { features: [{ type: 2, geometry: [[[0, 2048], [4096, 2048]]], tags: {} }] } }, { version: 2, extent: 4096 }).buffer;
const parse = async data => parseCustomData(data);
test('MVT decoding and parent re-encoding preserve child coordinates rather than moving parent geometry', () => {
    const parent = parseCustomData({ kind: 'mvt', bytes: mvt(), layers: ['trails'] });
    assert.deepEqual(parent.features[0].paths, [[[0, .5], [1, .5]]]);
    const child = parseCustomData({ kind: 'mvt', bytes: mvt(), layers: ['trails'], transform: { scale: 2, x: 1, y: 1 } });
    assert.deepEqual(child.features[0].paths, [[[0, 0], [1, 0]]]);
    assert.deepEqual(parseCustomData({ kind: 'mvt', bytes: child.data, layers: ['trails'] }).features[0].paths, child.features[0].paths);
    assert.deepEqual(parseCustomData({ kind: 'mvt', bytes: mvt(), layers: ['absent'] }).features, []);
    assert.throws(() => parseCustomData({ kind: 'mvt', bytes: new Uint8Array([255]).buffer, layers: ['trails'] }));
});
test('GeoJSON validation preserves holes and removes properties without accepting foreign CRS or dateline rings', () => {
    const value = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { html: '<script>bad</script>' }, geometry: { type: 'Polygon', coordinates: [
        [[0, 0], [2, 0], [2, 2], [0, 0]], [[.2, .2], [.4, .2], [.4, .4], [.2, .2]],
    ] } }] };
    assert.equal(readCustomGeoJSON(value).features[0].geometry.coordinates.length, 2);
    assert.deepEqual(readCustomGeoJSON(value).features[0].properties, {});
    assert.throws(() => readCustomGeoJSON({ ...value, crs: {} }));
    assert.throws(() => readCustomGeoJSON({ ...value, features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[179, 0], [-179, 0]] } }] }));
});
test('direct MVT loading falls back only on missing tiles and probes never borrow a parent', async () => {
    const calls = [], source = definition();
    const client = createCustomClient({ parse, fetchImpl: async (url, options) => {
        calls.push(url); assert.equal(options.mode, 'cors'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
        return url.includes('/8/') ? new Response(null, { status: 404 }) : new Response(mvt());
    } });
    const result = await client.tile(source, { z: 8, x: 6, y: 4 }, new AbortController().signal);
    assert.equal(result.lower, true); assert.equal(calls.length, 2); assert.match(calls[1], /\/7\/3\/2/);
    calls.length = 0;
    await assert.rejects(client.tile(source, { z: 8, x: 6, y: 4 }, new AbortController().signal, false), { status: 404 });
    assert.equal(calls.length, 1);
    const denied = createCustomClient({ parse, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(denied.tile(source, { z: 8, x: 6, y: 4 }, new AbortController().signal), error => error.code === 'access' && /CORS/.test(customFailure(error)));
});
test('TileJSON defaults and explicit metadata never overwrite manual zoom settings or hide extra origins', async () => {
    const source = definition(); source.source.metadataUrl = 'https://tiles.example.com/tiles.json';
    source.source.zoomOrigin = { min: 'manual', max: 'default' }; source.source.minNativeZoom = 5;
    const client = createCustomClient({ parse, fetchImpl: async () => Response.json({ tilejson: '3.0.0', minzoom: 2, maxzoom: 14, tiles: ['https://cdn.example.com/{z}/{x}/{y}.pbf'] }) });
    const result = await client.resolve(source);
    assert.equal(result.source.source.minNativeZoom, 5); assert.equal(result.source.source.maxNativeZoom, 14);
    assert.deepEqual(result.origins, ['https://cdn.example.com']);
    assert.deepEqual(customTileAt(0, 0, 1), { z: 1, x: 1, y: 1 });
});
