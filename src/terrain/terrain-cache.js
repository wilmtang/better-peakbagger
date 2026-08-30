// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — bounded, best-effort cache for public Mapterhorn DEM
// tiles. CacheStorage remains browser-managed: the browser may evict it when
// space is tight, and a cache miss always falls back to the network.

import { requestDeadline as Deadline } from '../net/request-deadline.js';

const CACHE_NAME = 'bpb-mapterhorn-dem-v1';
// The status a tile host returns for ground it does not cover. Mapterhorn's
// archives stop at different levels in different regions — global coverage runs
// to roughly zoom 11-13 and only a few areas are served deeper — so a view that
// asks for a level past the local archive is routine, not an error.
const MISSING_TILE_STATUS = 404;
// A tile the host accepts and never answers has two costs: the renderer
// leaves a permanent hole in the mesh where no camera move ever retries it,
// and the background prefetch — which passes no abort controller of its own
// — holds a worker awake on a request that will never settle. Generous
// enough that a slow connection still completes; a refused tile falls back
// to its parent exactly as a 404 already does.
const TILE_TIMEOUT_MS = 20000;
// A 2026-08-09 live sample across Mapterhorn zooms 10-14 measured
// 277,870-402,962 encoded bytes. One MiB leaves more than 2.5x headroom for
// legitimate terrain variation while bounding a provider or intermediary that
// returns an HTML error page, an unbounded stream, or otherwise hostile data.
// This is independent of the user-selected total CacheStorage budget: it
// applies before MapLibre or the cache receives any one response.
const MAX_TILE_BYTES = 1024 * 1024;
const INDEX_KEY = 'bpbMapterhornDemIndexV1';
const PROTOCOL = 'bpb-dem';
const REMOTE_TILE_ORIGIN = 'https://tiles.mapterhorn.com';
const MAX_ZOOM = 18;

// MapLibre's tile manager reads `error.status` to tell an absent tile from a
// broken one: a 404 keeps its parent/child fallback running and deliberately
// raises no map-level error, while anything else surfaces as a source error. A
// status-less Error therefore turned every gap in a provider's coverage into a
// renderer failure — and because the elevation source is the only one in the
// boot style, that failure landed before MapLibre's `load` and tore the whole
// 3D view down. Carrying the status through is what lets a coverage gap fall
// back to the coarser level that does exist.
class TileRequestError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'TileRequestError';
        this.status = status;
    }
}

const isMissingTile = error => error instanceof TileRequestError && error.status === MISSING_TILE_STATUS;

const responseHeader = (response, name) => response?.headers?.get?.(name);

const parseContentLength = response => {
    const raw = responseHeader(response, 'content-length');
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    if (!/^\d+$/.test(value)) throw new Error('DEM tile had an invalid Content-Length');
    const size = Number(value);
    if (!Number.isSafeInteger(size)) throw new Error('DEM tile had an invalid Content-Length');
    return size;
};

const hasAscii = (bytes, offset, value) => {
    for (let index = 0; index < value.length; index++) {
        if (bytes[offset + index] !== value.charCodeAt(index)) return false;
    }
    return true;
};

const validateWebp = data => {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength < 20) throw new Error('DEM tile was empty or truncated');
    if (!hasAscii(bytes, 0, 'RIFF') || !hasAscii(bytes, 8, 'WEBP')) {
        throw new Error('DEM tile was not a WebP image');
    }

    const view = new DataView(data);
    if (view.getUint32(4, true) + 8 !== bytes.byteLength) {
        throw new Error('DEM tile had an invalid WebP RIFF length');
    }
    const validFirstChunk = hasAscii(bytes, 12, 'VP8 ')
        || hasAscii(bytes, 12, 'VP8L')
        || hasAscii(bytes, 12, 'VP8X');
    if (!validFirstChunk) throw new Error('DEM tile had an invalid WebP image chunk');

    const chunkSize = view.getUint32(16, true);
    const chunkEnd = 20 + chunkSize + (chunkSize % 2);
    if (chunkEnd > bytes.byteLength) throw new Error('DEM tile had a truncated WebP image chunk');
};

