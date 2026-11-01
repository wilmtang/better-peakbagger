// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installVectorMapBridge } from '../../src/maps/vector-map-bridge.js';
import { VECTOR_BASEMAP, VECTOR_MESSAGE, readVectorView } from '../../src/maps/vector-basemap.js';
import { terrainBasemap } from '../../src/terrain/terrain-basemap.js';

const view = { center: [46.85, -121.76], zoom: 9 };
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup({ sendMessage } = {}) {
    const dom = new JSDOM('<select data-bpb-vector-map="test"><option value="BPB_VECTOR">Vector</option></select><div id="bpb-vector-slot-test"></div>', { url: 'https://www.peakbagger.com/map/MasterMap.aspx' });
    const win = dom.window, captures = new Map(), calls = [], messages = [];
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
    const choose = (trusted = true) => captures.get('change')({ type: 'change', isTrusted: trusted, target: win.document.querySelector('select') });
    const frame = () => win.document.querySelector('iframe');
    const fromFrame = (type, origin = 'chrome-extension://test', source = frame()?.contentWindow) => send(type, { dir: 'fromFrame' }, source, origin);
    const retry = disabled => {
        const button = win.document.createElement('button'); button.dataset.bpbVectorMap = 'test'; button.setAttribute('aria-disabled', String(disabled));
        captures.get('click')({ type: 'click', isTrusted: true, target: button });
    };
    return { win, calls, messages, send, choose, frame, fromFrame, retry, close() { bridge.dispose(); dom.window.close(); } };
}

test('planar vector views validate coordinates and preserve world zoom zero', () => {
    assert.deepEqual(readVectorView({ center: [0, 0], zoom: -1 }), { center: [0, 0], zoom: -1 });
    for (const bad of [{ ...view, center: [90, 0] }, { ...view, center: [0, 181] }, { ...view, zoom: NaN }, { ...view, zoom: 24 }, { ...view, center: [0, 0, 0] }]) assert.equal(readVectorView(bad), null);
    assert.deepEqual(terrainBasemap.active({}, {}, { value: VECTOR_BASEMAP.code, selectedIndex: 0, options: [{}] }), { kind: 'vector', name: VECTOR_BASEMAP.name });
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
