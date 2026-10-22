// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { installTerrainLodProbe } from '../../scripts/terrain-lod-probe.mjs';

test('the LOD probe counts painted DEM provenance, missing data, and tile deficits separately', () => {
    const handlers = {}, colors = [], pixels = new Uint8Array(8 * 8 * 4);
    for (const [index, color] of [[0, [104, 104, 200, 255]], [16, [104, 80, 200, 255]], [128, [104, 0, 200, 255]]]) pixels.set(color, index);
    const tiles = [0, 1].map(x => ({ tileID: { overscaledZ: 13, wrap: 0, canonical: { z: 13, x, y: 1 } } }));
    const gl = { COLOR_BUFFER_BIT: 1, RGBA: 2, UNSIGNED_BYTE: 3,
        clearColor: (...color) => colors.push(color), clear() {},
        readPixels: (_x, _y, _w, _h, _format, _type, output) => output.set(pixels) };
    const map = {
        terrain: { tileManager: { tileSize: 1024, deltaZoom: 1,
            tileManager: { _outOfViewCache: { max: 96 } },
            getSource: () => ({ minzoom: 0, maxzoom: 18 }), getRenderableTiles: () => tiles,
            getSourceTile: id => ({ dem: {}, tileID: { overscaledZ: id.canonical.x ? 9 : 12 } }) } },
        style: { tileManagers: {} }, __bpbRenders: 1,
        on: (type, handler) => { handlers[type] = handler; }, addLayer: layer => { map.layer = layer; },
        getCanvas: () => ({ width: 8, height: 8, getContext: () => gl }), triggerRepaint() {},
        getPitch: () => 60, getBearing: () => 0, getZoom: () => 14,
        loaded: () => true, areTilesLoaded: () => true,
        isMoving: () => false, isZooming: () => false, isRotating: () => false,
    };
    const read = installTerrainLodProbe(map);
    assert.equal(read().ready, false, 'an unpainted view is never reported settled');
    handlers.render();
    assert.deepEqual(read().shortfalls, { 0: 1, 3: 1, none: 1 });
    assert.deepEqual(read().tiles, { 0: 1, 3: 1 });
    assert.equal(read().surface, 3); assert.equal(read().sky, 1);
    map.layer.renderToTerrainTile(gl, { tileID: tiles[1].tileID });
    assert.deepEqual(colors.at(-1), [104 / 255, 80 / 255, 200 / 255, 1]);
    handlers.sourcedata({ sourceId: 'terrain' }); assert.equal(map.layer.terrainTileRevision, 1);
    map.isMoving = () => true; handlers.render(); assert.equal(read().idle, false);
});

test('LOD verification rejects unknown selections before launching a browser', () => {
    for (const [args, env, message] of [[['unknown'], {}, /Usage:/],
        [[], { BPB_LOD_DRAPE: 'unknown' }, /Unknown LOD drape/]]) {
        const result = spawnSync(process.execPath, ['scripts/verify-terrain-lod.mjs', ...args], {
            encoding: 'utf8', env: { ...process.env, ...env },
        });
        assert.notEqual(result.status, 0); assert.match(result.stderr, message);
    }
});
