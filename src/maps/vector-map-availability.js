// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Compatibility boundary for the packaged MapLibre 6 tile managers. Inspect
// live viewport membership, not feature counts: a loaded empty tile is usable,
// as is a cached parent. Offscreen cached tiles must not hide a complete outage.
export function vectorMapAvailability(map, { center } = {}) {
    const managers = map?.style?.tileManagers;
    if (!managers || typeof managers !== 'object' || Array.isArray(managers)) throw new Error('Vector tile availability is unsupported.');
    let requested = false, usable = false;
    for (const manager of Object.values(managers)) {
        if (typeof manager?.getIds !== 'function' || typeof manager.getRenderableIds !== 'function') throw new Error('Vector tile availability is unsupported.');
        // Elevation only shades cartography. A healthy DEM provider cannot make a
        // vector outage look usable, and a failed DEM tile is not an outage.
        if (manager.getSource?.()?.type === 'raster-dem') continue;
        const ids = manager.getIds(), renderable = manager.getRenderableIds();
        if (!Array.isArray(ids) || !Array.isArray(renderable)) throw new Error('Unexpected vector tile availability.');
        // Failed TileJSON has no tile IDs at all. Only an active source whose
        // metadata never loaded is unavailable here; old tile errors must not
        // turn a later out-of-coverage view into a failure.
        requested ||= ids.length > 0 || manager.used !== false && manager._sourceErrored === true && manager._sourceLoaded !== true;
        if (!center) usable ||= renderable.length > 0;
        else if (manager.getSource?.()?.type === 'vector') {
            if (typeof manager.getTileByID !== 'function') throw new Error('Vector center availability is unsupported.');
            // The frame overscans Leaflet's viewport. A tile in that outer
            // buffer (or only a DEM) must not hide the native map before any
            // cartography at the actual camera center is ready. Empty vector
            // tiles are still valid, including loaded parent fallbacks.
            usable ||= renderable.some(id => {
                const tile = manager.getTileByID(id)?.tileID?.canonical;
                if (!tile) return false;
                const scale = 2 ** tile.z;
                const x = ((center[1] + 180) / 360 * scale) % scale;
                const y = (1 - Math.asinh(Math.tan(center[0] * Math.PI / 180)) / Math.PI) / 2 * scale;
                return tile.x === Math.floor(x) && tile.y === Math.floor(Math.max(0, Math.min(scale - 1e-9, y)));
            });
        }
    }
    return { requested, usable };
}

// Before settling, only cartography at the camera center may replace the native
// map. Once settled, a failed center tile must not withhold its usable
// neighbors, and a view with no requested tiles is valid out-of-coverage output.
export function vectorMapReadyToPublish(map, center) {
    if (vectorMapAvailability(map, { center }).usable) return true;
    if (!map.areTilesLoaded() || !map.isStyleLoaded()) return false;
    const { requested, usable } = vectorMapAvailability(map);
    return usable || !requested;
}
