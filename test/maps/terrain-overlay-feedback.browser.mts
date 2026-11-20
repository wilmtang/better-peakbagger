/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { createTerrainOverlays } from '../../src/terrain/terrain-overlays.ts';

// The overlay owner talks to a MapLibre map, document and protocol registry;
// these stubs implement only the calls it makes, so the options stay loose.
const createOverlays = createTerrainOverlays as unknown as (options: object) => ReturnType<typeof createTerrainOverlays>;
// A status post as the assertions read it.
interface Post {
    type?: string; id?: string; revision?: number; pending?: boolean; error?: boolean; retry?: boolean;
    capturePending?: boolean; retryAt?: number; status?: { error?: boolean; pending?: boolean };
}
interface StyleLayer { id: string }
interface StubSource { tiles: string[]; setTiles?(tiles: string[]): void }
type Protocol = (request: { url: string }, controller: AbortController) => Promise<unknown>;
type Extension = { chrome?: unknown; createImageBitmap?: unknown };
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const tick = () => new Promise(resolve => nativeSetTimeout(resolve, 0));
async function waitUntil(ready: () => boolean, label: string, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await tick();
    }
}

test('custom terrain errors replay on a newer snapshot without restarting failed reads', async t => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const previous = (globalThis as Extension).chrome, posts: Post[] = [];
    let reads = 0, catalogs = 0;
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind: 'raster',
        source: { tiles: [], metadataUrl: 'https://tiles.example.com/source.json', scheme: 'xyz', minNativeZoom: 0, maxNativeZoom: 18, tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
    (globalThis as Extension).chrome = { runtime: { getURL: (path: string) => path, sendMessage: async () => { catalogs++; return { ok: true, registry: { schemaVersion: 1, revision: 1, sources: [source] } }; } } };
    t.after(() => { if (previous === undefined) delete (globalThis as Extension).chrome; else (globalThis as Extension).chrome = previous; dom.window.close(); });
    (dom.window as unknown as { fetch: () => Promise<never> }).fetch = async () => { reads++; throw new TypeError('Controlled unavailable'); };
    const map = { getStyle: () => ({ layers: [] }), getLayersOrder: () => [], getSource() {}, getLayer() {} };
    const owner = createOverlays({ map, document: dom.window.document, maplibre: { addProtocol() {}, removeProtocol() {} }, post: (type: string, value: Post) => posts.push({ type, ...value }) });
    const snapshot = { revision: 1, state: {}, custom: [{ id: source.id, sourceRevision: 1, enabled: true }], customSession: 'fixture' };
    try {
        owner.update(snapshot);
        for (let n = 0; n < 20 && !posts.some((item: Post) => item.type === 'customLayerStatus' && item.status!.error); n++) await tick();
        assert(posts.some((item: Post) => item.type === 'customLayerStatus' && item.status!.error));
        owner.update({ ...snapshot, revision: 2, menuOpen: true });
        const latest = posts.filter((item: Post) => item.type === 'customLayerStatus').at(-1);
        assert.equal(latest!.revision, 2); assert.equal(latest!.status!.error, true); assert.equal(latest!.status!.pending, false);
        assert.equal(reads, 1); assert.equal(catalogs, 1, 'status replay does no new I/O');
    } finally { owner.dispose(); }
});

