// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCustomRenderer } from '../../src/maps/custom-overlay-render.js';
import { parseCustomData } from '../../src/maps/custom-overlay-data.js';
import { installMapDiscovery } from '../../src/maps/map-discovery.js';
import { createCustomParser } from '../../src/maps/custom-overlay-parser.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
for (const kind of ['raster', 'mvt']) test(`${kind} Reload resolves its saved metadata even with saved tiles and retains the old map on failure`, async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/', pretendToBeVisual: true });
    const sources = new Map(), layers = new Map(), statuses = [];
    let calls = 0, denied = false;
    dom.window.fetch = async () => { calls++; if (denied) throw new Error('offline'); return Response.json({ tilejson: '3.0.0', minzoom: 1, maxzoom: 14,
        bounds: [-125, 40, -115, 50], tileSize: 512, tiles: [`https://tiles.example.com/new/{z}/{x}/{y}.${kind === 'mvt' ? 'pbf' : 'png'}`] }); };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: id => sources.get(id), getLayer: id => layers.get(id),
        addSource(id, value) { sources.set(id, value); }, addLayer(value) { layers.set(value.id, value); },
        removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id), moveLayer() {}, setPaintProperty() {} };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind,
        source: { tiles: ['https://tiles.example.com/old/{z}/{x}/{y}.png'], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: kind === 'raster' ? [] : [{ sourceLayer: 'trails', geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: .3 }] } };
    const renderer = createCustomRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} }, parse: async () => {}, onStatus: (_id, value) => statuses.push(value) });
    try {
        renderer.update([source]); assert.equal(sources.size, 1); assert.equal(calls, 0);
        renderer.update([source], {}, { [source.id]: 1 });
        for (let n = 0; n < 20 && [...sources.values()][0]?.maxzoom !== 14; n++) await settle();
        assert.equal(calls, 1); assert.equal(sources.size, 2, 'previous rendering remains until replacement tiles arrive');
        const good = [...sources.values()].at(-1); assert.equal(good.maxzoom, 14); assert.deepEqual(good.bounds, [-125, 40, -115, 50]);
        assert.equal(statuses.at(-1).error, false, 'metadata replacement setup succeeds before tiles load');
        if (kind === 'raster') assert.equal(good.tileSize, 512);
        denied = true; renderer.update([source], {}, { [source.id]: 2 });
        for (let n = 0; n < 20 && !statuses.at(-1)?.error; n++) await settle();
        assert.equal(calls, 2); assert.equal(statuses.at(-1).error, true); assert(sources.has([...sources.keys()].find(key => sources.get(key) === good)));
    } finally { renderer.dispose(); dom.window.close(); }
});

test('a late decoded GeoJSON from a removed entry cannot publish over the newly selected generation', async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/', pretendToBeVisual: true });
    const sources = new Map(), layers = new Map(), decoded = [], statuses = [];
    dom.window.fetch = async () => Response.json({ type: 'FeatureCollection', features: [] });
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: id => sources.get(id), getLayer: id => layers.get(id),
        addSource(id, value) { sources.set(id, value); }, addLayer(value) { layers.set(value.id, value); }, removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id), moveLayer() {} };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind: 'geojson', source: { dataUrl: 'https://tiles.example.com/data.json' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
    const renderer = createCustomRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} },
        parse: () => new Promise(resolve => decoded.push(resolve)), onStatus: (_id, value) => statuses.push(value) });
    try {
        renderer.update([source]); for (let n = 0; n < 20 && decoded.length < 1; n++) await settle();
        renderer.update([]); renderer.update([source]); for (let n = 0; n < 20 && decoded.length < 2; n++) await settle();
        decoded[1]({ type: 'FeatureCollection', features: [], marker: 'new' }); await settle();
        const count = statuses.length; decoded[0]({ type: 'FeatureCollection', features: [], marker: 'old' }); await settle();
        assert.equal([...sources.values()][0].data.marker, 'new'); assert.equal(statuses.length, count);
    } finally { renderer.dispose(); dom.window.close(); }
});

