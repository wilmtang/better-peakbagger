// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { terrainCache } from '../../src/terrain/terrain-cache.ts';

class MemoryCache {
    entries = new Map<string, Response>();
    url(value: string | Request) { return typeof value === 'string' ? value : value.url; }
    async keys() { return Array.from(this.entries.keys(), url => new Request(url)); }
    async match(value: string | Request) {
        const response = this.entries.get(this.url(value));
        return response ? response.clone() : undefined;
    }
    async put(value: string | Request, response: Response) { this.entries.set(this.url(value), response.clone()); }
    async delete(value: string | Request) { return this.entries.delete(this.url(value)); }
}

class MemoryCacheStorage {
    named = new Map<string, MemoryCache>();
    deletions: string[] = [];
    async keys() { return Array.from(this.named.keys()); }
    async open(name: string) {
        const existing = this.named.get(name);
        if (existing) return existing;
        const cache = new MemoryCache();
        this.named.set(name, cache);
        return cache;
    }
    async delete(name: string) {
        this.deletions.push(name);
        return this.named.delete(name);
    }
}

type CacheIndex = Record<string, { size: number; used: number }>;
type StoredIndexes = Record<string, CacheIndex>;

const makeStorageArea = () => {
    const values: StoredIndexes = {};
    return {
        values,
        async get(key: string) { return { [key]: values[key] }; },
        async set(patch: StoredIndexes) { Object.assign(values, structuredClone(patch)); },
        async remove(key: string) { delete values[key]; }
    };
};

const makeRecordingStorageArea = ({ failSets = 0 } = {}) => {
    const storage = makeStorageArea();
    let setCalls = 0;
    let serializedBytes = 0;
    return {
        ...storage,
        get setCalls() { return setCalls; },
        get serializedBytes() { return serializedBytes; },
        async set(patch: StoredIndexes) {
            setCalls++;
            serializedBytes += JSON.stringify(patch).length;
            if (setCalls <= failSets) throw new Error('injected storage failure');
            Object.assign(storage.values, structuredClone(patch));
        }
    };
};

type CacheOptions = Parameters<typeof terrainCache.create>[0];
type FixtureResponse = Pick<Response, 'ok' | 'status'> & {
    headers: Pick<Headers, 'get'>;
    body: {
        getReader(): Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'>;
        cancel?(): Promise<void>;
    };
};
interface FixtureStorage {
    cacheStorage: MemoryCacheStorage;
    storageArea: ReturnType<typeof makeStorageArea>;
}
type CacheFixtureOptions = Omit<CacheOptions, keyof FixtureStorage | 'fetchFn'> & FixtureStorage & {
    fetchFn?(url: string, init: { signal: AbortSignal }): Promise<Response | FixtureResponse>;
};

// The Node mocks implement the methods the terrain cache reads. The browser
// API signatures also describe wider CacheStorage, storage and fetch surfaces.
const cacheAdapters = ({ cacheStorage, storageArea }: FixtureStorage) => ({
    cacheStorage: cacheStorage as unknown as CacheStorage,
    storageArea: storageArea as unknown as NonNullable<CacheOptions['storageArea']>,
});

const createCache = ({ cacheStorage, storageArea, fetchFn, ...settings }: CacheFixtureOptions) =>
    terrainCache.create({
        ...settings,
        ...cacheAdapters({ cacheStorage, storageArea }),
        fetchFn: fetchFn as CacheOptions['fetchFn'],
    });

const getUsage = async (storage: FixtureStorage) => {
    const usage = await terrainCache.getUsage(cacheAdapters(storage));
    assert.ok(usage, 'usage must be available with a functioning cache adapter');
    return usage;
};

const deferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
};

const makeWebp = (size = 24, marker = 0) => {
    assert.ok(size >= 20 && size % 2 === 0, 'test WebP sizes must be even and include one chunk');
    const bytes = new Uint8Array(size);
    const writeAscii = (offset: number, value: string) => {
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

const webpResponse = (bytes = makeWebp(), headers: Record<string, string> = {}) => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/webp', ...headers }
});

