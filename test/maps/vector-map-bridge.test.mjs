// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installVectorMapBridge } from '../../src/maps/vector-map-bridge.js';
import { VECTOR_BASEMAP, VECTOR_MESSAGE, readVectorView, readVectorPaint } from '../../src/maps/vector-basemap.ts';
import { terrainBasemap } from '../../src/terrain/terrain-basemap.js';

const view = { center: [46.85, -121.76], zoom: 9 };
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup({ sendMessage } = {}) {
    const dom = new JSDOM('<select data-bpb-vector-map="test"><option value="BPB_VECTOR">Vector</option><option value="BPB_MAPTOOLKIT">Maptoolkit</option></select><div id="bpb-vector-slot-test-vector"></div><div id="bpb-vector-slot-test-maptoolkit"></div>', { url: 'https://www.peakbagger.com/map/MasterMap.aspx' });
    const win = dom.window, captures = new Map(), calls = [], messages = [];
    win.ImageBitmap = class { width = 640; height = 480; closed = false; close() { this.closed = true; } };
    const add = win.document.addEventListener.bind(win.document);
    win.document.addEventListener = (type, callback, options) => { if (options === true) captures.set(type, callback); add(type, callback, options); };
    win.postMessage = message => messages.push(message);
    const bridge = installVectorMapBridge(win, { runtime: {
        getURL: value => `chrome-extension://test/${value}`,
        sendMessage: async message => { calls.push(message); return sendMessage ? sendMessage(message) : { ok: true, token: 'opaque' }; },
    } });
    const send = (type, extra = {}, source = win, origin = win.location.origin) => win.dispatchEvent(new win.MessageEvent('message', {
        source, origin, data: { [VECTOR_MESSAGE]: true, dir: 'toCS', id: 'test', type, view, ...extra },
    }));
    const choose = (trusted = true, control = win.document.querySelector('select')) => captures.get('change')({ type: 'change', isTrusted: trusted, target: control });
    const frame = () => win.document.querySelector('iframe:not([data-bpb-vector-parked])');
    const fromFrame = (type, origin = 'chrome-extension://test', source = frame()?.contentWindow, detail = {}) => send(type, { dir: 'fromFrame', generation: calls.length, ...detail }, source, origin);
    const retry = disabled => {
        const button = win.document.createElement('button'); button.dataset.bpbVectorMap = 'test'; button.dataset.bpbVectorBasemap = 'vector'; button.setAttribute('aria-disabled', String(disabled));
        captures.get('click')({ type: 'click', isTrusted: true, target: button });
    };
    return { win, calls, messages, send, choose, frame, fromFrame, retry, close() { bridge.dispose(); dom.window.close(); } };
}

