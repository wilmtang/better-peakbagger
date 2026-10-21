// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sentinelTileUrl } from './sentinel-core.js';
import { overlayTileUrl, tileBounds, publicLandTileSources } from './map-overlay-providers.js';
import { drawAlbertaLand } from './canadian-land.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';

const abortError = () => new DOMException('Cancelled.', 'AbortError');
// A renderer lifetime owns bounded tile work. The browser cache may reuse public
// tiles; decoded images and scene mosaics never survive this owner.
export function createOverlayTiles({ document: doc, fetchImpl = globalThis.fetch, fetchBCTile, onError = () => {} }) {
    let scenes = [], generation = 0, disposed = false;
    const flights = new Set(), blocked = new Map();
    const queue = []; let running = 0;
    const acquire = signal => new Promise((resolve, reject) => {
        const entry = { start: () => { signal.removeEventListener('abort', abort); running++; resolve(() => { running--; queue.shift()?.start(); }); } };
        const abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(abortError()); };
        if (signal.aborted) { reject(abortError()); return; }
        if (running < 4) entry.start();
        else if (queue.length < 128) { queue.push(entry); signal.addEventListener('abort', abort, { once: true }); }
        else reject(new Error('Too many overlay tiles. Zoom in.'));
    });
    const cancel = id => { for (const flight of flights) if (!id || flight.id === id) flight.controller.abort(); };
    const bitmap = async (url, signal, bcCoordinates) => {
        const deadline = requestDeadline.createRequestDeadline();
        const abort = () => deadline.abort(); signal.addEventListener('abort', abort, { once: true });
        try {
            if (signal.aborted) throw abortError();
            const response = await deadline.run(bcCoordinates && fetchBCTile ? fetchBCTile(bcCoordinates, { signal: deadline.signal })
                : fetchImpl(url, { signal: deadline.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
            if (response.status === 429) throw rateLimitError('Map service', response);
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Map tiles unavailable.');
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
    return {
        setScenes(next) { generation++; scenes = next.slice(0, 8); cancel('sentinel'); },
        cancel,
        retry(id) { if (blocked.get(id)?.retryAt > Date.now()) return false; blocked.delete(id); cancel(id); return true; },
        async draw(id, coordinates, canvas, signal) {
            if (disposed || signal?.aborted) throw abortError();
            const limit = blocked.get(id);
            if (limit?.retryAt > Date.now()) throw limit;
            const controller = new AbortController(), flight = { id, controller }, revision = generation;
            const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); flights.add(flight);
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
                    const image = await bitmap(source.url, controller.signal, source.provider === 'bc' ? coordinates : undefined);
                    try {
                        if (disposed || controller.signal.aborted || id === 'sentinel' && revision !== generation) throw abortError();
                        context.drawImage(image, 0, 0, 256, 256);
                    } finally { image.close(); }
                }
                if (controller.signal.aborted) throw abortError();
                const output = canvas.getContext('2d'); output.clearRect(0, 0, 256, 256); output.drawImage(working, 0, 0);
                return canvas;
            } catch (error) {
                if (!controller.signal.aborted && error.name !== 'AbortError') {
                    if (error.code === 'rate-limit') { error.retryAt ??= Date.now() + 300000; blocked.set(id, error); cancel(id); }
                    onError(id, error);
                }
                throw error;
            } finally { release?.(); flights.delete(flight); signal?.removeEventListener('abort', abort); }
        },
        canvas() { const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 256; return canvas; },
        dispose() { disposed = true; cancel(); scenes = []; blocked.clear(); },
    };
}