const readBoundedWebp = async (response, deadline = null) => {
    const mediaType = String(responseHeader(response, 'content-type') || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (mediaType !== 'image/webp') {
        deadline?.abort();
        throw new Error('DEM tile had an unexpected media type');
    }

    let declaredSize;
    try {
        declaredSize = parseContentLength(response);
    } catch (error) {
        deadline?.abort();
        throw error;
    }
    if (declaredSize !== null && declaredSize > MAX_TILE_BYTES) {
        deadline?.abort();
        throw new Error(`DEM tile exceeded the ${MAX_TILE_BYTES}-byte limit`);
    }

    const reader = response?.body?.getReader?.();
    if (!reader) {
        deadline?.abort();
        throw new Error('DEM tile response body was unavailable');
    }

    const chunks = [];
    let complete = false;
    let total = 0;
    try {
        while (true) {
            const pending = reader.read();
            const result = deadline ? await deadline.run(pending) : await pending;
            if (result.done) {
                complete = true;
                break;
            }
            const chunk = result.value instanceof Uint8Array
                ? result.value
                : new Uint8Array(result.value);
            total += chunk.byteLength;
            if (total > MAX_TILE_BYTES) {
                throw new Error(`DEM tile exceeded the ${MAX_TILE_BYTES}-byte limit`);
            }
            chunks.push(chunk);
        }
    } finally {
        if (!complete) {
            deadline?.abort();
            try { reader.cancel().catch(() => {}); } catch (error) { /* Best-effort stream teardown. */ }
        }
        try { reader.releaseLock(); } catch (error) { /* A pending read releases after cancellation. */ }
    }

    if (declaredSize !== null && declaredSize !== total) {
        throw new Error('DEM tile body did not match its Content-Length');
    }
    const data = new ArrayBuffer(total);
    const output = new Uint8Array(data);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    validateWebp(data);
    return data;
};

const cleanIndex = raw => {
    const index = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return index;
    for (const [url, entry] of Object.entries(raw)) {
        if (!url.startsWith(`${REMOTE_TILE_ORIGIN}/`) || !entry || typeof entry !== 'object') continue;
        const size = Number(entry.size), used = Number(entry.used);
        if (Number.isFinite(size) && size > 0 && size <= MAX_TILE_BYTES
                && Number.isFinite(used) && used > 0) {
            index[url] = { size: Math.floor(size), used: Math.floor(used) };
        }
    }
    return index;
};

const resolveStorageArea = storageArea => {
    if (storageArea) return storageArea;
    const api = typeof browser !== 'undefined' && browser.storage ? browser : globalThis.chrome;
    return api && api.storage && api.storage.local;
};

const readStoredIndex = async storageArea => {
    if (!storageArea || typeof storageArea.get !== 'function') return {};
    try {
        const stored = await storageArea.get(INDEX_KEY);
        return cleanIndex(stored && stored[INDEX_KEY]);
    } catch (error) {
        return {};
    }
};

const parseTileUrl = value => {
    const match = typeof value === 'string' && value.match(/^bpb-dem:\/\/(\d{1,2})\/(\d+)\/(\d+)\.webp$/);
    if (!match) return null;
    const z = Number(match[1]), x = Number(match[2]), y = Number(match[3]);
    const dimension = 2 ** z;
    if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM
            || !Number.isInteger(x) || !Number.isInteger(y)
            || x < 0 || y < 0 || x >= dimension || y >= dimension) return null;
    return `${REMOTE_TILE_ORIGIN}/${z}/${x}/${y}.webp`;
};

