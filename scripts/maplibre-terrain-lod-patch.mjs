// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// MapLibre 6.13/6.14's TerrainTileManager.update omits the source's LOD callback
// from coveringTiles, although TileManager.update uses it for DEM downloads.
// Keep both grids on the same detail ladder. Fail closed on dependency changes
// so this narrow upstream workaround must be reviewed, never silently carried.
const BEFORE = 'maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t}';
const AFTER = 'maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t,calculateTileZoom:this.tileManager._source.calculateTileZoom}';
// 6.14.0 retains the identical compiled terrain update method from 6.13.0.
const REVIEWED_VERSIONS = new Set(['6.13.0', '6.14.0']);

export function patchMapLibreTerrainLod(source, version) {
    if (!REVIEWED_VERSIONS.has(version) || source.split(BEFORE).length !== 2 || source.includes(AFTER)) {
        throw new Error('MapLibre terrain LOD patch no longer matches. Review or remove the workaround before building.');
    }
    return '// Better Peakbagger: align terrain RTT and DEM LOD; see scripts/maplibre-terrain-lod-patch.mjs.\n'
        + source.replace(BEFORE, AFTER);
}