test('planar vector views validate coordinates and preserve world zoom zero', () => {
    assert.deepEqual(readVectorView({ center: [0, 0], zoom: -1 }), { center: [0, 0], zoom: -1 });
    for (const bad of [{ ...view, center: [90, 0] }, { ...view, center: [0, 181] }, { ...view, zoom: NaN }, { ...view, zoom: 24 }, { ...view, center: [0, 0, 0] }]) assert.equal(readVectorView(bad), null);
    assert.deepEqual(terrainBasemap.active({}, {}, { value: VECTOR_BASEMAP.code, selectedIndex: 0, options: [{}] }), { kind: 'vector', name: VECTOR_BASEMAP.name });
});
test('paint metadata rejects invalid cameras and unbounded CSS dimensions', () => {
    assert.deepEqual(readVectorPaint({ view, width: 640, height: 480 }), { view, width: 640, height: 480 });
    for (const width of [0, -1, 1.5, NaN, Infinity, 16385, '640']) assert.equal(readVectorPaint({ view, width, height: 480 }), null);
    assert.equal(readVectorPaint({ view: { ...view, zoom: NaN }, width: 640, height: 480 }), null);
});
test('paint relays require the current frame, activation and bounded metadata', async () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); env.fromFrame('ready'); await settle();
        for (const extra of [{ generation: 0 }, { width: 0 }, { view: { center: [0, 0], zoom: NaN } }]) {
            const bitmap = new env.win.ImageBitmap();
            env.fromFrame('painted', undefined, undefined, { bitmap, width: 640, height: 480, ...extra });
            assert.equal(bitmap.closed, true, 'Stale or invalid GPU images are released');
        }
        const bitmap = new env.win.ImageBitmap();
        env.fromFrame('painted', undefined, undefined, { bitmap, width: 640, height: 480 });
        assert.equal(env.messages.at(-1).type, 'painted'); assert.equal(env.messages.at(-1).bitmap, bitmap);
        assert.equal(env.messages.at(-1).basemap, 'vector', 'A queued paint remains scoped to its selected provider');
        assert.equal(bitmap.closed, false, 'The accepted bitmap transfers to the page owner');
        const older = new env.win.ImageBitmap();
        env.fromFrame('painted', undefined, undefined, { bitmap: older, width: 640, height: 480, view: { center: [0, 0], zoom: 9 } });
        assert.equal(older.closed, false, 'Older coupled cameras can be reprojected instead of starving a fast pan');
        env.fromFrame('loaded'); env.send('stop');
        const late = new env.win.ImageBitmap();
        env.fromFrame('painted', undefined, env.win.document.querySelector('iframe').contentWindow, { bitmap: late, width: 640, height: 480 });
        assert.equal(late.closed, true, 'A parked provider cannot paint over the native map');
    } finally { env.close(); }
});
test('renderer paint requests coalesce on the parent clock and cannot survive suspension', async () => {
    const env = setup(), callbacks = [], cancelled = [], sent = [];
    env.win.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    env.win.cancelAnimationFrame = id => cancelled.push(id);
    try {
        env.choose(); env.send('view'); env.fromFrame('ready'); await settle(); env.fromFrame('loaded');
        env.frame().contentWindow.postMessage = data => sent.push(data);
        env.fromFrame('renderNeeded', undefined, undefined, { generation: 0 }); assert.equal(callbacks.length, 0);
        env.fromFrame('renderNeeded'); env.fromFrame('renderNeeded'); assert.equal(callbacks.length, 1);
        callbacks[0](); env.send('renderClock', { generation: 1 }); env.send('render', { generation: 1 });
        assert.equal(sent.filter(data => data.type === 'render').length, 1);
        env.fromFrame('renderNeeded'); env.send('pause'); assert.ok(cancelled.includes(2));
        callbacks[1](); assert.equal(sent.filter(data => data.type === 'render').length, 1, 'A cancelled clock cannot redraw a parked renderer');
    } finally { env.close(); }
});
test('forged selection and page messages cannot start vector requests', () => {
    const env = setup();
    try { env.choose(false); env.send('view'); env.send('resume'); assert.equal(env.frame(), null); assert.deepEqual(env.calls, []); }
    finally { env.close(); }
});
test('only the selected extension frame can obtain one initialization capability', async () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); const frame = env.frame(); assert.ok(frame);
        env.fromFrame('ready', 'https://evil.example'); assert.equal(env.calls.length, 0);
        env.fromFrame('ready', 'chrome-extension://test', env.win); assert.equal(env.calls.length, 0);
        env.fromFrame('ready'); env.fromFrame('ready'); await Promise.resolve();
        assert.deepEqual(env.calls, [{ type: 'VECTOR_MAP_ACTIVATION_ISSUE', action: 'init' }]);
        env.fromFrame('loaded'); assert.equal(env.messages.at(-1).type, 'loaded');
        env.send('stop'); assert.equal(env.frame(), null);
        env.fromFrame('loaded', 'chrome-extension://test', frame.contentWindow);
        assert.equal(env.messages.filter(message => message.type === 'loaded').length, 1, 'Detached frames cannot complete a later selection');
    } finally { env.close(); }
});
test('pause tears down requests while retaining only the current trusted selection', () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); const original = env.frame();
        env.send('pause'); env.send('view'); assert.equal(env.frame(), null);
        env.send('resume'); assert.ok(env.frame()); assert.notEqual(env.frame(), original);
        env.send('stop'); env.send('resume'); assert.equal(env.frame(), null);
    } finally { env.close(); }
});
test('an outgoing authorization rejection cannot destroy the resumed frame', async () => {
    const pending = [], env = setup({ sendMessage: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    try {
        env.choose(); env.send('view'); const outgoing = env.frame(); env.fromFrame('ready');
        env.send('pause'); env.send('resume'); const replacement = env.frame(), sent = [];
        replacement.contentWindow.postMessage = data => sent.push(data);
        env.fromFrame('ready'); assert.equal(pending.length, 2);
        pending[0].reject(new Error('Outgoing worker channel closed')); await settle();
        assert.equal(replacement.isConnected, true, 'The outgoing failure must leave the replacement renderer alive');
        assert.equal(env.frame(), replacement); assert.equal(outgoing.isConnected, false);
        assert.equal(env.messages.some(message => message.type === 'error'), false);
        pending[1].resolve({ ok: true, token: 'replacement-activation' }); await settle();
        assert.equal(sent.find(message => message.type === 'init')?.activation, 'replacement-activation');
    } finally { env.close(); }
});
test('a current authorization rejection still reports an actionable failure', async () => {
    const env = setup({ sendMessage: async () => { throw new Error('Current worker channel closed'); } });
    try {
        env.choose(); env.send('view'); env.fromFrame('ready'); await settle();
        assert.equal(env.frame(), null); assert.equal(env.messages.at(-1)?.type, 'error');
    } finally { env.close(); }
});
test('a busy Retry cannot replace its current renderer or mint another capability', () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); const original = env.frame();
        env.retry(true); env.send('view'); assert.equal(env.frame(), original); assert.equal(env.calls.length, 0);
    } finally { env.close(); }
});
test('bfcache suspension discards vector authority rather than silently restarting requests', () => {
    const env = setup();
    try {
        env.choose(); env.send('view');
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true })); assert.equal(env.frame(), null);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        env.send('resume'); assert.equal(env.frame(), null);
    } finally { env.close(); }
});
test('a provider cooldown survives renderer removal, re-selection and suspension until expiry', () => {
    const realNow = Date.now; let now = realNow(); Date.now = () => now;
    const env = setup(), retryAt = now + 120000;
    try {
        env.choose(); env.send('view'); const outgoing = env.frame().contentWindow;
        env.fromFrame('error', undefined, undefined, { retryAt });
        assert.equal(env.frame(), null); assert.equal(env.messages.at(-1).retryAt, retryAt);
        for (const authorize of [env.choose, () => env.retry(false)]) {
            authorize(); env.send('view'); assert.equal(env.frame(), null, 'Renderer replacement cannot discard Retry-After');
            assert.equal(env.messages.at(-1).retryAt, retryAt);
        }
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        env.choose(); env.send('view'); assert.equal(env.frame(), null);
        env.retry(false); now = retryAt; env.send('view');
        assert.equal(env.frame(), null, 'A blocked click cannot leave authority for a later forged view');
        env.choose(); env.send('view'); assert.ok(env.frame());
        env.fromFrame('error', undefined, outgoing, { retryAt: now + 120000 });
        assert.ok(env.frame(), 'An outgoing frame cannot extend the provider cooldown');
        assert.equal(env.calls.length, 0, 'Blocked selections never request a worker capability');
    } finally { Date.now = realNow; env.close(); }
});
test('a provider cooldown stops every renderer in the isolated document', () => {
    const env = setup(), retryAt = Date.now() + 120000;
    try {
        const second = env.win.document.createElement('select'); second.dataset.bpbVectorMap = 'second';
        second.innerHTML = '<option value="BPB_VECTOR">Vector</option>';
        const slot = env.win.document.createElement('div'); slot.id = 'bpb-vector-slot-second-vector'; env.win.document.body.append(second, slot);
        env.choose(); env.send('view'); const first = env.frame().contentWindow;
        env.choose(true, second); env.send('view', { id: 'second' }); assert.equal(env.win.document.querySelectorAll('iframe').length, 2);
        env.fromFrame('error', undefined, first, { retryAt });
        assert.equal(env.win.document.querySelectorAll('iframe').length, 0);
        assert.deepEqual(env.messages.map(message => [message.id, message.retryAt]), [['test', retryAt], ['second', retryAt]]);
        env.choose(true, second); env.send('view', { id: 'second' }); assert.equal(env.frame(), null); assert.equal(env.calls.length, 0);
    } finally { env.close(); }
});
test('a trusted provider choice cannot be changed by page messages or another provider cooldown', async () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); env.fromFrame('error', undefined, undefined, { retryAt: Date.now() + 120000 });
        env.win.document.querySelector('select').value = 'BPB_MAPTOOLKIT'; env.choose(); env.send('view', { basemap: 'vector' });
        const frame = env.frame(), sent = []; assert.ok(frame, 'OpenFreeMap cooldown does not disable Maptoolkit');
        frame.contentWindow.postMessage = data => sent.push(data); env.fromFrame('ready'); await settle();
        assert.equal(sent.find(item => item.type === 'init')?.basemap, 'maptoolkit');
        assert.equal(frame.title, 'Maptoolkit vector basemap');
    } finally { env.close(); }
});
test('untrusted and unbounded cooldown messages cannot disable future vector selections', () => {
    for (const retryAt of [Date.now() - 1, Date.now() + 86401000, Infinity, '120000']) {
        const env = setup();
        try {
            env.choose(); env.send('view'); env.send('error', { retryAt }); assert.ok(env.frame());
            env.fromFrame('error', undefined, undefined, { retryAt }); env.choose(); env.send('view'); assert.ok(env.frame());
        } finally { env.close(); }
    }
});

