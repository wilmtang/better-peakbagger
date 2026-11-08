// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface VectorBasemap {
    readonly id: string; readonly code: string; readonly name: string; readonly provider: string;
    readonly styleUrl: string; readonly origins: readonly string[];
}
export interface VectorView { center: [number, number]; zoom: number; }
export interface VectorPaint { view: VectorView; width: number; height: number; }

export const MAPTOOLKIT_BASEMAP: VectorBasemap = Object.freeze({
    id: 'maptoolkit',
    code: 'BPB_MAPTOOLKIT',
    name: 'Maptoolkit Hiking (BPB experiment)',
    provider: 'Maptoolkit',
    styleUrl: 'https://styles.maptoolkit.org/hiking.json',
    origins: Object.freeze(['https://styles.maptoolkit.org', 'https://tiles.maptoolkit.org',
        'https://fonts.maptoolkit.org', 'https://icons.maptoolkit.org', 'https://tiles.mapterhorn.com']),
});
export const VECTOR_BASEMAPS: readonly VectorBasemap[] = Object.freeze([MAPTOOLKIT_BASEMAP]);
// Match the service's TileJSON HTML so MapLibre deduplicates the eager fallback
// against the source attribution when its asynchronous metadata arrives.
export const MAPTOOLKIT_ATTRIBUTION = "<a href='https://www.maptoolkit.com/copyright/' target='_blank' rel='noopener noreferrer'>&copy; Maptoolkit</a> <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noopener noreferrer'>&copy; Openstreetmap</a>";
export const vectorBasemap = (value: unknown): VectorBasemap | null => VECTOR_BASEMAPS.find(item => item.id === value || item.code === value) || null;
export function vectorProviderUrl(value: unknown, basemap: VectorBasemap = MAPTOOLKIT_BASEMAP, { templates = [] }: { templates?: readonly string[] } = {}): string | null {
    if (typeof value !== 'string' || !value || value.length > 4096 || !VECTOR_BASEMAPS.includes(basemap)) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || !basemap.origins.includes(url.origin) || url.username || url.password || url.hash
        || !templates.every(template => value.includes(`{${template}}`))) return null;
    return value;
}
export const VECTOR_MESSAGE = '__bpbVectorMap';
export const VECTOR_KEEPALIVE_MS = 60000;

// The Leaflet adapter sends the camera in MapLibre's 512-pixel zoom convention.
// Unlike terrain, a planar map can show the whole world at Leaflet zoom zero.
export function readVectorView(input: unknown): VectorView | null {
    const value = input as { center?: unknown; zoom?: unknown } | null | undefined;
    if (!value || !Array.isArray(value.center) || value.center.length !== 2
        || !value.center.every(Number.isFinite) || Math.abs(value.center[0]) > 85.0511287
        || Math.abs(value.center[1]) > 180 || typeof value.zoom !== 'number' || !Number.isFinite(value.zoom)
        || value.zoom < -1 || value.zoom > 23) return null;
    return { center: [value.center[0], value.center[1]], zoom: value.zoom };
}

// The geographic corners of a planar paint, clockwise from the top-left, in
// MapLibre's image-source [lng, lat] order. Null when it wraps the world or
// reaches past Web Mercator, where one quad cannot place the image.
const WORLD_TILE_SIZE = 512, MERCATOR_MAX_LATITUDE = 85.0511287;
export function vectorPaintCorners({ view, width, height }: VectorPaint): [number, number][] | null {
    const world = WORLD_TILE_SIZE * 2 ** view.zoom;
    if (width >= world || height >= world) return null;
    const x = (view.center[1] + 180) / 360 * world;
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + view.center[0] * Math.PI / 360)) / Math.PI) / 2 * world;
    const lng = (px: number) => px / world * 360 - 180;
    const lat = (py: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / world))) * 180 / Math.PI;
    const [west, east, north, south] = [lng(x - width / 2), lng(x + width / 2), lat(y - height / 2), lat(y + height / 2)];
    if (west < -180 || east > 180 || Math.abs(north) > MERCATOR_MAX_LATITUDE || Math.abs(south) > MERCATOR_MAX_LATITUDE) return null;
    return [[west, north], [east, north], [east, south], [west, south]];
}

// CSS dimensions accompany a transferred GPU bitmap; pixel dimensions can
// differ with device scale. Neither world may trust the other side's shape.
export function readVectorPaint(input: unknown): VectorPaint | null {
    const value = input as { view?: unknown; width?: unknown; height?: unknown } | null | undefined;
    const view = readVectorView(value?.view), width = value?.width, height = value?.height;
    if (!view || typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1 || width > 16384 || height > 16384) return null;
    return { view, width, height };
}
