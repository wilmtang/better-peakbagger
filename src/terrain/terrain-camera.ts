// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared camera validation and conversion for the native
// Leaflet maps and the extension-owned MapLibre terrain view.

const MAX_MERCATOR_LAT = 85.0511287;
const MAX_TERRAIN_ZOOM = 18;
const LEAFLET_ZOOM_OFFSET = 1;

export interface TerrainCameraState {
    center: [number, number];
    zoom: number;
}

export interface MapLibreCameraState {
    center: [number, number];
    zoom: number;
}

interface LatLngReadable {
    getCenter(): { lat?: unknown; lng?: unknown } | null | undefined;
    getZoom(): unknown;
}

interface LeafletViewWritable {
    setView(center: [number, number], zoom: number, options: { animate: boolean }): unknown;
}

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const isLatLngReadable = (map: unknown): map is LatLngReadable => {
    if (!map || (typeof map !== 'object' && typeof map !== 'function')) return false;
    const candidate = map as Record<string, unknown>;
    return typeof candidate.getCenter === 'function' && typeof candidate.getZoom === 'function';
};

const isLeafletViewWritable = (map: unknown): map is LeafletViewWritable => {
    if (!map || (typeof map !== 'object' && typeof map !== 'function')) return false;
    return typeof (map as Record<string, unknown>).setView === 'function';
};

const clean = (value: unknown): TerrainCameraState | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const center = record.center;
    if (!Array.isArray(center) || center.length !== 2) return null;
    const [lat, lon] = center;
    const zoom = record.zoom;
    if (!isFiniteNumber(lat) || Math.abs(lat) > MAX_MERCATOR_LAT
        || !isFiniteNumber(lon) || Math.abs(lon) > 180
        || !isFiniteNumber(zoom) || zoom < 0 || zoom > MAX_TERRAIN_ZOOM) return null;
    return { center: [lat, lon], zoom };
};

const fromLeaflet = (map: unknown): TerrainCameraState | null => {
    if (!isLatLngReadable(map)) return null;
    try {
        const center = map.getCenter();
        const zoom = map.getZoom();
        if (!center || !isFiniteNumber(zoom)) return null;
        return clean({
            center: [center.lat, center.lng],
            zoom: Math.max(0, Math.min(MAX_TERRAIN_ZOOM, zoom - LEAFLET_ZOOM_OFFSET))
        });
    } catch (error) {
        return null;
    }
};

const applyToLeaflet = (map: unknown, value: unknown): boolean => {
    const camera = clean(value);
    if (!camera || !isLeafletViewWritable(map)) return false;
    try {
        map.setView(camera.center, camera.zoom + LEAFLET_ZOOM_OFFSET, { animate: false });
        return true;
    } catch (error) {
        return false;
    }
};

const fromMapLibre = (map: unknown): TerrainCameraState | null => {
    if (!isLatLngReadable(map)) return null;
    try {
        const center = map.getCenter();
        if (!center) return null;
        return clean({ center: [center.lat, center.lng], zoom: map.getZoom() });
    } catch (error) {
        return null;
    }
};

const toMapLibre = (value: unknown): MapLibreCameraState | null => {
    const camera = clean(value);
    return camera ? { center: [camera.center[1], camera.center[0]], zoom: camera.zoom } : null;
};

export const terrainCamera = {
    clean,
    fromLeaflet,
    applyToLeaflet,
    fromMapLibre,
    toMapLibre
};
