// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainOverlays } from '../../src/terrain/terrain-overlays.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const id of ['slope', 'land']) test(`terrain ${id} retry publishes loading and keeps its painted source`, async t => {
    const held = [], posts = [], sources = new Map(), layers = new Map(); let protocol;
    const previous = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => held.push(resolve)));
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getLayer: id => layers.get(id), getSource: id => sources.get(id),
        addLayer: layer => layers.set(layer.id, layer), addSource: (id, source) => sources.set(id, { ...source, setTiles(tiles) { this.tiles = tiles; } }),
        removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id), setPaintProperty() {}, moveLayer() {} };
    const document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }), toBlob: callback => callback(new Blob(['png'])) }) };
    const owner = createTerrainOverlays({ map, document, maplibre: { addProtocol: (_name, handler) => { protocol = handler; }, removeProtocol() {} }, post: (type, value) => posts.push({ type, ...value }) });
    const latest = () => posts.filter(item => item.id === id).at(-1);
    const draw = () => protocol({ url: `bpb-overlay://${id}/0/10/163/359` }, new AbortController());
    try {
        owner.update({ revision: 1, state: { [id]: { enabled: true, opacity: 60 } } });
        const first = draw(); await tick(); assert.equal(latest().pending, true);
        held.shift()(new Response('', { status: 404 })); await assert.rejects(first);
        assert.equal(latest().error, true); assert.equal(latest().pending, false); assert.equal(latest().retry, true);
        const originalSource = [...sources.keys()][0];
        owner.action({ id, action: 'retry' }); assert.equal(latest().pending, true); assert.equal(latest().error, false);
        assert.equal([...sources.keys()][0], originalSource, 'retry retains the painted source rather than removing good shading');
        const retrySource = [...sources.keys()][0]; owner.action({ id, action: 'retry' });
        assert.equal([...sources.keys()][0], retrySource, 'repeated actions cannot restart a pending source');
        const next = draw(); await tick();
        owner.update({ revision: 2, state: { [id]: { enabled: true, opacity: 50 } } });
        assert.equal(latest().revision, 2); assert.equal(latest().pending, true, 'opacity updates reattach current loading to the accepted revision');
        held.shift()(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })); await next;
        assert.equal(latest().pending, false); assert.equal(latest().error, false); assert.equal(latest().retry, false);
        const count = posts.length; owner.tileError([...sources.keys()][0], new DOMException('Cancelled.', 'AbortError'));
        assert.equal(posts.length, count, 'cancelled renderer work is not a user-visible failure');
    } finally { owner.dispose(); }
});
test('terrain feedback preserves a provider cooldown through first load, opacity changes and resume', () => {
    const posts = [], sources = new Map(), retryAt = Date.now() + 120000;
    const map = { getStyle: () => ({ layers: [] }), getLayer() {}, getSource: id => sources.get(id),
        addSource: (id, source) => sources.set(id, source), addLayer() {}, setPaintProperty() {}, moveLayer() {} };
    const owner = createTerrainOverlays({ map, document: {}, maplibre: {}, post: (_type, value) => posts.push(value) });
    const snapshot = revision => ({ revision, state: { land: { enabled: true, opacity: 25 } }, cooldowns: { land: retryAt } });
    try {
        owner.update(snapshot(1));
        assert.equal(posts.filter(item => item.id === 'land').at(-1).retryAt, retryAt);
        assert.equal(posts.filter(item => item.id === 'land').at(-1).error, true); assert.equal(sources.size, 0);
        owner.update({ ...snapshot(2), state: { land: { enabled: true, opacity: 50 } } });
        owner.suspend(); owner.update(snapshot(3)); owner.action({ id: 'land', action: 'retry' });
        assert.equal(posts.filter(item => item.id === 'land').at(-1).retryAt, retryAt); assert.equal(sources.size, 0, 'replaying feedback never clears a known service wait or creates blocked work');
    } finally { owner.dispose(); }
});
