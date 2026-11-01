// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorMapRequest, vectorRequestUrl } from '../../src/maps/vector-map-request.js';
import { readRetryAt } from '../../src/net/rate-limit.js';

const url = 'https://tiles.openfreemap.org/fixture/1/0/0.pbf';
const parameters = { url: vectorRequestUrl(url), type: 'arrayBuffer' };
const response = (body, options = {}, responseUrl = url) => Object.defineProperty(new Response(body, options), 'url', { value: responseUrl });
test('the protocol validates both URL boundaries and keeps public request/cache semantics', async () => {
    for (const value of ['https://evil.example/tile', 'http://tiles.openfreemap.org/tile', 'https://user@tiles.openfreemap.org/tile', url + '#fragment']) assert.throws(() => vectorRequestUrl(value));
    let calls = 0;
    const request = createVectorMapRequest({ fetch: async (actual, options) => {
        calls++; assert.equal(actual, url); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
        assert.equal(options.signal.aborted, false);
        return response('bytes', { headers: { 'cache-control': 'max-age=60', expires: 'tomorrow' } });
    } });
    await assert.rejects(request({ url: 'bpb-vector://https://evil.example/tile' }, new AbortController()), /Unapproved/);
    const result = await request(parameters, new AbortController());
    assert.equal(new TextDecoder().decode(result.data), 'bytes'); assert.equal(result.cacheControl, 'max-age=60'); assert.equal(result.expires, 'tomorrow'); assert.equal(calls, 1);
    const redirected = createVectorMapRequest({ fetch: async () => response('bytes', {}, 'https://evil.example/tile') });
    await assert.rejects(redirected(parameters, new AbortController()), /Unapproved/);
    for (const status of [404, 503]) {
        const unavailable = createVectorMapRequest({ fetch: async () => response('', { status }) });
        await assert.rejects(unavailable(parameters, new AbortController()), error => error.status === status);
    }
});
test('metadata, glyph and sprite requests retain their expected data types', async () => {
    for (const [type, body, expected] of [['json', '{"tiles":[]}', { tiles: [] }], ['string', 'text', 'text']]) {
        const request = createVectorMapRequest({ fetch: async () => response(body) });
        assert.deepEqual((await request({ ...parameters, type }, new AbortController())).data, expected);
    }
});
test('tile-level 429 preserves Retry-After before error serialization and defaults conservatively', async () => {
    for (const header of ['120', null, '86401', 'nonsense']) {
        let cancelled = false, reported;
        const before = Date.now();
        const request = createVectorMapRequest({ fetch: async () => ({ status: 429, headers: new Headers(header ? { 'retry-after': header } : {}), body: { cancel() { cancelled = true; } } }), onRateLimit: error => { reported = error; } });
        await assert.rejects(request(parameters, new AbortController()), error => error === reported && error.code === 'rate-limit');
        const wait = header === '120' ? 120000 : 300000;
        assert.ok(reported.retryAt >= before + wait && reported.retryAt <= Date.now() + wait); assert.equal(cancelled, true);
    }
});
test('cancellation and whole-exchange deadlines abort fetch and stalled bodies', async () => {
    const already = new AbortController(); already.abort();
    await assert.rejects(createVectorMapRequest({ fetch: () => assert.fail('No fetch after cancellation') })(parameters, already), { name: 'AbortError' });
    let signal, started;
    const pending = new Promise(resolve => { started = resolve; });
    const controller = new AbortController();
    const request = createVectorMapRequest({ fetch: async (_url, options) => { signal = options.signal; started(); return new Promise(() => {}); } });
    const result = request(parameters, controller); await pending; controller.abort();
    await assert.rejects(result, { name: 'AbortError' }); assert.equal(signal.aborted, true);
    const stalled = createVectorMapRequest({ timeoutMs: 10, fetch: async (_url, options) => { signal = options.signal; return { ok: true, url, arrayBuffer: () => new Promise(() => {}) }; } });
    await assert.rejects(stalled(parameters, new AbortController()), { name: 'TimeoutError' }); assert.equal(signal.aborted, true);
});
test('cross-world retry deadlines accept only finite future values within one day', () => {
    const now = Date.now(); assert.equal(readRetryAt(now + 120000, now), now + 120000);
    for (const value of [now, now - 1, now + 86400001, Infinity, NaN, '120000', null]) assert.equal(readRetryAt(value, now), null);
});
