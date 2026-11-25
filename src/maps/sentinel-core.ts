// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requestDeadline } from '../net/request-deadline.ts';
import { rateLimitError, cancelResponseBody, type RateLimitResponseLike } from '../net/rate-limit.ts';

export interface SentinelTarget {
    time: number;
    platform: string;
    orbit: string;
}

export interface SentinelBoundsReader {
    getWest(): number;
    getEast(): number;
    getSouth(): number;
    getNorth(): number;
}

export interface SentinelViewBounds {
    west: number;
    east: number;
    south: number;
    north: number;
}

export interface SentinelScene {
    id: string;
    time: number;
    bounds: [number, number, number, number];
    covered: number[];
    platform: string;
    orbit: string;
    cloud: number | null;
}

export interface SentinelCapture {
    key: string;
    time: number;
    platform: string;
    orbit: string;
    scenes: SentinelScene[];
    coverage: number;
    centerCovered: boolean;
    cloud: number | null;
}

export interface SentinelResponseLike extends RateLimitResponseLike {
    ok?: boolean;
    status?: number;
    headers?: { get?(name: string): string | null } | null;
    body?: {
        getReader?(): {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(): unknown;
            releaseLock(): void;
        };
        cancel?(): unknown;
    } | null;
    text?(): Promise<string>;
}

export type SentinelFetch = (url: string, init?: RequestInit) => Promise<SentinelResponseLike>;

export interface SearchSentinelOptions {
    signal?: AbortSignal;
    fetchImpl?: SentinelFetch;
    now?: number;
    timeoutMs?: number;
}

type Position = number[];
type Ring = Position[];
type PolygonCoordinates = Ring[];
type MultiPolygonCoordinates = PolygonCoordinates[];
type SentinelGeometry =
    | { type: 'Polygon'; coordinates: PolygonCoordinates }
    | { type: 'MultiPolygon'; coordinates: MultiPolygonCoordinates };

interface CaptureGroup {
    key: string;
    time: number;
    platform: string;
    orbit: string;
    scenes: SentinelScene[];
}

export const SENTINEL_NAME = 'Sentinel-2 (experimental)';
export const SENTINEL_CODE = 'BPB_SENTINEL';
export const SENTINEL_MIN_ZOOM = 9;
// Conservative envelope around routine land coverage, including edge/island
// acquisitions. The catalog still decides actual recent-scene availability.
export const SENTINEL_LATITUDES: number[] = [-60, 84];
export const SENTINEL_ATTRIBUTION = '<a href="https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a" target="_blank" rel="noopener noreferrer">Copernicus Sentinel-2 / Microsoft Planetary Computer</a>';
const SEARCH_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const DAY = 86400000;
const PASS_WINDOW = 15 * 60000;
const MAX_BODY = 4 * 1024 * 1024;

export const sentinelTarget = (value: unknown): SentinelTarget | null => {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.time !== 'number' || !Number.isFinite(candidate.time) || candidate.time < Date.UTC(2015, 5, 27) || candidate.time > Date.now()
        || typeof candidate.platform !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(candidate.platform)
        || typeof candidate.orbit !== 'string' || !/^[1-9]\d{0,2}$/.test(candidate.orbit)) return null;
    return { time: candidate.time, platform: candidate.platform, orbit: candidate.orbit };
};

export const sentinelTileUrl = (id: string): string => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid satellite scene.');
    return 'https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x'
        + `?collection=sentinel-2-l2a&item=${encodeURIComponent(id)}&assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0&format=png`;
};

const longitude = (value: number): number => ((value + 180) % 360 + 360) % 360 - 180;
export const sentinelView = (bounds: SentinelBoundsReader | null | undefined, zoom: number | undefined): SentinelViewBounds => {
    const west = Number(bounds?.getWest()), east = Number(bounds?.getEast());
    const south = Number(bounds?.getSouth()), north = Number(bounds?.getNorth());
    if (![west, east, south, north, zoom].every(Number.isFinite)
        || south >= north || south < -85.0511287 || north > 85.0511287
        || north < SENTINEL_LATITUDES[0] || south > SENTINEL_LATITUDES[1]) throw new Error('This map area is outside satellite coverage.');
    let width = east - west;
    if (width < 0) width += 360;
    if ((zoom as number) < SENTINEL_MIN_ZOOM || width <= 0 || width > 5 || north - south > 5) throw new Error('Zoom in to load Sentinel-2 imagery.');
    const left = longitude(west);
    return { west: left, east: left + width, south, north };
};