const create = ({
    limitMb, cacheStorage, storageArea, fetchFn, ResponseCtor,
    now = Date.now, tileTimeoutMs = TILE_TIMEOUT_MS,
}) => {
    const limitBytes = Math.max(0, Math.floor(limitMb)) * 1024 * 1024;
    const cacheApi = cacheStorage || globalThis.caches;
    const local = resolveStorageArea(storageArea);
    const request = fetchFn || globalThis.fetch.bind(globalThis);
    const CachedResponse = ResponseCtor || globalThis.Response;
    let statePromise = null;
    let writeQueue = Promise.resolve();
    let persistenceQueue = Promise.resolve();
    let saveTimer = null;
    let closed = false;
    let dirtyGeneration = 0;
    let persistedGeneration = 0;
    let closePromise = null;
    const inFlight = new Map();
    const activeLoads = new Set();

    const saveIndex = async state => {
        if (!local || typeof local.set !== 'function' || !state) return false;
        const generation = dirtyGeneration;
        if (generation <= persistedGeneration) return true;
        const snapshot = Object.fromEntries(Object.entries(state.index)
            .map(([url, entry]) => [url, { size: entry.size, used: entry.used }]));
        let saved = false;
        persistenceQueue = persistenceQueue.then(async () => {
            try {
                await local.set({ [INDEX_KEY]: snapshot });
                persistedGeneration = Math.max(persistedGeneration, generation);
                saved = true;
            } catch (error) { /* Cache data remains usable without its LRU index. */ }
        }).catch(() => {});
        await persistenceQueue;
        return saved;
    };

    const removeStoredIndex = async () => {
        if (!local || typeof local.remove !== 'function') return;
        try { await local.remove(INDEX_KEY); } catch (error) { /* Best-effort cleanup. */ }
    };

    const removeIndexEntry = (state, url) => {
        const entry = state.index[url];
        if (!entry) return false;
        delete state.index[url];
        state.lru.delete(url);
        state.totalBytes = Math.max(0, state.totalBytes - entry.size);
        return true;
    };

    const setIndexEntry = (state, url, entry) => {
        const previous = state.index[url];
        if (previous) state.totalBytes -= previous.size;
        state.index[url] = entry;
        state.totalBytes += entry.size;
        state.lru.delete(url);
        state.lru.set(url, entry);
    };

    const trim = async state => {
        if (state.totalBytes <= limitBytes) return false;

        let changed = false;
        for (const [url] of [...state.lru]) {
            if (state.totalBytes <= limitBytes) break;
            try { await state.cache.delete(url); } catch (error) { continue; }
            changed = removeIndexEntry(state, url) || changed;
        }
        return changed;
    };

    const scheduleSave = state => {
        if (saveTimer !== null || !state || closed) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void saveIndex(state).then(saved => {
                // A mutation that landed while a successful snapshot was in
                // flight owns the next checkpoint. A failed best-effort write
                // waits for another mutation or an explicit flush/close rather
                // than spinning forever against a full storage quota.
                if (saved && dirtyGeneration > persistedGeneration) scheduleSave(state);
            });
        }, 1000);
    };

    const markDirty = state => {
        dirtyGeneration++;
        scheduleSave(state);
    };

    const initialize = async () => {
        if (!cacheApi || typeof cacheApi.open !== 'function') return null;
        if (limitBytes === 0) {
            try { await cacheApi.delete(CACHE_NAME); } catch (error) { /* Best-effort cleanup. */ }
            await removeStoredIndex();
            return null;
        }

        const [cache, storedIndex] = await Promise.all([cacheApi.open(CACHE_NAME), readStoredIndex(local)]);
        const requests = await cache.keys();
        const actualUrls = new Set(requests.map(item => item.url));
        const index = Object.fromEntries(Object.entries(storedIndex).filter(([url]) => actualUrls.has(url)));
        let metadataChanged = Object.keys(index).length !== Object.keys(storedIndex).length;

        // Rebuild metadata if the browser kept CacheStorage but purged the
        // small local index independently.
        for (const item of requests) {
            if (index[item.url]) continue;
            const response = await cache.match(item);
            const size = Number(response && response.headers.get('x-bpb-size'));
            const used = Number(response && response.headers.get('x-bpb-used'));
            if (Number.isFinite(size) && size > 0 && size <= MAX_TILE_BYTES) {
                index[item.url] = {
                    size: Math.floor(size),
                    used: Number.isFinite(used) && used > 0 ? Math.floor(used) : now()
                };
                metadataChanged = true;
            } else {
                await cache.delete(item);
                metadataChanged = true;
            }
        }

        const orderedEntries = Object.entries(index).sort((a, b) => a[1].used - b[1].used);
        const state = {
            cache,
            index,
            lru: new Map(orderedEntries),
            totalBytes: orderedEntries.reduce((sum, [, entry]) => sum + entry.size, 0),
        };
        if (await trim(state)) metadataChanged = true;
        if (metadataChanged) markDirty(state);
        return state;
    };

    const getState = () => {
        if (!statePromise) statePromise = initialize().catch(() => null);
        return statePromise;
    };

    const read = async remoteUrl => {
        const state = await getState();
        if (!state) return null;
        try {
            const response = await state.cache.match(remoteUrl);
            if (!response) {
                if (removeIndexEntry(state, remoteUrl)) markDirty(state);
                return null;
            }
            const data = await readBoundedWebp(response);
            setIndexEntry(state, remoteUrl, { size: data.byteLength, used: now() });
            markDirty(state);
            return data;
        } catch (error) {
            try { await state.cache.delete(remoteUrl); } catch (deleteError) { /* Best-effort corrupt-entry cleanup. */ }
            if (removeIndexEntry(state, remoteUrl)) markDirty(state);
            return null;
        }
    };

    const enqueueStore = (remoteUrl, data, contentType) => {
        writeQueue = writeQueue.then(async () => {
            const state = await getState();
            if (!state || data.byteLength > limitBytes || data.byteLength > MAX_TILE_BYTES) return;
            const used = now();
            const response = new CachedResponse(data.slice(0), {
                status: 200,
                headers: {
                    'content-type': contentType || 'image/webp',
                    'x-bpb-size': String(data.byteLength),
                    'x-bpb-used': String(used)
                }
            });
            try {
                await state.cache.put(remoteUrl, response);
                setIndexEntry(state, remoteUrl, { size: data.byteLength, used });
                await trim(state);
                markDirty(state);
            } catch (error) {
            // Quota pressure or browser eviction is a normal cache miss,
            // never a reason to fail terrain rendering.
            }
        }).catch(() => {});
    };

    const startNetworkLoad = remoteUrl => {
        if (closed) throw Object.assign(new Error('DEM cache was closed'), { name: 'AbortError' });
        // One owner holds the immutable tile's network request, byte bound,
        // validation, and cache write. Callers subscribe below; their own
        // cancellation never tears down work another caller still needs.
        const deadline = Deadline.createRequestDeadline(tileTimeoutMs);
        const owner = {
            deadline,
            consumers: 0,
            settled: false,
            promise: null,
            cancel: null,
            cancelled: null,
        };
        owner.cancelled = new Promise((_, reject) => {
            owner.cancel = () => reject(Object.assign(new Error('DEM cache was closed'), { name: 'AbortError' }));
        });
        owner.cancelled.catch(() => {});
        owner.promise = (async () => {
            const response = await deadline.run(request(remoteUrl, {
                signal: deadline.signal,
                credentials: 'omit',
                referrerPolicy: 'no-referrer'
            }));
            if (!response || !response.ok) {
                throw new TileRequestError(
                    `DEM tile request failed (${response && response.status})`,
                    response && response.status
                );
            }
            const data = await readBoundedWebp(response, deadline);
            if (!closed && limitBytes > 0) enqueueStore(remoteUrl, data, responseHeader(response, 'content-type'));
            return data;
        })().finally(() => {
            owner.settled = true;
            deadline.clear();
            if (inFlight.get(remoteUrl) === owner) inFlight.delete(remoteUrl);
        });
        inFlight.set(remoteUrl, owner);
        return owner;
    };

    const cancellationError = signal => signal?.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('DEM tile request was cancelled'), { name: 'AbortError' });

    const subscribe = async (remoteUrl, owner, signal) => {
        if (signal?.aborted) throw cancellationError(signal);
        owner.consumers++;
        let cancel = null;
        const cancelled = signal && typeof signal.addEventListener === 'function'
            ? new Promise((_, reject) => {
                cancel = () => reject(cancellationError(signal));
                signal.addEventListener('abort', cancel, { once: true });
            })
            : null;
        try {
            const data = await Promise.race([
                owner.promise,
                owner.cancelled,
                ...(cancelled ? [cancelled] : []),
            ]);
            // MapLibre may transfer or mutate the returned buffer. Never hand
            // two subscribers the same ArrayBuffer identity.
            return { data: data.slice(0) };
        } finally {
            if (cancel) signal.removeEventListener?.('abort', cancel);
            owner.consumers--;
            if (owner.consumers === 0 && !owner.settled) {
                if (inFlight.get(remoteUrl) === owner) inFlight.delete(remoteUrl);
                owner.deadline.abort();
            }
        }
    };

    const loadInternal = async (parameters, abortController) => {
        const remoteUrl = parseTileUrl(parameters && parameters.url);
        if (!remoteUrl) throw new Error('Invalid DEM tile URL');
        if (closed) throw Object.assign(new Error('DEM cache was closed'), { name: 'AbortError' });

        const caller = abortController?.signal;
        const cached = await read(remoteUrl);
        if (cached) return { data: cached };
        // The cache read above is awaited, so the camera can move on before a
        // network owner exists. Do not start work for an already-gone consumer.
        if (caller?.aborted) throw cancellationError(caller);

        const owner = inFlight.get(remoteUrl) || startNetworkLoad(remoteUrl);
        return subscribe(remoteUrl, owner, caller);
    };

    const load = async (parameters, abortController) => {
        if (closed) throw Object.assign(new Error('DEM cache was closed'), { name: 'AbortError' });
        const operation = loadInternal(parameters, abortController);
        activeLoads.add(operation);
        try {
            return await operation;
        } finally {
            activeLoads.delete(operation);
        }
    };

    const flush = async ({ attempts = 1 } = {}) => {
        await writeQueue;
        const state = await getState();
        if (saveTimer !== null) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        await persistenceQueue;
        if (!state || dirtyGeneration <= persistedGeneration) return true;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (await saveIndex(state)) {
                await persistenceQueue;
                if (dirtyGeneration <= persistedGeneration) return true;
            }
        }
        return dirtyGeneration <= persistedGeneration;
    };

    const close = () => {
        if (closePromise) return closePromise;
        closed = true;
        for (const owner of inFlight.values()) {
            owner.cancel();
            owner.deadline.abort();
            owner.deadline.clear();
        }
        inFlight.clear();
        closePromise = (async () => {
            await Promise.allSettled([...activeLoads]);
            // A transient storage failure gets one final retry. Persistent
            // quota/privacy failures remain best effort, but the false return
            // makes the unpersisted generation observable to the owner.
            return flush({ attempts: 2 });
        })();
        return closePromise;
    };

    return { load, flush, close };
};

