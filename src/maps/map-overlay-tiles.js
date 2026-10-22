// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sentinelTileUrl } from './sentinel-core.js';
import { overlayTileUrl, tileBounds, publicLandTileSources, mapOverlayCoverage } from './map-overlay-providers.js';
import { drawAlbertaLand } from './canadian-land.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.js';
import { retryTransient, temporaryHttpStatus } from '../net/retry-transient.js';

const abortError = () => new DOMException('Cancelled.', 'AbortError');
const tileKey = ({ z, x, y }) => `${z}/${(x % 2 ** z + 2 ** z) % 2 ** z}/${y}`;
// A renderer lifetime owns bounded tile work. The browser cache may reuse public
// tiles; decoded images and scene mosaics never survive this owner.
export function createOverlayTiles({ document: doc, fetchImpl = globalThis.fetch, fetchBCTile, onError = () => {}, onActivity = () => {}, retryDelayMs = 350 }) {
    let scenes = [], generation = 0, disposed = false;
    const flights = new Set(), blocked = new Map();
    const retainLimit = (key, error) => {
        // Reuse the recorded error so earlier tile outcomes see an extended
        // deadline too. Land providers remain independent within a mixed tile.
        const limit = blocked.get(key) || error;
        limit.retryAt = Math.max(limit.retryAt || 0, error.retryAt || Date.now() + 300000);
        blocked.set(key, limit); return limit;
    };
    const activity = new Map();
    const landCooldowns = () => Object.fromEntries([...blocked].filter(([key, error]) => key.startsWith('land:') && error.retryAt > Date.now()).map(([key, error]) => [key.slice(5), error.retryAt]));
    const publish = (id, batch) => {
        if (disposed || activity.get(id) !== batch) return;
        const outcomes = [...(batch.outcomes?.values() || [])];
        const missing = outcomes.some(item => item.state === 'failed'), loaded = outcomes.some(item => item.state === 'loaded' || item.partial);
        const pending = outcomes.some(item => item.state === 'pending');
        const failures = outcomes.flatMap(item => item.failures || []);
        const deadlines = failures.filter(error => error.retryAt > Date.now()).map(error => error.retryAt);
        const state = { pending, error: missing, partial: missing && loaded, complete: !pending && !missing,
            ...(id === 'land' ? { permission: failures.some(error => error.code === 'bc-permission-required'),
                retryAt: !loaded && failures.length > 0 && deadlines.length === failures.length ? Math.min(...deadlines) : 0,
                providerCooldowns: landCooldowns() } : {}) };
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
        let response;
        try {
            if (signal.aborted) throw abortError();
            response = await deadline.run(bcCoordinates && fetchBCTile ? fetchBCTile(bcCoordinates, { signal: deadline.signal })
                : fetchImpl(url, { signal: deadline.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
            if (response.status === 429) throw rateLimitError('Map service', response);
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw Object.assign(new Error('Map tiles unavailable.'),
                { status: response.status, transient: temporaryHttpStatus(response.status) });
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
            } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
            if (signal.aborted) throw abortError();
            const image = await deadline.run(createImageBitmap(new Blob(chunks)).then(decoded => {
                if (deadline.expired || signal.aborted) { decoded.close(); throw abortError(); }
                return decoded;
            }));
            if (signal.aborted) { image.close(); throw abortError(); }
            if (image.width > 1024 || image.height > 1024) { image.close(); throw new Error('Map tile too large.'); }
            return image;
        } finally { cancelResponseBody(response); signal.removeEventListener('abort', abort); deadline.clear(); }
    };
    return {
        setScenes(next) { generation++; scenes = next.slice(0, 8); cancel('sentinel'); },
        cancel,
        retry(id) {
            if (blocked.get(id)?.retryAt > Date.now()) return false;
            const previous = [...(activity.get(id)?.outcomes.values() || [])];
            if (id === 'land' && previous.length && previous.every(item => item.state === 'failed' && !item.partial
                && item.failures?.length && item.failures.every(error => error.retryAt > Date.now()))) return false;
            blocked.delete(id);
            const outcomes = new Map([...(activity.get(id)?.outcomes || [])].filter(([, item]) => item.state === 'loaded'));
            activity.set(id, { outcomes }); abortFlights(id);
            return true;
        },
        failed(id, coordinates) { return activity.get(id)?.outcomes.get(tileKey(coordinates))?.state === 'failed'; },
        landCooldowns(value) {
            for (const provider of ['us', 'bc', 'ab']) if (value?.[provider] > Date.now() && value[provider] <= Date.now() + 86400000)
                retainLimit(`land:${provider}`, Object.assign(new Error('Land service is busy.'), { code: 'rate-limit', retryAt: value[provider] }));
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
            const batch = activity.get(id) || { outcomes: new Map() };
            const key = tileKey(coordinates), outcome = { state: 'pending' };
            batch.outcomes?.set(key, outcome);
            activity.set(id, batch); publish(id, batch);
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
                const supported = mapOverlayCoverage([west, south, east, north])?.[id] !== false;
                const sources = !supported ? [] : id === 'land' ? publicLandTileSources(coordinates)
                    : (id === 'sentinel' ? intersecting.map(scene => sentinelTileUrl(scene.id)
                        .replace('{z}', coordinates.z).replace('{x}', coordinates.x).replace('{y}', coordinates.y)) : [overlayTileUrl(id, coordinates)])
                        .map(url => ({ url }));
                const failures = []; let completed = 0;
                for (const source of sources) {
                    try {
                        const providerLimit = blocked.get(`land:${source.provider}`); if (id === 'land' && providerLimit?.retryAt > Date.now()) throw providerLimit;
                        if (source.kind === 'parcels') {
                            const parcelCanvas = await retryTransient(async () => {
                                const tile = doc.createElement('canvas'); tile.width = tile.height = 256;
                                await drawAlbertaLand({ context: tile.getContext('2d'), bbox: source.bbox, fetchImpl, signal: controller.signal }); return tile;
                            }, { signal: controller.signal, delayMs: retryDelayMs });
                            context.drawImage(parcelCanvas, 0, 0);
                        } else {
                            const image = await retryTransient(() => bitmap(source.url, controller.signal, source.provider === 'bc' ? coordinates : undefined),
                                { signal: controller.signal, delayMs: retryDelayMs });
                            try {
                                if (disposed || controller.signal.aborted || id === 'sentinel' && revision !== generation) throw abortError();
                                context.drawImage(image, 0, 0, 256, 256);
                            } finally { image.close(); }
                        }
                        completed++;
                    } catch (error) {
                        if (id !== 'land' || controller.signal.aborted || error.name === 'AbortError') throw error;
                        failures.push(error.code === 'rate-limit' ? retainLimit(`land:${source.provider}`, error) : error);
                    }
                }
                if (controller.signal.aborted) throw abortError();
                if (failures.length && !completed) throw Object.assign(failures[0], { tileFailures: failures });
                const output = canvas.getContext('2d'); output.clearRect(0, 0, 256, 256); output.drawImage(working, 0, 0);
                outcome.state = failures.length ? 'failed' : 'loaded'; outcome.partial = failures.length > 0; outcome.failures = failures;
                if (failures.length) onError(id, failures[0]);
                return canvas;
            } catch (error) {
                if (!controller.signal.aborted && error.name !== 'AbortError' && (!batch.outcomes || batch.outcomes.get(key) === outcome)) {
                    outcome.state = 'failed';
                    outcome.failures = error.tileFailures || [error];
                    if (id !== 'land' && error.code === 'rate-limit') { error = retainLimit(id, error); abortFlights(id); }
                    onError(id, error);
                }
                throw error;
            } finally {
                if (outcome.state === 'pending' && batch.outcomes?.get(key) === outcome) batch.outcomes.delete(key);
                release?.(); flights.delete(flight); signal?.removeEventListener('abort', abort); publish(id, batch);
            }
        },
        canvas() { const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 256; return canvas; },
        dispose() { disposed = true; cancel(); scenes = []; blocked.clear(); },
    };
}