const unwrap = (value: number, around: number): number => around + longitude(value - around);
const insideRing = (ring: Ring, x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = unwrap(ring[i][0], x), ay = ring[i][1];
        const bx = unwrap(ring[j][0], x), by = ring[j][1];
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
};
const contains = (geometry: SentinelGeometry, x: number, y: number): boolean => {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some(rings => insideRing(rings[0], x, y)
        && !rings.slice(1).some(ring => insideRing(ring, x, y)));
};
const validGeometry = (geometry: unknown): geometry is SentinelGeometry => {
    if (!geometry || typeof geometry !== 'object') return false;
    const candidate = geometry as { type?: unknown; coordinates?: unknown };
    if (candidate.type !== 'Polygon' && candidate.type !== 'MultiPolygon') return false;
    const polygons = candidate.type === 'Polygon' ? [candidate.coordinates] : candidate.coordinates;
    let points = 0;
    return Array.isArray(polygons) && polygons.length > 0 && polygons.length <= 20
        && polygons.every(rings => Array.isArray(rings) && rings.length > 0 && rings.length <= 20
            && rings.every(ring => Array.isArray(ring) && ring.length >= 4
                && ring.every(point => ++points <= 2000 && Array.isArray(point) && point.length >= 2
                    && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
                    && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90)
                && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]));
};

// These percentages sample footprints, not clear pixels. Cloud metadata describes
// entire scenes; neither statistic establishes visibility of the viewed summit.
export const sentinelCaptures = (features: readonly unknown[], view: SentinelViewBounds): SentinelCapture[] => {
    const samples: [number, number][] = [];
    for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) {
        samples.push([view.west + (x + 0.5) / 11 * (view.east - view.west), view.south + (y + 0.5) / 11 * (view.north - view.south)]);
    }
    const seen = new Set<string>();
    const scenes: SentinelScene[] = [];
    for (const rawFeature of features) {
        if (!rawFeature || typeof rawFeature !== 'object') continue;
        const feature = rawFeature as { id?: unknown; collection?: unknown; properties?: unknown; geometry?: unknown };
        const properties = feature.properties && typeof feature.properties === 'object' ? feature.properties as Record<string, unknown> : null;
        const time = typeof properties?.datetime === 'string' ? Date.parse(properties.datetime) : NaN;
        const id = feature.id;
        const geometry = feature.geometry;
        const relativeOrbit = properties?.['sat:relative_orbit'];
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || seen.has(id)
            || !Number.isFinite(time) || feature.collection !== 'sentinel-2-l2a' || !validGeometry(geometry)
            || typeof properties?.platform !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(properties.platform)
            || typeof relativeOrbit !== 'number' || !Number.isInteger(relativeOrbit) || relativeOrbit < 1 || relativeOrbit > 999) continue;
        seen.add(id);
        const points: Position[] = geometry.type === 'Polygon'
            ? geometry.coordinates.flat()
            : geometry.coordinates.flat(2);
        const around = (view.west + view.east) / 2;
        const longitudes = points.map(point => unwrap(point[0], around));
        const latitudes = points.map(point => point[1]);
        const bounds: [number, number, number, number] = [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
        const covered = samples.map(([x, y], index) => contains(geometry, x, y) ? index : -1).filter(index => index >= 0);
        if (!covered.length) continue;
        const cloud = properties['eo:cloud_cover'];
        scenes.push({
            id,
            time,
            bounds,
            covered,
            platform: String(properties.platform || ''),
            orbit: String(relativeOrbit ?? ''),
            cloud: typeof cloud === 'number' && cloud >= 0 && cloud <= 100 ? cloud : null,
        });
    }
    scenes.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
    const groups: CaptureGroup[] = [];
    for (const scene of scenes) {
        let group = groups.at(-1);
        if (!group || group.platform !== scene.platform || group.orbit !== scene.orbit || scene.time - group.time > PASS_WINDOW) {
            group = { key: `${scene.platform}/${scene.orbit}/${scene.time}`, time: scene.time, platform: scene.platform, orbit: scene.orbit, scenes: [] };
            groups.push(group);
        }
        group.scenes.push(scene);
    }
    return groups.map(group => {
        const covered = new Set<number>();
        const chosen: SentinelScene[] = [];
        // Greedy union coverage, capped at eight raster sources. Never count
        // footprints of a scene we will not render in the displayed estimate.
        while (chosen.length < 8) {
            const next = group.scenes.filter(scene => !chosen.includes(scene)).sort((left, right) =>
                right.covered.filter(index => !covered.has(index)).length - left.covered.filter(index => !covered.has(index)).length
                || left.id.localeCompare(right.id))[0];
            if (!next || next.covered.every(index => covered.has(index))) break;
            chosen.push(next);
            next.covered.forEach(index => covered.add(index));
        }
        return {
            ...group,
            scenes: chosen,
            coverage: covered.size / samples.length,
            centerCovered: covered.has(60),
            cloud: chosen.every(scene => scene.cloud !== null) ? chosen.reduce((sum, scene) => sum + (scene.cloud ?? 0), 0) / chosen.length : null,
        };
    }).sort((left, right) => Number(right.centerCovered) - Number(left.centerCovered) || right.time - left.time);
};

