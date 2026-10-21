// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sentinelTileUrl } from './sentinel-core.js';
import { overlayTileUrl, tileBounds, publicLandTileSources } from './map-overlay-providers.js';
import { drawAlbertaLand } from './canadian-land.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';

const abortError = () => new DOMException('Cancelled.', 'AbortError');
const tileKey = ({ z, x, y }) => `${z}/${(x % 2 ** z + 2 ** z) % 2 ** z}/${y}`;
const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
});
// A renderer lifetime owns bounded tile work. The browser cache may reuse public
// tiles; decoded images and scene mosaics never survive this owner.
export function createOverlayTiles({ document: doc, fetchImpl = globalThis.fetch, fetchBCTile, onError = () => {}, onActivity = () => {}, retryDelayMs = 350 }) {
    let scenes = [], generation = 0, disposed = false;
    const flights = new Set(), blocked = new Map();
    const activity = new Map();
    const publish = (id, batch) => {
        if (disposed || activity.get(id) !== batch) return;
        const outcomes = [...(batch.outcomes?.values() || [])];
        const missing = outcomes.some(item => item.state === 'failed'), loaded = outcomes.some(item => item.state === 'loaded');
        const pending = outcomes.some(item => item.state === 'pending');
        const state = id === 'slope' ? { pending, error: missing, partial: missing && loaded, complete: !pending && !missing }
            : { pending: batch.count > 0 && !batch.error, error: batch.error, complete: batch.count === 0 && batch.successes > 0 && !batch.error };
        const signature = JSON.stringify(state); if (signature === batch.signature) return;
        batch.signature = signature; onActivity(id, state);
    };
    const queue = []; let running = 0;
    const acquire = signal => new Promise((resolve, reject) => {
        const entry = { start: () => { signal.removeEventListener('abort', abort); running++; resolve(() => { running--; queue.shift()?.start(); }); } };
        const abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(abortError()); };
        if (signal.aborted) { reject(abortError()); return; }
        if (running < 4) entry.start();
        else if (queue.length < 128) { queue.push(entry); signal.addEventListener('abort', abort, { once: true }); }
        else reject(new Error('Too many overlay tiles. Zoom in.'));
    });
    const abortFlights = id => { for (const flight of flights) if (!id || flight.id === id) flight.controller.abort(); };
    const cancel = id => {
        for (const key of [...activity.keys()]) if (!id || key === id) {
            activity.delete(key); if (!disposed) onActivity(key, { pending: false, error: false, complete: false });
        }
        abortFlights(id);
    };
    const bitmap = async (url, signal, bcCoordinates) => {
        const deadline = requestDeadline.createRequestDeadline();
        const abort = () => deadline.abort(); signal.addEventListener('abort', abort, { once: true });
        try {
            if (signal.aborted) throw abortError();
            const response = await deadline.run(bcCoordinates && fetchBCTile ? fetchBCTile(bcCoordinates, { signal: deadline.signal })
                : fetchImpl(url, { signal: deadline.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
            if (response.status === 429) throw rateLimitError('Map service', response);
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw Object.assign(new Error('Map tiles unavailable.'),
                { status: response.status, transient: [408, 500, 502, 503, 504].includes(response.status) });
            if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('Map tile too large.');
            const reader = response.body.getReader(), chunks = []; let bytes = 0;
            try {
                while (true) {
                    const part = await deadline.run(reader.read());
                    if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > 4 * 1024 * 1024) throw new Error('Map tile too large.');
                    chunks.push(part.value);
                }
            } finally { void reader.cancel().catch(() => {}); }
            if (signal.aborted) throw abortError();
            const image = await deadline.run(createImageBitmap(new Blob(chunks)).then(decoded => {
                if (deadline.expired || signal.aborted) { decoded.close(); throw abortError(); }
                return decoded;
            }));
            if (signal.aborted) { image.close(); throw abortError(); }
            if (image.width > 1024 || image.height > 1024) { image.close(); throw new Error('Map tile too large.'); }
            return image;
        } finally { signal.removeEventListener('abort', abort); deadline.clear(); }
    };
    const slopeBitmap = async (url, signal) => {
        try { return await bitmap(url, signal); }
        catch (error) {
            if (signal.aborted || !(error.transient || error.name === 'TimeoutError' || error instanceof TypeError)) throw error;
            // Dynamic USGS exports can be slow. Recover one temporary failure,
            // keeping the same four-request budget and each attempt's deadline.
            // Rate limits, bad requests and invalid images are never replayed.
            await pause(retryDelayMs, signal);
            return bitmap(url, signal);
        }
    };
    return {
        setScenes(next) { generation++; scenes = next.slice(0, 8); cancel('sentinel'); },
        cancel,
        retry(id) {
            if (blocked.get(id)?.retryAt > Date.now()) return false;
            blocked.delete(id);
            if (id === 'slope') {
                const outcomes = new Map([...(activity.get(id)?.outcomes || [])].filter(([, item]) => item.state === 'loaded'));
                activity.set(id, { count: 0, successes: 0, error: false, outcomes }); abortFlights(id);
            } else cancel(id);
            return true;
        },
        forget(id, coordinates) { const batch = activity.get(id); if (batch?.outcomes?.delete(tileKey(coordinates))) publish(id, batch); },
        retain(id, coordinates) {
            const batch = activity.get(id); if (!batch?.outcomes) return;
            const keep = new Set(coordinates.map(tileKey));
            for (const key of batch.outcomes.keys()) if (!keep.has(key)) batch.outcomes.delete(key);
            publish(id, batch);
        },
        async draw(id, coordinates, canvas, signal) {
            if (disposed || signal?.aborted) throw abortError();
            const limit = blocked.get(id);
            if (limit?.retryAt > Date.now()) throw limit;
            const controller = new AbortController(), flight = { id, controller }, revision = generation;
            const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); flights.add(flight);
            const batch = activity.get(id) || { count: 0, successes: 0, error: false, ...(id === 'slope' ? { outcomes: new Map() } : {}) };
            const key = tileKey(coordinates), outcome = { state: 'pending' };
            batch.outcomes?.set(key, outcome);
            activity.set(id, batch); batch.count++; publish(id, batch);
            const working = doc.createElement('canvas'); working.width = working.height = 256;
            const context = working.getContext('2d');
            let release;
            try {
                release = await acquire(controller.signal);
                const [left, bottom, right, top] = tileBounds(coordinates);
                const west = left / 20037508.342789244 * 180, east = right / 20037508.342789244 * 180;
                const latitude = value => Math.atan(Math.sinh(value / 6378137)) * 180 / Math.PI;
                const south = latitude(bottom), north = latitude(top);
                const intersecting = scenes.filter(scene => {
                    const [w, s, e, n] = scene.bounds, shift = Math.round(((west + east) - (w + e)) / 720) * 360;
                    return n >= south && s <= north && e + shift >= west && w + shift <= east;
                });
                // Scenes are opaque source images with transparent no-data. Draw
                // all of them at full alpha, then let the engine fade this ONE
                // mosaic. Two overlapping scenes at 50% still mean 50%.
                const sources = id === 'land' ? publicLandTileSources(coordinates)
                    : (id === 'sentinel' ? intersecting.map(scene => sentinelTileUrl(scene.id)
                        .replace('{z}', coordinates.z).replace('{x}', coordinates.x).replace('{y}', coordinates.y)) : [overlayTileUrl(id, coordinates)])
                        .map(url => ({ url }));
                for (const source of sources) {
                    if (source.kind === 'parcels') {
                        await drawAlbertaLand({ context, bbox: source.bbox, fetchImpl, signal: controller.signal }); continue;
                    }
                    const image = id === 'slope' ? await slopeBitmap(source.url, controller.signal)
                        : await bitmap(source.url, controller.signal, source.provider === 'bc' ? coordinates : undefined);
                    try {
                        if (disposed || controller.signal.aborted || id === 'sentinel' && revision !== generation) throw abortError();
                        context.drawImage(image, 0, 0, 256, 256);
                    } finally { image.close(); }
                }
                if (controller.signal.aborted) throw abortError();
                const output = canvas.getContext('2d'); output.clearRect(0, 0, 256, 256); output.drawImage(working, 0, 0);
                batch.successes++; outcome.state = 'loaded';
                return canvas;
            } catch (error) {
                if (!controller.signal.aborted && error.name !== 'AbortError' && (!batch.outcomes || batch.outcomes.get(key) === outcome)) {
                    outcome.state = 'failed';
                    batch.error = true;
                    if (error.code === 'rate-limit') { error.retryAt ??= Date.now() + 300000; blocked.set(id, error); abortFlights(id); }
                    onError(id, error);
                }
                throw error;
            } finally {
                if (outcome.state === 'pending' && batch.outcomes?.get(key) === outcome) batch.outcomes.delete(key);
                release?.(); flights.delete(flight); signal?.removeEventListener('abort', abort); batch.count--; publish(id, batch);
            }
        },
        canvas() { const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 256; return canvas; },
        dispose() { disposed = true; cancel(); scenes = []; blocked.clear(); },
    };
}
