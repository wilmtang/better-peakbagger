// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — bounded, best-effort cache for public Mapterhorn DEM
// tiles. CacheStorage remains browser-managed: the browser may evict it when
// space is tight, and a cache miss always falls back to the network.

(() => {
    'use strict';

    const CACHE_NAME = 'bpb-mapterhorn-dem-v1';
    const INDEX_KEY = 'bpbMapterhornDemIndexV1';
    const PROTOCOL = 'bpb-dem';
    const REMOTE_TILE_ORIGIN = 'https://tiles.mapterhorn.com';
    const MAX_ZOOM = 18;

    const cleanIndex = raw => {
        const index = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return index;
        for (const [url, entry] of Object.entries(raw)) {
            if (!url.startsWith(`${REMOTE_TILE_ORIGIN}/`) || !entry || typeof entry !== 'object') continue;
            const size = Number(entry.size), used = Number(entry.used);
            if (Number.isFinite(size) && size > 0 && Number.isFinite(used) && used > 0) {
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

    const create = ({ limitMb, cacheStorage, storageArea, fetchFn, ResponseCtor, now = Date.now }) => {
        const limitBytes = Math.max(0, Math.floor(limitMb)) * 1024 * 1024;
        const cacheApi = cacheStorage || globalThis.caches;
        const local = resolveStorageArea(storageArea);
        const request = fetchFn || globalThis.fetch.bind(globalThis);
        const CachedResponse = ResponseCtor || globalThis.Response;
        let statePromise = null;
        let writeQueue = Promise.resolve();
        let saveTimer = null;

        const saveIndex = async state => {
            if (!local || typeof local.set !== 'function' || !state) return;
            try { await local.set({ [INDEX_KEY]: state.index }); } catch (error) { /* Cache data remains usable without its LRU index. */ }
        };

        const removeStoredIndex = async () => {
            if (!local || typeof local.remove !== 'function') return;
            try { await local.remove(INDEX_KEY); } catch (error) { /* Best-effort cleanup. */ }
        };

        const trim = async state => {
            let total = Object.values(state.index).reduce((sum, entry) => sum + entry.size, 0);
            if (total <= limitBytes) return false;

            const oldest = Object.entries(state.index).sort((a, b) => a[1].used - b[1].used);
            for (const [url, entry] of oldest) {
                if (total <= limitBytes) break;
                try { await state.cache.delete(url); } catch (error) { continue; }
                delete state.index[url];
                total -= entry.size;
            }
            return true;
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

            // Rebuild metadata if the browser kept CacheStorage but purged the
            // small local index independently.
            for (const item of requests) {
                if (index[item.url]) continue;
                const response = await cache.match(item);
                const size = Number(response && response.headers.get('x-bpb-size'));
                const used = Number(response && response.headers.get('x-bpb-used'));
                if (Number.isFinite(size) && size > 0) {
                    index[item.url] = {
                        size: Math.floor(size),
                        used: Number.isFinite(used) && used > 0 ? Math.floor(used) : now()
                    };
                } else {
                    await cache.delete(item);
                }
            }

            const state = { cache, index };
            if (await trim(state)) await saveIndex(state);
            return state;
        };

        const getState = () => {
            if (!statePromise) statePromise = initialize().catch(() => null);
            return statePromise;
        };

        const scheduleSave = state => {
            if (saveTimer !== null || !state) return;
            saveTimer = setTimeout(() => {
                saveTimer = null;
                void saveIndex(state);
            }, 1000);
        };

        const read = async remoteUrl => {
            const state = await getState();
            if (!state) return null;
            try {
                const response = await state.cache.match(remoteUrl);
                if (!response) {
                    delete state.index[remoteUrl];
                    scheduleSave(state);
                    return null;
                }
                const data = await response.arrayBuffer();
                if (!data.byteLength) {
                    await state.cache.delete(remoteUrl);
                    delete state.index[remoteUrl];
                    scheduleSave(state);
                    return null;
                }
                state.index[remoteUrl] = { size: data.byteLength, used: now() };
                scheduleSave(state);
                return data;
            } catch (error) {
                return null;
            }
        };

        const enqueueStore = (remoteUrl, data, contentType) => {
            writeQueue = writeQueue.then(async () => {
                const state = await getState();
                if (!state || data.byteLength > limitBytes) return;
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
                    state.index[remoteUrl] = { size: data.byteLength, used };
                    await trim(state);
                    await saveIndex(state);
                } catch (error) {
                    // Quota pressure or browser eviction is a normal cache miss,
                    // never a reason to fail terrain rendering.
                }
            }).catch(() => {});
        };

        const load = async (parameters, abortController) => {
            const remoteUrl = parseTileUrl(parameters && parameters.url);
            if (!remoteUrl) throw new Error('Invalid DEM tile URL');

            const cached = await read(remoteUrl);
            if (cached) return { data: cached };

            const response = await request(remoteUrl, {
                signal: abortController && abortController.signal,
                credentials: 'omit',
                referrerPolicy: 'no-referrer'
            });
            if (!response || !response.ok) throw new Error(`DEM tile request failed (${response && response.status})`);
            const data = await response.arrayBuffer();
            if (!data.byteLength) throw new Error('DEM tile was empty');
            if (limitBytes > 0) enqueueStore(remoteUrl, data, response.headers.get('content-type'));
            return { data };
        };

        const flush = async () => {
            await writeQueue;
            const state = await getState();
            if (saveTimer !== null) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
            await saveIndex(state);
        };

        return { load, flush };
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

    globalThis.BPBTerrainCache = { CACHE_NAME, INDEX_KEY, PROTOCOL, create, getUsage, parseTileUrl };
})();
