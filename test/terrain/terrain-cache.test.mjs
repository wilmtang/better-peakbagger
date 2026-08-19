// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { terrainCache } from '../../src/terrain/terrain-cache.js';

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

const makeWebp = (size = 24, marker = 0) => {
    assert.ok(size >= 20 && size % 2 === 0, 'test WebP sizes must be even and include one chunk');
    const bytes = new Uint8Array(size);
    const writeAscii = (offset, value) => {
        for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
    };
    writeAscii(0, 'RIFF');
    writeAscii(8, 'WEBP');
    writeAscii(12, 'VP8L');
    const view = new DataView(bytes.buffer);
    view.setUint32(4, size - 8, true);
    view.setUint32(16, size - 20, true);
    bytes.fill(marker, 20);
    return bytes;
};

const webpResponse = (bytes = makeWebp(), headers = {}) => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/webp', ...headers }
});

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
            return webpResponse(makeWebp(24, 7));
        }
    });

    const request = { url: 'bpb-dem://1/1/0.webp' };
    assert.deepEqual(new Uint8Array((await loader.load(request, new AbortController())).data), makeWebp(24, 7));
    await loader.flush();
    assert.deepEqual(new Uint8Array((await loader.load(request, new AbortController())).data), makeWebp(24, 7));
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
            return webpResponse(makeWebp(700 * 1024, fetches));
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
            return webpResponse(makeWebp(24, 7));
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

test('DEM response size accepts the exact ceiling and rejects an honest byte over before reading', async () => {
    const { dom, module } = loadCacheModule();
    const exact = makeWebp(module.MAX_TILE_BYTES, 3);
    let oversizedBodyReads = 0;
    const responses = [
        webpResponse(exact, {
            'content-length': String(module.MAX_TILE_BYTES),
            'content-type': 'Image/WebP; charset=binary'
        }),
        {
            ok: true,
            status: 200,
            headers: { get: name => ({
                'content-type': 'image/webp',
                'content-length': String(module.MAX_TILE_BYTES + 1)
            })[name.toLowerCase()] ?? null },
            get body() {
                oversizedBodyReads++;
                return new ReadableStream();
            }
        }
    ];
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => responses.shift()
    });

    const accepted = await loader.load({ url: 'bpb-dem://2/0/0.webp' }, new AbortController());
    assert.equal(accepted.data.byteLength, module.MAX_TILE_BYTES);
    await assert.rejects(
        loader.load({ url: 'bpb-dem://2/1/0.webp' }, new AbortController()),
        /exceeded.*byte limit/i
    );
    assert.equal(oversizedBodyReads, 0, 'an honest oversized response must be rejected before its body is read');
    dom.window.close();
});

test('DEM response streaming catches missing and dishonest Content-Length overflow', async () => {
    const { dom, module } = loadCacheModule();
    const responses = [
        webpResponse(makeWebp(24, 1)),
        webpResponse(makeWebp(24, 2), { 'content-length': '22' })
    ];
    let overflowCancelled = 0;
    let overflowSignal = null;
    const overflowReader = {
        index: 0,
        async read() {
            const chunks = [makeWebp(module.MAX_TILE_BYTES, 4), new Uint8Array([0])];
            return this.index < chunks.length
                ? { done: false, value: chunks[this.index++] }
                : { done: true };
        },
        cancel() { overflowCancelled++; return Promise.resolve(); },
        releaseLock() {}
    };
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async (_url, init) => {
            if (responses.length) return responses.shift();
            overflowSignal = init.signal;
            return {
                ok: true,
                status: 200,
                headers: { get: name => (name.toLowerCase() === 'content-type' ? 'image/webp' : null) },
                body: { getReader: () => overflowReader }
            };
        }
    });

    assert.equal((await loader.load({ url: 'bpb-dem://2/0/0.webp' })).data.byteLength, 24,
        'a chunked response without Content-Length remains valid');
    await assert.rejects(loader.load({ url: 'bpb-dem://2/1/0.webp' }), /match its Content-Length/i);
    await assert.rejects(loader.load({ url: 'bpb-dem://2/2/0.webp' }), /exceeded.*byte limit/i);
    assert.equal(overflowCancelled, 1, 'overflow must cancel the unread remainder of the stream');
    assert.equal(overflowSignal.aborted, true, 'overflow must abort the network request');
    dom.window.close();
});

