// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayTiles } from '../../src/maps/map-overlay-tiles.js';
const document = { createElement: () => ({ width: 256, height: 256, getContext: () => ({ clearRect() {}, drawImage() {} }) }) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const mockBitmap = t => {
    const previous = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
};

test('buffered tiles outside overlay coverage stay clear without contacting a provider', async () => {
    let requests = 0;
    const tiles = createOverlayTiles({ document, fetchImpl: async () => { requests++; throw new Error('Out-of-region request'); } });
    tiles.setScenes([{ id: 'polar_scene', bounds: [-180, -90, 180, 90] }]);
    const tile = (lon, lat) => ({ z: 12, x: Math.floor((lon + 180) / 360 * 4096), y: Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 4096) });
    try {
        for (const id of ['slope', 'land']) await tiles.draw(id, tile(7.65, 45.98), tiles.canvas());
        await tiles.draw('sentinel', tile(-86, -78), tiles.canvas());
        assert.equal(requests, 0);
    } finally { tiles.dispose(); }
});

test('tile ownership bounds concurrency to four and off aborts queued and active work', async () => {
    const held = [], failures = [];
    const tiles = createOverlayTiles({ document, fetchImpl: (url, options) => new Promise(resolve => held.push({ url, options, resolve })), onError: (...args) => failures.push(args) });
    const results = Array.from({ length: 10 }, (_, x) => tiles.draw('slope', { z: 10, x, y: 100 }, tiles.canvas()).then(() => 'unexpected', error => error.name));
    await tick(); assert.equal(held.length, 4);
    tiles.cancel('slope'); assert.ok(held.every(request => request.options.signal.aborted));
    for (const request of held) request.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
    assert.deepEqual(await Promise.all(results), Array(10).fill('AbortError'));
    assert.equal(failures.length, 0); assert.equal(held.length, 4, 'cancelled queue cannot start another request'); tiles.dispose();
});
test('tile transport rejects over-budget responses before decoding and surfaces the provider error', async () => {
    const failures = [], tiles = createOverlayTiles({ document, fetchImpl: async () => new Response('', { headers: { 'content-type': 'image/png', 'content-length': String(5 * 1024 * 1024) } }),
        onError: (id, error) => failures.push([id, error.message]) });
    await assert.rejects(tiles.draw('land', { z: 10, x: 163, y: 359 }, tiles.canvas()), /too large/);
    assert.deepEqual(failures, [['land', 'Map tile too large.']]); tiles.dispose();
});
test('a provider cooldown blocks new tile work until an explicit allowed retry', async () => {
    let requests = 0;
    const tiles = createOverlayTiles({ document, fetchImpl: async () => { requests++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); } });
    const draw = () => tiles.draw('land', { z: 10, x: 163, y: 359 }, tiles.canvas());
    await assert.rejects(draw(), error => error.code === 'rate-limit');
    assert.equal(tiles.retry('land'), false, 'a renderer command cannot bypass the provider deadline');
    await assert.rejects(draw(), error => error.code === 'rate-limit'); assert.equal(requests, 1);
    tiles.dispose();
});
test('incomplete Alberta pages never publish a partially colored tile', async () => {
    let filled = 0, published = 0;
    const canvasDocument = { createElement: () => ({ getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { filled++; } }) }) };
    const tiles = createOverlayTiles({ document: canvasDocument, fetchImpl: async () => new Response(JSON.stringify({ spatialReference: { wkid: 3857 }, exceededTransferLimit: true,
        features: [{ attributes: { objectid: 1, crownclass: 'Provincial' }, geometry: { rings: [[[0,0],[1,0],[1,1],[0,0]]] } }],
    })) });
    const z = 12, longitude = -115.57, latitude = 51.18;
    const coordinates = { z, x: Math.floor((longitude + 180) / 360 * 2 ** z), y: Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** z) };
    const output = { getContext: () => ({ clearRect() { published++; }, drawImage() { published++; } }) };
    await assert.rejects(tiles.draw('land', coordinates, output), /Incomplete Alberta/);
    assert.equal(filled, 1, 'a working polygon was drawn before the incomplete page was detected');
    assert.equal(published, 0, 'the visible canvas retains its prior content'); tiles.dispose();
});
test('tile activity reports pending through the body, then clears failures only after a successful retry', async t => {
    mockBitmap(t);
    const states = [], held = [];
    const tiles = createOverlayTiles({ document, onActivity: (id, state) => states.push({ id, ...state }),
        fetchImpl: () => new Promise(resolve => held.push(resolve)) });
    const draw = () => tiles.draw('land', { z: 10, x: 163, y: 359 }, tiles.canvas());
    const first = draw(); await tick(); assert.equal(states.at(-1).pending, true);
    held.shift()(new Response('', { status: 404 })); await assert.rejects(first);
    assert.equal(states.at(-1).pending, false); assert.equal(states.at(-1).error, true);
    assert.equal(tiles.retry('land'), true);
    const next = draw(); await tick(); assert.equal(states.at(-1).pending, true); assert.equal(states.at(-1).error, false);
    let body;
    held.shift()(new Response(new ReadableStream({ start(controller) { body = controller; } }), { headers: { 'content-type': 'image/png' } }));
    await tick(); assert.equal(states.at(-1).pending, true, 'HTTP headers alone do not mean the tile is loaded');
    body.enqueue(new Uint8Array([1])); body.close(); await next;
    assert.deepEqual(states.at(-1), { id: 'land', pending: false, error: false, partial: false, complete: true, permission: false, retryAt: 0, providerCooldowns: {} }); tiles.dispose();
});
test('cancelled tile completions cannot clear a newer loading batch', async t => {
    mockBitmap(t);
    const states = [], held = [];
    const tiles = createOverlayTiles({ document, onActivity: (_id, state) => states.push(state), fetchImpl: () => new Promise(resolve => held.push(resolve)) });
    const draw = () => tiles.draw('slope', { z: 10, x: 163, y: 359 }, tiles.canvas());
    const stale = draw().catch(error => error.name); await tick(); tiles.retry('slope');
    const current = draw(); await tick();
    const image = () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    held[0](image()); assert.equal(await stale, 'AbortError'); assert.equal(states.at(-1).pending, true);
    held[1](image()); await current; assert.equal(states.at(-1).complete, true); tiles.dispose();
});