for (const kind of ['raster', 'mvt']) test(`3D ${kind} Retry initializes a missing source after metadata recovers`, async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/', pretendToBeVisual: true });
    const sources = new Map(), layers = new Map(), statuses = [];
    let calls = 0, fail = true, release;
    dom.window.fetch = async () => {
        calls++; if (fail) throw new TypeError('Controlled offline');
        await new Promise(resolve => { release = resolve; });
        return Response.json({ tilejson: '3.0.0', minzoom: 0, maxzoom: 18, tiles: [`https://tiles.example.com/{z}/{x}/{y}.${kind === 'raster' ? 'png' : 'pbf'}`] });
    };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: id => sources.get(id), getLayer: id => layers.get(id),
        addSource(id, value) { assert(!sources.has(id), 'one source per attempt'); sources.set(id, value); }, addLayer(value) { layers.set(value.id, value); },
        removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id), moveLayer() {} };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind,
        source: { tiles: [], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: kind === 'raster' ? [] : [{ sourceLayer: 'trails', geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: .3 }] } };
    const renderer = createCustomRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} }, parse: async () => {}, onStatus: (_id, value) => statuses.push(value) });
    try {
        renderer.update([source]); for (let n = 0; n < 20 && !statuses.at(-1)?.error; n++) await settle();
        assert.equal(statuses.at(-1).error, true); assert.equal(sources.size, 0);
        fail = false; renderer.update([source], {}, { [source.id]: 1 });
        for (let n = 0; n < 20 && calls < 2; n++) await settle();
        assert.equal(calls, 2, 'Retry must perform a new metadata request');
        renderer.update([source], {}, { [source.id]: 2 });
        await settle(); assert.equal(calls, 2, 'repeated pending Retry must not duplicate initialization');
        release(); for (let n = 0; n < 20 && !sources.size; n++) await settle();
        assert.equal(sources.size, 1); assert.equal(statuses.at(-1).error, false);
    } finally { renderer.dispose(); dom.window.close(); }
});

for (const kind of ['geojson', 'raster', 'mvt']) test(`a fresh ${kind} layer can be ordered before its asynchronous paint creates a pane`, async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', pretendToBeVisual: true });
    dom.window.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError'))));
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind,
        source: kind === 'geojson' ? { dataUrl: 'https://tiles.example.com/data.geojson' } : { tiles: [], metadataUrl: 'https://tiles.example.com/meta.json' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
    const renderer = createCustomRenderer({ win: dom.window, map: { getPane() {} }, parse: async () => {}, onStatus() {} });
    try {
        assert.doesNotThrow(() => renderer.update([source]));
        assert.doesNotThrow(() => renderer.update([source]));
        assert.doesNotThrow(() => renderer.update([]));
    } finally { renderer.dispose(); await settle(); dom.window.close(); }
});