test('DEM response validation rejects empty, truncated, mistyped, and malformed WebP bodies', async () => {
    const { dom, module } = loadCacheModule();
    const badRiff = makeWebp();
    badRiff[0] = 'N'.charCodeAt(0);
    const badWebp = makeWebp();
    badWebp[8] = 'N'.charCodeAt(0);
    const badChunk = makeWebp();
    badChunk[12] = 'J'.charCodeAt(0);
    const badRiffLength = makeWebp();
    new DataView(badRiffLength.buffer).setUint32(4, 100, true);
    const truncatedChunk = makeWebp();
    new DataView(truncatedChunk.buffer).setUint32(16, 100, true);
    const cases = [
        { response: webpResponse(new Uint8Array()), pattern: /empty or truncated/i },
        { response: webpResponse(makeWebp().subarray(0, 12)), pattern: /empty or truncated/i },
        { response: webpResponse(badRiff), pattern: /not a WebP/i },
        { response: webpResponse(badWebp), pattern: /not a WebP/i },
        { response: webpResponse(badChunk), pattern: /invalid WebP image chunk/i },
        { response: webpResponse(badRiffLength), pattern: /invalid WebP RIFF length/i },
        { response: webpResponse(truncatedChunk), pattern: /truncated WebP image chunk/i },
        {
            response: new Response(makeWebp(), { headers: { 'content-type': 'text/html' } }),
            pattern: /unexpected media type/i
        },
        {
            response: webpResponse(makeWebp(), { 'content-length': '24, 25' }),
            pattern: /invalid Content-Length/i
        }
    ];
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => cases[0].response
    });

    for (let index = 0; cases.length; index++) {
        const { pattern } = cases[0];
        await assert.rejects(loader.load({ url: `bpb-dem://4/${index}/0.webp` }), pattern);
        cases.shift();
    }
    dom.window.close();
});

test('a corrupt cached DEM tile is purged before a validated network replacement is used', async () => {
    const { dom, module } = loadCacheModule();
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    const remoteUrl = 'https://tiles.mapterhorn.com/1/1/0.webp';
    const cache = await cacheStorage.open(module.CACHE_NAME);
    await cache.put(remoteUrl, webpResponse(new Uint8Array([1, 2, 3, 4]), {
        'x-bpb-size': '4', 'x-bpb-used': '1'
    }));
    storageArea.values[module.INDEX_KEY] = { [remoteUrl]: { size: 4, used: 1 } };
    let fetches = 0;
    const loader = module.create({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        fetchFn: async () => {
            fetches++;
            return webpResponse(makeWebp(24, 8));
        }
    });

    assert.deepEqual(new Uint8Array((await loader.load({ url: 'bpb-dem://1/1/0.webp' })).data), makeWebp(24, 8));
    await loader.flush();
    assert.deepEqual(new Uint8Array((await loader.load({ url: 'bpb-dem://1/1/0.webp' })).data), makeWebp(24, 8));
    assert.equal(fetches, 1, 'the validated replacement should become the next cache hit');
    dom.window.close();
});

test('concurrent DEM loads validate each response independently', async () => {
    const { dom, module } = loadCacheModule();
    let fetches = 0;
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => webpResponse(makeWebp(24, ++fetches))
    });
    const results = await Promise.all([
        'bpb-dem://3/0/0.webp', 'bpb-dem://3/1/0.webp',
        'bpb-dem://3/2/0.webp', 'bpb-dem://3/3/0.webp'
    ].map(url => loader.load({ url })));

    assert.equal(results.length, 4);
    assert.equal(results.every(result => result.data.byteLength === 24), true);
    assert.equal(fetches, 4);
    dom.window.close();
});

test('concurrent identical DEM loads share validation but receive independent buffers', async () => {
    const { dom, module } = loadCacheModule();
    let fetches = 0;
    let releaseFetch;
    const response = new Promise(resolve => { releaseFetch = resolve; });
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => {
            fetches++;
            return response;
        }
    });
    const request = { url: 'bpb-dem://3/1/1.webp' };
    const first = loader.load(request, new AbortController());
    const second = loader.load(request, new AbortController());
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(fetches, 1);
    releaseFetch(webpResponse(makeWebp(24, 9)));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.notEqual(firstResult.data, secondResult.data);
    new Uint8Array(firstResult.data)[20] = 3;
    assert.equal(new Uint8Array(secondResult.data)[20], 9);
    dom.window.close();
});