test('DEM protocol accepts only bounded Mapterhorn tile coordinates', () => {
    assert.equal(terrainCache.parseTileUrl('bpb-dem://14/2651/5947.webp'), 'https://tiles.mapterhorn.com/14/2651/5947.webp');
    assert.equal(terrainCache.parseTileUrl('bpb-dem://14/16384/0.webp'), null);
    assert.equal(terrainCache.parseTileUrl('bpb-dem://19/1/1.webp'), null);
    assert.equal(terrainCache.parseTileUrl('https://tiles.mapterhorn.com/14/2651/5947.webp'), null);
});

test('DEM cache usage counts actual cached entries and ignores stale index rows', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    const cache = await cacheStorage.open(terrainCache.CACHE_NAME);
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
    storageArea.values[terrainCache.INDEX_KEY] = {
        [secondUrl]: { size: 400, used: 2 },
        [staleUrl]: { size: 9000, used: 3 }
    };

    const usage = await getUsage({ cacheStorage, storageArea });
    assert.equal(usage.bytes, 1000);
    assert.equal(usage.entries, 3);
    assert.equal(usage.unmeasuredEntries, 1);

    const emptyStorage = new MemoryCacheStorage();
    const empty = await getUsage({ cacheStorage: emptyStorage, storageArea });
    assert.equal(empty.bytes, 0);
    assert.equal(empty.entries, 0);
    assert.equal(emptyStorage.named.size, 0, 'inspecting an empty cache must not create one');
});

test('DEM cache reuses a tile without another network request', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    let fetches = 0;
    const loader = createCache({
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
});

test('a 1,000-tile DEM burst persists a bounded index generation instead of every prefix', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeRecordingStorageArea();
    let clock = 100;
    const loader = createCache({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => ++clock,
        fetchFn: async () => webpResponse(makeWebp(24, 7))
    });

    await Promise.all(Array.from({ length: 1_000 }, (_, x) =>
        loader.load({ url: `bpb-dem://10/${x}/0.webp` })));
    assert.equal(await loader.flush(), true);

    const index = storageArea.values[terrainCache.INDEX_KEY];
    assert.equal(Object.keys(index).length, 1_000);
    const finalBytes = JSON.stringify({ [terrainCache.INDEX_KEY]: index }).length;
    assert.ok(storageArea.setCalls <= 4,
        `expected at most 4 coalesced index writes, observed ${storageArea.setCalls}`);
    assert.ok(storageArea.serializedBytes <= finalBytes * 4,
        `expected serialized bytes proportional to the final index, observed ${storageArea.serializedBytes}`);

    const writesAfterBurst = storageArea.setCalls;
    const previousUsed = index['https://tiles.mapterhorn.com/10/0/0.webp'].used;
    await loader.load({ url: 'bpb-dem://10/0/0.webp' });
    assert.equal(await loader.flush(), true);
    assert.ok(storageArea.values[terrainCache.INDEX_KEY]['https://tiles.mapterhorn.com/10/0/0.webp'].used > previousUsed,
        'a cache hit must persist its refreshed LRU timestamp');
    assert.equal(storageArea.setCalls, writesAfterBurst + 1);

    assert.equal(await loader.flush(), true);
    assert.equal(storageArea.setCalls, writesAfterBurst + 1,
        'flushing an already-persisted generation must not rewrite it');
    assert.equal(await loader.close(), true);
});

test('DEM cache close retries transient index failures and reports a persistent failure', async () => {
    const transientStorage = makeRecordingStorageArea({ failSets: 1 });
    const transientLoader = createCache({
        limitMb: 1,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: transientStorage,
        ResponseCtor: Response,
        fetchFn: async () => webpResponse(makeWebp(24, 3))
    });

    await transientLoader.load({ url: 'bpb-dem://1/0/0.webp' });
    assert.equal(await transientLoader.close(), true);
    assert.equal(transientStorage.setCalls, 2);
    assert.equal(Object.keys(transientStorage.values[terrainCache.INDEX_KEY]).length, 1);

    const persistentStorage = makeRecordingStorageArea({ failSets: Number.POSITIVE_INFINITY });
    const persistentLoader = createCache({
        limitMb: 1,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: persistentStorage,
        ResponseCtor: Response,
        fetchFn: async () => webpResponse(makeWebp(24, 4))
    });

    await persistentLoader.load({ url: 'bpb-dem://1/1/0.webp' });
    assert.equal(await persistentLoader.close(), false,
        'the owner must be able to observe an unpersisted final generation');
    assert.equal(persistentStorage.setCalls, 2,
        'persistent quota/privacy failures must remain bounded and best effort');
});

