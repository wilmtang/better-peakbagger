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

// Exercise the actual driver probe with a frame whose hit-test surface becomes
// ready after its initial DOM appears. A wheel sent to the old surface is lost.
test('scroll verification targets a settled canvas and accepts a quantized label when the scale width changes', async () => {
    const source = await readFile(new URL('../../scripts/verify-terrain-visual.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('const assertPlainScrollZooms =');
    const end = source.indexOf('\nconst navigate =', start);
    assert.ok(start >= 0 && end > start);
    const state = { loaded: false, pointerReady: false, zoom: 14, scale: '500 m', scaleWidth: 60 };
    const inputs = [];
    let gesture = { zoom: true, scale: true };
    const rect = { left: 0, top: 0, width: 1000, height: 760, toJSON: () => ({ width: 1000, height: 760 }) };
    const canvas = { getBoundingClientRect: () => rect };
    const scale = { get textContent() { return state.scale; },
        getBoundingClientRect: () => ({ width: state.scaleWidth }) };
    const map = { loaded: () => state.loaded, isMoving: () => false,
        getZoom: () => state.zoom, getCanvas: () => canvas };
    const frame = { getBoundingClientRect: () => rect, contentWindow: { __bpbTerrainTestMap: map },
        contentDocument: { querySelector: selector => selector === '.maplibregl-ctrl-scale' ? scale : null,
            elementFromPoint: () => state.loaded ? canvas : null } };
    const context = vm.createContext({
        document: { getElementById: () => frame, elementFromPoint: () => state.loaded ? frame : null },
        cdp: { call: async method => {
            assert.equal(method, 'Input.dispatchMouseEvent');
            inputs.push('wheel');
            if (state.loaded && state.pointerReady) {
                if (gesture.zoom) state.zoom++;
                if (gesture.scale) state.scaleWidth = 95;
            }
        } },
        moveTo: async () => { assert.equal(state.loaded, true); inputs.push('move'); state.pointerReady = true; },
        delay: async () => {},
    });
    context.evaluate = async (_cdp, expression) => vm.runInContext(expression, context);
    context.waitForPageState = async (_cdp, expression) => {
        for (let attempt = 0; attempt < 4; attempt++) {
            state.loaded = attempt > 0;
            const result = vm.runInContext(expression, context);
            if (result.ready) return result;
        }
        throw new Error('wheel did not zoom the current canvas');
    };
    await vm.runInContext(`(async () => { ${source.slice(start, end)} await assertPlainScrollZooms(cdp, 'test map'); })()`, context);
    assert.deepEqual(inputs, ['move', 'wheel', 'wheel', 'wheel', 'wheel']);
    assert.equal(state.scale, '500 m', 'the human-readable distance remains in the same quantized bucket');
    assert.equal(state.scaleWidth, 95);
    for (gesture of [{ zoom: false, scale: false }, { zoom: true, scale: false }, { zoom: false, scale: true }]) {
        Object.assign(state, { loaded: false, pointerReady: false, zoom: 14, scaleWidth: 60 });
        await assert.rejects(vm.runInContext(`(async () => { ${source.slice(start, end)} await assertPlainScrollZooms(cdp, 'test map'); })()`, context),
            /plain scroll did not settle/);
    }
});