test('a completed renderer can warm-start only after a fresh trusted choice and capability', async () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); const original = env.frame();
        env.fromFrame('ready'); await settle(); env.fromFrame('loaded');
        env.send('stop'); assert.equal(env.frame(), null); assert.equal(original.isConnected, true, 'The initialized frame stays bounded in memory');
        const count = env.calls.length;
        env.send('resume'); env.send('view'); env.choose(false);
        assert.equal(env.calls.length, count, 'A parked frame has no page-owned activation authority');
        const sent = []; original.contentWindow.postMessage = data => sent.push(data);
        env.choose(); env.send('view'); await settle();
        assert.equal(env.frame(), original, 'The trusted choice reuses its own provider frame');
        assert.equal(env.calls.length, count + 1); assert.equal(sent.find(data => data.type === 'resume')?.generation, 2);
        const loaded = env.messages.filter(data => data.type === 'loaded').length;
        env.fromFrame('loaded', undefined, undefined, { generation: 1 });
        assert.equal(env.messages.filter(data => data.type === 'loaded').length, loaded, 'The previous activation cannot complete the new selection');
        env.fromFrame('error', undefined, undefined, { generation: 1 }); assert.equal(env.frame(), original, 'A stale failure cannot destroy the new activation');
        env.fromFrame('loaded'); assert.equal(env.messages.filter(data => data.type === 'loaded').length, loaded + 1);
        env.send('dispose'); assert.equal(original.isConnected, false);
    } finally { env.close(); }
});

