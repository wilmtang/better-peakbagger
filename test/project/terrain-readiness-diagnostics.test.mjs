// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readTerrainReadiness } from '../../scripts/terrain-readiness-diagnostics.mjs';

const probe = elements => JSON.parse(JSON.stringify(vm.runInNewContext(
    `(${readTerrainReadiness.toString()})()`, {
        document: { URL: 'https://www.peakbagger.com/climber/ascent.aspx',
            visibilityState: 'visible', getElementById: id => elements[id] },
    },
)));

test('timeout evidence survives a missing or inaccessible terrain frame', () => {
    assert.equal(probe({}).map, null);
    const result = probe({
        'bpb-terrain-toggle': { textContent: '3D', title: 'Could not load terrain', disabled: false },
        'bpb-terrain-frame': { style: { opacity: '0' },
            get contentDocument() { throw new Error('frame detached'); } },
    });
    assert.equal(result.toggle.title, 'Could not load terrain');
    assert.match(result.probeError, /frame detached/);
});

test('timeout evidence distinguishes loaded layers from pending tiles and lost GPU context', () => {
    const gl = { RENDERER: 1, getExtension: () => null,
        getParameter: () => 'test hardware', isContextLost: () => true };
    const result = probe({ 'bpb-terrain-frame': {
        style: { opacity: '0' },
        contentDocument: { readyState: 'complete', getElementById: () => ({ dataset: { theme: 'dark' } }) },
        contentWindow: { __bpbTerrainTestMap: {
            getCanvas: () => ({ width: 448, height: 448, getContext: () => gl }),
            loaded: () => false, isStyleLoaded: () => true, isMoving: () => false,
            areTilesLoaded: () => false, getZoom: () => 12,
            getLayer: id => id === 'bpb-route',
            getStyle: () => ({ sources: { terrain: {}, basemap: {} } }),
            isSourceLoaded: id => id === 'terrain',
        } },
    } });
    assert.equal(result.surface.renderer, 'test hardware');
    assert.equal(result.surface.contextLost, true);
    assert.equal(result.surface.theme, 'dark');
    assert.deepEqual(result.map.sources, { terrain: true, basemap: false });
    assert.deepEqual(result.map.layers, ['bpb-route']);
    assert.equal(result.map.loaded, false);
});
