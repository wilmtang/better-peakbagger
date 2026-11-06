// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// MapLibre 6.13 through 6.16's TerrainTileManager.update omits the source's LOD
// callback from coveringTiles, although TileManager.update uses it for DEM
// downloads. Keep both grids on the same detail ladder. The compiled shape is the
// review gate, not the version number: routine releases that keep this exact call
// pass, and the terrain test and GPU smokes exercise each one. A rewritten call, a
// renamed private field or an upstream fix fails closed so the workaround gets
// reassessed. A version allowlist added only a false failure to every update.
const BEFORE = 'maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t}';
const AFTER = 'maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t,calculateTileZoom:this.tileManager._source.calculateTileZoom}';
const REQUIRED_INTERNALS = ['this.tileManager=', 'tileManager._source'];

export function patchMapLibreTerrainLod(source: string, version: string): string {
    if (source.split(BEFORE).length !== 2 || source.includes(AFTER)
        || REQUIRED_INTERNALS.some(internal => !source.includes(internal))) {
        throw new Error(`MapLibre ${version} terrain LOD patch no longer matches. Review or remove the workaround before building.`);
    }
    return '// Better Peakbagger: align terrain RTT and DEM LOD; see scripts/maplibre-terrain-lod-patch.mts.\n'
        + source.replace(BEFORE, AFTER);
}