test('parked renderer expiry frees its resources without restoring activation authority', async () => {
    const env = setup(), timers = [];
    env.win.setTimeout = (callback, ms) => { timers.push({ callback, ms }); return timers.length; };
    env.win.clearTimeout = () => {};
    try {
        env.choose(); env.send('view'); const original = env.frame(); env.fromFrame('ready'); await settle(); env.fromFrame('loaded');
        env.send('stop'); const expiry = timers.find(item => item.ms === 60000); assert.ok(expiry);
        expiry.callback(); assert.equal(original.isConnected, false);
        env.send('resume'); env.send('view'); assert.equal(env.frame(), null);
        env.choose(); env.send('view'); assert.ok(env.frame()); assert.notEqual(env.frame(), original);
    } finally { env.close(); }
});

test('an outgoing warm authorization cannot tear down a newer activation of the same frame', async () => {
    const pending = [], env = setup({ sendMessage: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    try {
        env.choose(); env.send('view'); const original = env.frame(); env.fromFrame('ready');
        pending[0].resolve({ ok: true, token: 'initial' }); await settle(); env.fromFrame('loaded');
        env.send('stop'); env.choose(); env.send('view'); assert.equal(pending.length, 2);
        env.send('stop'); env.choose(); env.send('view'); assert.equal(pending.length, 3);
        pending[1].reject(new Error('Outgoing warm channel closed')); await settle();
        assert.equal(env.frame(), original); assert.equal(env.messages.some(data => data.type === 'error'), false);
        pending[2].resolve({ ok: true, token: 'current' }); await settle(); env.fromFrame('loaded');
        assert.equal(env.frame(), original); env.send('pause');
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(original.isConnected, false, 'BFCache releases parked frames and their authorization');
    } finally { env.close(); }
});

test('each provider keeps its own bounded warm renderer and a parked limit cannot disable the other', async () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); const vector = env.frame(); env.fromFrame('ready'); await settle(); env.fromFrame('loaded');
        env.win.document.querySelector('select').value = 'BPB_MAPTOOLKIT'; env.choose(); env.send('view');
        const toolkit = env.frame(); env.fromFrame('ready'); await settle(); env.fromFrame('loaded');
        assert.notEqual(vector, toolkit); assert.equal(env.win.document.querySelectorAll('iframe').length, 2);
        env.win.document.querySelector('select').value = 'BPB_VECTOR'; env.choose(); env.send('view'); await settle();
        assert.equal(env.frame(), vector); assert.equal(env.calls.length, 3);
        env.fromFrame('error', undefined, toolkit.contentWindow, { retryAt: Date.now() + 120000 });
        assert.equal(toolkit.isConnected, false); assert.equal(env.frame(), vector);
        env.send('dispose'); assert.equal(env.win.document.querySelectorAll('iframe').length, 0);
    } finally { env.close(); }
});

