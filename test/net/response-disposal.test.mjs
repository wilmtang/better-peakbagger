// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherClient } from '../../src/weather/open-meteo-client.js';
import { WEATHER_MODELS } from '../../src/weather/weather-models.js';
import { createPeakModelUpdateClient } from '../../src/weather/peak-weather-updates.js';
import { createSnotelClient } from '../../src/snow/snotel-client.js';
import { searchSentinel } from '../../src/maps/sentinel-core.js';
import { drawAlbertaLand } from '../../src/maps/canadian-land.js';
import { createOverlayTiles } from '../../src/maps/map-overlay-tiles.js';
import { createBCLandRoutes } from '../../src/background/bc-land-routes.js';
import { terrainStyle } from '../../src/terrain/terrain-style.js';
import { terrainCache } from '../../src/terrain/terrain-cache.js';

const readers = {
    weather: fetchFn => assert.rejects(createWeatherClient({ fetchFn }).request(
        { latitude: 47, longitude: -121, elevation: null },
        { startDate: '2026-10-01', endDate: '2026-10-01' }, WEATHER_MODELS[0])),
    snow: fetchFn => assert.rejects(createSnotelClient({ fetchFn, retryDelayMs: 0 }).stations()),
    'weather metadata': async fetchFn => {
        const result = await createPeakModelUpdateClient({ fetchFn }).request('ncep_gfs013');
        assert.deepEqual(result, { data: null });
    },
    satellite: fetchImpl => assert.rejects(searchSentinel(
        { west: -122, south: 47, east: -121.9, north: 47.1 }, { fetchImpl })),
    alberta: fetchImpl => assert.rejects(drawAlbertaLand({ fetchImpl,
        signal: new AbortController().signal, bbox: [0, 0, 1, 1] })),
    bc: async fetchImpl => {
        const { handlers } = createBCLandRoutes({ fetchImpl, isPeakbaggerSender: () => true,
            ext: { permissions: { contains: async () => true } } });
        const result = await handlers.BC_LAND_TILE_GET({ requestId: 'one', coordinates: { z: 12, x: 637, y: 1315 } },
            { tab: { id: 1 }, frameId: 0 });
        assert.equal(result.ok, false);
    },
    overlay: async fetchImpl => {
        const document = { createElement: () => ({ getContext: () => ({}) }) };
        const tiles = createOverlayTiles({ document, fetchImpl, retryDelayMs: 0 });
        try { await assert.rejects(tiles.draw('slope', { z: 10, x: 163, y: 359 }, tiles.canvas())); }
        finally { tiles.dispose(); }
    },
    style: fetch => assert.rejects(terrainStyle.createVectorStyleLoader({ fetch,
        styleUrl: 'https://tiles.openfreemap.org/styles/liberty' }).load()),
    dem: async fetchFn => {
        const loader = terrainCache.create({ limitMb: 0, fetchFn });
        try { await assert.rejects(loader.load({ url: 'bpb-dem://1/1/0.webp' })); }
        finally { await loader.close(); }
    },
};

for (const [name, read] of Object.entries(readers)) {
    for (const status of [404, 503]) test(`${name} cancels unread HTTP ${status} bodies before completing or retrying`, async () => {
        let fetched = 0, cancelled = 0;
        await read(async () => {
            assert.equal(cancelled, fetched, 'dispose the previous response before another attempt');
            fetched++;
            return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status });
        });
        assert.ok(fetched > 0, 'the production transport must execute');
        assert.equal(cancelled, fetched, 'every rejected response relinquishes its open body');
    });
}

for (const [name, headers] of [
    ['weather', { 'content-type': 'text/html' }],
    ['weather metadata', { 'content-type': 'text/html' }],
    ['satellite', { 'content-length': String(5 * 1024 * 1024) }],
    ['bc', { 'content-type': 'image/png', 'content-length': '1048577' }],
    ['overlay', { 'content-type': 'image/png', 'content-length': String(5 * 1024 * 1024) }],
    ['style', {}], // Response.url is empty, outside the fixed style provider.
    ['dem', { 'content-type': 'text/html' }],
]) test(`${name} cancels a body refused by response metadata without awaiting cancellation`, async () => {
    let cancelled = 0;
    await readers[name](async () => new Response(new ReadableStream({
        cancel() { cancelled++; return new Promise(() => {}); },
    }), { headers }));
    assert.equal(cancelled, 1);
});
