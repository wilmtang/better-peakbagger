// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared camera validation and conversion for the native
// Leaflet maps and the extension-owned MapLibre terrain view.

const MAX_MERCATOR_LAT = 85.0511287;
const MAX_TERRAIN_ZOOM = 18;
const LEAFLET_ZOOM_OFFSET = 1;

const clean = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const center = value.center;
    if (!Array.isArray(center) || center.length !== 2) return null;
    const [lat, lon] = center;
    const zoom = value.zoom;
    if (!Number.isFinite(lat) || Math.abs(lat) > MAX_MERCATOR_LAT
        || !Number.isFinite(lon) || Math.abs(lon) > 180
        || !Number.isFinite(zoom) || zoom < 0 || zoom > MAX_TERRAIN_ZOOM) return null;
    return { center: [lat, lon], zoom };
};

const fromLeaflet = map => {
    if (!map || typeof map.getCenter !== 'function' || typeof map.getZoom !== 'function') return null;
    try {
        const center = map.getCenter();
        const zoom = map.getZoom();
        if (!center || !Number.isFinite(zoom)) return null;
        return clean({
            center: [center.lat, center.lng],
            zoom: Math.max(0, Math.min(MAX_TERRAIN_ZOOM, zoom - LEAFLET_ZOOM_OFFSET))
        });
    } catch (error) {
        return null;
    }
};

const applyToLeaflet = (map, value) => {
    const camera = clean(value);
    if (!camera || !map || typeof map.setView !== 'function') return false;
    try {
        map.setView(camera.center, camera.zoom + LEAFLET_ZOOM_OFFSET, { animate: false });
        return true;
    } catch (error) {
        return false;
    }
};

const fromMapLibre = map => {
    if (!map || typeof map.getCenter !== 'function' || typeof map.getZoom !== 'function') return null;
    try {
        const center = map.getCenter();
        return clean({ center: [center.lat, center.lng], zoom: map.getZoom() });
    } catch (error) {
        return null;
    }
};

const toMapLibre = value => {
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
