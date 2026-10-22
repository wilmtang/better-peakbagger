// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// MapLibre 6.13's TerrainTileManager.update omits the source's LOD callback
// from coveringTiles, although TileManager.update uses it for DEM downloads.
// Keep both grids on the same detail ladder. Fail closed on dependency changes
// so this narrow upstream workaround must be reviewed, never silently carried.
const BEFORE = 'maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t}';
const AFTER = 'maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t,calculateTileZoom:this.tileManager._source.calculateTileZoom}';

export function patchMapLibreTerrainLod(source, version) {
    if (version !== '6.13.0' || source.split(BEFORE).length !== 2 || source.includes(AFTER)) {
        throw new Error('MapLibre terrain LOD patch no longer matches. Review or remove the 6.13.0 workaround before building.');
    }
    return '// Better Peakbagger: align terrain RTT and DEM LOD; see scripts/maplibre-terrain-lod-patch.mjs.\n'
        + source.replace(BEFORE, AFTER);
}