export const searchSentinel = async (
    view: SentinelViewBounds,
    { signal, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 15000 }: SearchSentinelOptions = {},
): Promise<SentinelCapture[]> => {
    const boxes = view.east > 180
        ? [[view.west, view.south, 180, view.north], [-180, view.south, view.east - 360, view.north]]
        : [[view.west, view.south, view.east, view.north]];
    const deadline = requestDeadline.createRequestDeadline(timeoutMs);
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_, reject) => {
        const cancel = () => { deadline.abort(); reject(Object.assign(new Error('Satellite search cancelled.'), { name: 'AbortError' })); };
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
        removeAbortListener = () => signal?.removeEventListener('abort', cancel);
    });
    aborted.catch(() => {});
    const run = <T>(promise: Promise<T>): Promise<T> => deadline.run(Promise.race([promise, aborted]));
    const features: unknown[] = [];
    let response: SentinelResponseLike | undefined;
    try {
        if (signal?.aborted) throw Object.assign(new Error('Satellite search cancelled.'), { name: 'AbortError' });
        for (const bbox of boxes) {
            response = await run(fetchImpl(SEARCH_URL, {
                method: 'POST', mode: 'cors', credentials: 'omit',
                headers: { 'content-type': 'application/json', accept: 'application/geo+json' },
                body: JSON.stringify({
                    collections: ['sentinel-2-l2a'], bbox,
                    datetime: `${new Date(now - 30 * DAY).toISOString()}/${new Date(now).toISOString()}`, limit: 100,
                    sortby: [{ field: 'datetime', direction: 'desc' }],
                }),
                signal: deadline.signal,
            }));
            if (response.status === 429) throw rateLimitError('Microsoft Planetary Computer', response, now);
            if (!response.ok) throw new Error('Satellite service is unavailable. Try again.');
            if (Number(response.headers?.get?.('content-length')) > MAX_BODY) throw new Error('Satellite search is too large. Zoom in.');
            let text: string;
            if (response.body?.getReader) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let size = 0;
                text = '';
                try {
                    while (true) {
                        const chunk = await run(reader.read());
                        if (chunk.done) break;
                        const bytes = chunk.value!;
                        size += bytes.byteLength;
                        if (size > MAX_BODY) throw new Error('Satellite search is too large. Zoom in.');
                        text += decoder.decode(bytes, { stream: true });
                    }
                    text += decoder.decode();
                } finally { void Promise.resolve(reader.cancel()).catch(() => {}); reader.releaseLock(); }
            } else {
                text = await run(response.text!());
                if (text.length > MAX_BODY) throw new Error('Satellite search is too large. Zoom in.');
            }
            const data = JSON.parse(text) as { features?: unknown; links?: unknown } | null;
            if (!data || !Array.isArray(data.features) || data.features.length > 100) throw new Error('Satellite service returned an invalid catalog.');
            if (Array.isArray(data.links) && data.links.some(link => (link as { rel?: unknown } | null | undefined)?.rel === 'next')) {
                throw new Error('Too many captures in this area. Zoom in.');
            }
            features.push(...(data.features as unknown[]));
        }
        return sentinelCaptures(features.filter(rawFeature => {
            const dt = (rawFeature as { properties?: { datetime?: unknown } } | null | undefined)?.properties?.datetime;
            const time = typeof dt === 'string' ? Date.parse(dt) : NaN;
            return time >= now - 30 * DAY && time <= now;
        }), view);
    } finally { cancelResponseBody(response); removeAbortListener(); deadline.clear(); }
};