test('GeoJSON refresh retains last good geometry on failure, opacity makes no request, and teardown cancels work', async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', pretendToBeVisual: true });
    const sources = new Map(), layers = new Map(), statuses = [];
    let requests = 0, denied = false;
    dom.window.fetch = async () => { requests++; if (denied) throw new TypeError('Failed to fetch'); return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { hostile: '<script>' }, geometry: { type: 'Point', coordinates: [1, 2] } }] }); };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: id => sources.get(id), getLayer: id => layers.get(id),
        addSource(id, value) { sources.set(id, { ...value, setData(data) { this.data = data; } }); }, addLayer(value) { layers.set(value.id, value); },
        removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id), moveLayer(id) { const layer = layers.get(id); layers.delete(id); layers.set(id, layer); }, setPaintProperty(id, key, value) { layers.get(id).paint[key] = value; } };
    const protocols = new Map(), renderer = createCustomRenderer({ win: dom.window, map, maplibre: { addProtocol: (key, fn) => protocols.set(key, fn), removeProtocol: key => protocols.delete(key) },
        parse: async job => parseCustomData(job), onStatus: (_id, status) => statuses.push(status) });
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind: 'geojson', source: { dataUrl: 'https://tiles.example.com/data.geojson' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [{ geometry: 'point', color: '#26734d', radius: 5 }] } };
    try {
        renderer.update([source]); for (let i = 0; i < 10 && !sources.size; i++) await settle();
        assert.equal(sources.size, 1); const original = [...sources.values()][0].data;
        renderer.update([source], { [source.id]: 25 }); assert.equal(requests, 1);
        denied = true; renderer.update([source], {}, { [source.id]: 1 });
        for (let i = 0; i < 10 && !statuses.at(-1)?.error; i++) await settle();
        assert.equal(statuses.at(-1).error, true); assert.equal(statuses.at(-1).partial, true);
        assert.strictEqual([...sources.values()][0].data, original); assert.equal(layers.size, 1);
        denied = false; renderer.update([source], {}, { [source.id]: 2 });
        for (let i = 0; i < 10 && (statuses.at(-1)?.error || statuses.at(-1)?.pending); i++) await settle();
        assert.equal(statuses.at(-1).error, false); assert.equal(requests, 3);
        renderer.update([]); assert.equal(layers.size, 0); assert.equal(sources.size, 0);
    } finally { renderer.dispose(); assert.equal(protocols.size, 0); dom.window.close(); }
});
test('early discovery retains multiple unnamed Leaflet maps and removes unloaded instances', async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/' });
    const hooks = [], listeners = [];
    const library = { Map: { addInitHook(fn) { hooks.push(fn); } } };
    installMapDiscovery(dom.window); dom.window.L = library;
    for (let i = 0; i < 2; i++) hooks[0].call({ on(_event, listener) { listeners.push(listener); } });
    await Promise.resolve(); assert.equal(dom.window[Symbol.for('bpb.leafletMaps')].size, 2);
    listeners[0](); assert.equal(dom.window[Symbol.for('bpb.leafletMaps')].size, 1);
    assert.strictEqual(dom.window.L, library); dom.window.close();
});
test('parser workers terminate on a hard deadline and queued/active work cancels on disposal', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const workers = [];
    class WorkerStub {
        constructor() { workers.push(this); }
        postMessage() {}
        terminate() { this.terminated = true; }
    }
    const parser = createCustomParser('packaged-worker.js', WorkerStub), job = { kind: 'mvt', bytes: new ArrayBuffer(0) };
    const first = parser.parse(job); const timeout = assert.rejects(first, /too long/);
    t.mock.timers.tick(2001); await timeout; assert.equal(workers[0].terminated, true);
    const next = parser.parse(job); workers[1].onmessage({ data: { ok: true, value: 'recovered' } }); assert.equal(await next, 'recovered');
    const pending = [parser.parse(job), parser.parse(job), parser.parse(job)]; const cancelled = pending.map(promise => assert.rejects(promise, { name: 'AbortError' }));
    assert.equal(workers.length, 4, 'two active workers, one queued'); parser.dispose(); await Promise.all(cancelled);
    assert.ok(workers.every(worker => worker.terminated)); await assert.rejects(parser.parse(job), { name: 'AbortError' });
});
test('saved order controls vector stacking without recreating sources or requesting data again', async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/', pretendToBeVisual: true });
    const sources = new Map(), layers = new Map(); let requests = 0;
    dom.window.fetch = async () => { requests++; return Response.json({ type: 'FeatureCollection', features: [] }); };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: id => sources.get(id), getLayer: id => layers.get(id),
        addSource(id, value) { sources.set(id, value); }, addLayer(layer) { layers.set(layer.id, layer); },
        moveLayer(id) { const layer = layers.get(id); layers.delete(id); layers.set(id, layer); }, removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id) };
    const renderer = createCustomRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} }, parse: async job => parseCustomData(job), onStatus() {} });
    const first = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind: 'geojson', source: { dataUrl: 'https://tiles.example.com/first.json' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [{ geometry: 'point', color: '#26734d', radius: 5 }] } };
    const second = { ...first, id: 'custom:1537a032-271c-4d11-9b8c-0edc566b47c1', source: { dataUrl: 'https://tiles.example.com/second.json' } };
    try {
        renderer.update([first, second]); for (let i = 0; i < 10 && layers.size < 2; i++) await settle();
        assert.equal(layers.size, 2); assert.match([...layers.values()].at(-1).source, /0537a032/);
        const originalSources = [...sources.values()]; renderer.update([second, first]);
        assert.match([...layers.values()].at(-1).source, /1537a032/); assert.equal(requests, 2);
        assert.deepEqual([...sources.values()], originalSources, 'reorder keeps live source objects');
    } finally { renderer.dispose(); dom.window.close(); }
});
