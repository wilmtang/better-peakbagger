// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUSTOM_LIMITS, customUrl } from './custom-overlay-schema.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';
import { validateCustomRaster } from './custom-overlay-raster.js';
import { resolveCustomSourceDocument } from './custom-overlay-source.js';

export const customFailure = error => error?.code === 'approval' ? 'Approve private map access in BPB, then choose Retry.'
    : error?.code === 'budget' ? 'Private map request allowance reached. Wait before approving more.'
        : error?.code === 'permission' ? 'Allow this provider in BPB Settings.'
            : error?.code === 'busy' ? 'Other private map requests are running. Choose Retry when they finish.'
                : error?.code === 'access' ? 'Check the URL and the provider’s CORS settings. The source must allow browser access from this map.'
                    : error?.code === 'origins' ? 'Review the tile provider hosts in Edit source before loading.'
                        : error?.status === 401 || error?.status === 403 ? 'This source requires access. Use a public endpoint.'
                            : error?.status === 404 || error?.status === 410 ? 'Some tiles are unavailable at this location or zoom.'
                                : error?.code === 'rate-limit' ? 'The provider is busy. Retry after its cooldown.' : error?.message || 'Couldn’t load this source.';
export function createCustomPool() {
    let running = 0; const queue = [], cooldowns = new Map();
    const pump = () => { while (running < 4 && queue.length) { const task = queue.shift(); task.start(); } };
    return { cooldowns, run(work, signal) { return new Promise((resolve, reject) => {
        const abort = () => { const index = queue.indexOf(task); if (index >= 0) { queue.splice(index, 1); reject(new DOMException('Cancelled.', 'AbortError')); } };
        const task = { start() { signal?.removeEventListener('abort', abort); if (signal?.aborted) { reject(new DOMException('Cancelled.', 'AbortError')); return; }
            running++; Promise.resolve().then(work).then(resolve, reject).finally(() => { running--; pump(); }); } };
        if (signal?.aborted) { reject(new DOMException('Cancelled.', 'AbortError')); return; }
        if (queue.length >= 64) { reject(new Error('Too many overlay requests. Zoom in.')); return; }
        queue.push(task); signal?.addEventListener('abort', abort, { once: true }); pump();
    }); } };
}
export function customPoolForWindow(win) {
    let owner = win;
    try { if (win.top.location.origin === win.location.origin) owner = win.top; } catch { /* Separate origin retains its own bounded scheduler. */ }
    const key = Symbol.for('bpb.customOverlayPool');
    return owner[key] || (owner[key] = createCustomPool());
}
export function createCustomClient({ fetchImpl = globalThis.fetch, pool = createCustomPool(), parse, bitmap = globalThis.createImageBitmap }) {
    const cache = new Map(), flights = new Map(); let cacheBytes = 0;
    const requestOnce = (url, limit, signal, retry = true, refresh = null) => pool.run(async () => {
        if (!customUrl(url)) throw new Error('Invalid source URL.');
        const origin = new URL(url).origin;
        if (pool.cooldowns.get(origin) > Date.now()) throw Object.assign(new Error('Provider cooldown.'), { code: 'rate-limit', retryAt: pool.cooldowns.get(origin) });
        for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
            const deadline = requestDeadline.createRequestDeadline(CUSTOM_LIMITS.deadline), abort = () => deadline.abort();
            signal?.addEventListener('abort', abort, { once: true });
            let response, reader;
            try {
                if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
                try { response = await deadline.run(fetchImpl(url, { mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', ...(refresh && { cache: 'no-cache' }), signal: deadline.signal })); }
                catch (error) { if (signal?.aborted || error.name === 'AbortError' || ['approval', 'budget', 'permission', 'busy', 'private-source', 'origins'].includes(error.code)) throw error; throw Object.assign(new Error('Couldn’t access this source.'), { code: 'access' }); }
                if (response.status === 429) {
                    const error = rateLimitError('Custom map provider', response); error.retryAt ??= Date.now() + 300000;
                    pool.cooldowns.set(origin, Math.max(pool.cooldowns.get(origin) || 0, error.retryAt)); throw error;
                }
                if (!response.ok) {
                    if (attempt === 0 && retry && [408, 500, 502, 503, 504].includes(response.status)) { await response.body?.cancel(); continue; }
                    throw Object.assign(new Error(`Source returned HTTP ${response.status}.`), { status: response.status });
                }
                if (Number(response.headers.get('content-length')) > limit) throw new Error('Source too large.');
                reader = response.body?.getReader(); if (!reader) throw new Error('Empty source response.');
                const chunks = []; let size = 0;
                while (true) {
                    const part = await deadline.run(reader.read()); if (part.done) break;
                    size += part.value.byteLength; if (size > limit) throw new Error('Source too large.'); chunks.push(part.value);
                }
                const bytes = new Uint8Array(size); let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                return { bytes: bytes.buffer, type: response.headers.get('content-type') || '' };
            } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else void response?.body?.cancel().catch(() => {}); signal?.removeEventListener('abort', abort); deadline.clear(); }
        }
    }, signal);
    const request = async (url, limit, signal, retry = true, scope = '', refresh = null) => {
        const key = `${scope}|${url}`;
        if (!retry) return requestOnce(url, limit, signal, false);
        if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
        if (refresh && cache.has(key) && cache.get(key).refresh !== refresh) { cacheBytes -= cache.get(key).bytes.byteLength; cache.delete(key); }
        if (refresh && flights.has(key) && flights.get(key).refresh !== refresh) { flights.get(key).controller.abort(); flights.delete(key); }
        if (cache.has(key)) { const result = cache.get(key); cache.delete(key); cache.set(key, result); if (result.bytes.byteLength > limit) throw new Error('Source too large.'); return { ...result, bytes: result.bytes.slice(0) }; }
        let flight = flights.get(key);
        if (!flight) {
            flight = { controller: new AbortController(), users: 0, scope, refresh };
            const owner = flight;
            flight.promise = requestOnce(url, limit, owner.controller.signal, true, refresh).then(result => {
                if (owner.controller.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
                result.scope = scope; result.refresh = refresh;
                while (cacheBytes + result.bytes.byteLength > 8 * 1024 * 1024 && cache.size) { const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes.byteLength; cache.delete(oldest); }
                cache.set(key, result); cacheBytes += result.bytes.byteLength; return result;
            }).finally(() => { if (flights.get(key) === owner) flights.delete(key); });
            flights.set(key, flight);
        }
        flight.users++;
        let rejectAbort;
        const aborted = new Promise((_, reject) => { rejectAbort = reject; });
        const abort = () => rejectAbort(new DOMException('Cancelled.', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        try { const result = await Promise.race([flight.promise, aborted]); if (result.bytes.byteLength > limit) throw new Error('Source too large.'); return { ...result, bytes: result.bytes.slice(0) }; }
        finally { signal?.removeEventListener('abort', abort); if (--flight.users === 0) flight.controller.abort(); }
    };
    const resolve = async (input, signal, retry = true, options = {}) => {
        const url = input.source.metadataUrl || (options.inspect && input.kind === 'geojson' ? input.source.dataUrl : null);
        if (!url) return { source: input, origins: [] };
        const { bytes } = await request(url, input.kind === 'geojson' ? CUSTOM_LIMITS.geojson : CUSTOM_LIMITS.metadata, signal, retry, `${input.id}:${input.revision}`, options.refresh);
        return resolveCustomSourceDocument(input, JSON.parse(new TextDecoder().decode(bytes)), options);
    };
    const tile = async (source, coordinates, signal, fallback = true, refresh = null) => {
        const original = coordinates;
        const overzoom = Math.max(0, original.z - source.source.maxNativeZoom);
        for (let delta = overzoom; delta <= overzoom + (fallback ? 2 : 0) && original.z - delta >= source.source.minNativeZoom; delta++) {
            const scale = 2 ** delta, n = 2 ** (original.z - delta);
            const canonical = { z: original.z - delta, x: Math.floor(original.x / scale), y: Math.floor(original.y / scale) };
            const x = (canonical.x % n + n) % n, y = source.source.scheme === 'tms' ? n - 1 - canonical.y : canonical.y;
            const template = source.source.tiles[0]; if (!template) throw Object.assign(new Error('Review source metadata.'), { code: 'origins' });
            const url = template.replaceAll('{z}', String(canonical.z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
            try {
                const result = await request(url, CUSTOM_LIMITS[source.kind], signal, fallback, `${source.id}:${source.revision}`, refresh);
                if (source.kind === 'raster') {
                    validateCustomRaster(result.bytes, result.type, source.source.tileSize);
                    const image = await bitmap(new Blob([result.bytes], { type: result.type }));
                    const size = source.source.tileSize;
                    if (image.width !== image.height || ![size, size * 2].includes(image.width)) { image.close(); throw new Error('Unexpected tile dimensions.'); }
                    if (signal?.aborted) { image.close(); throw new DOMException('Cancelled.', 'AbortError'); }
                    return { image, lower: delta > 0, scale, x: original.x - canonical.x * scale, y: original.y - canonical.y * scale };
                }
                const value = await parse({ kind: 'mvt', bytes: result.bytes, layers: [...new Set(source.appearance.rules.map(rule => rule.sourceLayer))],
                    transform: { scale, x: original.x - canonical.x * scale, y: original.y - canonical.y * scale } }, signal);
                signal?.throwIfAborted();
                return { ...value, lower: delta > 0 };
            } catch (error) { if (![404, 410].includes(error.status) || delta === overzoom + (fallback ? 2 : 0) || canonical.z === source.source.minNativeZoom) throw error; }
        }
        throw new Error('Tile is outside its zoom range.');
    };
    return { request, resolve, tile, evict(scope) {
        for (const [key, result] of cache) if (scope == null || result.scope === scope) { cache.delete(key); cacheBytes -= result.bytes.byteLength; }
        for (const [key, flight] of flights) if (scope == null || flight.scope === scope) { flight.controller.abort(); flights.delete(key); }
    }, clear() { cache.clear(); cacheBytes = 0; for (const flight of flights.values()) flight.controller.abort(); flights.clear(); }, async geojson(source, signal, refresh = null) {
        const result = await request(source.source.dataUrl, CUSTOM_LIMITS.geojson, signal, true, `${source.id}:${source.revision}`, refresh);
        return parse({ kind: 'geojson', bytes: result.bytes }, signal);
    } };
}
export function customTileAt(lat, lng, z) {
    const n = 2 ** z, latitude = Math.max(-85.051128, Math.min(85.051128, lat)) * Math.PI / 180;
    return { z, x: Math.floor(((lng + 180) / 360 * n % n + n) % n), y: Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * n))) };
}
