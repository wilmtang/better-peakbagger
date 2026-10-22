// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeafletOverlays } from '../../src/maps/map-overlay-leaflet.js';
import { JSDOM } from 'jsdom';
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const id of ['slope', 'land']) for (const toggled of [false, true]) test(`${id} retry mounts a cooldown-blocked layer${toggled ? ' after off/on' : ' from a handoff'} at its saved opacity`, async t => {
    let now = Date.now(), requests = 0;
    t.mock.method(Date, 'now', () => now);
    const oldBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    t.after(() => { if (oldBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = oldBitmap; });
    const opacities = [], activity = [];
    const document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }) }) };
    const map = { getPane: () => ({}), removeLayer() {} };
    const win = { document, addEventListener() {}, removeEventListener() {}, fetch: async () => {
        requests++; return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    }, L: { GridLayer: { extend(methods) {
        class Grid {
            on() {} setOpacity(value) { opacities.push(value); }
            addTo() { this.createTile({ z: 14, x: 2666, y: 5796 }, () => {}); }
        }
        Object.assign(Grid.prototype, methods); return Grid;
    } } } };
    const owner = createLeafletOverlays({ win, map, onActivity: (_id, value) => activity.push(value) });
    const state = { enabled: true, opacity: 37, retryAt: now + 120000 };
    try {
        owner.set(id, state);
        if (toggled) { owner.set(id, { ...state, enabled: false }); owner.set(id, state); }
        owner.retry(id); await tick(); assert.equal(requests, 0, 'retry respects the active handoff cooldown');
        now = state.retryAt + 1; owner.retry(id); await tick();
        assert.equal(requests, 1, 'retry requests tiles even when no layer was mounted');
        assert.deepEqual(opacities, [.37]);
        assert.equal(activity.at(-1)?.complete, true, 'loading settles after the requested tile paints');
        owner.set(id, { ...state, enabled: false }); owner.retry(id); await tick();
        assert.equal(requests, 1, 'retry cannot restore a disabled layer');
        owner.set(id, { ...state, opacity: 0 }); owner.retry(id); await tick();
        assert.equal(requests, 1, 'retry cannot restore a fully transparent layer');
    } finally { owner.dispose(); }
});

test('native station membership updates preserve the open popup, marker and focused NRCS link', () => {
    const dom = new JSDOM('<body></body>'), win = dom.window, markers = [], groups = [], removed = [];
    const station = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78, longitude: -121.74, elevation: 1570 };
    win.fetch = async () => { throw new Error('Unexpected fetch'); };
    win.L = { layerGroup: () => { const group = { addTo() { groups.push(this); }, removeLayer() {} }; return group; },
        marker: () => { const marker = { bindPopup(content) { this.content = content; return this; }, addTo() { markers.push(this); return this; } }; return marker; },
        divIcon: () => ({}) };
    const owner = createLeafletOverlays({ win, map: { removeLayer: layer => removed.push(layer) } });
    try {
        owner.stations([station]); win.document.body.append(markers[0].content);
        const link = markers[0].content.querySelector('a'); link.focus();
        owner.stations([station], { selectable: new Set([station.id]), onSelect() {} });
        assert.equal(markers.length, 1, 'membership changes must not replace an open marker');
        assert.equal(removed.length, 0, 'the existing popup remains on the map');
        assert.equal(win.document.activeElement, link, 'the NRCS link keeps focus');
        const action = markers[0].content.querySelector('button'); assert.ok(action); action.focus();
        owner.stations([station]);
        assert.equal(markers[0].content.querySelector('button'), null);
        assert.equal(win.document.activeElement, link, 'revoking a focused action falls back to the same station link');
    } finally { owner.dispose(); win.close(); }
});

for (const id of ['slope', 'land', 'sentinel']) test(`${id} retry fills missing tiles while leaving successful native canvases in place`, async t => {
    const oldBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    t.after(() => { if (oldBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = oldBitmap; });
    let now = Date.now(), calls = 0, limited; const held = [], canvases = [], done = new Map();
    t.mock.method(Date, 'now', () => now);
    const document = { createElement: () => {
        const canvas = { painted: 0 }; canvas.getContext = () => ({ clearRect() {}, drawImage() { canvas.painted++; } }); return canvas;
    } };
    const image = () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    const map = { getPane: () => ({}), removeLayer(current) { for (const canvas of canvases) current.events.tileunload({ tile: canvas }); } };
    const win = { document, addEventListener() {}, removeEventListener() {}, fetch: (_url, { signal }) => {
        calls++; if (calls === 2 || calls > 3) return Promise.resolve(image());
        if (id === 'land' && calls === 1) { held.push(null); return Promise.resolve(new Response('', { status: 404 })); }
        return new Promise((resolve, reject) => {
            held.push(resolve); signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true });
        });
    }, L: { GridLayer: { extend(methods) {
        class Grid {
            constructor() { this.events = {}; }
            on(name, callback) { this.events[name] = callback; }
            setOpacity() { return this; }
            redraw() { for (const canvas of canvases) canvas.painted = 0; this.addTo(); }
            addTo() {
                for (let x = 2666; x < 2669; x++) {
                    const canvas = this.createTile({ z: 14, x, y: 5796 }, error => done.set(canvas, error?.name || 'loaded')); canvases.push(canvas);
                }
            }
        }
        Object.assign(Grid.prototype, methods); return Grid;
    } } } };
    const owner = createLeafletOverlays({ win, map, onError: (_id, error) => { limited = error.retryAt; } });
    try {
        if (id === 'sentinel') owner.scenes([{ id: 'scene_new', bounds: [-122, 46, -121, 47] }], 60);
        else owner.set(id, { enabled: true, opacity: 60 });
        await tick();
        const painted = canvases[1].painted; assert.ok(painted > 0);
        held[1](new Response('', { status: 429, headers: { 'retry-after': '120' } })); await tick();
        assert.equal(done.get(canvases[0]), id === 'land' ? 'Error' : 'AbortError'); assert.equal(done.get(canvases[2]), 'RateLimitError');
        owner.retry(id); await tick(); assert.equal(calls, 3, 'the provider cooldown cannot be bypassed');
        now = limited + 1; owner.retry(id); await tick();
        assert.equal(canvases[1].painted, painted, 'successful shading is untouched');
        assert.equal(calls, 5, 'both the rejected tile and its aborted neighbor are retried');
        assert.ok(canvases.every(canvas => done.get(canvas) === 'loaded'));
    } finally { owner.dispose(); }
});