for (const id of ['slope', 'land', 'sentinel']) test(`a temporary ${id} failure recovers once without showing a terminal layer error`, async t => {
    mockBitmap(t);
    let calls = 0; const errors = [], states = [];
    const tiles = createOverlayTiles({ document, retryDelayMs: 0, onError: (_id, error) => errors.push(error), onActivity: (_id, state) => states.push(state),
        fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }) });
    if (id === 'sentinel') tiles.setScenes([{ id: 'scene_new', bounds: [-122, 46, -121, 47] }]);
    try {
        await tiles.draw(id, { z: 14, x: 2666, y: 5796 }, tiles.canvas());
        assert.equal(calls, 2); assert.equal(errors.length, 0);
        assert.equal(states.at(-1).error, false); assert.equal(states.at(-1).complete, true);
    } finally { tiles.dispose(); }
});

test('a BC permission or service failure cannot erase validated US coverage in the same land tile', async t => {
    mockBitmap(t);
    for (const failure of [Object.assign(new Error('Allow BC'), { code: 'bc-permission-required' }), Object.assign(new Error('BC limited'), { code: 'rate-limit', retryAt: Date.now() + 120000 })]) {
        const states = []; let usCalls = 0, bcCalls = 0;
        const tiles = createOverlayTiles({ document, onActivity: (_id, state) => states.push(state),
            fetchImpl: async () => { usCalls++; return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }); },
            fetchBCTile: async () => { bcCalls++; throw failure; } });
        try {
            const coordinates = { z: 10, x: 164, y: 351 };
            await tiles.draw('land', coordinates, tiles.canvas());
            assert.equal(states.at(-1).partial, true); assert.equal(states.at(-1).error, true);
            assert.equal(states.at(-1).permission, failure.code === 'bc-permission-required');
            assert.equal(tiles.failed('land', coordinates), true);
            assert.equal(usCalls, 1); assert.equal(bcCalls, 1);
            if (failure.code === 'rate-limit') {
                await tiles.draw('land', { ...coordinates, x: 163 }, tiles.canvas());
                assert.equal(bcCalls, 1, 'BC cooldown does not replay provider requests');
                assert.equal(usCalls, 2, 'the same cooldown does not block valid US coverage');
                assert.equal(states.at(-1).providerCooldowns.bc, failure.retryAt);
            }
        } finally { tiles.dispose(); }
    }
});

