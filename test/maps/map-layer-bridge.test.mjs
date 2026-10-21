// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { snotelStations } from '../helpers/snotel-fixture.mjs';
import { createMapLayerHandoff } from '../../src/background/map-layer-handoff.js';

const bundle = await readFile(new URL('../../dist/content/peak-snow.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup({ catalog = snotelStations(), held = false } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', runScripts: 'outside-only' });
    const win = dom.window, messages = [], requests = [], local = {}, listeners = [];
    win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
    win.chrome = { storage: { sync: { get: async () => ({ bpbSettings: { showSnotel: true } }) },
        local: { get: async () => local, set: async value => Object.assign(local, value) },
        onChanged: { addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1) } } };
    const response = () => new Response(JSON.stringify(catalog));
    win.fetch = (url, options) => { const entry = { url, options }; requests.push(entry); return held ? new Promise(resolve => { entry.resolve = () => resolve(response()); }) : Promise.resolve(response()); };
    win.postMessage = value => messages.push(value);
    win.eval(bundle);
    const send = (detail, origin = win.location.origin, source = win) => win.dispatchEvent(new win.MessageEvent('message', { source, origin,
        data: { __bpbMapLayers: true, dir: 'toCS', ...detail } }));
    return { win, local, messages, requests, send, listeners, close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
test('the isolated map service persists bounded opacity only and rejects foreign requests', async () => {
    const env = setup();
    try {
        await tick(); env.send({ type: 'preferences' }); await tick(); assert.equal(env.requests.length, 0);
        env.send({ type: 'save', preferences: { sentinel: 150, slope: -5, land: 33.8, snotel: 5, enabled: true, url: 'https://example.com' } }); await tick();
        assert.deepEqual(JSON.parse(JSON.stringify(env.local.bpbMapOverlayOpacityV1)), { sentinel: 100, slope: 0, land: 34, snotel: 100 });
        const request = { type: 'stations', requestId: 1, bounds: [-122, 46, -121, 47] };
        env.send(request, 'https://example.com'); env.send(request, env.win.location.origin, null); env.send({ ...request, bounds: [-122, -200, -121, 47] });
        await tick(); assert.equal(env.requests.length, 0);
    } finally { env.close(); }
});
test('viewport station overflow is explicit and no viewport reaches NRCS', async () => {
    const sample = snotelStations()[0], catalog = Array.from({ length: 51 }, (_, i) => ({ ...sample, stationTriplet: `${1000 + i}:WA:SNTL` }));
    const env = setup({ catalog });
    try {
        await tick(); env.send({ type: 'stations', requestId: 1, bounds: [-180, 0, 0, 85] }); await tick(); await tick();
        const reply = env.messages.find(message => message.type === 'stations');
        assert.equal(reply.overflow, true); assert.equal(reply.stations.length, 0);
        assert.equal(env.requests.length, 1); assert.equal(new URL(env.requests[0].url).searchParams.has('bbox'), false);
        assert.equal(env.requests[0].options.credentials, 'omit');
    } finally { env.close(); }
});
test('off cancels the catalog subscriber and late or opted-out work cannot publish stations', async () => {
    const env = setup({ held: true });
    try {
        await tick(); env.send({ type: 'stations', requestId: 1, bounds: [-180, 0, 0, 85] }); await tick();
        assert.equal(env.requests.length, 1); env.send({ type: 'cancel' });
        assert.equal(env.requests[0].options.signal.aborted, true); env.requests[0].resolve(); await tick();
        assert.equal(env.messages.some(message => message.type === 'stations'), false);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showSnotel: false } } }, 'sync')); await tick();
        env.send({ type: 'stations', requestId: 2, bounds: [-180, 0, 0, 85] }); await tick(); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});
test('full-screen handoffs are bounded, expiring, one-use and bound to destination and source tab', async () => {
    let time = Date.now(); const values = {};
    const storage = { get: async key => ({ [key]: structuredClone(values[key]) }), set: async next => Object.assign(values, structuredClone(next)) };
    const service = createMapLayerHandoff({ storage, now: () => time, isPeakbaggerSender: sender => sender?.url?.startsWith('https://www.peakbagger.com/') });
    const source = { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296', tab: { id: 7, windowId: 2 } };
    const destination = 'https://www.peakbagger.com/map/BigMap.aspx?t=P&d=2296';
    const snapshot = { revision: 5, state: { slope: { enabled: true, opacity: 60 } }, menuOpen: true, cooldowns: { slope: time + 120000 } };
    assert.equal((await service.prepare({ destination: 'https://example.com/map/BigMap.aspx', snapshot }, source)).ok, false);
    await service.prepare({ destination, snapshot }, source);
    assert.equal((await service.consume({}, { url: destination, tab: { id: 9, windowId: 2 } })).ok, false);
    const target = { url: destination, tab: { id: 9, windowId: 2, openerTabId: 7 } };
    const result = await service.consume({}, target); assert.equal(result.ok, true); assert.equal(result.snapshot.state.slope.enabled, true); assert.equal(result.snapshot.menuOpen, false);
    assert.equal(result.snapshot.cooldowns.slope, snapshot.cooldowns.slope);
    assert.equal((await service.consume({}, target)).ok, false);
    await service.prepare({ destination, snapshot }, source); time += 30001; assert.equal((await service.consume({}, target)).ok, false);
});
