// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure slippy-tile math for the DEM prefetch. Given a route
// bounds or a peak center+zoom and the host viewport, it enumerates the small
// set of Mapterhorn DEM tiles the 3D camera will request first, so the
// background worker can warm the origin-keyed cache before the user opens 3D.
//
// The zoom math mirrors the terrain frame's fitBounds (512-px DEM tiles,
// padding 46, maxZoom 15.5 — see src/terrain/terrain-frame.js). This module has no DOM
// or extension-API dependency so it stays node-testable.

const TILE_SIZE = 512;
const MAX_MERCATOR_LAT = 85.0511287;
const DEFAULT_PADDING = 46;
const DEFAULT_MAX_ZOOM = 15.5;
const DEFAULT_CAP = 32;

const clampLat = lat => Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));

// Normalized Web Mercator in [0, 1]; y increases southward, matching the tile
// grid. Longitude is not wrapped — callers validate lon in [-180, 180] and the
// frame already rejects antimeridian-spanning views.
const mercatorX = lon => (lon + 180) / 360;
const mercatorY = lat => {
    const rad = clampLat(lat) * Math.PI / 180;
    return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
};

// Clamp a fractional tile coordinate to the valid [0, 2^z - 1] range.
const tileFromMercator = (value, z) => {
    const dimension = 2 ** z;
    return Math.max(0, Math.min(dimension - 1, Math.floor(value * dimension)));
};

const lonToTileX = (lon, z) => tileFromMercator(mercatorX(lon), z);
const latToTileY = (lat, z) => tileFromMercator(mercatorY(lat), z);

// The zoom at which `bounds` fills the padded viewport, capped at maxZoom.
// Mirrors MapLibre's cameraForBounds for a bearing-0 camera on 512-px tiles.
const fitZoom = (bounds, viewport, { padding = DEFAULT_PADDING, maxZoom = DEFAULT_MAX_ZOOM } = {}) => {
    const availWidth = Math.max(1, viewport.width - padding * 2);
    const availHeight = Math.max(1, viewport.height - padding * 2);
    const spanX = Math.abs(mercatorX(bounds.maxLon) - mercatorX(bounds.minLon)) || Number.EPSILON;
    const spanY = Math.abs(mercatorY(bounds.minLat) - mercatorY(bounds.maxLat)) || Number.EPSILON;
    const zoomX = Math.log2(availWidth / (spanX * TILE_SIZE));
    const zoomY = Math.log2(availHeight / (spanY * TILE_SIZE));
    return Math.min(maxZoom, zoomX, zoomY);
};

// Enumerate the DEM tiles the first 3D paint will request for a view, plus
// their parent level (MapLibre paints ancestors while the target level loads).
// Accepts either a route `bounds` ({minLat,minLon,maxLat,maxLon}) or a peak
// `center` ([lat, lon]) + `zoom`. Returns [] for anything malformed. The result
// is bounded by `cap`: if the target level would exceed it, the level is
// lowered until the combined set fits.
const tilesForView = ({
    bounds, center, zoom, viewport,
    cap = DEFAULT_CAP, padding = DEFAULT_PADDING, maxZoom = DEFAULT_MAX_ZOOM
} = {}) => {
    if (!viewport || !(viewport.width > 0) || !(viewport.height > 0)) return [];

    let fitZoomValue;
    // The fixed ground rectangle the view covers, in normalized mercator. It
    // does not change with the prefetch tile level — only the grid resolution
    // does — so it is computed once from the real (fractional) view zoom.
    let rect;
    if (bounds) {
        if (![bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon].every(Number.isFinite)) return [];
        fitZoomValue = fitZoom(bounds, viewport, { padding, maxZoom });
        rect = {
            west: mercatorX(bounds.minLon),
            east: mercatorX(bounds.maxLon),
            north: mercatorY(bounds.maxLat),
            south: mercatorY(bounds.minLat)
        };
    } else if (Array.isArray(center) && center.length === 2 && Number.isFinite(zoom)) {
        const [lat, lon] = center;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        fitZoomValue = Math.min(maxZoom, zoom);
        const worldPixels = TILE_SIZE * 2 ** fitZoomValue;
        const halfWidth = (viewport.width / 2) / worldPixels;
        const halfHeight = (viewport.height / 2) / worldPixels;
        const centerX = mercatorX(lon);
        const centerY = mercatorY(lat);
        rect = {
            west: centerX - halfWidth,
            east: centerX + halfWidth,
            north: centerY - halfHeight,
            south: centerY + halfHeight
        };
    } else {
        return [];
    }
    if (!Number.isFinite(fitZoomValue)) return [];

    const tilesAt = z => {
        const out = [];
        if (z < 0) return out;
        const minX = tileFromMercator(Math.min(rect.west, rect.east), z);
        const maxX = tileFromMercator(Math.max(rect.west, rect.east), z);
        const minY = tileFromMercator(Math.min(rect.north, rect.south), z);
        const maxY = tileFromMercator(Math.max(rect.north, rect.south), z);
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) out.push({ z, x, y });
        }
        return out;
    };

    // Target level plus its parent; drop a level at a time if the pair exceeds
    // the cap. zt stays ≥ 1 so the parent level (zt - 1) is never negative.
    let targetZoom = Math.max(1, Math.floor(Math.min(fitZoomValue, maxZoom)));
    let tiles = tilesAt(targetZoom).concat(tilesAt(targetZoom - 1));
    while (tiles.length > cap && targetZoom > 1) {
        targetZoom--;
        tiles = tilesAt(targetZoom).concat(tilesAt(targetZoom - 1));
    }
    return tiles;
};

export const terrainTiles = { lonToTileX, latToTileY, fitZoom, tilesForView };