test('DEM cache close waits for an active cache hit before persisting its LRU update', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeRecordingStorageArea();
    const remoteUrl = 'https://tiles.mapterhorn.com/1/1/0.webp';
    const cache = await cacheStorage.open(terrainCache.CACHE_NAME);
    await cache.put(remoteUrl, webpResponse(makeWebp(24, 5), {
        'x-bpb-size': '24',
        'x-bpb-used': '1'
    }));
    storageArea.values[terrainCache.INDEX_KEY] = { [remoteUrl]: { size: 24, used: 1 } };

    const originalMatch = cache.match.bind(cache);
    const { promise: matchStarted, resolve: announceMatch } = deferred<void>();
    const { promise: matchGate, resolve: releaseMatch } = deferred<void>();
    cache.match = async value => {
        announceMatch();
        await matchGate;
        return originalMatch(value);
    };

    const loader = createCache({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => 50,
        fetchFn: async () => { throw new Error('the cached tile must not use the network'); }
    });
    const pending = loader.load({ url: 'bpb-dem://1/1/0.webp' });
    await matchStarted;
    const closing = loader.close();
    releaseMatch();
    assert.equal(new Uint8Array((await pending).data)[20], 5);
    assert.equal(await closing, true);
    assert.equal(storageArea.values[terrainCache.INDEX_KEY][remoteUrl].used, 50);
    assert.equal(storageArea.setCalls, 1);
});

test('DEM cache evicts least-recently-used tiles above its limit', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    let fetches = 0, clock = 100;
    const loader = createCache({
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
    const cache = await cacheStorage.open(terrainCache.CACHE_NAME);
    assert.deepEqual(Array.from(cache.entries.keys()), ['https://tiles.mapterhorn.com/1/1/0.webp']);

    await loader.load({ url: 'bpb-dem://1/0/0.webp' }, new AbortController());
    assert.equal(fetches, 3, 'the evicted oldest tile should return to the network');
    await loader.flush();
});

test('two DEM cache owners enforce one budget and persist the retained entry', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    const first = createCache({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => 100,
        fetchFn: async () => webpResponse(makeWebp(700 * 1024, 1))
    });
    const second = createCache({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => 200,
        fetchFn: async () => webpResponse(makeWebp(700 * 1024, 2))
    });

    await Promise.all([
        first.load({ url: 'bpb-dem://1/0/0.webp' }),
        second.load({ url: 'bpb-dem://1/1/0.webp' })
    ]);
    assert.deepEqual(await Promise.all([first.close(), second.flush()]), [true, true]);

    const usage = await getUsage({ cacheStorage, storageArea });
    assert.deepEqual(usage, { bytes: 700 * 1024, entries: 1, unmeasuredEntries: 0 });
    const cache = await cacheStorage.open(terrainCache.CACHE_NAME);
    assert.deepEqual(Object.keys(storageArea.values[terrainCache.INDEX_KEY]), [...cache.entries.keys()],
        'the shared index must describe the one retained CacheStorage entry');
    await second.close();
});

test('two owners storing the same DEM tile retain one indexed copy', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    let fetches = 0;
    const { promise: fetchGate, resolve: releaseFetches } = deferred<void>();
    const makeOwner = (marker: number) => createCache({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        fetchFn: async () => {
            fetches++;
            await fetchGate;
            return webpResponse(makeWebp(700 * 1024, marker));
        }
    });
    const first = makeOwner(3);
    const second = makeOwner(4);
    const request = { url: 'bpb-dem://1/1/0.webp' };
    const pending = Promise.all([first.load(request), second.load(request)]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetches, 2, 'network ownership remains local to each context');
    releaseFetches();
    await pending;
    await Promise.all([first.flush(), second.flush()]);

    assert.deepEqual(await getUsage({ cacheStorage, storageArea }), {
        bytes: 700 * 1024, entries: 1, unmeasuredEntries: 0
    });
    assert.deepEqual(Object.keys(storageArea.values[terrainCache.INDEX_KEY]), [
        'https://tiles.mapterhorn.com/1/1/0.webp'
    ]);
    await Promise.all([first.close(), second.close()]);
});