test('a parked renderer that fails is replaced on reselection rather than awaited', async () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); env.fromFrame('ready'); await settle();
        const parked = env.frame();
        env.fromFrame('painted', undefined, undefined, { bitmap: new env.win.ImageBitmap(), width: 640, height: 480 });
        env.send('stop');
        assert.equal(parked.dataset.bpbVectorParked, 'true');
        const generation = env.calls.length;
        env.send('error', { dir: 'fromFrame', generation }, parked.contentWindow, 'chrome-extension://test');
        assert.equal(parked.isConnected, false, 'A renderer that disposed itself while parked is not retained');
        env.choose(); env.send('view');
        assert.notEqual(env.frame(), parked, 'Reselection boots a live renderer instead of waiting 20 seconds on a dead one');
    } finally { env.close(); }
});

test('a renderer failing during 3D suspension leaves the selection able to resume', async () => {
    const env = setup();
    try {
        env.choose(); env.send('view'); env.fromFrame('ready'); await settle();
        const paused = env.frame();
        env.fromFrame('painted', undefined, undefined, { bitmap: new env.win.ImageBitmap(), width: 640, height: 480 });
        env.send('pause');
        const generation = env.calls.length;
        env.send('error', { dir: 'fromFrame', generation, retryAt: Date.now() + 1 }, paused.contentWindow, 'chrome-extension://test');
        env.send('error', { dir: 'fromFrame', generation }, paused.contentWindow, 'chrome-extension://test');
        assert.equal(paused.isConnected, false);
        assert.equal(env.messages.some(message => message.type === 'error'), false, 'A suspended page ignores errors, so none is spent on it');
        await new Promise(resolve => setTimeout(resolve, 5));
        env.send('resume');
        assert.ok(env.frame(), 'Returning from 3D starts a new renderer for the retained selection');
        assert.notEqual(env.frame(), paused);
    } finally { env.close(); }
});
