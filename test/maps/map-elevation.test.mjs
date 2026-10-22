// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElevationClient, elevationTile, sampleElevation } from '../../src/maps/map-elevation.js';

const pixelsAt = meters => {
    const pixels = new Uint8ClampedArray(512 * 512 * 4), value = meters + 32768;
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = Math.floor(value / 256); pixels[i + 1] = Math.floor(value % 256);
        pixels[i + 2] = Math.round(value % 1 * 256); pixels[i + 3] = 255;
    }
    return pixels;
};
const webp = () => {
    const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
    for (const [offset, text] of [[0, 'RIFF'], [8, 'WEBP'], [12, 'VP8L']]) [...text].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
    view.setUint32(4, 16, true); view.setUint32(16, 4, true);
    return new Response(bytes, { headers: { 'content-type': 'image/webp' } });
};
const point = { latitude: 46.8, longitude: -121.7 };
const client = options => createElevationClient({ document: {}, decode: async () => pixelsAt(1957.5), ...options });

test('slippy tile coordinates wrap the antimeridian and reject polar or invalid data', () => {
    assert.deepEqual(elevationTile(0, 0, 14), { z: 14, x: 8192, y: 8192, pixelX: 0, pixelY: 0 });
    assert.deepEqual(elevationTile(0, 180, 14), elevationTile(0, -180, 14));
    assert.equal(elevationTile(86, 0, 14), null); assert.equal(elevationTile(NaN, 0, 14), null);
    assert.equal(elevationTile(0, 181, 14), null); assert.equal(elevationTile(0, 0, 19), null);
    const south = elevationTile(-85.0511287798066, 179.99, 14);
    assert.ok(south.y < 16384 && south.pixelY < 512);
});

test('Terrarium heights retain fractions, negative ground and genuine sea level; nodata never becomes zero', () => {
    for (const value of [-430.25, 0, 1957.5, 8848.75]) assert.equal(sampleElevation(pixelsAt(value), 200, 350), value);
    assert.equal(sampleElevation(new Uint8ClampedArray(512 * 512 * 4), 0, 0), null);
    assert.equal(sampleElevation(new Uint8ClampedArray(4), 0, 0), null);
    const invalid = pixelsAt(0); invalid.fill(255); assert.equal(sampleElevation(invalid, 0, 0), null);
});

test('one fixed level falls back only on 404, with bounded tab-memory reuse and credential-free requests', async () => {
    const calls = [], lookup = client({ fetchImpl: async (url, init) => {
        calls.push({ url, init }); return url.includes('/14/') ? new Response('', { status: 404 }) : webp();
    } });
    assert.equal(await lookup.lookup(point), 1957.5); assert.equal(calls.length, 2);
    assert.match(calls[0].url, /^https:\/\/tiles\.mapterhorn\.com\/14\/\d+\/\d+\.webp$/);
    assert.match(calls[1].url, /\/13\//);
    assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
    assert.equal(await lookup.lookup(point), 1957.5); assert.equal(calls.length, 2);
    lookup.clear(); await lookup.lookup(point); assert.equal(calls.length, 4);
});

test('missing coverage has a five-request ceiling, while service errors and corrupt tiles do not fall back', async () => {
    let count = 0;
    const missing = client({ fetchImpl: async () => { count++; return new Response('', { status: 404 }); } });
    assert.equal(await missing.lookup(point), null); assert.equal(count, 5);
    for (const response of [() => new Response('', { status: 503 }), () => new Response('not a tile', { headers: { 'content-type': 'image/webp' } }),
        () => new Response(new Uint8Array(2 ** 20 + 1), { headers: { 'content-type': 'image/webp', 'content-length': String(2 ** 20 + 1) } })]) {
        count = 0;
        await assert.rejects(client({ fetchImpl: async () => { count++; return response(); } }).lookup(point));
        assert.equal(count, 1);
    }
});

test('known limits gate retries until Retry-After without retaining the clicked coordinate', async () => {
    let count = 0, now = 1000;
    const lookup = client({ now: () => now, fetchImpl: async () => ++count === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : webp() });
    await assert.rejects(lookup.lookup(point), error => error.code === 'rate-limit');
    await assert.rejects(lookup.lookup(point), error => error.code === 'rate-limit'); assert.equal(count, 1);
    now += 121000; assert.equal(await lookup.lookup(point), 1957.5); assert.equal(count, 2);
});

test('deadlines cover stalled bodies and cancellation reaches the actual transport', async () => {
    let signal;
    const stalled = client({ timeoutMs: 20, fetchImpl: async (_, init) => {
        signal = init.signal;
        return new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'image/webp' } });
    } });
    await assert.rejects(stalled.lookup(point), error => error.name === 'TimeoutError'); assert.equal(signal.aborted, true);
    const controller = new AbortController();
    const aborted = client({ fetchImpl: async (_, init) => new Promise((_, reject) => {
        signal = init.signal;
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
        controller.abort();
    }) });
    await assert.rejects(aborted.lookup(point, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(signal.aborted, true);
});

test('decoded tiles have a four-tile bound and rejected or aborted decodes are never cached', async () => {
    let calls = 0;
    const lookup = client({ fetchImpl: async () => { calls++; return webp(); } });
    for (const longitude of [0, 1, 2, 3, 4, 0]) await lookup.lookup({ latitude: 0, longitude });
    assert.equal(calls, 6);
    const controller = new AbortController(); let decodeCount = 0;
    const interrupted = client({ fetchImpl: async () => webp(), decode: async () => {
        decodeCount++; if (decodeCount === 1) controller.abort(); return pixelsAt(0);
    } });
    await assert.rejects(interrupted.lookup(point, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(await interrupted.lookup(point), 0); assert.equal(decodeCount, 2);
});
