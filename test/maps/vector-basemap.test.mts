// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { VECTOR_BASEMAP, MAPTOOLKIT_BASEMAP, vectorBasemap, vectorProviderUrl } from '../../src/maps/vector-basemap.ts';
import type { VectorBasemap } from '../../src/maps/vector-basemap.ts';
import { terrainStyle } from '../../src/terrain/terrain-style.ts';
import type { VectorStyle } from '../../src/terrain/terrain-style.ts';

const asFetch = (implementation: (url: string, options: RequestInit) => Promise<unknown>) => implementation as unknown as typeof fetch;

test('built-in vector choices resolve only fixed identifiers and scope resource hosts to their provider', () => {
    assert.equal(vectorBasemap('maptoolkit'), MAPTOOLKIT_BASEMAP); assert.equal(vectorBasemap('BPB_MAPTOOLKIT'), MAPTOOLKIT_BASEMAP);
    assert.equal(vectorBasemap('BPB_VECTOR'), VECTOR_BASEMAP);
    for (const id of ['https://evil.example/style', '__proto__', null, {}]) assert.equal(vectorBasemap(id), null);
    for (const url of ['https://tiles.openfreemap.org/tile', 'https://evil.example/tile', 'http://tiles.maptoolkit.org/tile', 'https://user@tiles.maptoolkit.org/tile', 'https://tiles.maptoolkit.org/tile#secret']) assert.equal(vectorProviderUrl(url, MAPTOOLKIT_BASEMAP), null);
    for (const origin of MAPTOOLKIT_BASEMAP.origins) assert.equal(vectorProviderUrl(origin + '/tile', MAPTOOLKIT_BASEMAP), origin + '/tile');
    assert.equal(vectorProviderUrl(MAPTOOLKIT_BASEMAP.styleUrl), null, 'OpenFreeMap never inherits Maptoolkit hosts');
    assert.equal(vectorProviderUrl('https://evil.example/tile', { origins: ['https://evil.example'] } as unknown as VectorBasemap), null);
});
test('Maptoolkit relief, terrarium DEM and named sprite sheets survive bounded style normalization', () => {
    const style = { version: 8, sources: {
        base: { type: 'vector', url: 'https://tiles.maptoolkit.org/mtk-contours.json' },
        relief: { type: 'raster-dem', url: 'https://tiles.maptoolkit.org/terrainrgb.json', encoding: 'terrarium', tileSize: 8192 },
    }, layers: [{ id: 'sea', type: 'color-relief', source: 'relief', paint: { 'color-relief-color': '#ace' } },
        { id: 'contours', type: 'line', source: 'base', 'source-layer': 'contour' }],
    sprite: [{ id: 'sdf', url: 'https://icons.maptoolkit.org/sprite' }], glyphs: 'https://fonts.maptoolkit.org/{fontstack}/{range}.pbf',
    metadata: { copyright: 'Maptoolkit', license_url: 'https://www.maptoolkit.org/tos/', 'unused:legend': { remote: 'https://evil.example/font.css' } } };
    const normalized = terrainStyle.normalizeStyle(style, { basemap: MAPTOOLKIT_BASEMAP });
    assert.ok(normalized); assert.deepEqual(normalized.sources, style.sources); assert.deepEqual(normalized.sprite, style.sprite);
    assert.deepEqual(normalized.layers, style.layers); assert.deepEqual(normalized.metadata, { copyright: 'Maptoolkit', license_url: 'https://www.maptoolkit.org/tos/' });
    assert.equal(terrainStyle.normalizeStyle(style), null);
    for (const bad of [{ ...style, sprite: [{ id: 'sdf', url: 'https://evil.example/sprite' }] },
        { ...style, sprite: [...style.sprite, ...style.sprite] }, { ...style, sources: { base: { type: 'vector', url: VECTOR_BASEMAP.styleUrl } } },
        { ...style, sources: { relief: { ...style.sources.relief, encoding: 'unknown' } } }]) assert.equal(terrainStyle.normalizeStyle(bad, { basemap: MAPTOOLKIT_BASEMAP }), null);
});
test('Maptoolkit style loading omits identity, rejects redirects and preserves provider-specific rate limits', async () => {
    const style = { version: 8, sources: {}, layers: [] };
    let calls = 0;
    const loader = terrainStyle.createVectorStyleLoader({ basemap: MAPTOOLKIT_BASEMAP, styleUrl: MAPTOOLKIT_BASEMAP.styleUrl, fetch: asFetch(async (url, options) => {
        calls++; assert.equal(url, MAPTOOLKIT_BASEMAP.styleUrl); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
        return { ok: true, url, text: async () => JSON.stringify(style) };
    }) });
    assert.deepEqual(await loader.load(), style); await loader.load(); assert.equal(calls, 1);
    const limited = terrainStyle.createVectorStyleLoader({ basemap: MAPTOOLKIT_BASEMAP, styleUrl: MAPTOOLKIT_BASEMAP.styleUrl,
        fetch: asFetch(async () => ({ status: 429, headers: new Headers({ 'retry-after': '120' }) })) });
    await assert.rejects(limited.load(), (error: Error & { retryAt: number }) => error.retryAt > Date.now() && /Maptoolkit request limit/.test(error.message));
});

test('Hiking uses one detailed hillshade in 2D and the existing terrain shading in 3D', () => {
    const sources = { mtk: { type: 'vector' }, sea: { type: 'raster-dem', tileSize: 512 },
        detail: { type: 'raster-dem' }, ...Object.fromEntries([2048, 4096, 8192].map(tileSize => [`soft${tileSize}`, { type: 'raster-dem', tileSize }])) };
    const style: VectorStyle = { version: 8, sources, sprite: [{ id: 'sdf', url: 'https://icons.maptoolkit.org/sprite' }],
        layers: [{ id: 'paths', type: 'line', source: 'mtk' }, { id: 'labels', type: 'symbol', source: 'mtk' },
            { id: 'water', type: 'color-relief', source: 'sea' }, ...['detail', 'soft2048', 'soft4096', 'soft8192'].map(source => ({ id: source, type: 'hillshade', source }))] };
    const original = structuredClone(style);
    const planar = terrainStyle.renderingStyle(style, { basemap: MAPTOOLKIT_BASEMAP });
    const terrain = terrainStyle.renderingStyle(style, { basemap: MAPTOOLKIT_BASEMAP, terrain: true });
    assert.equal(planar.layers.filter(layer => layer.type === 'hillshade').length, 1);
    assert.deepEqual(Object.keys(planar.sources), ['mtk', 'sea', 'detail']);
    assert.equal(terrain.layers.some(layer => layer.type === 'hillshade'), false);
    assert.deepEqual(Object.keys(terrain.sources), ['mtk', 'sea']);
    for (const adapted of [planar, terrain]) {
        assert.deepEqual(adapted.layers.slice(0, 3), style.layers.slice(0, 3)); assert.equal(adapted.sprite, style.sprite);
    }
    assert.deepEqual(style, original, 'Adapting one surface cannot mutate the shared accepted provider style');
    assert.equal(terrainStyle.renderingStyle(style), style, 'OpenFreeMap remains unchanged');
});