test('concurrent cross-owner cache hits guide later shared eviction', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    let seedClock = 0;
    const seed = createCache({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => ++seedClock,
        fetchFn: async url => webpResponse(makeWebp(400 * 1024, url.includes('/0/0.webp') ? 1 : 2))
    });
    await seed.load({ url: 'bpb-dem://2/0/0.webp' });
    await seed.load({ url: 'bpb-dem://2/1/0.webp' });
    await seed.close();

    const hitOwner = (used: number, url: string) => {
        const owner = createCache({
            limitMb: 1,
            cacheStorage,
            storageArea,
            ResponseCtor: Response,
            now: () => used,
            fetchFn: async () => { throw new Error(`expected ${url} to be cached`); }
        });
        return { owner, pending: owner.load({ url }) };
    };
    const firstHit = hitOwner(100, 'bpb-dem://2/0/0.webp');
    const secondHit = hitOwner(200, 'bpb-dem://2/1/0.webp');
    await Promise.all([firstHit.pending, secondHit.pending]);

    const writer = createCache({
        limitMb: 1,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => 300,
        fetchFn: async () => webpResponse(makeWebp(400 * 1024, 3))
    });
    await writer.load({ url: 'bpb-dem://2/2/0.webp' });
    await writer.flush();

    const cache = await cacheStorage.open(terrainCache.CACHE_NAME);
    assert.deepEqual([...cache.entries.keys()], [
        'https://tiles.mapterhorn.com/2/1/0.webp',
        'https://tiles.mapterhorn.com/2/2/0.webp'
    ], 'the least-recent cross-owner hit must be the tile evicted');
    assert.deepEqual(Object.keys(storageArea.values[terrainCache.INDEX_KEY]), [...cache.entries.keys()]);
    await Promise.all([firstHit.owner.close(), secondHit.owner.close(), writer.close()]);
});

test('a replacement DEM owner applies a lower or zero cache limit', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    let clock = 0;
    const larger = createCache({
        limitMb: 2,
        cacheStorage,
        storageArea,
        ResponseCtor: Response,
        now: () => ++clock,
        fetchFn: async () => webpResponse(makeWebp(700 * 1024, clock + 1))
    });
    await larger.load({ url: 'bpb-dem://1/0/0.webp' });
    await larger.load({ url: 'bpb-dem://1/1/0.webp' });
    await larger.close();
    assert.equal((await getUsage({ cacheStorage, storageArea })).entries, 2);

    const smaller = createCache({
        limitMb: 1, cacheStorage, storageArea, ResponseCtor: Response,
        fetchFn: async () => { throw new Error('limit reconciliation needs no network'); }
    });
    assert.equal(await smaller.flush(), true);
    assert.deepEqual(await getUsage({ cacheStorage, storageArea }), {
        bytes: 700 * 1024, entries: 1, unmeasuredEntries: 0
    });
    await smaller.close();

    const disabled = createCache({
        limitMb: 0, cacheStorage, storageArea, ResponseCtor: Response,
        fetchFn: async () => webpResponse(makeWebp())
    });
    assert.equal(await disabled.flush(), true);
    assert.deepEqual(await getUsage({ cacheStorage, storageArea }), {
        bytes: 0, entries: 0, unmeasuredEntries: 0
    });
    assert.equal(storageArea.values[terrainCache.INDEX_KEY], undefined);
});

