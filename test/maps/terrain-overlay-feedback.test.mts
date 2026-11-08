// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error jsdom ships no type declarations, so page objects stay untyped here.
import { JSDOM } from 'jsdom';
type PageValue = JSDOM;
import { createTerrainOverlays } from '../../src/terrain/terrain-overlays.ts';
const createOverlays = createTerrainOverlays as unknown as (options: PageValue) => PageValue;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('custom terrain errors replay on a newer snapshot without restarting failed reads', async t => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/', pretendToBeVisual: true });
    const previous = (globalThis as PageValue).chrome, posts: PageValue = [];
    let reads = 0, catalogs = 0;
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind: 'raster',
        source: { tiles: [], metadataUrl: 'https://tiles.example.com/source.json', scheme: 'xyz', minNativeZoom: 0, maxNativeZoom: 18, tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
    (globalThis as PageValue).chrome = { runtime: { getURL: (path: PageValue) => path, sendMessage: async () => { catalogs++; return { ok: true, registry: { schemaVersion: 1, revision: 1, sources: [source] } }; } } };
    t.after(() => { if (previous === undefined) delete (globalThis as PageValue).chrome; else (globalThis as PageValue).chrome = previous; dom.window.close(); });
    dom.window.fetch = async () => { reads++; throw new TypeError('Controlled unavailable'); };
    const map = { getStyle: () => ({ layers: [] }), getLayersOrder: () => [], getSource() {}, getLayer() {} };
    const owner = createOverlays({ map, document: dom.window.document, maplibre: { addProtocol() {}, removeProtocol() {} }, post: (type: PageValue, value: PageValue) => posts.push({ type, ...value }) });
    const snapshot = { revision: 1, state: {}, custom: [{ id: source.id, sourceRevision: 1, enabled: true }], customSession: 'fixture' };
    try {
        owner.update(snapshot);
        for (let n = 0; n < 20 && !posts.some((item: PageValue) => item.type === 'customLayerStatus' && item.status.error); n++) await tick();
        assert(posts.some((item: PageValue) => item.type === 'customLayerStatus' && item.status.error));
        owner.update({ ...snapshot, revision: 2, menuOpen: true });
        const latest = posts.filter((item: PageValue) => item.type === 'customLayerStatus').at(-1);
        assert.equal(latest.revision, 2); assert.equal(latest.status.error, true); assert.equal(latest.status.pending, false);
        assert.equal(reads, 1); assert.equal(catalogs, 1, 'status replay does no new I/O');
    } finally { owner.dispose(); }
});

test('terrain scene changes reload the existing raster source and leave other layers attached', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sources = new Map(), layers = new Map(), urls: PageValue = [], posts: PageValue = [];
    let scene = 'original';
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [{ id: scene, collection: 'sentinel-2-l2a',
        properties: { datetime: new Date(Date.now() - 86400000).toISOString(), platform: 'Sentinel-2B', 'sat:relative_orbit': 13 },
        geometry: { type: 'Polygon', coordinates: [[[-122, 46], [-121, 46], [-121, 47], [-122, 47], [-122, 46]]] } }] })));
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getLayersOrder: () => [...layers.keys()], getLayer: (id: PageValue) => layers.get(id), getSource: (id: PageValue) => sources.get(id),
        getZoom: () => 12, getBounds: () => ({ getWest: () => -122, getEast: () => -121, getSouth: () => 46, getNorth: () => 47 }),
        addLayer: (layer: PageValue) => layers.set(layer.id, layer), addSource: (id: PageValue, source: PageValue) => sources.set(id, { ...source, setTiles(next: PageValue) { this.tiles = next; urls.push(next); } }),
        removeLayer: (id: PageValue) => layers.delete(id), removeSource: (id: PageValue) => sources.delete(id), setPaintProperty() {}, moveLayer() {} };
    const owner = createOverlays({ map, document: {}, maplibre: { addProtocol() {}, removeProtocol() {} }, post: (_type: PageValue, value: PageValue) => posts.push(value) });
    try {
        owner.update({ revision: 1, state: Object.fromEntries(['sentinel', 'slope', 'land'].map(id => [id, { enabled: true, opacity: 60 }])) });
        await tick();
        const originalSources = [...sources.values()], originalLayers = [...layers.values()];
        assert.equal(originalSources.length, 3);
        scene = 'next'; owner.refresh(); t.mock.timers.tick(300); await tick();
        assert.deepEqual([...sources.values()], originalSources, 'a pan keeps the existing raster textures reachable');
        assert.deepEqual([...layers.values()], originalLayers);
        assert.equal(urls.length, 1); assert.match(urls[0][0], /sentinel\/2\//, 'a fresh revision replaces the scene data in place');
        scene = 'next'; owner.refresh(); t.mock.timers.tick(300); await tick();
        assert.equal(urls.length, 1, 'unchanged mosaics never reload the raster source');
        assert.equal(posts.filter((item: PageValue) => item.id === 'sentinel').at(-1).capturePending, false);
        owner.suspend(); assert.equal(sources.size, 0); assert.equal(layers.size, 0);
    } finally { owner.dispose(); }
});

