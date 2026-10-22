// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBCLandRoutes } from '../../src/background/bc-land-routes.js';
import { createBCTileFetch, readBCTileCoordinates } from '../../src/maps/bc-land-client.js';

const sender = { tab: { id: 1 }, frameId: 0, url: 'https://www.peakbagger.com/Peak.aspx?pid=1' };
const coordinates = { z: 12, x: 637, y: 1315 }; // Coastal BC.
const image = () => { const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); new DataView(bytes.buffer).setUint32(16, 256); new DataView(bytes.buffer).setUint32(20, 256); return bytes; };
const setup = (overrides = {}) => {
    const calls = []; let granted = true;
    const ext = { permissions: { contains: async () => granted, request: async () => { granted = true; return true; } } };
    const routes = createBCLandRoutes({ ext, isPeakbaggerSender: value => value.url?.startsWith('https://www.peakbagger.com/'),
        fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(image(), { headers: { 'content-type': 'image/png' } }); }, ...overrides });
    return { routes: routes.handlers, cancelTab: routes.cancelTab, calls, ext, deny: () => { granted = false; } };
};
test('BC broker refuses missing consent, foreign senders, arbitrary URLs and invalid tiles', async () => {
    const state = setup(); state.deny();
    assert.deepEqual(await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'one' }, sender), { ok: false, code: 'bc-permission-required' });
    for (const [message, owner] of [
        [{ coordinates, requestId: 'one', url: 'https://evil.example/' }, { ...sender, url: 'https://evil.example/' }],
        [{ coordinates: { ...coordinates, z: 1 }, requestId: 'one' }, sender],
        [{ coordinates: { ...coordinates, y: -1 }, requestId: 'one' }, sender],
        [{ coordinates: { z: 12, x: 2000, y: 1315 }, requestId: 'one' }, sender],
    ]) assert.equal((await state.routes.BC_LAND_TILE_GET(message, owner)).code, 'forbidden');
    assert.equal(state.calls.length, 0);
});
test('BC broker returns bounded PNG data using its own fixed provider URL and no credentials', async () => {
    const state = setup(), reply = await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'one', url: 'https://evil.example/' }, sender);
    assert.equal(reply.ok, true); assert.equal(atob(reply.image).length, 24);
    assert.equal(new URL(state.calls[0].url).hostname, 'maps.gov.bc.ca');
    assert.equal(state.calls[0].options.credentials, 'omit'); assert.equal(state.calls[0].options.referrerPolicy, 'no-referrer');
    const fetchTile = createBCTileFetch(message => state.routes[message.type](message, sender));
    const response = await fetchTile(coordinates, { signal: new AbortController().signal });
    assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal((await response.arrayBuffer()).byteLength, 24);
});
test('BC broker enforces PNG byte and dimension ceilings', async () => {
    for (const body of [new Uint8Array(1048577), new Uint8Array(24), (() => { const bytes = image(); new DataView(bytes.buffer).setUint32(16, 8192); return bytes; })()]) {
        const state = setup({ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'image/png' } }) });
        assert.equal((await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'one' }, sender)).ok, false);
    }
});
test('BC temporary errors survive the narrow relay without treating bad PNG data as retryable', async () => {
    for (const status of [503, 404, 200]) {
        const state = setup({ fetchImpl: async () => new Response('', { status, headers: { 'content-type': 'image/png' } }) });
        const tile = createBCTileFetch(message => state.routes[message.type](message, sender));
        await assert.rejects(tile(coordinates, { signal: new AbortController().signal }), error => (error.transient === true) === (status === 503));
    }
});
test('BC cancellation belongs to the sender frame and clients stop waiting immediately', async () => {
    let started, transport;
    const ready = new Promise(resolve => { started = resolve; });
    const state = setup({ fetchImpl: (_url, options) => new Promise((_, reject) => {
        transport = options.signal; started(); options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true });
    }) });
    const result = state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'one' }, sender); await ready;
    state.routes.BC_LAND_TILE_CANCEL({ requestId: 'one' }, { ...sender, frameId: 2 }); assert.equal(transport.aborted, false);
    state.routes.BC_LAND_TILE_CANCEL({ requestId: 'one' }, sender); assert.equal(transport.aborted, true); assert.equal((await result).ok, false);
    const messages = [], controller = new AbortController();
    const fetchTile = createBCTileFetch(message => { messages.push(message); return new Promise(() => {}); });
    const pending = fetchTile(coordinates, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(messages[1].type, 'BC_LAND_TILE_CANCEL');
});
test('BC permission request preserves user activation and coordinate wrapping is bounded', async () => {
    let requested = false;
    const state = setup({ ext: { permissions: { contains: () => assert.fail('permission request must not await a preflight'), request: () => { requested = true; return Promise.resolve(true); } } } });
    const reply = state.routes.BC_LAND_PERMISSION_REQUEST({}, sender); assert.equal(requested, true); assert.equal((await reply).ok, true);
    assert.deepEqual(readBCTileCoordinates({ ...coordinates, x: coordinates.x - 4096 }), coordinates);
    assert.equal(readBCTileCoordinates({ ...coordinates, x: Infinity }), null);
});
test('BC worker bounds concurrent jobs and tab teardown cancels only that tab', async () => {
    const signals = [];
    const state = setup({ fetchImpl: (_url, options) => new Promise((_, reject) => {
        signals.push(options.signal); options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true });
    }) });
    const pending = Array.from({ length: 16 }, (_, i) => state.routes.BC_LAND_TILE_GET({ coordinates, requestId: `job-${i}` }, i === 15 ? { ...sender, tab: { id: 2 } } : sender));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signals.length, 16);
    assert.equal((await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'overflow' }, sender)).code, 'busy');
    state.cancelTab(1); assert.equal(signals.slice(0, 15).every(signal => signal.aborted), true); assert.equal(signals[15].aborted, false);
    state.cancelTab(2); assert.equal((await Promise.all(pending)).every(reply => !reply.ok), true);
});
test('BC rate limits survive client retries without another provider request', async () => {
    let calls = 0;
    const state = setup({ fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); } });
    const first = await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'one' }, sender);
    assert.equal(first.code, 'rate-limit'); assert.ok(first.retryAt > Date.now());
    const fetchTile = createBCTileFetch(message => state.routes[message.type](message, sender));
    await assert.rejects(fetchTile(coordinates, { signal: new AbortController().signal }), { code: 'rate-limit', retryAt: first.retryAt });
    assert.equal(calls, 1);
});
test('BC refusals without a usable reset apply a shared five-minute cooldown', async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    for (const header of [null, 'invalid', '0', '999999999']) {
        let calls = 0;
        const state = setup({ fetchImpl: async () => {
            calls++;
            return new Response('', { status: 429, headers: header === null ? {} : { 'retry-after': header } });
        } });
        const first = await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'first' }, sender);
        assert.equal(first.retryAt, now + 300000, `fallback for ${header}`);
        const otherTab = { ...sender, tab: { id: 2 } };
        assert.deepEqual(await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'second' }, otherTab), first);
        assert.equal(calls, 1, 'a second tab shares the provider cooldown');
        now = first.retryAt;
        assert.equal((await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'expired' }, otherTab)).retryAt, now + 300000);
        assert.equal(calls, 2, 'requests resume at expiry');
    }
});
test('a later in-flight BC refusal cannot shorten an established cooldown', async () => {
    const responses = [];
    const state = setup({ fetchImpl: () => new Promise(resolve => responses.push(resolve)) });
    const first = state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'first' }, sender);
    const second = state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'second' }, sender);
    await new Promise(resolve => setImmediate(resolve));
    responses[0](new Response('', { status: 429, headers: { 'retry-after': '600' } }));
    const refused = await first;
    responses[1](new Response('', { status: 429, headers: { 'retry-after': '1' } }));
    assert.equal((await second).retryAt, refused.retryAt);
    assert.equal((await state.routes.BC_LAND_TILE_GET({ coordinates, requestId: 'third' }, sender)).retryAt, refused.retryAt);
    assert.equal(responses.length, 2);
});
test('a rejected web-page permission gesture opens and reuses an explicit packaged setup tab', async () => {
    const created = [], updated = []; let tab;
    const ext = { runtime: { getURL: path => `moz-extension://self/${path}` }, permissions: { request: async () => { throw Error('user input handler required'); } },
        tabs: { create: async value => { created.push(value); tab = { ...value, id: 7 }; return tab; }, get: async () => tab, update: async (...args) => updated.push(args) } };
    const state = setup({ ext }), owner = { ...sender, tab: { id: 1, windowId: 4 } };
    assert.equal((await state.routes.BC_LAND_PERMISSION_REQUEST({}, owner)).code, 'permission-setup-opened');
    assert.deepEqual(created, [{ url: 'moz-extension://self/bc-land/access.html?tab=1', active: true, windowId: 4 }]);
    await state.routes.BC_LAND_PERMISSION_REQUEST({}, owner); assert.equal(created.length, 1); assert.deepEqual(updated, [[7, { active: true }]]);
    state.cancelTab(7); await state.routes.BC_LAND_PERMISSION_REQUEST({}, owner); assert.equal(created.length, 2);
});