test('a zero DEM cache limit clears owned best-effort storage', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    const existing = await cacheStorage.open(terrainCache.CACHE_NAME);
    await existing.put('https://tiles.mapterhorn.com/1/0/0.webp', new Response(new Uint8Array([1]), {
        headers: { 'x-bpb-size': '1', 'x-bpb-used': '1' }
    }));
    storageArea.values[terrainCache.INDEX_KEY] = {
        'https://tiles.mapterhorn.com/1/0/0.webp': { size: 1, used: 1 }
    };
    let fetches = 0;
    const loader = createCache({
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
    assert.equal(cacheStorage.deletions.includes(terrainCache.CACHE_NAME), true);
    assert.equal(storageArea.values[terrainCache.INDEX_KEY], undefined);
});

test('DEM response size accepts the exact ceiling and rejects an honest byte over before reading', async () => {
    const exact = makeWebp(terrainCache.MAX_TILE_BYTES, 3);
    let oversizedBodyReads = 0, oversizedBodyCancels = 0;
    const responses: (Response | FixtureResponse)[] = [
        webpResponse(exact, {
            'content-length': String(terrainCache.MAX_TILE_BYTES),
            'content-type': 'Image/WebP; charset=binary'
        }),
        {
            ok: true,
            status: 200,
            headers: new Headers({
                'content-type': 'image/webp',
                'content-length': String(terrainCache.MAX_TILE_BYTES + 1),
            }),
            body: {
                getReader() { oversizedBodyReads++; throw new Error('Oversized bodies must not be read.'); },
                cancel() { oversizedBodyCancels++; return Promise.resolve(); },
            }
        }
    ];
    const loader = createCache({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => {
            const response = responses.shift();
            assert.ok(response, 'unexpected extra tile request');
            return response;
        }
    });

    const accepted = await loader.load({ url: 'bpb-dem://2/0/0.webp' }, new AbortController());
    assert.equal(accepted.data.byteLength, terrainCache.MAX_TILE_BYTES);
    await assert.rejects(
        loader.load({ url: 'bpb-dem://2/1/0.webp' }, new AbortController()),
        /exceeded.*byte limit/i
    );
    assert.equal(oversizedBodyReads, 0, 'an honest oversized response must be rejected before its body is read');
    assert.equal(oversizedBodyCancels, 1, 'metadata rejection still cancels the unread stream');
});

test('DEM response streaming catches missing and dishonest Content-Length overflow', async () => {
    const responses = [
        webpResponse(makeWebp(24, 1)),
        webpResponse(makeWebp(24, 2), { 'content-length': '22' })
    ];
    let overflowCancelled = 0;
    let overflowSignal: AbortSignal | undefined;
    const overflowReader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'> & { index: number } = {
        index: 0,
        async read() {
            const chunks = [makeWebp(terrainCache.MAX_TILE_BYTES, 4), new Uint8Array([0])];
            return this.index < chunks.length
                ? { done: false, value: chunks[this.index++] }
                : { done: true, value: undefined };
        },
        cancel() { overflowCancelled++; return Promise.resolve(); },
        releaseLock() {}
    };
    const loader = createCache({
        limitMb: 0,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async (_url, init) => {
            const response = responses.shift();
            if (response) return response;
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
    assert.equal(overflowSignal?.aborted, true, 'overflow must abort the network request');
});

test('DEM response validation rejects empty, truncated, mistyped, and malformed WebP bodies', async () => {
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
    const loader = createCache({
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
});

test('a corrupt cached DEM tile is purged before a validated network replacement is used', async () => {
    const cacheStorage = new MemoryCacheStorage();
    const storageArea = makeStorageArea();
    const remoteUrl = 'https://tiles.mapterhorn.com/1/1/0.webp';
    const cache = await cacheStorage.open(terrainCache.CACHE_NAME);
    await cache.put(remoteUrl, webpResponse(new Uint8Array([1, 2, 3, 4]), {
        'x-bpb-size': '4', 'x-bpb-used': '1'
    }));
    storageArea.values[terrainCache.INDEX_KEY] = { [remoteUrl]: { size: 4, used: 1 } };
    let fetches = 0;
    const loader = createCache({
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
});

test('concurrent DEM loads validate each response independently', async () => {
    let fetches = 0;
    const loader = createCache({
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
});

test('concurrent identical DEM loads share validation but receive independent buffers', async () => {
    let fetches = 0;
    const { promise: response, resolve: releaseFetch } = deferred<Response>();
    const loader = createCache({
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
});

test('one DEM subscriber can cancel without aborting another subscriber', async () => {
    let transportAborted = false;
    const { promise: response, resolve: releaseFetch } = deferred<Response>();
    const loader = createCache({
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
    await assert.rejects(first, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(transportAborted, false, 'the shared transport remains owned by the second caller');
    releaseFetch(webpResponse(makeWebp(24, 6)));
    assert.equal(new Uint8Array((await second).data)[20], 6);
});

test('the final cancelled DEM subscriber aborts transport and a later load retries', async () => {
    let fetches = 0;
    let transportAborts = 0;
    const loader = createCache({
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
        assert.rejects(first, error => error instanceof Error && error.name === 'AbortError'),
        assert.rejects(second, error => error instanceof Error && error.name === 'AbortError'),
    ]);
    assert.equal(transportAborts, 1);
    assert.equal(new Uint8Array((await loader.load(request)).data)[20], 5);
    assert.equal(fetches, 2, 'settled ownership must not poison a retry');
});

test('closing the DEM cache settles subscribers and aborts every shared owner', async () => {
    const { promise: fetchStarted, resolve: started } = deferred<void>();
    let transportAborts = 0;
    const loader = createCache({
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
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(transportAborts, 1);
    await assert.rejects(loader.load(request), error => error instanceof Error && error.name === 'AbortError');
});

test('a shared missing DEM response clears ownership for a retry', async () => {
    let fetches = 0;
    const loader = createCache({
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
    const statuses = [404, 500];
    const loader = createCache({
        limitMb: 1,
        cacheStorage: new MemoryCacheStorage(),
        storageArea: makeStorageArea(),
        ResponseCtor: Response,
        fetchFn: async () => new Response('Tile not found', { status: statuses.shift() })
    });

    await assert.rejects(loader.load({ url: 'bpb-dem://14/2650/5772.webp' }), error => {
        assert.ok(error instanceof Error && 'status' in error);
        assert.equal(error.status, 404, 'the tile host status must survive the protocol');
        assert.equal(terrainCache.isMissingTile(error), true);
        return true;
    });
    // A provider that is failing rather than empty stays a real error, so the
    // frame can still fall back to 2D instead of pretending the world is flat.
    await assert.rejects(loader.load({ url: 'bpb-dem://14/2650/5773.webp' }), error => {
        assert.ok(error instanceof Error && 'status' in error);
        assert.equal(error.status, 500);
        assert.equal(terrainCache.isMissingTile(error), false);
        return true;
    });
    assert.equal(terrainCache.isMissingTile(new Error('DEM tile request failed (404)')), false,
        'only a real tile-request error carries a trustworthy status');
});

test('a DEM tile that never answers fails instead of leaving a hole in the mesh', async () => {
    // Without a bound this request never settles: the renderer leaves a
    // permanent gap no camera move retries, and the background prefetch — which
    // passes no controller of its own — holds a worker awake on it forever.
    const aborts: boolean[] = [];
    const loader = createCache({
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
});

test('a DEM body that stalls after headers is cancelled at the same request deadline', async () => {
    let aborts = 0, cancellations = 0;
    const reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'> = {
        read: () => new Promise(() => {}),
        cancel() { cancellations++; return Promise.resolve(); },
        releaseLock() {}
    };
    const loader = createCache({
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
});

test('MapLibre cancellation tears down a DEM response body already being streamed', async () => {
    const { promise: started, resolve: readStarted } = deferred<void>();
    let cancellations = 0;
    const controller = new AbortController();
    const loader = createCache({
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
                    read: () => new Promise<never>((_resolve, reject) => {
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
    await assert.rejects(pending, error => error instanceof Error && !/deadline/i.test(error.message));
    assert.equal(cancellations, 1);
});

test('MapLibre cancelling during the cache read starts no DEM request', async () => {
    const aborts: boolean[] = [];
    const loader = createCache({
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
    await assert.rejects(pending, error => error instanceof Error && !/deadline/i.test(error.message),
        'cancellation must end the tile, not its 50-second deadline');
    assert.equal(aborts.length, 0, 'an already-gone consumer must not create a network owner');
});

test('confirmed DEM limits retain HTTP status and gate new tiles without breaking cached coverage', async () => {
    let now = 1000, calls = 0;
    const cache = createCache({ limitMb: 1, cacheStorage: new MemoryCacheStorage(), storageArea: makeStorageArea(), now: () => now,
        fetchFn: async () => { calls++; return calls === 1 ? webpResponse() : new Response('', { status: 429, headers: { 'retry-after': '60' } }); } });
    try {
        const a = { url: 'bpb-dem://14/2651/5947.webp' }, b = { url: 'bpb-dem://14/2652/5947.webp' };
        await cache.load(a); await cache.flush();
        await assert.rejects(cache.load(b), error => error instanceof Error && 'status' in error
            && error.status === 429 && /Mapterhorn request limit reached/.test(error.message));
        await cache.load(a); await assert.rejects(cache.load(b), { code: 'rate-limit' }); assert.equal(calls, 2);
        now += 60001; await assert.rejects(cache.load(b), { status: 429 }); assert.equal(calls, 3);
    } finally { cache.close(); }
});