test('terrain scene changes reload the existing raster source and leave other layers attached', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sources = new Map<string, StubSource>(), layers = new Map<string, StyleLayer>(), urls: string[][] = [], posts: Post[] = [];
    let scene = 'original';
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [{ id: scene, collection: 'sentinel-2-l2a',
        properties: { datetime: new Date(Date.now() - 86400000).toISOString(), platform: 'Sentinel-2B', 'sat:relative_orbit': 13 },
        geometry: { type: 'Polygon', coordinates: [[[-122, 46], [-121, 46], [-121, 47], [-122, 47], [-122, 46]]] } }] })));
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getLayersOrder: () => [...layers.keys()], getLayer: (id: string) => layers.get(id), getSource: (id: string) => sources.get(id),
        getZoom: () => 12, getBounds: () => ({ getWest: () => -122, getEast: () => -121, getSouth: () => 46, getNorth: () => 47 }),
        addLayer: (layer: StyleLayer) => layers.set(layer.id, layer), addSource: (id: string, source: StubSource) => sources.set(id, { ...source, setTiles(next: string[]) { this.tiles = next; urls.push(next); } }),
        removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), setPaintProperty() {}, moveLayer() {} };
    const owner = createOverlays({ map, document: {}, maplibre: { addProtocol() {}, removeProtocol() {} }, post: (_type: string, value: Post) => posts.push(value) });
    try {
        owner.update({ revision: 1, state: Object.fromEntries(['sentinel', 'slope', 'land'].map(id => [id, { enabled: true, opacity: 60 }])) });
        await waitUntil(() => sources.size === 3, 'initial three overlay sources');
        const originalSources = [...sources.values()], originalLayers = [...layers.values()];
        assert.equal(originalSources.length, 3);
        scene = 'next'; owner.refresh(); t.mock.timers.tick(300);
        await waitUntil(() => urls.length === 1, 'sentinel raster tile reload');
        assert.deepEqual([...sources.values()], originalSources, 'a pan keeps the existing raster textures reachable');
        assert.deepEqual([...layers.values()], originalLayers);
        assert.equal(urls.length, 1); assert.match(urls[0][0], /sentinel\/2\//, 'a fresh revision replaces the scene data in place');
        const beforeThird = posts.length;
        scene = 'next'; owner.refresh(); t.mock.timers.tick(300);
        await waitUntil(() => posts.length > beforeThird && posts.filter((item: Post) => item.id === 'sentinel').at(-1)?.capturePending === false, 'unchanged mosaic refresh to settle');
        assert.equal(urls.length, 1, 'unchanged mosaics never reload the raster source');
        assert.equal(posts.filter((item: Post) => item.id === 'sentinel').at(-1)!.capturePending, false);
        owner.suspend(); assert.equal(sources.size, 0); assert.equal(layers.size, 0);
    } finally { owner.dispose(); }
});

for (const id of ['slope', 'land', 'snow']) test(`terrain ${id} retry publishes loading and keeps its painted source`, async t => {
    const held: ((response: Response) => void)[] = [], posts: Post[] = [], sources = new Map<string, StubSource>(), layers = new Map<string, StyleLayer>(); let protocol!: Protocol;
    const previous = (globalThis as Extension).createImageBitmap;
    (globalThis as Extension).createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    t.after(() => { if (previous === undefined) delete (globalThis as Extension).createImageBitmap; else (globalThis as Extension).createImageBitmap = previous; });
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => held.push(resolve)));
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getLayersOrder: () => [...layers.keys()], getLayer: (name: string) => layers.get(name), getSource: (name: string) => sources.get(name),
        addLayer: (layer: StyleLayer) => layers.set(layer.id, layer), addSource: (name: string, source: StubSource) => sources.set(name, { ...source, setTiles(tiles: string[]) { this.tiles = tiles; } }),
        removeLayer: (name: string) => layers.delete(name), removeSource: (name: string) => sources.delete(name), setPaintProperty() {}, moveLayer() {} };
    const document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }), toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['png'])) }) };
    const owner = createOverlays({ map, document, maplibre: { addProtocol: (_name: string, handler: Protocol) => { protocol = handler; }, removeProtocol() {} }, post: (type: string, value: Post) => posts.push({ type, ...value }) });
    const latest = () => posts.filter((item: Post) => item.id === id).at(-1);
    const draw = () => protocol({ url: `bpb-overlay://${id}/0/10/163/359` }, new AbortController());
    try {
        owner.update({ revision: 1, state: { [id]: { enabled: true, opacity: 60 } } });
        const first = draw(); await tick(); assert.equal(latest()!.pending, true);
        held.shift()!(new Response('', { status: 404 })); await assert.rejects(first);
        assert.equal(latest()!.error, true); assert.equal(latest()!.pending, false); assert.equal(latest()!.retry, true);
        const originalSource = [...sources.keys()][0];
        owner.action({ id, action: 'retry' }); assert.equal(latest()!.pending, true); assert.equal(latest()!.error, false);
        assert.equal([...sources.keys()][0], originalSource, 'retry retains the painted source rather than removing good shading');
        const retrySource = [...sources.keys()][0]; owner.action({ id, action: 'retry' });
        assert.equal([...sources.keys()][0], retrySource, 'repeated actions cannot restart a pending source');
        const next = draw(); await tick();
        owner.update({ revision: 2, state: { [id]: { enabled: true, opacity: 50 } } });
        assert.equal(latest()!.revision, 2); assert.equal(latest()!.pending, true, 'opacity updates reattach current loading to the accepted revision');
        held.shift()!(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })); await next;
        assert.equal(latest()!.pending, false); assert.equal(latest()!.error, false); assert.equal(latest()!.retry, false);
        const count = posts.length; owner.tileError([...sources.keys()][0], new DOMException('Cancelled.', 'AbortError') as Error);
        assert.equal(posts.length, count, 'cancelled renderer work is not a user-visible failure');
    } finally { owner.dispose(); }
});
test('terrain feedback preserves a provider cooldown through first load, opacity changes and resume', () => {
    const posts: Post[] = [], sources = new Map<string, StubSource>(), retryAt = Date.now() + 120000;
    const map = { getStyle: () => ({ layers: [] }), getLayersOrder: () => [], getLayer() {}, getSource: (id: string) => sources.get(id),
        addSource: (id: string, source: StubSource) => sources.set(id, source), addLayer() {}, setPaintProperty() {}, moveLayer() {} };
    const owner = createOverlays({ map, document: {}, maplibre: {}, post: (_type: string, value: Post) => posts.push(value) });
    const snapshot = (revision: number) => ({ revision, state: { land: { enabled: true, opacity: 25 } }, cooldowns: { land: retryAt } });
    try {
        owner.update(snapshot(1));
        assert.equal(posts.filter((item: Post) => item.id === 'land').at(-1)!.retryAt, retryAt);
        assert.equal(posts.filter((item: Post) => item.id === 'land').at(-1)!.error, true); assert.equal(sources.size, 0);
        owner.update({ ...snapshot(2), state: { land: { enabled: true, opacity: 50 } } });
        owner.suspend(); owner.update(snapshot(3)); owner.action({ id: 'land', action: 'retry' });
        assert.equal(posts.filter((item: Post) => item.id === 'land').at(-1)!.retryAt, retryAt); assert.equal(sources.size, 0, 'replaying feedback never clears a known service wait or creates blocked work');
    } finally { owner.dispose(); }
});