for (const id of ['slope', 'land', 'snow']) test(`terrain ${id} retry publishes loading and keeps its painted source`, async t => {
    const held: PageValue = [], posts: PageValue = [], sources = new Map(), layers = new Map(); let protocol: PageValue;
    const previous = (globalThis as PageValue).createImageBitmap;
    (globalThis as PageValue).createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    t.after(() => { if (previous === undefined) delete (globalThis as PageValue).createImageBitmap; else (globalThis as PageValue).createImageBitmap = previous; });
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => held.push(resolve)));
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getLayersOrder: () => [...layers.keys()], getLayer: (name: PageValue) => layers.get(name), getSource: (name: PageValue) => sources.get(name),
        addLayer: (layer: PageValue) => layers.set(layer.id, layer), addSource: (name: PageValue, source: PageValue) => sources.set(name, { ...source, setTiles(tiles: PageValue) { this.tiles = tiles; } }),
        removeLayer: (name: PageValue) => layers.delete(name), removeSource: (name: PageValue) => sources.delete(name), setPaintProperty() {}, moveLayer() {} };
    const document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }), toBlob: (callback: PageValue) => callback(new Blob(['png'])) }) };
    const owner = createOverlays({ map, document, maplibre: { addProtocol: (_name: PageValue, handler: PageValue) => { protocol = handler; }, removeProtocol() {} }, post: (type: PageValue, value: PageValue) => posts.push({ type, ...value }) });
    const latest = () => posts.filter((item: PageValue) => item.id === id).at(-1);
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
    const posts: PageValue = [], sources = new Map(), retryAt = Date.now() + 120000;
    const map = { getStyle: () => ({ layers: [] }), getLayersOrder: () => [], getLayer() {}, getSource: (id: PageValue) => sources.get(id),
        addSource: (id: PageValue, source: PageValue) => sources.set(id, source), addLayer() {}, setPaintProperty() {}, moveLayer() {} };
    const owner = createOverlays({ map, document: {}, maplibre: {}, post: (_type: PageValue, value: PageValue) => posts.push(value) });
    const snapshot = (revision: PageValue) => ({ revision, state: { land: { enabled: true, opacity: 25 } }, cooldowns: { land: retryAt } });
    try {
        owner.update(snapshot(1));
        assert.equal(posts.filter((item: PageValue) => item.id === 'land').at(-1).retryAt, retryAt);
        assert.equal(posts.filter((item: PageValue) => item.id === 'land').at(-1).error, true); assert.equal(sources.size, 0);
        owner.update({ ...snapshot(2), state: { land: { enabled: true, opacity: 50 } } });
        owner.suspend(); owner.update(snapshot(3)); owner.action({ id: 'land', action: 'retry' });
        assert.equal(posts.filter((item: PageValue) => item.id === 'land').at(-1).retryAt, retryAt); assert.equal(sources.size, 0, 'replaying feedback never clears a known service wait or creates blocked work');
    } finally { owner.dispose(); }
});

test('terrain filter changes invalidate old tile identities while opacity and menu updates retain the source', async () => {
    const sources = new Map(), layers = new Map(); let protocol: PageValue;
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getLayersOrder: () => [...layers.keys()], getLayer: (id: PageValue) => layers.get(id), getSource: (id: PageValue) => sources.get(id),
        addLayer: (layer: PageValue) => layers.set(layer.id, layer), addSource: (id: PageValue, source: PageValue) => sources.set(id, source),
        removeLayer: (id: PageValue) => layers.delete(id), removeSource: (id: PageValue) => sources.delete(id), setPaintProperty() {}, moveLayer() {} };
    const owner = createOverlays({ map, document: {}, maplibre: { addProtocol: (_name: PageValue, handler: PageValue) => { protocol = handler; }, removeProtocol() {} }, post() {} });
    const value = { revision: 1, state: { land: { enabled: true, opacity: 25 }, slope: { enabled: true, opacity: 60 } } };
    try {
        owner.update(value); const original = [...sources.entries()], stale = original.find(([id]: PageValue[]) => id.includes('land'))![1].tiles[0].replace('{z}/{x}/{y}', '10/163/359');
        owner.update({ ...value, revision: 2, landTypes: ['BLM'] });
        const filtered = [...sources.entries()], land = filtered.find(([id]: PageValue[]) => id.includes('land'))!;
        assert.notEqual(land[0], original.find(([id]: PageValue[]) => id.includes('land'))![0]);
        assert.equal(filtered.find(([id]: PageValue[]) => id.includes('slope'))![1], original.find(([id]: PageValue[]) => id.includes('slope'))![1]);
        assert.match(land[1].tiles[0], /land\/1\//);
        await assert.rejects(protocol({ url: stale }, new AbortController()), { name: 'AbortError' });
        owner.update({ ...value, revision: 3, menuOpen: true, landTypes: ['BLM'], state: { ...value.state, land: { enabled: true, opacity: 50 } } });
        assert.equal(sources.get(land[0]), land[1], 'pan, opacity and disclosure snapshots never remove painted tiles');
        owner.update({ ...value, revision: 4, landTypes: [] });
        assert.equal([...sources.keys()].some(id => id.includes('land')), false, 'empty selection immediately removes old land pixels');
    } finally { owner.dispose(); }
});
