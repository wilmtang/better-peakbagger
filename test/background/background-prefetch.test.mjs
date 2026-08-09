// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// The worker ships as one bundle; Unit 7 folds terrain-tiles + terrain-cache in
// so the DEM prefetch runs entirely inside the extension-origin worker. Boot the
// built bundle in a worker-like vm context, exactly as the service worker runs.
const workerBundle = await fs.readFile(new URL('../../dist/background.js', import.meta.url), 'utf8');

const event = () => {
    const listeners = [];
    return { listeners, addListener: listener => listeners.push(listener) };
};

// A minimal in-memory CacheStorage/Cache, mirroring the terrain-cache tests.
class MemoryCache {
    constructor() { this.entries = new Map(); }
    url(value) { return typeof value === 'string' ? value : value.url; }
    async keys() { return Array.from(this.entries.keys(), url => ({ url })); }
    async match(value) {
        const response = this.entries.get(this.url(value));
        return response ? response.clone() : undefined;
    }
    async put(value, response) { this.entries.set(this.url(value), response.clone()); }
    async delete(value) { return this.entries.delete(this.url(value)); }
}
class MemoryCacheStorage {
    constructor() { this.named = new Map(); }
    async keys() { return Array.from(this.named.keys()); }
    async open(name) {
        if (!this.named.has(name)) this.named.set(name, new MemoryCache());
        return this.named.get(name);
    }
    async delete(name) { return this.named.delete(name); }
}

const makeWebp = () => {
    const bytes = new Uint8Array(24);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WEBP'), 8);
    bytes.set(new TextEncoder().encode('VP8L'), 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.byteLength - 8, true);
    view.setUint32(16, bytes.byteLength - 20, true);
    return bytes;
};

const createHarness = ({
    settings = { enable3dMap: true, terrainCacheLimitMb: 512 },
    // The status the tile host answers each request with, so a region the
    // provider does not cover can be replayed.
    tileStatus = () => 200
} = {}) => {
    const syncValues = { bpbSettings: structuredClone(settings) };
    const localValues = {};
    const sessionValues = {};
    const runtimeMessage = event();
    const tabRemoved = event();
    const alarmEvent = event();
    const fetchCalls = [];

    const area = values => ({
        get: async key => ({ [key]: structuredClone(values[key]) }),
        set: async patch => Object.assign(values, structuredClone(patch)),
        remove: async key => { delete values[key]; }
    });

    const browser = {
        storage: {
            session: area(sessionValues),
            sync: area(syncValues),
            local: area(localValues),
            onChanged: event(),
        },
        runtime: {
            onMessage: runtimeMessage,
            getURL: path => `chrome-extension://test-id/${path}`,
        },
        tabs: { onRemoved: tabRemoved },
        alarms: { create: () => {}, onAlarm: alarmEvent }
    };

    const fetch = async url => {
        const value = String(url);
        fetchCalls.push(value);
        const status = tileStatus(value);
        return status === 200
            ? new Response(makeWebp(), { status, headers: { 'content-type': 'image/webp' } })
            : new Response('Tile not found', { status });
    };

    // scheduleSave arms a 1 s timer inside terrain-cache; unref so a pending
    // save never keeps the test process alive.
    const wrapTimeout = (fn, ms, ...args) => {
        const handle = setTimeout(fn, ms, ...args);
        if (handle && typeof handle.unref === 'function') handle.unref();
        return handle;
    };

    const context = vm.createContext({
        browser, fetch, URL, URLSearchParams, Math, Date, console, structuredClone,
        caches: new MemoryCacheStorage(), Response, AbortController, crypto: webcrypto,
        setTimeout: wrapTimeout, clearTimeout, btoa
    });
    context.globalThis = context;
    context.self = context;
    vm.runInContext(workerBundle, context, { filename: 'dist/background.js' });

    const listener = runtimeMessage.listeners[0];
    // Replies are created inside the vm realm, so their prototype differs from
    // the test realm's; copy the plain fields out before asserting on them.
    const send = (message, sender = {}) => new Promise(resolve => {
        assert.equal(listener(message, sender, reply => resolve({ ...reply })), true);
    });
    const peakbaggerSender = (id = 5) => ({
        tab: { id }, url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1'
    });
    const prefetch = async (message, sender) => {
        const issued = await send({ type: 'TERRAIN_ACTIVATION_ISSUE', action: 'prefetch' }, sender);
        return send({ ...message, ...(issued.ok ? { activation: issued.token } : {}) }, sender);
    };
    return { send, prefetch, fetchCalls, peakbaggerSender, tabRemoved };
};

const ROUTE = {
    type: 'TERRAIN_PREFETCH',
    bounds: { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 },
    viewport: { width: 1280, height: 800 }
};

test('DEM prefetch is refused unless a Peakbagger tab asks with 3D on and a cache budget', async () => {
    // 3D disabled: the consent gate for contacting Mapterhorn is closed.
    const off = createHarness({ settings: { enable3dMap: false, terrainCacheLimitMb: 512 } });
    assert.deepEqual(await off.prefetch(ROUTE, off.peakbaggerSender()), { ok: false, reason: 'disabled' });
    assert.equal(off.fetchCalls.length, 0);

    // 3D on but no cache budget: nothing to warm.
    const noBudget = createHarness({ settings: { enable3dMap: true, terrainCacheLimitMb: 0 } });
    assert.deepEqual(await noBudget.prefetch(ROUTE, noBudget.peakbaggerSender()), { ok: false, reason: 'disabled' });
    assert.equal(noBudget.fetchCalls.length, 0);

    // A non-Peakbagger sender may not drive worker→Mapterhorn traffic.
    const enabled = createHarness();
    assert.deepEqual(
        await enabled.prefetch(ROUTE, { tab: { id: 5 }, url: 'https://evil.example.com/x' }),
        { ok: false, reason: 'forbidden' });
    assert.equal(enabled.fetchCalls.length, 0);
    // A tabless sender (e.g. another extension page) is refused too.
    assert.deepEqual(await enabled.prefetch(ROUTE, { url: 'https://www.peakbagger.com/' }), { ok: false, reason: 'forbidden' });
    assert.equal(enabled.fetchCalls.length, 0);
    assert.deepEqual(await enabled.send(ROUTE, enabled.peakbaggerSender()),
        { ok: false, reason: 'activation' });
    assert.equal(enabled.fetchCalls.length, 0, 'a public payload without a capability warms nothing');
});