test('terrain filter changes invalidate old tile identities while opacity and menu updates retain the source', async () => {
    const sources = new Map<string, StubSource>(), layers = new Map<string, StyleLayer>(); let protocol!: Protocol;
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getLayersOrder: () => [...layers.keys()], getLayer: (id: string) => layers.get(id), getSource: (id: string) => sources.get(id),
        addLayer: (layer: StyleLayer) => layers.set(layer.id, layer), addSource: (id: string, source: StubSource) => sources.set(id, source),
        removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), setPaintProperty() {}, moveLayer() {} };
    const owner = createOverlays({ map, document: {}, maplibre: { addProtocol: (_name: string, handler: Protocol) => { protocol = handler; }, removeProtocol() {} }, post() {} });
    const value = { revision: 1, state: { land: { enabled: true, opacity: 25 }, slope: { enabled: true, opacity: 60 } } };
    try {
        owner.update(value); const original = [...sources.entries()], stale = original.find(([id]: [string, StubSource]) => id.includes('land'))![1].tiles[0].replace('{z}/{x}/{y}', '10/163/359');
        owner.update({ ...value, revision: 2, landTypes: ['BLM'] });
        const filtered = [...sources.entries()], land = filtered.find(([id]: [string, StubSource]) => id.includes('land'))!;
        assert.notEqual(land[0], original.find(([id]: [string, StubSource]) => id.includes('land'))![0]);
        assert.equal(filtered.find(([id]: [string, StubSource]) => id.includes('slope'))![1], original.find(([id]: [string, StubSource]) => id.includes('slope'))![1]);
        assert.match(land[1].tiles[0], /land\/1\//);
        await assert.rejects(protocol({ url: stale }, new AbortController()), { name: 'AbortError' });
        owner.update({ ...value, revision: 3, menuOpen: true, landTypes: ['BLM'], state: { ...value.state, land: { enabled: true, opacity: 50 } } });
        assert.equal(sources.get(land[0]), land[1], 'pan, opacity and disclosure snapshots never remove painted tiles');
        owner.update({ ...value, revision: 4, landTypes: [] });
        assert.equal([...sources.keys()].some(id => id.includes('land')), false, 'empty selection immediately removes old land pixels');
    } finally { owner.dispose(); }
});
