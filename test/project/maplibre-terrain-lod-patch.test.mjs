// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { patchMapLibreTerrainLod } from '../../scripts/maplibre-terrain-lod-patch.mjs';

const original = await readFile(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl.mjs', import.meta.url), 'utf8');
const { version } = JSON.parse(await readFile(new URL('../../node_modules/maplibre-gl/package.json', import.meta.url), 'utf8'));

// Execute the real distributed terrain update with an empty covering set. This
// exercises the omitted argument, without loading WebGL or mirroring its logic.
const coveringOptions = source => {
    const anchor = source.indexOf('maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t');
    assert.ok(anchor > 0);
    const start = source.lastIndexOf('update(e,t){', anchor);
    const end = source.indexOf('}releaseRTT(', anchor) + 1;
    assert.ok(start > 0 && end > start);
    let options;
    const context = vm.createContext({ xE: (_transform, value) => { options = value; return []; } });
    const update = vm.runInContext(`(class { ${source.slice(start, end)} }).prototype.update`, context);
    const calculateTileZoom = () => 12;
    update.call({ tileManager: { update() {}, _source: { calculateTileZoom } },
        _tiles: {}, tileSize: 1024, minzoom: 0, maxzoom: 22 }, {}, {});
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

test('the LOD workaround refuses changed, ambiguous, upgraded or already patched input', () => {
    for (const [source, candidateVersion] of [
        [original, '6.14.0'], ['', version], [original + original, version],
        [patchMapLibreTerrainLod(original, version), version],
    ]) assert.throws(() => patchMapLibreTerrainLod(source, candidateVersion), /Review or remove/);
});