test('one DEM subscriber can cancel without aborting another subscriber', async () => {
    const { dom, module } = loadCacheModule();
    let releaseFetch;
    let transportAborted = false;
    const response = new Promise(resolve => { releaseFetch = resolve; });
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async (_url, init) => {
            init.signal.addEventListener('abort', () => { transportAborted = true; }, { once: true });
            return response;
        }
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const request = { url: 'bpb-dem://3/1/1.webp' };
    const first = loader.load(request, firstController);
    const second = loader.load(request, secondController);
    await new Promise(resolve => setTimeout(resolve, 0));
    firstController.abort();
    await assert.rejects(first, error => error.name === 'AbortError');
    assert.equal(transportAborted, false, 'the shared transport remains owned by the second caller');
    releaseFetch(webpResponse(makeWebp(24, 6)));
    assert.equal(new Uint8Array((await second).data)[20], 6);
    dom.window.close();
});

test('the final cancelled DEM subscriber aborts transport and a later load retries', async () => {
    const { dom, module } = loadCacheModule();
    let fetches = 0;
    let transportAborts = 0;
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: (_url, init) => {
            fetches++;
            if (fetches > 1) return Promise.resolve(webpResponse(makeWebp(24, 5)));
            return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    transportAborts++;
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        }
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const request = { url: 'bpb-dem://3/1/1.webp' };
    const first = loader.load(request, firstController);
    const second = loader.load(request, secondController);
    await new Promise(resolve => setTimeout(resolve, 0));
    firstController.abort();
    secondController.abort();
    await Promise.all([
        assert.rejects(first, error => error.name === 'AbortError'),
        assert.rejects(second, error => error.name === 'AbortError'),
    ]);
    assert.equal(transportAborts, 1);
    assert.equal(new Uint8Array((await loader.load(request)).data)[20], 5);
    assert.equal(fetches, 2, 'settled ownership must not poison a retry');
    dom.window.close();
});

test('closing the DEM cache settles subscribers and aborts every shared owner', async () => {
    const { dom, module } = loadCacheModule();
    let started;
    const fetchStarted = new Promise(resolve => { started = resolve; });
    let transportAborts = 0;
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        tileTimeoutMs: 50_000,
        fetchFn: (_url, init) => {
            started();
            init.signal.addEventListener('abort', () => { transportAborts++; }, { once: true });
            return new Promise(() => {});
        }
    });
    const request = { url: 'bpb-dem://3/1/1.webp' };
    const pending = loader.load(request);
    await fetchStarted;
    await loader.close();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(transportAborts, 1);
    await assert.rejects(loader.load(request), error => error.name === 'AbortError');
    dom.window.close();
});

test('a shared missing DEM response clears ownership for a retry', async () => {
    const { dom, module } = loadCacheModule();
    let fetches = 0;
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => ++fetches === 1
            ? new Response('missing', { status: 404 })
            : webpResponse(makeWebp(24, 4))
    });
    const request = { url: 'bpb-dem://3/1/1.webp' };
    const outcomes = await Promise.allSettled([loader.load(request), loader.load(request)]);
    assert.equal(fetches, 1);
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.status === 404));
    assert.equal(new Uint8Array((await loader.load(request)).data)[20], 4);
    assert.equal(fetches, 2);
    dom.window.close();
});

test('a DEM tile the provider does not cover is reported as absent, not as a failure', async () => {
    // MapLibre's tile manager reads error.status to tell "this tile does not
    // exist" from "this tile is broken": a 404 keeps its parent/child fallback
    // running and raises no map-level error, anything else surfaces as a source
    // error. Dropping the status made every coverage gap a renderer failure —
    // and because elevation is the only source in the boot style, that failure
    // landed before MapLibre's `load` and tore the whole 3D view down with
    // "Your browser could not render 3D terrain." Mapterhorn's archives stop at
    // different levels in different regions, so those gaps are routine.
    const { dom, module } = loadCacheModule();
    const statuses = [404, 500];
    const loader = module.create({
        limitMb: 1,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => new Response('Tile not found', { status: statuses.shift() })
    });

    await assert.rejects(loader.load({ url: 'bpb-dem://14/2650/5772.webp' }), error => {
        assert.equal(error.status, 404, 'the tile host status must survive the protocol');
        assert.equal(module.isMissingTile(error), true);
        return true;
    });
    // A provider that is failing rather than empty stays a real error, so the
    // frame can still fall back to 2D instead of pretending the world is flat.
    await assert.rejects(loader.load({ url: 'bpb-dem://14/2650/5773.webp' }), error => {
        assert.equal(error.status, 500);
        assert.equal(module.isMissingTile(error), false);
        return true;
    });
    assert.equal(module.isMissingTile(new Error('DEM tile request failed (404)')), false,
        'only a real tile-request error carries a trustworthy status');
    dom.window.close();
});

