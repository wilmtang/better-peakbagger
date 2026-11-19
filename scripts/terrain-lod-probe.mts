// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface LodProbeTileId {
    overscaledZ: number;
    wrap: number;
    canonical: { z: number; x: number; y: number };
}

export interface LodProbeTile {
    tileID: LodProbeTileId;
}

export interface LodProbeSourceTile {
    dem?: unknown;
    tileID: { overscaledZ: number };
}

export interface LodProbeGl {
    readonly COLOR_BUFFER_BIT: number;
    readonly RGBA: number;
    readonly UNSIGNED_BYTE: number;
    clearColor(red: number, green: number, blue: number, alpha: number): void;
    clear(mask: number): void;
    readPixels(
        x: number,
        y: number,
        width: number,
        height: number,
        format: number,
        type: number,
        pixels: Uint8Array,
    ): void;
}

export interface LodProbeCanvas {
    width: number;
    height: number;
    getContext(contextId: 'webgl2'): LodProbeGl | null;
}

export interface LodDrapeTileManager {
    getRenderableIds(): Iterable<string | number>;
    getTileByID(id: string | number): { tileID: { overscaledZ: number } } | undefined;
    getSource(): { tileSize: number };
}

export interface LodProbeCustomLayer {
    id: string;
    type: 'custom';
    terrainTileRevision: number;
    render(): void;
    renderToTerrainTile(gl: LodProbeGl, options: { tileID: LodProbeTileId }): void;
}

export interface LodProbeMap {
    terrain: {
        qualityFactor?: number;
        tileManager: {
            tileSize: number;
            deltaZoom: number;
            tileManager?: { _outOfViewCache?: { max?: number } };
            getSource(): { minzoom: number; maxzoom: number };
            getRenderableTiles(): LodProbeTile[];
            getSourceTile(tileID: LodProbeTileId, waitForPending?: boolean): LodProbeSourceTile | null | undefined;
        };
    };
    style: {
        tileManagers: {
            basemap?: LodDrapeTileManager;
        };
    };
    __bpbRenders?: number;
    on(type: 'sourcedata', handler: (event: { sourceId?: string }) => void): void;
    on(type: 'render', handler: () => void): void;
    addLayer(layer: LodProbeCustomLayer): void;
    getCanvas(): LodProbeCanvas;
    triggerRepaint(): void;
    getPitch(): number;
    getBearing(): number;
    getZoom(): number;
    loaded(): boolean;
    areTilesLoaded(): boolean;
    isMoving(): boolean;
    isZooming(): boolean;
    isRotating(): boolean;
}

export interface LodDrapeSample {
    levels: Record<number, number>;
    tileSize: number;
    targetPixels: number;
    ceilingFinest: number | null;
    ceilingCoarsest: number | null;
}

export interface LodProbeSample {
    ready: boolean;
    reason: string;
    surface?: number;
    sky?: number;
    levels?: Record<string, number>;
    shortfalls?: Record<string, number>;
    tiles?: Record<string, number>;
    drape?: LodDrapeSample | null;
    pitch?: number;
    bearing?: number;
    zoom?: number;
    rttTiles?: number;
    retainedTileCeiling?: number | null;
    renders?: number;
    idle?: boolean;
    framebuffer?: { width: number; height: number };
}

// Serialized into the fixture page. MapLibre 6 removed its private coords
// framebuffer. Its custom terrain hook can instead paint DEM provenance onto
// the actual mesh, including occlusion, and read the resulting screen pixels.
// This diagnostic replaces the drape's appearance; it measures elevation LOD,
// not imagery quality, frame rate, or native onscreen behavior.
export function installTerrainLodProbe(map: LodProbeMap): () => LodProbeSample {
    let pixels: Uint8Array | undefined;
    let sample: LodProbeSample | undefined;
    const manager = map.terrain.tileManager;
    const entryFor = (tile: LodProbeTile) => {
        const source = manager.getSource();
        const desired = Math.max(source.minzoom,
            Math.min(source.maxzoom, tile.tileID.overscaledZ - manager.deltaZoom));
        const dem = manager.getSourceTile(tile.tileID, true);
        return { desired, actual: dem?.dem ? dem.tileID.overscaledZ : null };
    };
    const layer: LodProbeCustomLayer = {
        id: 'bpb-lod-provenance', type: 'custom', terrainTileRevision: 0,
        render() {},
        renderToTerrainTile(gl, { tileID }) {
            const tile = manager.getRenderableTiles().find(candidate =>
                candidate.tileID.wrap === tileID.wrap
                && (['z', 'x', 'y'] as const).every(key => candidate.tileID.canonical[key] === tileID.canonical[key]));
            if (!tile) throw new Error('LOD probe cannot resolve the rendered terrain tile.');
            const { desired, actual } = entryFor(tile);
            gl.clearColor((desired + 1) * 8 / 255, actual === null ? 0 : (actual + 1) * 8 / 255, 200 / 255, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
        },
    };
    map.on('sourcedata', event => { if (event.sourceId === 'terrain') layer.terrainTileRevision++; });
    map.addLayer(layer);
    map.on('render', () => {
        const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!;
        const width = canvas.width, height = canvas.height;
        if (!pixels || pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const levels: Record<string, number> = {};
        const shortfalls: Record<string, number> = {};
        const tiles: Record<string, number> = {};
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
        let drape: LodDrapeSample | null = null;
        if (drapeManager) {
            const drapeLevels: Record<number, number> = {};
            for (const id of drapeManager.getRenderableIds()) {
                const tile = drapeManager.getTileByID(id);
                if (tile) {
                    const level = tile.tileID.overscaledZ;
                    drapeLevels[level] = (drapeLevels[level] || 0) + 1;
                }
            }
            const tileSize = drapeManager.getSource().tileSize;
            const targetPixels = manager.tileSize * map.terrain.qualityFactor!;
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
            retainedTileCeiling: manager.tileManager?._outOfViewCache?.max ?? null,
            renders: map.__bpbRenders || 0,
            idle: !map.isMoving() && !map.isZooming() && !map.isRotating()
                && map.loaded() && map.areTilesLoaded(),
            framebuffer: { width, height },
        };
    });
    map.triggerRepaint();
    return () => sample || { ready: false, reason: 'provenance frame has not painted' };
}
