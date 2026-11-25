/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDom, builtBundle } from '../helpers/fixture-dom.mts';
import { snotelStations } from '../helpers/snotel-fixture.mts';
import { createMapLayerHandoff } from '../../src/background/map-layer-handoff.ts';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';

const bundle = await builtBundle('content/peak-snow.js');
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const tick = () => new Promise(resolve => nativeSetTimeout(resolve, 0));

interface BridgeMessage {
    type?: string;
    requestId?: number;
    snotel?: boolean;
    ok?: boolean;
    overflow?: boolean;
    nearby?: boolean;
    stations?: { id: string }[];
    preferences?: { land?: number; landTypes?: string[]; [key: string]: unknown };
    reply?: { code?: string };
    [key: string]: unknown;
}
interface RecordedRequest {
    url: string;
    options?: RequestInit;
    resolve?: () => void;
}
type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => unknown;
interface SetupOptions {
    catalog?: ReturnType<typeof snotelStations>;
    held?: boolean;
    runtime?: Record<string, unknown> & { sendMessage?: (message: Record<string, unknown>) => Promise<unknown> };
    localGet?: (key: unknown) => Promise<Record<string, unknown>>;
    syncGet?: () => Promise<{ bpbSettings?: Record<string, unknown> }>;
}

function setup({ catalog = snotelStations(), held = false, runtime, localGet, syncGet = async () => ({ bpbSettings: { showSnotel: true } }) }: SetupOptions = {}) {
    const dom = new FixtureDom('<!doctype html><body></body>', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', runScripts: 'outside-only' });
    const win = dom.window as unknown as Omit<Window & typeof globalThis, 'chrome'> & { chrome: { runtime: Record<string, unknown>; storage: Record<string, unknown> } };
    const messages: BridgeMessage[] = [], requests: RecordedRequest[] = [], local: Record<string, unknown> = {}, listeners: StorageListener[] = [];
    win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
    win.chrome = { runtime: { ...runtime, sendMessage: async (message: { type?: string; patch?: Record<string, unknown> }) => {
        if (message.type === 'SETTINGS_PATCH') { Object.assign(local, message.patch); return { ok: true, settings: Schema.clean({ ...(await syncGet()).bpbSettings, ...message.patch }) }; }
        return runtime?.sendMessage?.(message);
    } }, storage: { sync: { get: syncGet },
        local: { get: async (key: unknown) => Array.isArray(key) && key.includes('bpbDeviceSettings') ? {} : (localGet ? localGet(key) : local), set: async (value: Record<string, unknown>) => Object.assign(local, value) },
        onChanged: { addListener: (fn: StorageListener) => listeners.push(fn), removeListener: (fn: StorageListener) => listeners.splice(listeners.indexOf(fn), 1) } } };
    const response = () => new Response(JSON.stringify(catalog));
    (win as unknown as { fetch: (url: string, options?: RequestInit) => Promise<Response> }).fetch = (url, options) => {
        const entry: RecordedRequest = { url, options }; requests.push(entry);
        return held ? new Promise(resolve => { entry.resolve = () => resolve(response()); }) : Promise.resolve(response());
    };
    (win as unknown as { postMessage: (value: BridgeMessage) => void }).postMessage = value => { messages.push(value); };
    win.eval(bundle);
    const send = (detail: Record<string, unknown>, origin = win.location.origin, source: MessageEventSource | null = win as unknown as Window) =>
        win.dispatchEvent(new win.MessageEvent('message', { source, origin, data: { __bpbMapLayers: true, dir: 'toCS', ...detail } }));
    return { win, local, messages, requests, send, listeners, close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
test('opacity announcements wait for saved preferences as well as settings', async () => {
    let finish!: (value: Record<string, unknown>) => void;
    const env = setup({ localGet: key => key === 'bpbMapOverlayOpacityV1' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({}) });
    try {
        await tick(); env.send({ type: 'preferences' });
        assert.equal(env.messages.filter(message => message.type === 'preferences').length, 0, 'saved opacity is still unknown');
        finish({ bpbMapOverlayOpacityV1: { sentinel: 31, slope: 42, land: 73 } }); await tick();
        const announcements = env.messages.filter(message => message.type === 'preferences');
        assert.equal(announcements.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(announcements[0].preferences)), { sentinel: 31, snow: 60, slope: 42, land: 73, snotel: 100, wildfire: 100, landTypes: [...Schema.MAP_LAND_TYPE_IDS] });
        assert.equal(announcements[0].snotel, true);
    } finally { env.close(); }
});
test('a late opacity read cannot overwrite a newer save', async () => {
    let finish!: (value: Record<string, unknown>) => void;
    const env = setup({ localGet: key => key === 'bpbMapOverlayOpacityV1' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({}) });
    try {
        await tick(); env.send({ type: 'save', preferences: { sentinel: 22, slope: 33, land: 44 } }); await tick();
        finish({ bpbMapOverlayOpacityV1: { sentinel: 85, slope: 55, land: 55 } }); await tick();
        env.send({ type: 'preferences' });
        assert.equal(env.messages.filter(message => message.type === 'preferences').at(-1)!.preferences!.land, 44);
        assert.equal((env.local.bpbMapOverlayOpacityV1 as { land: number }).land, 44);
    } finally { env.close(); }
});
test('unavailable preference storage settles startup with usable defaults', async () => {
    const env = setup({ localGet: async () => { throw new Error('Storage unavailable'); } });
    try {
        await tick(); env.send({ type: 'preferences' });
        const announcement = env.messages.filter(message => message.type === 'preferences').at(-1)!;
        assert.equal(announcement.preferences!.land, (Schema.mapOverlayPreferences() as Record<string, unknown>).land); assert.equal(announcement.snotel, true);
    } finally { env.close(); }
});
test('loading opacity preferences cannot publish a false SNOTEL opt-out before settings are known', async () => {
    let finish!: (value: { bpbSettings?: Record<string, unknown> }) => void;
    const pending = new Promise<{ bpbSettings?: Record<string, unknown> }>(resolve => { finish = resolve; });
    const env = setup({ syncGet: () => pending });
    try {
        await tick(); env.send({ type: 'preferences' }); await tick();
        assert.equal(env.messages.filter(message => message.type === 'preferences').length, 0,
            'unknown settings must not clear a Full Screen handoff that enabled SNOTEL');
        env.send({ type: 'stations', requestId: 1, bounds: [-122, 46, -121, 47] }); await tick();
        assert.equal(env.requests.length, 0, 'unknown settings still fail closed for provider access');
        finish({ bpbSettings: { showSnotel: true } }); await tick();
        assert.equal(env.messages.filter(message => message.type === 'preferences').at(-1)?.snotel, true);
    } finally { env.close(); }
});
test('a late startup settings read cannot overwrite a newer SNOTEL opt-out', async () => {
    let finish!: (value: { bpbSettings?: Record<string, unknown> }) => void;
    const pending = new Promise<{ bpbSettings?: Record<string, unknown> }>(resolve => { finish = resolve; });
    const env = setup({ syncGet: () => pending });
    try {
        await tick();
        env.listeners.forEach(listener => listener({ bpbSettings: { newValue: { showSnotel: false } } }, 'sync'));
        finish({ bpbSettings: { showSnotel: true } }); await tick();
        env.send({ type: 'preferences' });
        assert.equal(env.messages.filter(message => message.type === 'preferences').at(-1)?.snotel, false);
        env.send({ type: 'stations', requestId: 1, bounds: [-122, 46, -121, 47] }); await tick();
        assert.equal(env.requests.length, 0, 'the newer privacy choice continues to block station requests');
    } finally { env.close(); }
});
test('the isolated map service persists bounded preferences only and rejects foreign requests', async () => {
    const env = setup();
    try {
        await tick(); env.send({ type: 'preferences' }); await tick(); assert.equal(env.requests.length, 0);
        env.send({ type: 'save', preferences: { sentinel: 150, slope: -5, land: 33.8, snotel: 5, enabled: true, url: 'https://example.com' } }); await tick();
        assert.deepEqual(JSON.parse(JSON.stringify(env.local.bpbMapOverlayOpacityV1)), { sentinel: 100, snow: 60, slope: 0, land: 34, snotel: 100, wildfire: 100, landTypes: [...Schema.MAP_LAND_TYPE_IDS] });
        const request = { type: 'stations', requestId: 1, bounds: [-122, 46, -121, 47] };
        env.send(request, 'https://example.com'); env.send(request, env.win.location.origin, null); env.send({ ...request, bounds: [-122, -200, -121, 47] });
        await tick(); assert.equal(env.requests.length, 0);
    } finally { env.close(); }
});

test('the BC relay narrows coordinate requests, rejects foreign senders and never prompts on scripted clicks', async () => {
    const env = setup(), calls: Record<string, unknown>[] = [];
    env.win.chrome.runtime = { sendMessage: async (message: Record<string, unknown>) => { calls.push(message); return { ok: false, code: 'bc-permission-required' }; } };
    try {
        const message = { type: 'BC_LAND_TILE_GET', requestId: 'one', coordinates: { z: 12, x: 637, y: 1315 }, url: 'https://evil.example/', landTypes: ['CROWN', 'CROWN', 'private'] };
        env.send({ type: 'bcTile', message }, 'https://evil.example/');
        env.send({ type: 'bcTile', message: { ...message, coordinates: { z: 1, x: 0, y: 0 } } });
        env.send({ type: 'bcTile', message }); await tick();
        assert.equal(calls.length, 1); assert.equal(Object.hasOwn(calls[0], 'url'), false);
        assert.deepEqual(JSON.parse(JSON.stringify(calls[0].landTypes)), ['CROWN']);
        assert.ok(env.messages.some(reply => reply.type === 'bcTileReply' && reply.reply?.code === 'bc-permission-required'));
        const button = env.win.document.createElement('button'); button.dataset.bpbBcPermission = 'true'; env.win.document.body.append(button); button.click(); await tick();
        assert.ok(!calls.some(call => call.type === 'BC_LAND_PERMISSION_REQUEST'));
    } finally { env.close(); }
});
test('only the packaged BC setup page can acknowledge granted access', async () => {
    const listeners: ((message: unknown, sender: unknown) => void)[] = [];
    const runtime = { id: 'self', getURL: (path: string) => `moz-extension://self/${path}`,
        onMessage: { addListener: (listener: (message: unknown, sender: unknown) => void) => listeners.push(listener), removeListener: (listener: (message: unknown, sender: unknown) => void) => listeners.splice(listeners.indexOf(listener), 1) } };
    const env = setup({ runtime });
    try {
        const message = { type: 'BC_LAND_PERMISSION_GRANTED' }, handler = listeners[0];
        for (const sender of [{ id: 'other', url: runtime.getURL('bc-land/access.html') }, { id: 'self', url: 'moz-extension://foreign/bc-land/access.html' },
            { id: 'self', url: 'https://www.peakbagger.com/bc-land/access.html' }]) handler(message, sender);
        assert.equal(env.messages.filter(reply => reply.type === 'bcPermission').length, 0);
        handler(message, { id: 'self', url: runtime.getURL('bc-land/access.html?tab=1') });
        assert.equal(env.messages.find(reply => reply.type === 'bcPermission')?.ok, true);
    } finally { env.close(); }
    assert.equal(listeners.length, 0);
});
test('viewport station overflow is explicit and no viewport reaches NRCS', async () => {
    const sample = snotelStations()[0], catalog = Array.from({ length: 51 }, (_, i) => ({ ...sample, stationTriplet: `${1000 + i}:WA:SNTL` }));
    const env = setup({ catalog });
    try {
        await tick(); env.send({ type: 'stations', requestId: 1, bounds: [-180, 0, 0, 85] }); await tick(); await tick();
        const reply = env.messages.find(message => message.type === 'stations')!;
        assert.equal(reply.overflow, true); assert.equal(reply.stations!.length, 0);
        assert.equal(env.requests.length, 1); assert.equal(new URL(env.requests[0].url).searchParams.has('bbox'), false);
        assert.equal(env.requests[0].options!.credentials, 'omit');
    } finally { env.close(); }
});

test('explicit SNOTEL activation discovers nearby offscreen stations without changing passive viewport queries', async () => {
    const env = setup(), bounds = [-121.761, 46.851, -121.759, 46.853];
    try {
        await tick(); env.send({ type: 'stations', requestId: 1, bounds }); await tick(); await tick();
        assert.equal(env.messages.find(message => message.requestId === 1)?.stations?.length, 0, 'passive pans stay viewport-only');
        env.send({ type: 'stations', requestId: 2, bounds, reveal: true }); await tick(); await tick();
        const revealed = env.messages.find(message => message.requestId === 2)!;
        assert.deepEqual(Array.from(revealed.stations!, station => station.id), ['679:WA:SNTL', '375:WA:SNTL']);
        assert.equal(revealed.nearby, true, 'nearby discovery is explicit in the reply');
        env.send({ type: 'stations', requestId: 3, bounds: [-121.76, 46.78, -121.74, 46.79], reveal: true }); await tick(); await tick();
        const visible = env.messages.find(message => message.requestId === 3)!;
        assert.equal(visible.stations!.length, 1); assert.equal(visible.stations![0].id, '679:WA:SNTL');
        assert.equal(visible.nearby, false, 'already-visible stations do not expand to a nearby search');
        env.send({ type: 'stations', requestId: 4, bounds: [-74.01, 40.69, -74, 40.7], reveal: true }); await tick(); await tick();
        assert.equal(env.messages.find(message => message.requestId === 4)?.stations?.length, 0, 'the reveal stays within 50 km');
        assert.equal(env.requests.length, 1, 'activation reuses the national station catalog');
        assert.equal(new URL(env.requests[0].url).searchParams.has('bbox'), false, 'discovery coordinates stay local');
    } finally { env.close(); }
});

test('SNOTEL activation normalizes wrapped map centers near the date line', async () => {
    const env = setup({ catalog: [{ ...snotelStations()[0], stationTriplet: '1234:AK:SNTL', latitude: 65.12, longitude: -179.7 }] });
    try {
        await tick(); env.send({ type: 'stations', requestId: 1, bounds: [539.8, 64.9, 540.2, 65.1], reveal: true }); await tick(); await tick();
        const reply = env.messages.find(message => message.requestId === 1)!;
        assert.equal(reply.stations!.length, 1); assert.equal(reply.nearby, true);
    } finally { env.close(); }
});
test('off cancels the catalog subscriber and late or opted-out work cannot publish stations', async () => {
    const env = setup({ held: true });
    try {
        await tick(); env.send({ type: 'stations', requestId: 1, bounds: [-180, 0, 0, 85], reveal: true }); await tick();
        assert.equal(env.requests.length, 1); env.send({ type: 'cancel' });
        assert.equal(env.requests[0].options!.signal!.aborted, true); env.requests[0].resolve!(); await tick();
        assert.equal(env.messages.some(message => message.type === 'stations'), false);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showSnotel: false } } }, 'sync')); await tick();
        env.send({ type: 'stations', requestId: 2, bounds: [-180, 0, 0, 85] }); await tick(); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});