test('a DEM tile that never answers fails instead of leaving a hole in the mesh', async () => {
    // Without a bound this request never settles: the renderer leaves a
    // permanent gap no camera move retries, and the background prefetch — which
    // passes no controller of its own — holds a worker awake on it forever.
    const { dom, module } = loadCacheModule();
    const aborts = [];
    const loader = module.create({
        limitMb: 1,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        tileTimeoutMs: 10,
        fetchFn: (_url, init) => {
            init.signal?.addEventListener('abort', () => aborts.push(true));
            return new Promise(() => {});
        }
    });

    await assert.rejects(loader.load({ url: 'bpb-dem://1/1/0.webp' }), /deadline/i);
    assert.equal(aborts.length, 1, 'the stalled tile socket must be released');
    dom.window.close();
});

test('a DEM body that stalls after headers is cancelled at the same request deadline', async () => {
    const { dom, module } = loadCacheModule();
    let aborts = 0, cancellations = 0;
    const reader = {
        read: () => new Promise(() => {}),
        cancel() { cancellations++; return Promise.resolve(); },
        releaseLock() {}
    };
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        tileTimeoutMs: 10,
        fetchFn: async (_url, init) => {
            init.signal.addEventListener('abort', () => { aborts++; }, { once: true });
            return {
                ok: true,
                status: 200,
                headers: { get: name => (name.toLowerCase() === 'content-type' ? 'image/webp' : null) },
                body: { getReader: () => reader }
            };
        }
    });

    await assert.rejects(loader.load({ url: 'bpb-dem://1/1/0.webp' }), /deadline/i);
    assert.equal(aborts, 1, 'the body deadline must abort the underlying request');
    assert.equal(cancellations, 1, 'the unread response stream must be cancelled');
    dom.window.close();
});

test('MapLibre cancellation tears down a DEM response body already being streamed', async () => {
    const { dom, module } = loadCacheModule();
    let readStarted;
    const started = new Promise(resolve => { readStarted = resolve; });
    let cancellations = 0;
    const controller = new AbortController();
    const loader = module.create({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        tileTimeoutMs: 50_000,
        fetchFn: async (_url, init) => ({
            ok: true,
            status: 200,
            headers: { get: name => (name.toLowerCase() === 'content-type' ? 'image/webp' : null) },
            body: {
                getReader: () => ({
                    read: () => new Promise((_resolve, reject) => {
                        readStarted();
                        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                    }),
                    cancel() { cancellations++; return Promise.resolve(); },
                    releaseLock() {}
                })
            }
        })
    });

    const pending = loader.load({ url: 'bpb-dem://1/1/0.webp' }, controller);
    await started;
    controller.abort();
    await assert.rejects(pending, error => !/deadline/i.test(error.message));
    assert.equal(cancellations, 1);
    dom.window.close();
});

test('MapLibre cancelling during the cache read starts no DEM request', async () => {
    const { dom, module } = loadCacheModule();
    const aborts = [];
    const loader = module.create({
        limitMb: 1,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        tileTimeoutMs: 50_000,
        // Matches real fetch: an already-aborted signal rejects at once rather
        // than waiting for an 'abort' event that has already been dispatched.
        fetchFn: (_url, init) => new Promise((_resolve, reject) => {
            const stop = () => { aborts.push(true); reject(new Error('aborted')); };
            if (init.signal?.aborted) stop();
            else init.signal?.addEventListener('abort', stop, { once: true });
        })
    });

    // The camera can move on while the cache read is still awaited, so the
    // abort lands before the tile fetch is even started. Subscribing without
    // first checking `aborted` misses it, and the tile then runs to the full
    // deadline for a view nobody is looking at — the generous bound that makes
    // the stall survivable is exactly what makes that miss expensive.
    const controller = new AbortController();
    const pending = loader.load({ url: 'bpb-dem://1/1/0.webp' }, controller);
    controller.abort();
    await assert.rejects(pending, error => !/deadline/i.test(error.message),
        'cancellation must end the tile, not its 50-second deadline');
    assert.equal(aborts.length, 0, 'an already-gone consumer must not create a network owner');
    dom.window.close();
});
