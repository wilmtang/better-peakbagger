// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readBoundedWebp } from '../terrain/terrain-cache.ts';
import { requestDeadline } from '../net/request-deadline.ts';
import { cancelResponseBody, rateLimitError } from '../net/rate-limit.ts';

export interface ElevationTile {
    z: number;
    x: number;
    y: number;
    pixelX: number;
    pixelY: number;
}

export interface ElevationPoint {
    latitude: number;
    longitude: number;
}

export interface ElevationLookupOptions {
    signal?: AbortSignal;
}

export interface ElevationClientOptions {
    document?: Document;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    decode?: (data: ArrayBuffer) => Promise<ArrayLike<number>>;
    timeoutMs?: number;
    now?: () => number;
}

export interface ElevationClient {
    lookup(point: ElevationPoint, options?: ElevationLookupOptions): Promise<number | null>;
    clear(): void;
}

const TILE_SIZE = 512;
// A fixed detail level keeps a reading independent of the camera and of 3D.
// Missing regional levels fall back to the global archive, never to height 0.
const MAX_ZOOM = 14, MIN_ZOOM = 10, MAX_LATITUDE = 85.0511287798066;

export function elevationTile(latitude: number, longitude: number, zoom: number): ElevationTile | null {
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

export function sampleElevation(pixels: ArrayLike<number>, x: number, y: number): number | null {
    const index = (y * TILE_SIZE + x) * 4;
    if (pixels.length !== TILE_SIZE * TILE_SIZE * 4 || pixels[index + 3] !== 255) return null;
    const meters = pixels[index] * 256 + pixels[index + 1] + pixels[index + 2] / 256 - 32768;
    return meters >= -12000 && meters <= 10000 ? meters : null;
}

async function decodeTile(data: ArrayBuffer, doc: Document): Promise<Uint8ClampedArray> {
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/webp' }),
        { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
        if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) throw new Error('Invalid elevation tile dimensions');
        const canvas = doc.createElement('canvas'); canvas.width = canvas.height = TILE_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Elevation canvas context unavailable');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    } finally { bitmap.close(); }
}

export function createElevationClient({ document: doc = document, fetchImpl = (url, init) => fetch(url, init),
    decode = data => decodeTile(data, doc), timeoutMs = 8000, now = () => Date.now() }: ElevationClientOptions = {}): ElevationClient {
    const tiles = new Map<string, ArrayLike<number>>(), missing = new Set<string>();
    let retryAt = 0;
    return {
        async lookup({ latitude, longitude }: ElevationPoint, { signal }: ElevationLookupOptions = {}): Promise<number | null> {
            if (!elevationTile(latitude, longitude, MAX_ZOOM)) return null;
            const deadline = requestDeadline.createRequestDeadline(timeoutMs);
            const abort = () => deadline.abort();
            signal?.addEventListener('abort', abort, { once: true });
            const check = () => { if (signal?.aborted) throw Object.assign(new Error('Elevation lookup cancelled'), { name: 'AbortError' }); };
            try {
                for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom--) {
                    check();
                    const tile = elevationTile(latitude, longitude, zoom);
                    if (!tile) return null;
                    const key = `${tile.z}/${tile.x}/${tile.y}`;
                    let pixels = tiles.get(key);
                    if (!pixels) {
                        if (missing.has(key)) continue;
                        if (retryAt > now()) throw Object.assign(new Error('Elevation requests temporarily limited'), { code: 'rate-limit' });
                        let response: Response | undefined;
                        try {
                            response = await deadline.run(fetchImpl(`https://tiles.mapterhorn.com/${key}.webp`, {
                                signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
                            }));
                            check();
                            if (response.status === 404) {
                                missing.add(key);
                                if (missing.size > 64) {
                                    const oldest = missing.values().next().value;
                                    if (oldest !== undefined) missing.delete(oldest);
                                }
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
                    if (tiles.size > 4) {
                        const oldest = tiles.keys().next().value;
                        if (oldest !== undefined) tiles.delete(oldest);
                    }
                    return sampleElevation(pixels, tile.pixelX, tile.pixelY);
                }
                return null;
            } finally { signal?.removeEventListener('abort', abort); deadline.clear(); }
        },
        clear() { tiles.clear(); missing.clear(); },
    };
}
