// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DEM_FIXTURE_CONTENT_TYPE, syntheticDemPixels, syntheticDemWebp } from '../../scripts/terrain-dem-fixture.mts';
import { terrainCache } from '../../src/terrain/terrain-cache.ts';

// Playwright's internal WebP helpers ship no declarations; these are the two
// calls this test makes.
const { utils } = createRequire(import.meta.url)('playwright-core/lib/coreBundle') as { utils: {
    isLosslessWebp(bytes: Uint8Array): boolean;
    decodeWebp(bytes: Uint8Array): { width: number; height: number; data: Uint8Array };
} };
// The CDP Fetch.fulfillRequest parameters the LOD handler sends.
interface FulfillRequest { body: string; responseHeaders: { name: string; value: string }[] }

test('synthetic DEM WebP preserves every Terrarium channel losslessly', () => {
    const pixels = syntheticDemPixels(10, 170, 370), encoded = syntheticDemWebp(10, 170, 370);
    assert.equal(utils.isLosslessWebp(encoded), true);
    const decoded = utils.decodeWebp(encoded);
    assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
    assert.deepEqual(Buffer.from(decoded.data), pixels.data);
    assert.ok(new Set(pixels.data).size > 200, 'the fixture carries varied elevation bytes');
});

test('the actual LOD response reaches the strict production DEM cache without weakening validation', async () => {
    const source = await readFile(new URL('../../scripts/verify-terrain-lod.mts', import.meta.url), 'utf8');
    const start = source.indexOf("cdp.on('Fetch.requestPaused'");
    const end = source.indexOf("await cdp.call('Fetch.enable'", start);
    assert.ok(start >= 0 && end > start, 'LOD request-handler boundaries are missing');
    const tile = syntheticDemWebp(10, 170, 370);
    let receive!: (event: unknown) => void, fulfilled!: (value: FulfillRequest) => void;
    const response = new Promise<FulfillRequest>(resolve => { fulfilled = resolve; });
    vm.runInNewContext(source.slice(start, end), {
        cdp: { on: (_event: string, listener: typeof receive) => { receive = listener; }, call: async (method: string, value: FulfillRequest) => {
            assert.equal(method, 'Fetch.fulfillRequest'); fulfilled(value);
        } },
        DRAPE_HOST: 'drape.example', drapeRequests: 0, demRequests: 0, unexpected: [],
        boundedMapterhornTile: () => ({ z: 10, x: 170, y: 370 }), demTile: () => tile,
        DEM_FIXTURE_CONTENT_TYPE, TILE_DELAY_MS: 0, delay: async () => {},
    });
    receive({ requestId: 'dem', request: { method: 'GET', url: 'https://tiles.mapterhorn.com/10/170/370.webp' } });
    const wire = await response;
    const cache = terrainCache.create({ limitMb: 0, fetchFn: async () => new Response(Buffer.from(wire.body, 'base64'), {
        headers: Object.fromEntries(wire.responseHeaders.map(({ name, value }) => [name, value])),
    }) });
    try {
        const result = await cache.load({ url: 'bpb-dem://10/170/370.webp' });
        assert.deepEqual(Buffer.from(result.data), tile);
    } finally { await cache.close(); }
});
