// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayTiles } from '../../src/maps/map-overlay-tiles.js';
const document = { createElement: () => ({ width: 256, height: 256, getContext: () => ({ clearRect() {}, drawImage() {} }) }) };
const tick = () => new Promise(resolve => setImmediate(resolve));

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
