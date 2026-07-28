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
// The deepest level the DEM protocol will accept (src/terrain/terrain-cache.js).
// A level offset can never enumerate past it, because the resulting URL would be
// refused rather than fetched.
const MAX_TILE_ZOOM = 18;
// Target level plus its parent: MapLibre paints ancestors while the target
// loads, so this pair is what a first paint needs.
const DEFAULT_LEVEL_OFFSETS = [0, -1];

// What gives way when the enumerated set exceeds the cap.
//
// COARSEN lowers the target level, so a first paint still gets a complete
// target-plus-parent pair, just at a coarser level than the view wanted.
//
// SHED_FINEST keeps the target level and drops the finest requested level
// instead. Warming a live view wants this: the coarse rungs are what a fallback
// lands on and they cost a handful of tiles, while the finest requested level
// across a pitched camera's whole ground rectangle is both the most expensive
// and the least needed — the renderer is already fetching it for the part of
// that rectangle the user is actually looking at. Coarsening here would walk the
// target away from the levels the renderer uses and warm tiles nothing asks for.
const COARSEN = 'coarsen';
const SHED_FINEST = 'shed-finest';

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

// Enumerate the DEM tiles a view needs. Accepts either a route `bounds`
// ({minLat,minLon,maxLat,maxLon}) or a peak `center` ([lat, lon]) + `zoom`.
// Returns [] for anything malformed, and never more than `cap` tiles.
//
// By default this is the first-paint set — the target level plus its parent.
// Options widen it to the tiles a *tilt* will ask for, which is a different
// question: pitching the camera up both re-levels ground already on screen and
// pulls new ground over the horizon.
//
// - `levelOffsets` chooses which levels to enumerate, relative to the target.
//   Negative offsets are the coarse rungs a fallback lands on, and they are
//   cheap: each step down quarters the tile count for the same ground.
// - `expand` grows the ground rectangle about its centre, covering the extra
//   ground a few more degrees of pitch would pull over the horizon.
// - `expandStep` grows it again for each coarser rung. A coarser level is used
//   further from the camera, so one rectangle cannot serve the whole ladder: at
//   the near level it would have to be enormous, and at the far level it would
//   fall short. Growing the rectangle at the same rate as the tiles keeps the
//   tile count per rung roughly flat.
// - passing `bounds` together with `zoom` takes the ground rectangle from the
//   bounds and the level from the zoom, which is what a live pitched camera
//   needs: its visible rectangle says nothing about the level it is rendering.
// - `capPolicy` decides what gives way when the set exceeds `cap`.
const tilesForView = ({
    bounds, center, zoom, viewport,
    cap = DEFAULT_CAP, padding = DEFAULT_PADDING, maxZoom = DEFAULT_MAX_ZOOM,
    levelOffsets = DEFAULT_LEVEL_OFFSETS, expand = 1, expandStep = 1, capPolicy = COARSEN
} = {}) => {
    if (!viewport || !(viewport.width > 0) || !(viewport.height > 0)) return [];
    if (!Array.isArray(levelOffsets) || !levelOffsets.length
        || !levelOffsets.every(Number.isInteger)) return [];
    if (!Number.isFinite(expand) || expand < 1) return [];
    if (!Number.isFinite(expandStep) || expandStep < 1) return [];
    if (capPolicy !== COARSEN && capPolicy !== SHED_FINEST) return [];

    let fitZoomValue;
    // The fixed ground rectangle the view covers, in normalized mercator. It
    // does not change with the prefetch tile level — only the grid resolution
    // does — so it is computed once from the real (fractional) view zoom.
    let rect;
    if (bounds) {
        if (![bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon].every(Number.isFinite)) return [];
        // An explicit zoom names the level to enumerate at. Without one the level
        // is the zoom at which the bounds fill the padded viewport, which is what
        // an opening view does — but a live camera's ground rectangle and its
        // zoom are independent, and a pitched camera's rectangle would otherwise
        // imply a far coarser level than it is actually rendering.
        fitZoomValue = Number.isFinite(zoom)
            ? Math.min(maxZoom, zoom)
            : fitZoom(bounds, viewport, { padding, maxZoom });
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

    const baseRect = rect;
    // north/south stay in mercator order (north is the smaller y); tilesAt takes
    // min/max, so the growth is orientation-independent either way.
    const grown = factor => {
        if (!(factor > 1)) return baseRect;
        const midX = (baseRect.west + baseRect.east) / 2;
        const midY = (baseRect.north + baseRect.south) / 2;
        const halfX = Math.abs(baseRect.east - baseRect.west) / 2 * factor;
        const halfY = Math.abs(baseRect.south - baseRect.north) / 2 * factor;
        return { west: midX - halfX, east: midX + halfX, north: midY - halfY, south: midY + halfY };
    };

    const tilesAt = (z, area) => {
        const out = [];
        if (z < 0) return out;
        const minX = tileFromMercator(Math.min(area.west, area.east), z);
        const maxX = tileFromMercator(Math.max(area.west, area.east), z);
        const minY = tileFromMercator(Math.min(area.north, area.south), z);
        const maxY = tileFromMercator(Math.max(area.north, area.south), z);
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) out.push({ z, x, y });
        }
        return out;
    };

    // Every requested level, deduplicated: clamping keeps distinct offsets from
    // resolving to the same level silently. Each coarser rung takes a rectangle
    // `expandStep` times larger than the rung above it.
    const tilesForLevels = (target, offsets) => {
        const seen = new Set();
        const out = [];
        offsets.forEach((offset, rung) => {
            const level = target + offset;
            if (level < 0 || level > MAX_TILE_ZOOM) return;
            for (const tile of tilesAt(level, grown(expand * expandStep ** rung))) {
                const key = `${tile.z}/${tile.x}/${tile.y}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(tile);
            }
        });
        return out;
    };

    // The target stays ≥ 1 so the default parent level (target - 1) is never
    // negative. Offsets run finest first, which is the order SHED_FINEST drops.
    let targetZoom = Math.max(1, Math.floor(Math.min(fitZoomValue, maxZoom)));
    let offsets = [...levelOffsets].sort((a, b) => b - a);
    let tiles = tilesForLevels(targetZoom, offsets);
    if (capPolicy === SHED_FINEST) {
        while (tiles.length > cap && offsets.length > 1) {
            offsets = offsets.slice(1);
            tiles = tilesForLevels(targetZoom, offsets);
        }
    } else {
        while (tiles.length > cap && targetZoom > 1) {
            targetZoom--;
            tiles = tilesForLevels(targetZoom, offsets);
        }
    }
    // A single level over a large rectangle can still exceed the cap once there
    // is nothing left to shed or coarsen. The cap is a traffic guarantee, so it
    // holds here too rather than being best-effort.
    return tiles.length > cap ? tiles.slice(0, cap) : tiles;
};

export const terrainTiles = {
    lonToTileX, latToTileY, fitZoom, tilesForView,
    CAP_POLICY: { COARSEN, SHED_FINEST }
};
