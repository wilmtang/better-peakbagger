// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Serialized into the fixture page. MapLibre 6 removed its private coords
// framebuffer. Its custom terrain hook can instead paint DEM provenance onto
// the actual mesh, including occlusion, and read the resulting screen pixels.
// This diagnostic replaces the drape's appearance; it measures elevation LOD,
// not imagery quality, frame rate, or native onscreen behavior.
export function installTerrainLodProbe(map) {
    let pixels, sample;
    const manager = map.terrain.tileManager;
    const entryFor = tile => {
        const source = manager.getSource();
        const desired = Math.max(source.minzoom,
            Math.min(source.maxzoom, tile.tileID.overscaledZ - manager.deltaZoom));
        const dem = manager.getSourceTile(tile.tileID, true);
        return { desired, actual: dem?.dem ? dem.tileID.overscaledZ : null };
    };
    const layer = {
        id: 'bpb-lod-provenance', type: 'custom', terrainTileRevision: 0,
        render() {},
        renderToTerrainTile(gl, { tileID }) {
            const tile = manager.getRenderableTiles().find(candidate =>
                candidate.tileID.wrap === tileID.wrap
                && ['z', 'x', 'y'].every(key => candidate.tileID.canonical[key] === tileID.canonical[key]));
            if (!tile) throw new Error('LOD probe cannot resolve the rendered terrain tile.');
            const { desired, actual } = entryFor(tile);
            gl.clearColor((desired + 1) * 8 / 255, actual === null ? 0 : (actual + 1) * 8 / 255, 200 / 255, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
        },
    };
    map.on('sourcedata', event => { if (event.sourceId === 'terrain') layer.terrainTileRevision++; });
    map.addLayer(layer);
    map.on('render', () => {
        const canvas = map.getCanvas(), gl = canvas.getContext('webgl2');
        const width = canvas.width, height = canvas.height;
        if (!pixels || pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const levels = {}, shortfalls = {}, tiles = {};
        const entries = manager.getRenderableTiles().map(entryFor);
        for (const { desired, actual } of entries) {
            const gap = actual === null ? 'none' : String(desired - actual);
            tiles[gap] = (tiles[gap] || 0) + 1;
        }
        let surface = 0, sky = 0;
        for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
            const index = (y * width + x) * 4;
            // Blue identifies the diagnostic surface; sky and untouched pixels
            // carry no DEM provenance. Mipmap seams can interpolate the bytes.
            if (Math.abs(pixels[index + 2] - 200) > 2) { sky++; continue; }
            surface++;
            const desired = Math.round(pixels[index] / 8) - 1;
            const actual = pixels[index + 1] < 4 ? null : Math.round(pixels[index + 1] / 8) - 1;
            const level = actual === null ? 'none' : String(actual);
            const gap = actual === null ? 'none' : String(desired - actual);
            levels[level] = (levels[level] || 0) + 1;
            shortfalls[gap] = (shortfalls[gap] || 0) + 1;
        }
        const drapeManager = map.style.tileManagers.basemap;
        let drape = null;
        if (drapeManager) {
            const drapeLevels = {};
            for (const id of drapeManager.getRenderableIds()) {
                const tile = drapeManager.getTileByID(id);
                if (tile) {
                    const level = tile.tileID.overscaledZ;
                    drapeLevels[level] = (drapeLevels[level] || 0) + 1;
                }
            }
            const tileSize = drapeManager.getSource().tileSize;
            const targetPixels = manager.tileSize * map.terrain.qualityFactor;
            const headroom = Math.round(Math.log2(targetPixels / tileSize));
            const rttLevels = entries.map(entry => entry.desired + manager.deltaZoom);
            drape = { levels: drapeLevels, tileSize, targetPixels,
                ceilingFinest: rttLevels.length ? Math.max(...rttLevels) + headroom : null,
                ceilingCoarsest: rttLevels.length ? Math.min(...rttLevels) + headroom : null };
        }
        sample = {
            ready: surface > 0, reason: surface ? '' : 'no terrain provenance on screen',
            surface, sky, levels, shortfalls, tiles, drape,
            pitch: Math.round(map.getPitch() * 100) / 100,
            bearing: map.getBearing(),
            zoom: Math.round(map.getZoom() * 1000) / 1000,
            rttTiles: entries.length,
            retainedTileCeiling: manager.tileManager._outOfViewCache?.max ?? null,
            renders: map.__bpbRenders || 0,
            idle: !map.isMoving() && !map.isZooming() && !map.isRotating()
                && map.loaded() && map.areTilesLoaded(),
            framebuffer: { width, height },
        };
    });
    map.triggerRepaint();
    return () => sample || { ready: false, reason: 'provenance frame has not painted' };
}
