// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCustomSourceUrl, resolveCustomSourceDocument } from '../../src/maps/custom-overlay-source.js';
import { createCustomClient } from '../../src/maps/custom-overlay-client.js';

const source = () => ({ id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'My chosen name', kind: 'raster',
    source: { metadataUrl: 'https://tiles.example.com/source.json', tiles: [], scheme: 'xyz', minNativeZoom: 0, maxNativeZoom: 18,
        tileSize: 256, zoomOrigin: { min: 'default', max: 'default' }, bounds: null },
    approvedOrigins: ['https://tiles.example.com'], attribution: { text: 'Saved credit' }, appearance: { opacity: 60, rules: [] } });
const metadata = () => ({ tilejson: '3.0.0', minzoom: 2, maxzoom: 14, scheme: 'tms', tileSize: 512,
    bounds: [-124, 44, -120, 49], tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'] });

test('URL inference recognizes supported suffixes without guessing hidden metadata or unsafe endpoints', () => {
    for (const [suffix, kind] of [['png', 'raster'], ['JPG', 'raster'], ['webp', 'raster'], ['pbf', 'mvt'], ['mvt', 'mvt']]) {
        assert.deepEqual(inferCustomSourceUrl(`https://tiles.example.com/{z}/{x}/{y}.${suffix}?key=public`), { kind, format: 'template' });
    }
    assert.deepEqual(inferCustomSourceUrl('https://tiles.example.com/data.geojson?download=1'), { kind: 'geojson', format: 'tilejson' });
    assert.deepEqual(inferCustomSourceUrl('https://tiles.example.com/source.json'), { kind: null, format: 'tilejson' });
    assert.deepEqual(inferCustomSourceUrl('https://tiles.example.com/{z}/{x}/{y}'), { kind: null, format: 'template' });
    for (const url of ['http://tiles.example.com/a.json', 'javascript:alert(1)', 'https://localhost/source.json', 'https://tiles.example.com/{z}/{x}.png']) assert.equal(inferCustomSourceUrl(url), null);
});
test('TileJSON fills type, zoom, scheme, bounds and declared tile size while preserving the user name and credit', () => {
    const result = resolveCustomSourceDocument(source(), metadata(), { detectKind: true, styleAuto: true });
    assert.equal(result.source.kind, 'raster');assert.equal(result.source.name, 'My chosen name');assert.equal(result.source.attribution.text, 'Saved credit');
    assert.deepEqual([result.source.source.minNativeZoom, result.source.source.maxNativeZoom, result.source.source.scheme, result.source.source.tileSize], [2, 14, 'tms', 512]);
    assert.deepEqual(result.source.source.bounds, [-124, 44, -120, 49]);
    const manual = source();manual.source.maxNativeZoom = 12;manual.source.zoomOrigin.max = 'manual';manual.source.bounds = [-123, 45, -122, 47];
    const retained = resolveCustomSourceDocument(manual, metadata(), { detectKind: true, manualFields: ['scheme', 'bounds', 'tile-size'] }).source;
    assert.equal(retained.source.maxNativeZoom, 12);assert.equal(retained.source.scheme, 'xyz');assert.equal(retained.source.tileSize, 256);assert.deepEqual(retained.source.bounds, manual.source.bounds);
});
test('saved manual scheme, bounds and logical tile size survive metadata resolution on the actual map', async () => {
    const input = source();input.source.manualFields = ['scheme', 'bounds', 'tile-size'];input.source.bounds = [-123,45,-122,47];
    const client = createCustomClient({ fetchImpl: async () => new Response(JSON.stringify(metadata())) });
    const resolved = await client.resolve(input, new AbortController().signal);
    assert.equal(resolved.source.source.scheme, 'xyz');assert.equal(resolved.source.source.tileSize, 256);
    assert.deepEqual(resolved.source.source.bounds, input.source.bounds);assert.deepEqual(resolved.source.source.manualFields, input.source.manualFields);
    client.clear();
});
test('vector metadata supplies the sole source layer and geometry defaults; ambiguous layers remain a user choice', () => {
    const data = { ...metadata(), tiles: ['https://tiles.example.com/{z}/{x}/{y}.pbf'], vector_layers: [{ id: 'trails' }] };
    const result = resolveCustomSourceDocument(source(), data, { detectKind: true, styleAuto: true });
    assert.equal(result.source.kind, 'mvt');assert.deepEqual(result.layers, ['trails']);
    assert.deepEqual(result.source.appearance.rules.map(rule => rule.geometry), ['point', 'line', 'polygon']);
    assert(result.source.appearance.rules.every(rule => rule.sourceLayer === 'trails'));
    data.vector_layers.push({ id: 'roads' });
    assert(resolveCustomSourceDocument(source(), data, { detectKind: true, styleAuto: true }).source.appearance.rules.every(rule => rule.sourceLayer === '__choose_layer__'));
    assert.throws(() => resolveCustomSourceDocument(source(), { ...data, vector_layers: [{ id: {} }] }, { detectKind: true }), /vector source layers/);
});
test('a JSON endpoint can identify GeoJSON and populate matching default geometry without inheriting tile fields', () => {
    const result = resolveCustomSourceDocument(source(), { type: 'FeatureCollection', bbox: [-123, 45, -122, 47],
        features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }] }, { detectKind: true, styleAuto: true });
    assert.equal(result.source.kind, 'geojson');assert.equal(result.source.source.dataUrl, 'https://tiles.example.com/source.json');assert.equal(result.source.source.metadataUrl, undefined);
    assert.deepEqual(result.source.appearance.rules.map(rule => rule.geometry), ['polygon']);
    assert.throws(() => resolveCustomSourceDocument(result.source, metadata()), /GeoJSON FeatureCollection/);
    assert.throws(() => resolveCustomSourceDocument(source(), { version: 8, sources: {} }, { detectKind: true }), /full map styles/);
    assert.throws(() => resolveCustomSourceDocument(source(), { ...metadata(), tiles: ['https://tiles.example.com/{z}/{x}/{y}'] }, { detectKind: true }), /tile type/);
    assert.throws(() => resolveCustomSourceDocument(source(), { ...metadata(), tiles: ['https://127.0.0.1/{z}/{x}/{y}.png'] }, { detectKind: true }));
    assert.throws(() => resolveCustomSourceDocument(source(), { ...metadata(), maxzoom: '22' }, { detectKind: true }));
});
test('source inspection uses one bounded request to the supplied JSON endpoint and reports extra hosts for review', async () => {
    const calls = [], client = createCustomClient({ fetchImpl: async (url, options) => {
        calls.push(url);assert.equal(options.credentials, 'omit');assert.equal(options.redirect, 'error');
        return new Response(JSON.stringify({ ...metadata(), tiles: ['https://other.example.com/{z}/{x}/{y}.png'] }));
    } });
    const result = await client.resolve(source(), new AbortController().signal, false, { detectKind: true });
    assert.deepEqual(calls, ['https://tiles.example.com/source.json']);assert.deepEqual(result.origins, ['https://other.example.com']);
    client.clear();
});