test('full-screen handoffs are bounded, expiring, one-use and bound to destination and source tab', async () => {
    let time = Date.now(); const values: Record<string, unknown> = {};
    const storage = { get: async (key: string) => ({ [key]: structuredClone(values[key]) }), set: async (next: Record<string, unknown>) => { Object.assign(values, structuredClone(next)); } };
    const service = createMapLayerHandoff({ storage, now: () => time, isPeakbaggerSender: sender => Boolean(sender?.url?.startsWith('https://www.peakbagger.com/')) });
    const source = { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296', tab: { id: 7, windowId: 2 } } as chrome.runtime.MessageSender;
    const destination = 'https://www.peakbagger.com/map/BigMap.aspx?t=P&d=2296';
    const snapshot = { revision: 5, state: { slope: { enabled: true, opacity: 60 }, wildfire: { enabled: true, opacity: 0 } }, menuOpen: true, cooldowns: { slope: time + 120000, wildfire: time + 180000 }, fires: [{ secret: 'not transferred' }] };
    assert.equal((await service.prepare({ destination: 'https://example.com/map/BigMap.aspx', snapshot }, source)).ok, false);
    await service.prepare({ destination, snapshot }, source);
    assert.match((values.bpbMapLayerHandoffsV1 as { target: string }[])[0].target, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(values).includes(destination), false, 'session storage never retains the native map URL');
    assert.equal((await service.consume({}, { url: destination, tab: { id: 9, windowId: 2 } } as chrome.runtime.MessageSender)).ok, false);
    const target = { url: destination, tab: { id: 9, windowId: 2, openerTabId: 7 } } as chrome.runtime.MessageSender;
    const result = await service.consume({}, target);
    assert.equal(result.ok, true);
    const consumed = result.snapshot as {
        state: Record<string, { enabled: boolean; opacity: number }>;
        menuOpen: boolean;
        cooldowns: Record<string, number>;
    };
    assert.equal(consumed.state.slope.enabled, true); assert.equal(consumed.menuOpen, false);
    assert.equal(consumed.cooldowns.slope, snapshot.cooldowns.slope);
    assert.equal(consumed.state.wildfire.enabled, true); assert.equal(consumed.state.wildfire.opacity, 100);
    assert.equal(consumed.cooldowns.wildfire, snapshot.cooldowns.wildfire); assert.equal(Object.hasOwn(consumed, 'fires'), false);
    assert.equal((await service.consume({}, target)).ok, false);
    await service.prepare({ destination, snapshot }, source); time += 30001; assert.equal((await service.consume({}, target)).ok, false);
});


test('land filter saves preserve explicit empty selection and survive later preference announcements', async () => {
    const env = setup();
    try {
        await tick();
        for (const landTypes of [['USFS', 'BLM', 'USFS', 'private'], []]) {
            env.send({ type: 'save', preferences: { landTypes } }); await tick();
            env.send({ type: 'preferences' });
            const expected = landTypes.length ? ['BLM', 'USFS'] : [];
            assert.deepEqual(JSON.parse(JSON.stringify((env.local.bpbMapOverlayOpacityV1 as { landTypes: string[] }).landTypes)), expected);
            assert.deepEqual(JSON.parse(JSON.stringify(env.messages.filter(message => message.type === 'preferences').at(-1)!.preferences!.landTypes)), expected);
        }
    } finally { env.close(); }
});
