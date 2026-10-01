// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { installTerrainLifecycleProbe, readTerrainReadiness } from '../../scripts/terrain-readiness-diagnostics.mjs';

const pendingDrapeProbe = async ({ intercept = true } = {}) => {
    const source = await readFile(new URL('../../scripts/verify-terrain-visual.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('// Regression: a configured raster drape');
    const end = source.indexOf('// The pending-drape probe is the only reason', start);
    assert.ok(start >= 0 && end > start, 'the pending-drape probe boundaries are missing');
    const calls = [];
    const context = {
        baseUrl: 'https://www.peakbagger.com:1234/climber/ascent.aspx',
        basemapRequests: [], // Network delivery can lag Fetch interception.
        pendingBasemapRequestIds: [],
        holdBasemapRequests: false,
        navigate: async () => { calls.push('navigate'); },
        openTerrainWithTrustedClick: async () => {
            calls.push('open');
            if (intercept) context.pendingBasemapRequestIds.push('paused-raster');
        },
        waitForCondition: async (predicate, describe) => {
            if (!await predicate()) throw new Error(await describe());
        },
        waitForPageState: async () => { calls.push('active terrain'); },
        cdp: { call: async (method, args) => { calls.push([method, args.requestId]); } },
    };
    await vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, context);
    return { context, calls };
};

test('pending-drape verification accepts Fetch interception before Network delivery', async () => {
    const { context, calls } = await pendingDrapeProbe();
    assert.deepEqual(calls, ['navigate', 'open', 'active terrain', ['Fetch.continueRequest', 'paused-raster']]);
    assert.equal(context.basemapRequests.length, 0);
    assert.equal(context.pendingBasemapRequestIds.length, 0);
    assert.equal(context.holdBasemapRequests, false);
});

test('pending-drape verification fails when no raster was intercepted', async () => {
    await assert.rejects(pendingDrapeProbe({ intercept: false }), /did not intercept a raster request/);
});

test('lifecycle diagnostics retain bounded reasons without capturing terrain payloads', () => {
    let receive;
    const context = vm.createContext({
        performance: { now: () => 123 },
        addEventListener: (_type, listener) => { receive = listener; },
    });
    vm.runInContext(`(${installTerrainLifecycleProbe.toString()})()`, context);
    receive({ data: { __bpbTerrain: true, type: 'view' } });
    assert.equal(context.__bpbTerrainLifecycle.length, 0);
    for (let index = 0; index < 45; index++) {
        receive({ data: { __bpbTerrainFrame: true, type: 'error', reason: 'timeout', route: 'excluded' } });
    }
    assert.equal(context.__bpbTerrainLifecycle.length, 40);
    assert.equal(context.__bpbTerrainLifecycle[0].reason, 'timeout');
    assert.equal(context.__bpbTerrainLifecycle[0].route, undefined);
});

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