test('slope feedback describes partial coverage and retires unloaded failures', async t => {
    mockBitmap(t);
    const states = []; let fail = true, calls = 0;
    const tiles = createOverlayTiles({ document, retryDelayMs: 0, onActivity: (_id, state) => states.push(state), fetchImpl: async () => {
        calls++; return fail ? new Response('', { status: 503 }) : new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    } });
    const missing = { z: 14, x: 2666, y: 5796 }, loaded = { ...missing, x: 2667 };
    try {
        await assert.rejects(tiles.draw('slope', missing, tiles.canvas())); assert.equal(calls, 2, 'automatic recovery is bounded');
        fail = false; await tiles.draw('slope', loaded, tiles.canvas());
        assert.equal(states.at(-1).error, true, 'a real missing tile remains reported');
        assert.equal(states.at(-1).partial, true, 'available shading is distinct from a failed layer');
        tiles.forget('slope', missing);
        assert.equal(states.at(-1).error, false, 'an unloaded tile cannot leave a permanent warning');
        assert.equal(states.at(-1).complete, true);
    } finally { tiles.dispose(); }
});

test('permanent slope errors and rate limits are not automatically retried', async () => {
    for (const status of [400, 404, 429]) {
        let calls = 0;
        const tiles = createOverlayTiles({ document, retryDelayMs: 0, fetchImpl: async () => { calls++; return new Response('', { status }); } });
        try { await assert.rejects(tiles.draw('slope', { z: 14, x: 2666, y: 5796 }, tiles.canvas())); assert.equal(calls, 1); }
        finally { tiles.dispose(); }
    }
});

test('turning slope off during recovery cancels its delay and starts no replacement request', async () => {
    let calls = 0, failed;
    const reachedFailure = new Promise(resolve => { failed = resolve; });
    const tiles = createOverlayTiles({ document, retryDelayMs: 60000, fetchImpl: async () => { calls++; failed(); return new Response('', { status: 503 }); } });
    const drawing = tiles.draw('slope', { z: 14, x: 2666, y: 5796 }, tiles.canvas());
    await reachedFailure; await tick(); tiles.cancel('slope');
    await assert.rejects(drawing, { name: 'AbortError' }); assert.equal(calls, 1); tiles.dispose();
});

test('a late offscreen slope failure cannot poison the new view', async t => {
    mockBitmap(t);
    const held = [], states = [], errors = [];
    const tiles = createOverlayTiles({ document, onActivity: (_id, state) => states.push(state), onError: (_id, error) => errors.push(error),
        fetchImpl: () => new Promise(resolve => held.push(resolve)) });
    const stale = { z: 14, x: 2666, y: 5796 }, current = { ...stale, x: 2670 };
    try {
        const first = tiles.draw('slope', stale, tiles.canvas()).catch(error => error.status); await tick();
        const next = tiles.draw('slope', current, tiles.canvas()); await tick();
        tiles.retain('slope', [current]);
        held[1](new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })); await next;
        held[0](new Response('', { status: 404 })); assert.equal(await first, 404);
        assert.equal(states.at(-1).error, false); assert.equal(errors.length, 0);
    } finally { tiles.dispose(); }
});
