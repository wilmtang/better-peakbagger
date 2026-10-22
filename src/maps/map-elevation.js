// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readBoundedWebp } from '../terrain/terrain-cache.js';
import { requestDeadline } from '../net/request-deadline.js';
import { cancelResponseBody, rateLimitError } from '../net/rate-limit.js';

const TILE_SIZE = 512;
// A fixed detail level keeps a reading independent of the camera and of 3D.
// Missing regional levels fall back to the global archive, never to height 0.
const MAX_ZOOM = 14, MIN_ZOOM = 10, MAX_LATITUDE = 85.0511287798066;

export function elevationTile(latitude, longitude, zoom) {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > MAX_LATITUDE
        || !Number.isFinite(longitude) || Math.abs(longitude) > 180
        || !Number.isInteger(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) return null;
    const scale = 2 ** zoom, lat = latitude * Math.PI / 180;
    const x = ((longitude + 180) % 360) / 360 * scale;
    const y = Math.max(0, Math.min(scale - Number.EPSILON * scale,
        (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale));
    return { z: zoom, x: Math.floor(x), y: Math.floor(y),
        pixelX: Math.min(511, Math.floor((x - Math.floor(x)) * TILE_SIZE)),
        pixelY: Math.min(511, Math.floor((y - Math.floor(y)) * TILE_SIZE)) };
}

export function sampleElevation(pixels, x, y) {
    const index = (y * TILE_SIZE + x) * 4;
    if (pixels.length !== TILE_SIZE * TILE_SIZE * 4 || pixels[index + 3] !== 255) return null;
    const meters = pixels[index] * 256 + pixels[index + 1] + pixels[index + 2] / 256 - 32768;
    return meters >= -12000 && meters <= 10000 ? meters : null;
}

async function decodeTile(data, doc) {
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/webp' }),
        { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
        if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) throw new Error('Invalid elevation tile dimensions');
        const canvas = doc.createElement('canvas'); canvas.width = canvas.height = TILE_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    } finally { bitmap.close(); }
}

export function createElevationClient({ document: doc = document, fetchImpl = (...args) => fetch(...args),
    decode = data => decodeTile(data, doc), timeoutMs = 8000, now = () => Date.now() } = {}) {
    const tiles = new Map(), missing = new Set();
    let retryAt = 0;
    return {
        async lookup({ latitude, longitude }, { signal } = {}) {
            if (!elevationTile(latitude, longitude, MAX_ZOOM)) return null;
            const deadline = requestDeadline.createRequestDeadline(timeoutMs);
            const abort = () => deadline.abort();
            signal?.addEventListener('abort', abort, { once: true });
            const check = () => { if (signal?.aborted) throw Object.assign(new Error('Elevation lookup cancelled'), { name: 'AbortError' }); };
            try {
                for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom--) {
                    check();
                    const tile = elevationTile(latitude, longitude, zoom), key = `${tile.z}/${tile.x}/${tile.y}`;
                    let pixels = tiles.get(key);
                    if (!pixels) {
                        if (missing.has(key)) continue;
                        if (retryAt > now()) throw Object.assign(new Error('Elevation requests temporarily limited'), { code: 'rate-limit' });
                        let response;
                        try {
                            response = await deadline.run(fetchImpl(`https://tiles.mapterhorn.com/${key}.webp`, {
                                signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
                            }));
                            check();
                            if (response.status === 404) {
                                missing.add(key); if (missing.size > 64) missing.delete(missing.values().next().value);
                                continue;
                            }
                            if (response.status === 429) {
                                const error = rateLimitError('Mapterhorn', response, now());
                                retryAt = error.retryAt || now() + 300000; throw error;
                            }
                            if (!response.ok) throw new Error('Elevation data unavailable');
                            const data = await deadline.run(readBoundedWebp(response, deadline));
                            pixels = await deadline.run(decode(data));
                            check();
                            if (pixels.length !== TILE_SIZE * TILE_SIZE * 4) throw new Error('Invalid elevation pixels');
                        } finally { cancelResponseBody(response); }
                    }
                    check();
                    tiles.delete(key); tiles.set(key, pixels);
                    if (tiles.size > 4) tiles.delete(tiles.keys().next().value);
                    return sampleElevation(pixels, tile.pixelX, tile.pixelY);
                }
                return null;
            } finally { signal?.removeEventListener('abort', abort); deadline.clear(); }
        },
        clear() { tiles.clear(); missing.clear(); },
    };
}
