// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const VECTOR_BASEMAP = Object.freeze({
    id: 'vector',
    code: 'BPB_VECTOR',
    name: 'OSM Vector (experimental)',
    provider: 'OpenFreeMap',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    origins: Object.freeze(['https://tiles.openfreemap.org']),
});
export const MAPTOOLKIT_BASEMAP = Object.freeze({
    id: 'maptoolkit',
    code: 'BPB_MAPTOOLKIT',
    name: 'Maptoolkit Hiking',
    provider: 'Maptoolkit',
    styleUrl: 'https://styles.maptoolkit.org/hiking.json',
    origins: Object.freeze(['https://styles.maptoolkit.org', 'https://tiles.maptoolkit.org',
        'https://fonts.maptoolkit.org', 'https://icons.maptoolkit.org', 'https://tiles.mapterhorn.com']),
});
export const VECTOR_BASEMAPS = Object.freeze([VECTOR_BASEMAP, MAPTOOLKIT_BASEMAP]);
// Match the service's TileJSON HTML so MapLibre deduplicates the eager fallback
// against the source attribution when its asynchronous metadata arrives.
export const MAPTOOLKIT_ATTRIBUTION = "<a href='https://www.maptoolkit.com/copyright/' target='_blank' rel='noopener noreferrer'>&copy; Maptoolkit</a> <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noopener noreferrer'>&copy; Openstreetmap</a>";
export const vectorBasemap = value => VECTOR_BASEMAPS.find(item => item.id === value || item.code === value) || null;
export function vectorProviderUrl(value, basemap = VECTOR_BASEMAP, { templates = [] } = {}) {
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
export function readVectorView(value) {
    if (!value || !Array.isArray(value.center) || value.center.length !== 2
        || !value.center.every(Number.isFinite) || Math.abs(value.center[0]) > 85.0511287
        || Math.abs(value.center[1]) > 180 || !Number.isFinite(value.zoom)
        || value.zoom < -1 || value.zoom > 23) return null;
    return { center: [...value.center], zoom: value.zoom };
}