test('DEM prefetch validates the viewport before computing any tiles', async () => {
    const harness = createHarness();
    for (const viewport of [undefined, { width: 50, height: 600 }, { width: 1280, height: 99999 }, { width: NaN, height: 600 }]) {
        const reply = await harness.prefetch({ ...ROUTE, viewport }, harness.peakbaggerSender());
        assert.deepEqual(reply, { ok: false, reason: 'invalid' }, `viewport ${JSON.stringify(viewport)}`);
    }
    // A well-formed request that names neither bounds nor centre is invalid too.
    assert.deepEqual(
        await harness.prefetch({ type: 'TERRAIN_PREFETCH', viewport: { width: 1280, height: 800 } }, harness.peakbaggerSender()),
        { ok: false, reason: 'invalid' });
    assert.equal(harness.fetchCalls.length, 0);
});

test('DEM prefetch warms a bounded set of Mapterhorn tiles for a route view', async () => {
    const harness = createHarness();
    const reply = await harness.prefetch(ROUTE, harness.peakbaggerSender());
    assert.equal(reply.ok, true);
    assert.ok(reply.tiles > 0 && reply.tiles <= 32, `expected 1..32 tiles, got ${reply.tiles}`);
    // Every request goes to Mapterhorn as a DEM webp tile; count matches the
    // reported tiles (each fresh tile is fetched exactly once on a cold cache).
    assert.equal(harness.fetchCalls.length, reply.tiles);
    assert.ok(harness.fetchCalls.every(url => /^https:\/\/tiles\.mapterhorn\.com\/\d+\/\d+\/\d+\.webp$/.test(url)),
        harness.fetchCalls.join(', '));
});

test('DEM prefetch warms a peak center+zoom view', async () => {
    const harness = createHarness();
    const reply = await harness.prefetch(
        { type: 'TERRAIN_PREFETCH', center: [48.83115, -121.60214], zoom: 13, viewport: { width: 1000, height: 425 } },
        harness.peakbaggerSender());
    assert.equal(reply.ok, true);
    assert.ok(reply.tiles > 0 && reply.tiles <= 32);
    assert.equal(harness.fetchCalls.length, reply.tiles);
    assert.ok(harness.fetchCalls.every(url => url.startsWith('https://tiles.mapterhorn.com/')));
});

test('DEM prefetch rate-limits per tab and dedupes tiles across tabs', async () => {
    const harness = createHarness();
    const first = await harness.prefetch(ROUTE, harness.peakbaggerSender(5));
    assert.equal(first.ok, true);
    const warmed = harness.fetchCalls.length;

    // A second request from the same tab within the window is throttled — no
    // additional traffic.
    assert.deepEqual(await harness.prefetch(ROUTE, harness.peakbaggerSender(5)), { ok: false, reason: 'throttled' });
    assert.equal(harness.fetchCalls.length, warmed, 'a throttled request fetches nothing');

    // A different tab bypasses the per-tab limit, but the identical view is
    // already warmed, so the shared dedupe set fetches nothing new.
    const other = await harness.prefetch(ROUTE, harness.peakbaggerSender(9));
    assert.deepEqual(other, { ok: true, tiles: 0 }, 'an already-warmed view fetches no new tiles');
    assert.equal(harness.fetchCalls.length, warmed, 'no duplicate tile fetches across tabs');
});

test('DEM prefetch stops re-asking for tiles the provider says do not exist', async () => {
    // Warming is driven by hovering the idle 3D toggle, so a peak in a region
    // Mapterhorn's archives do not cover would otherwise re-request the same
    // absent tiles on every hover — permanent, pointless load on a donated
    // server for ground it has already said it does not have. A 404 is a
    // settled answer; a 503 is not, and stays retryable.
    const absent = createHarness({ tileStatus: () => 404 });
    const first = await absent.prefetch(ROUTE, absent.peakbaggerSender(5));
    assert.deepEqual(first, { ok: true, tiles: 0 }, 'no tile was warmed');
    const attempted = absent.fetchCalls.length;
    assert.ok(attempted > 0, 'the absent tiles were tried once');

    // Another tab bypasses the per-tab rate limit, so only the dedupe set can
    // hold the second attempt back.
    assert.deepEqual(await absent.prefetch(ROUTE, absent.peakbaggerSender(9)), { ok: true, tiles: 0 });
    assert.equal(absent.fetchCalls.length, attempted, 'an absent tile must not be re-requested');

    const failing = createHarness({ tileStatus: () => 503 });
    await failing.prefetch(ROUTE, failing.peakbaggerSender(5));
    const tried = failing.fetchCalls.length;
    assert.ok(tried > 0);
    await failing.prefetch(ROUTE, failing.peakbaggerSender(9));
    assert.ok(failing.fetchCalls.length > tried, 'a provider that is merely failing stays retryable');
});
