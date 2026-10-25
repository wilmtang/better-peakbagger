// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUSTOM_LIMITS, customUrl, readCustomSource } from './custom-overlay-schema.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';

export const customFailure = error => error?.code === 'access' ? 'Check the URL and the provider’s CORS settings. The source must allow browser access from this map.'
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
export function createCustomClient({ fetchImpl = globalThis.fetch, pool = createCustomPool(), parse, bitmap = globalThis.createImageBitmap }) {
    const request = (url, limit, signal, retry = true) => pool.run(async () => {
        if (!customUrl(url)) throw new Error('Invalid source URL.');
        const origin = new URL(url).origin;
        if (pool.cooldowns.get(origin) > Date.now()) throw Object.assign(new Error('Provider cooldown.'), { code: 'rate-limit', retryAt: pool.cooldowns.get(origin) });
        for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
            const deadline = requestDeadline.createRequestDeadline(CUSTOM_LIMITS.deadline), abort = () => deadline.abort();
            signal?.addEventListener('abort', abort, { once: true });
            let response, reader;
            try {
                if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
                try { response = await deadline.run(fetchImpl(url, { mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: deadline.signal })); }
                catch (error) { if (signal?.aborted || error.name === 'AbortError') throw error; throw Object.assign(new Error('Couldn’t access this source.'), { code: 'access' }); }
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
    const resolve = async (input, signal, retry = true) => {
        if (!input.source.metadataUrl) return { source: input, origins: [] };
        const { bytes } = await request(input.source.metadataUrl, CUSTOM_LIMITS.metadata, signal, retry);
        const metadata = JSON.parse(new TextDecoder().decode(bytes));
        if (metadata.version === 8 || !/^([23])\./.test(metadata.tilejson) || !Array.isArray(metadata.tiles) || !metadata.tiles.length || metadata.tiles.length > 4
            || metadata.tiles.some(url => !customUrl(url, true))) throw new Error('Use TileJSON or a tile template; full map styles are unsupported.');
        const origins = [...new Set(metadata.tiles.map(url => new URL(url).origin))];
        const source = { ...input.source, tiles: metadata.tiles, scheme: metadata.scheme || 'xyz' };
        const maxDefault = metadata.tilejson.startsWith('3.') ? 30 : 22;
        for (const [field, key] of [['minNativeZoom', 'min'], ['maxNativeZoom', 'max']]) {
            const value = metadata[`${key}zoom`] ?? (key === 'min' ? 0 : maxDefault);
            if (!Number.isInteger(value) || value < 0 || value > 30) throw new Error('Invalid source zoom range.');
            if (source.zoomOrigin?.[key] !== 'manual') {
                source[field] = Math.min(CUSTOM_LIMITS.zoom, value);
                source.zoomOrigin = { ...source.zoomOrigin, [key]: metadata[`${key}zoom`] == null ? 'default' : 'metadata' };
            }
        }
        if (metadata.minzoom > CUSTOM_LIMITS.zoom || metadata.minzoom > metadata.maxzoom) throw new Error('Source zoom range is unsupported.');
        if (metadata.bounds) source.bounds = metadata.bounds;
        const approved = [...new Set([...input.approvedOrigins, ...origins])];
        const normalized = readCustomSource({ ...input, source, approvedOrigins: approved });
        if (!normalized) throw new Error('Invalid source metadata.');
        return { source: normalized, origins: origins.filter(origin => !input.approvedOrigins.includes(origin)),
            layers: Array.isArray(metadata.vector_layers) ? metadata.vector_layers.slice(0, 32).map(layer => String(layer.id).slice(0, 128)) : [] };
    };
    const tile = async (source, coordinates, signal, fallback = true) => {
        const original = coordinates;
        for (let delta = 0; delta <= (fallback ? 2 : 0) && original.z - delta >= source.source.minNativeZoom; delta++) {
            const scale = 2 ** delta, n = 2 ** (original.z - delta);
            const canonical = { z: original.z - delta, x: Math.floor(original.x / scale), y: Math.floor(original.y / scale) };
            const x = (canonical.x % n + n) % n, y = source.source.scheme === 'tms' ? n - 1 - canonical.y : canonical.y;
            const template = source.source.tiles[0]; if (!template) throw Object.assign(new Error('Review source metadata.'), { code: 'origins' });
            const url = template.replaceAll('{z}', String(canonical.z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
            try {
                const result = await request(url, CUSTOM_LIMITS[source.kind], signal, fallback);
                if (source.kind === 'raster') {
                    if (!/^image\/(png|jpeg|webp)(?:;|$)/i.test(result.type)) throw new Error('Expected a PNG, JPEG or WebP tile.');
                    const image = await bitmap(new Blob([result.bytes], { type: result.type }));
                    const size = source.source.tileSize;
                    if (image.width !== image.height || ![size, size * 2].includes(image.width)) { image.close(); throw new Error('Unexpected tile dimensions.'); }
                    if (signal?.aborted) { image.close(); throw new DOMException('Cancelled.', 'AbortError'); }
                    return { image, lower: delta > 0, scale, x: original.x - canonical.x * scale, y: original.y - canonical.y * scale };
                }
                const value = await parse({ kind: 'mvt', bytes: result.bytes, layers: [...new Set(source.appearance.rules.map(rule => rule.sourceLayer))],
                    transform: { scale, x: original.x - canonical.x * scale, y: original.y - canonical.y * scale } }, signal);
                return { ...value, lower: delta > 0 };
            } catch (error) { if (![404, 410].includes(error.status) || delta === (fallback ? 2 : 0) || canonical.z === source.source.minNativeZoom) throw error; }
        }
        throw new Error('Tile is outside its zoom range.');
    };
    return { request, resolve, tile, async geojson(source, signal) {
        const result = await request(source.source.dataUrl, CUSTOM_LIMITS.geojson, signal);
        return parse({ kind: 'geojson', bytes: result.bytes }, signal);
    } };
}
export function customTileAt(lat, lng, z) {
    const n = 2 ** z, latitude = Math.max(-85.051128, Math.min(85.051128, lat)) * Math.PI / 180;
    return { z, x: Math.floor(((lng + 180) / 360 * n % n + n) % n), y: Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * n))) };
}
