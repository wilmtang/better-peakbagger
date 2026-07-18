// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { terrainCache } from '../src/terrain-cache.js';

class MemoryCache {
    constructor() { this.entries = new Map(); }
    url(value) { return typeof value === 'string' ? value : value.url; }
    async keys() { return Array.from(this.entries.keys(), url => new Request(url)); }
    async match(value) {
        const response = this.entries.get(this.url(value));
        return response ? response.clone() : undefined;
    }
    async put(value, response) { this.entries.set(this.url(value), response.clone()); }
    async delete(value) { return this.entries.delete(this.url(value)); }
}

class MemoryCacheStorage {
    constructor() { this.named = new Map(); this.deletions = []; }
    async keys() { return Array.from(this.named.keys()); }
    async open(name) {
        if (!this.named.has(name)) this.named.set(name, new MemoryCache());
        return this.named.get(name);
    }
    async delete(name) {
        this.deletions.push(name);
        return this.named.delete(name);
    }
}

const makeStorageArea = () => {
    const values = {};
    return {
        values,
        async get(key) { return { [key]: values[key] }; },
        async set(patch) { Object.assign(values, structuredClone(patch)); },
        async remove(key) { delete values[key]; }
    };
};

const loadCacheModule = () => {
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    // Tests pass cacheStorage/storageArea explicitly, so the module needs no
    // ambient caches API.
    return { dom, module: terrainCache };
};

test('DEM protocol accepts only bounded Mapterhorn tile coordinates', () => {
    const { dom, module } = loadCacheModule();
    assert.equal(module.parseTileUrl('bpb-dem://14/2651/5947.webp'), 'https://tiles.mapterhorn.com/14/2651/5947.webp');
    assert.equal(module.parseTileUrl('bpb-dem://14/16384/0.webp'), null);
    assert.equal(module.parseTileUrl('bpb-dem://19/1/1.webp'), null);
    assert.equal(module.parseTileUrl('https://tiles.mapterhorn.com/14/2651/5947.webp'), null);
    dom.window.close();
});

test('DEM cache usage counts actual cached entries and ignores stale index rows', async () => {
    const { dom, module } = loadCacheModule();
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    const cache = await cacheStorage.open(module.CACHE_NAME);
    const firstUrl = 'https://tiles.mapterhorn.com/14/2651/5947.webp';
    const secondUrl = 'https://tiles.mapterhorn.com/14/2651/5948.webp';
    const unknownUrl = 'https://tiles.mapterhorn.com/14/2651/5949.webp';
    const staleUrl = 'https://tiles.mapterhorn.com/14/2651/5950.webp';
    await cache.put(firstUrl, new Response(new Uint8Array([1]), {
        headers: { 'x-bpb-size': '600', 'x-bpb-used': '1' }
    }));
    await cache.put(secondUrl, new Response(new Uint8Array([2]), {
        headers: { 'x-bpb-used': '2' }
    }));
    await cache.put(unknownUrl, new Response(new Uint8Array([3])));
    storageArea.values[module.INDEX_KEY] = {
        [secondUrl]: { size: 400, used: 2 },
        [staleUrl]: { size: 9000, used: 3 }
    };

    const usage = await module.getUsage({ cacheStorage, storageArea });
    assert.equal(usage.bytes, 1000);
    assert.equal(usage.entries, 3);
    assert.equal(usage.unmeasuredEntries, 1);

    const emptyStorage = new MemoryCacheStorage();
    const empty = await module.getUsage({ cacheStorage: emptyStorage, storageArea });
    assert.equal(empty.bytes, 0);
    assert.equal(empty.entries, 0);
    assert.equal(emptyStorage.named.size, 0, 'inspecting an empty cache must not create one');
    dom.window.close();
});

test('DEM cache reuses a tile without another network request', async () => {
    const { dom, module } = loadCacheModule();
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    let fetches = 0;
    const loader = module.create({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        fetchFn: async () => {
            fetches++;
            return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/webp' } });
        }
    });

    const request = { url: 'bpb-dem://1/1/0.webp' };
    assert.deepEqual(Array.from(new Uint8Array((await loader.load(request, new AbortController())).data)), [1, 2, 3, 4]);
    await loader.flush();
    assert.deepEqual(Array.from(new Uint8Array((await loader.load(request, new AbortController())).data)), [1, 2, 3, 4]);
    assert.equal(fetches, 1);
    await loader.flush();
    dom.window.close();
});

test('DEM cache evicts least-recently-used tiles above its limit', async () => {
    const { dom, module } = loadCacheModule();
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    let fetches = 0, clock = 100;
    const loader = module.create({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => ++clock,
        fetchFn: async () => {
            fetches++;
            return new Response(new Uint8Array(700 * 1024).fill(fetches), { status: 200, headers: { 'content-type': 'image/webp' } });
        }
    });

    await loader.load({ url: 'bpb-dem://1/0/0.webp' }, new AbortController());
    await loader.flush();
    await loader.load({ url: 'bpb-dem://1/1/0.webp' }, new AbortController());
    await loader.flush();
    const cache = await cacheStorage.open(module.CACHE_NAME);
    assert.deepEqual(Array.from(cache.entries.keys()), ['https://tiles.mapterhorn.com/1/1/0.webp']);

    await loader.load({ url: 'bpb-dem://1/0/0.webp' }, new AbortController());
    assert.equal(fetches, 3, 'the evicted oldest tile should return to the network');
    await loader.flush();
    dom.window.close();
});

test('a zero DEM cache limit clears owned best-effort storage', async () => {
    const { dom, module } = loadCacheModule();
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    const existing = await cacheStorage.open(module.CACHE_NAME);
    await existing.put('https://tiles.mapterhorn.com/1/0/0.webp', new Response(new Uint8Array([1]), {
        headers: { 'x-bpb-size': '1', 'x-bpb-used': '1' }
    }));
    storageArea.values[module.INDEX_KEY] = {
        'https://tiles.mapterhorn.com/1/0/0.webp': { size: 1, used: 1 }
    };
    let fetches = 0;
    const loader = module.create({
        limitMb: 0,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        fetchFn: async () => {
            fetches++;
            return new Response(new Uint8Array([7]), { status: 200, headers: { 'content-type': 'image/webp' } });
        }
    });

    await loader.load({ url: 'bpb-dem://1/0/0.webp' }, new AbortController());
    await loader.load({ url: 'bpb-dem://1/0/0.webp' }, new AbortController());
    await loader.flush();
    assert.equal(fetches, 2);
    assert.equal(cacheStorage.deletions.includes(module.CACHE_NAME), true);
    assert.equal(storageArea.values[module.INDEX_KEY], undefined);
    dom.window.close();
});