const getUsage = async ({ cacheStorage, storageArea } = {}) => {
    const cacheApi = cacheStorage || globalThis.caches;
    if (!cacheApi || typeof cacheApi.keys !== 'function' || typeof cacheApi.open !== 'function') return null;

    try {
        const cacheNames = await cacheApi.keys();
        if (!cacheNames.includes(CACHE_NAME)) return { bytes: 0, entries: 0, unmeasuredEntries: 0 };

        const local = resolveStorageArea(storageArea);
        const [cache, storedIndex] = await Promise.all([
            cacheApi.open(CACHE_NAME),
            readStoredIndex(local)
        ]);
        const requests = await cache.keys();
        let bytes = 0, entries = 0, unmeasuredEntries = 0;

        for (const request of requests) {
            const response = await cache.match(request);
            if (!response) continue;
            entries++;
            const url = typeof request === 'string' ? request : request.url;
            const headerSize = Number(response.headers && response.headers.get('x-bpb-size'));
            const size = Number.isFinite(headerSize) && headerSize > 0
                ? headerSize
                : Number(storedIndex[url] && storedIndex[url].size);
            if (Number.isFinite(size) && size > 0) bytes += Math.floor(size);
            else unmeasuredEntries++;
        }

        return { bytes, entries, unmeasuredEntries };
    } catch (error) {
        return null;
    }
};

export const terrainCache = {
    CACHE_NAME, INDEX_KEY, MAX_TILE_BYTES, PROTOCOL, create, getUsage, isMissingTile, parseTileUrl
};
