// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainCache } from '../../src/terrain/terrain-cache.ts';

const webp = (size: number) => {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    const ascii = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index); };
    ascii(0, 'RIFF'); ascii(8, 'WEBP'); ascii(12, 'VP8L');
    view.setUint32(4, size - 8, true); view.setUint32(16, size - 20, true);
    return bytes;
};
const response = (bytes: Uint8Array) => new Response(bytes.slice(), { headers: { 'content-type': 'image/webp', 'x-bpb-size': String(bytes.byteLength), 'x-bpb-used': '1' } });

// A full cache holds about a thousand entries, so its hit path must not visit them all.
test('a burst of cache hits costs one index write and no per-entry lookups', async () => {
    const entries = new Map<string, Uint8Array>(), bytes = webp(64);
    let matches = 0, writes = 0;
    const url = (x: number) => `https://tiles.mapterhorn.com/10/${x}/0.webp`;
    const index: Record<string, { size: number; used: number }> = {};
    for (let x = 0; x < 1000; x++) { entries.set(url(x), bytes); index[url(x)] = { size: 64, used: x + 1 }; }
    const cache = {
        keys: async () => [...entries.keys()].map(item => ({ url: item })),
        match: async (item: string | { url: string }) => { matches++; const found = entries.get(typeof item === 'string' ? item : item.url); return found && response(found); },
        put: async () => {}, delete: async () => true,
    };
    const cacheStorage = { open: async () => cache, delete: async () => true, keys: async () => [terrainCache.CACHE_NAME] };
    const values: Record<string, unknown> = { [terrainCache.INDEX_KEY]: index };
    const storageArea = {
        get: async (key: string) => ({ [key]: values[key] }), remove: async () => {},
        set: async (data: Record<string, unknown>) => { writes++; Object.assign(values, data); },
    };
    let clock = 5000;
    const loader = terrainCache.create({ limitMb: 512, cacheStorage, storageArea, fetchFn: async () => assert.fail('A hit must not fetch'), now: () => ++clock, ResponseCtor: Response } as never);
    await new Promise(resolve => setTimeout(resolve, 0));
    matches = 0; writes = 0;
    const loaded = await Promise.all(Array.from({ length: 50 }, (_, x) => loader.load({ url: `bpb-dem://10/${x}/0.webp` }, new AbortController())));
    assert.equal(loaded.length, 50);
    assert.equal(writes, 0, 'Tile bytes do not wait on the index');
    assert.equal(await loader.close(), true);
    assert.equal(matches, 50, 'Each hit opens its own tile and nothing else');
    assert.equal(writes, 1, 'The batch commits once');
    const stored = values[terrainCache.INDEX_KEY] as typeof index;
    assert.ok(stored[url(0)].used > 1000 && stored[url(49)].used > 1000, 'Every hit refreshed its LRU position');
    assert.equal(stored[url(999)].used, 1000, 'An untouched tile keeps its place');
});
