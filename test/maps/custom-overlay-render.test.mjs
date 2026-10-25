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
test('GeoJSON refresh retains last good geometry on failure, opacity makes no request, and teardown cancels work', async () => {
    const dom = new JSDOM('', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', pretendToBeVisual: true });
    const sources = new Map(), layers = new Map(), statuses = [];
    let requests = 0, denied = false;
    dom.window.fetch = async () => { requests++; if (denied) throw new TypeError('Failed to fetch'); return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { hostile: '<script>' }, geometry: { type: 'Point', coordinates: [1, 2] } }] }); };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: id => sources.get(id), getLayer: id => layers.get(id),
        addSource(id, value) { sources.set(id, { ...value, setData(data) { this.data = data; } }); }, addLayer(value) { layers.set(value.id, value); },
        removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id), setPaintProperty(id, key, value) { layers.get(id).paint[key] = value; } };
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
