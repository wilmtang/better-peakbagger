// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { patchMapLibreTerrainLod } from '../../scripts/maplibre-terrain-lod-patch.mts';

const original = await readFile(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl.mjs', import.meta.url), 'utf8');
const { version } = JSON.parse(await readFile(new URL('../../node_modules/maplibre-gl/package.json', import.meta.url), 'utf8'));

// Execute the real distributed terrain update with an empty covering set. This
// exercises the omitted argument, without loading WebGL or mirroring its logic.
type CoveringOptions = { calculateTileZoom?: () => number };
const coveringOptions = (source: string) => {
    const anchor = source.indexOf('maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t');
    assert.ok(anchor > 0);
    const start = source.lastIndexOf('update(e,t){', anchor);
    const end = source.indexOf('}releaseRTT(', anchor) + 1;
    assert.ok(start > 0 && end > start);
    let options: CoveringOptions | undefined;
    // The minifier renames coveringTiles in each release; read it from the call.
    const callee = source.slice(start, anchor).match(/of (\w+)\(e,\{tileSize:this\.tileSize/)?.[1];
    assert.ok(callee, 'the terrain update no longer calls coveringTiles in the expected form');
    const context = vm.createContext({ [callee]: (_transform: unknown, value: CoveringOptions) => { options = value; return []; } });
    const update = vm.runInContext(`(class { ${source.slice(start, end)} }).prototype.update`, context);
    const calculateTileZoom = () => 12;
    update.call({ tileManager: { update() {}, _source: { calculateTileZoom } },
        _tiles: {}, tileSize: 1024, minzoom: 0, maxzoom: 22 }, {}, {});
    assert.ok(options);
    return { options, calculateTileZoom };
};

test('the distributed terrain grid uses the same LOD callback as its DEM downloads', async () => {
    assert.equal(coveringOptions(original).options.calculateTileZoom, undefined,
        'the pinned upstream regression is still present; reassess this patch when upstream fixes it');
    const shipped = await readFile(new URL('../../dist/vendor/maplibre-gl.mjs', import.meta.url), 'utf8');
    const { options, calculateTileZoom } = coveringOptions(shipped);
    assert.equal(options.calculateTileZoom, calculateTileZoom);
    assert.equal(shipped, patchMapLibreTerrainLod(original, version));
    for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
        assert.deepEqual(await readFile(new URL(`../../dist/vendor/${file}`, import.meta.url)),
            await readFile(new URL(`../../node_modules/maplibre-gl/dist/${file}`, import.meta.url)));
    }
});

test('the LOD workaround follows the compiled call rather than a version list', () => {
    for (const candidate of ['6.13.0', '6.15.0', '7.0.0']) {
        const { options, calculateTileZoom } = coveringOptions(patchMapLibreTerrainLod(original, candidate));
        assert.equal(options.calculateTileZoom, calculateTileZoom);
    }
});

test('the LOD workaround refuses changed, ambiguous, renamed or already patched input', () => {
    for (const source of [
        '', original + original, patchMapLibreTerrainLod(original, version),
        original.replaceAll('tileManager._source', 'tileManager._renamed'),
        original.replaceAll('this.tileManager=', 'this.manager='),
    ]) assert.throws(() => patchMapLibreTerrainLod(source, version), /Review or remove/);
});
