/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { createCustomRenderer } from '../../src/maps/custom-overlay-render.ts';
import { parseCustomData } from '../../src/maps/custom-overlay-data.ts';
import { installMapDiscovery } from '../../src/maps/map-discovery.ts';
import { createCustomParser } from '../../src/maps/custom-overlay-parser.ts';

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const settle = () => new Promise(resolve => nativeSetTimeout(resolve, 0));

const createRenderer = createCustomRenderer as unknown as (options: object) => ReturnType<typeof createCustomRenderer>;

type ProtocolHandler = (request: { url: string }, controller: AbortController) => Promise<unknown>;
interface StoredSource {
    tiles?: string[];
    maxzoom?: number;
    bounds?: number[];
    tileSize?: number;
    data?: { marker?: string; [key: string]: unknown };
    setData?(data: unknown): void;
    [key: string]: unknown;
}
interface StoredLayer {
    id: string;
    source?: string;
    paint?: Record<string, unknown>;
    [key: string]: unknown;
}
interface StatusRecord {
    error?: boolean;
    partial?: boolean;
    pending?: boolean;
    message?: string;
    [key: string]: unknown;
}

test('terrain refresh revalidates resolved viewport tiles without changing future pan policy', async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const sources = new Map<string, StoredSource>();
    const layers = new Map<string, StoredLayer>();
    const protocols = new Map<string, ProtocolHandler>();
    const calls: { url: string; cache: RequestCache | undefined }[] = [];
    const coverage: unknown[] = [];
    (dom.window as unknown as { fetch: (url: string, options?: RequestInit) => Promise<Response> }).fetch = async (url, options = {}) => {
        calls.push({ url, cache: options.cache });
        return url.endsWith('meta.json') ? Response.json({ tilejson: '3.0.0', minzoom: 2, maxzoom: 14, tiles: ['https://tiles.example.com/new/{z}/{x}/{y}.pbf'] }) : new Response('vector');
    };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource: (id: string, value: StoredSource) => sources.set(id, value), addLayer: (value: StoredLayer) => layers.set(value.id, value), removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), moveLayer() {}, setPaintProperty() {},
        coveringTiles(options: unknown) { coverage.push(options); return [{ canonical: { z: 8, x: 1, y: 2 } }]; } };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind: 'mvt',
        source: { tiles: ['https://tiles.example.com/old/{z}/{x}/{y}.pbf'], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz' },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [{ sourceLayer: 'trails', geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: .3 }] } };
    const renderer = createRenderer({ win: dom.window, map, maplibre: { addProtocol: (key: string, handler: ProtocolHandler) => protocols.set(key, handler), removeProtocol: (key: string) => protocols.delete(key) },
        parse: async () => ({ features: [], data: new ArrayBuffer(0) }), onStatus() {} });
    try {
        renderer.update([source as never]); renderer.update([source as never], {}, { [source.id]: 1 });
        for (let n = 0; n < 20 && sources.size !== 2; n++) await settle();
        assert.deepEqual(coverage.at(-1), { tileSize: 512, minzoom: 2, maxzoom: 14 }, 'refresh uses newly resolved geometry');
        const template = [...sources.values()].at(-1)!.tiles![0], protocol = [...protocols.values()][0];
        for (const x of [1, 2]) await protocol({ url: template.replace('{z}', '8').replace('{x}', String(x)).replace('{y}', '2') }, new AbortController());
        assert.deepEqual(calls.map(call => call.cache), ['no-cache', 'no-cache', undefined]);
    } finally { renderer.dispose(); dom.window.close(); }
});

for (const outcome of ['cancel', 'success', 'failure', 'mixed', 'empty']) test(`staged terrain replacement retains output until renderer acceptance: ${outcome}`, async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const sources = new Map<string, StoredSource>();
    const layers = new Map<string, StoredLayer>();
    const protocols = new Map<string, ProtocolHandler>();
    const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
    const statuses: StatusRecord[] = [];
    let empty = false;
    (dom.window as unknown as { fetch: (url: string, options: { signal: AbortSignal }) => Promise<Response> }).fetch = async (url, { signal }) => {
        if (url.endsWith('meta.json')) return Response.json({ tilejson: '3.0.0', minzoom: 1, maxzoom: 14, tiles: ['https://tiles.example.com/new/{z}/{x}/{y}.pbf'] });
        if (outcome === 'failure' && url.includes('/new/')) return new Response(null, { status: 401 });
        if (outcome === 'cancel' && url.includes('/new/')) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true }));
        return new Response('vector');
    };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource: (id: string, value: StoredSource) => sources.set(id, value), addLayer: (value: StoredLayer) => layers.set(value.id, value), removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), moveLayer() {}, setPaintProperty() {},
        on(type: string, listener: (event: Record<string, unknown>) => void) { const entries = listeners.get(type) || new Set(); entries.add(listener); listeners.set(type, entries); },
        off(type: string, listener: (event: Record<string, unknown>) => void) { listeners.get(type)?.delete(listener); }, isSourceLoaded: () => true,
        coveringTiles: () => empty ? [] : [{ canonical: { z: 8, x: 1, y: 2 } }] };
    const fire = (type: string, event: Record<string, unknown> = {}) => { for (const listener of [...listeners.get(type) || []]) listener(event); };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind: 'mvt',
        source: { tiles: ['https://tiles.example.com/old/{z}/{x}/{y}.pbf'], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz' },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [{ sourceLayer: 'trails', geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: .3 }] } };
    const renderer = createRenderer({ win: dom.window, map, maplibre: { addProtocol: (key: string, handler: ProtocolHandler) => protocols.set(key, handler), removeProtocol: (key: string) => protocols.delete(key) },
        parse: async () => ({ features: [], data: new ArrayBuffer(0) }), onStatus: (_id: string, value: StatusRecord) => statuses.push(value) });
    try {
        renderer.update([source as never]); const original = [...sources.keys()][0], protocol = [...protocols.values()][0];
        const url = (template: string) => template.replace('{z}', '8').replace('{x}', '1').replace('{y}', '2');
        await protocol({ url: url(sources.get(original)!.tiles![0]) }, new AbortController());
        renderer.update([source as never], {}, { [source.id]: 1 });
        for (let n = 0; n < 20 && sources.size !== 2; n++) await settle();
        const replacement = [...sources.keys()].at(-1)!, abort = new AbortController();
        if (outcome !== 'empty') {
            const pending = protocol({ url: url(sources.get(replacement)!.tiles![0]) }, abort);
            if (outcome === 'cancel') { await settle(); abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); }
            else if (outcome === 'failure') await assert.rejects(pending, { status: 401 });
            else await pending;
            assert.ok(sources.has(original), 'transport completion/cancellation is not rendered replacement readiness');
            fire('sourcedata', { sourceId: original, tile: { state: 'loaded' }, coord: { canonical: { z: 8, x: 1, y: 2 } } });
            fire('render'); assert.ok(sources.has(original), 'old source events cannot acknowledge the replacement');
            if (outcome === 'success') {
                fire('sourcedata', { sourceId: replacement, tile: { state: 'loaded', aborted: true }, coord: { canonical: { z: 8, x: 1, y: 2 } } });
                fire('render'); assert.ok(sources.has(original), 'an aborted accepted event cannot finish replacement');
                fire('sourcedata', { sourceId: replacement, tile: { state: 'loaded' }, coord: { canonical: { z: 8, x: 9, y: 2 } } });
                fire('render'); assert.ok(sources.has(original), 'nonvisible acceptance cannot finish replacement');
                fire('sourcedata', { sourceId: replacement, tile: { state: 'loaded', aborted: false }, coord: { canonical: { z: 8, x: 1, y: 2 } } });
                assert.ok(sources.has(original), 'source acceptance still precedes paint');
                fire('render'); assert.equal(sources.has(original), false);
            }
            if (outcome === 'mixed') {
                fire('sourcedata', { sourceId: replacement, tile: { state: 'loaded' }, coord: { canonical: { z: 8, x: 1, y: 2 } } });
                fire('error', { sourceId: replacement, error: new Error('Controlled map decode failure') });
                fire('render'); assert.ok(sources.has(original), 'a rendering error preserves the old source despite other accepted tiles');
                assert.equal(statuses.at(-1)!.error, true);
            }
        } else {
            empty = true; fire('render'); assert.equal(sources.has(original), false, 'a genuinely empty viewport releases redundant output');
            assert.equal(statuses.at(-1)!.message, 'No tiles in this area.');
            empty = false; renderer.refresh();
            assert.notEqual(statuses.at(-1)!.message, 'No tiles in this area.', 'returning to coverage clears stale empty feedback without Reload');
            await protocol({ url: url(sources.get(replacement)!.tiles![0]) }, new AbortController());
            assert.equal(statuses.at(-1)!.message, 'Loaded', 'successful replacement tiles report the current viewport state');
            assert.equal(sources.size, 1, 'ordinary viewport recovery does not recreate the retired owner');
        }
    } finally {
        renderer.dispose(); assert.equal([...listeners.values()].reduce((sum, value) => sum + value.size, 0), 0);
        assert.equal(sources.size, 0); dom.window.close();
    }
});
for (const kind of ['raster', 'mvt']) test(`${kind} Reload resolves its saved metadata even with saved tiles and retains the old map on failure`, async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const sources = new Map<string, StoredSource>(), layers = new Map<string, StoredLayer>(), statuses: StatusRecord[] = [];
    let calls = 0, denied = false;
    (dom.window as unknown as { fetch: () => Promise<Response> }).fetch = async () => { calls++; if (denied) throw new Error('offline'); return Response.json({ tilejson: '3.0.0', minzoom: 1, maxzoom: 14,
        bounds: [-125, 40, -115, 50], tileSize: 512, tiles: [`https://tiles.example.com/new/{z}/{x}/{y}.${kind === 'mvt' ? 'pbf' : 'png'}`] }); };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource(id: string, value: StoredSource) { sources.set(id, value); }, addLayer(value: StoredLayer) { layers.set(value.id, value); },
        removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), moveLayer() {}, setPaintProperty() {} };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind,
        source: { tiles: ['https://tiles.example.com/old/{z}/{x}/{y}.png'], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: kind === 'raster' ? [] : [{ sourceLayer: 'trails', geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: .3 }] } };
    const renderer = createRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} }, parse: async () => {}, onStatus: (_id: string, value: StatusRecord) => statuses.push(value) });
    try {
        renderer.update([source as never]); assert.equal(sources.size, 1); assert.equal(calls, 0);
        renderer.update([source as never], {}, { [source.id]: 1 });
        for (let n = 0; n < 20 && [...sources.values()][0]?.maxzoom !== 14; n++) await settle();
        assert.equal(calls, 1); assert.equal(sources.size, 2, 'previous rendering remains until replacement tiles arrive');
        const good = [...sources.values()].at(-1)!; assert.equal(good.maxzoom, 14); assert.deepEqual(good.bounds, [-125, 40, -115, 50]);
        assert.equal(statuses.at(-1)!.error, false, 'metadata replacement setup succeeds before tiles load');
        if (kind === 'raster') assert.equal(good.tileSize, 512);
        denied = true; renderer.update([source as never], {}, { [source.id]: 2 });
        for (let n = 0; n < 20 && !statuses.at(-1)?.error; n++) await settle();
        assert.equal(calls, 2); assert.equal(statuses.at(-1)!.error, true); assert(sources.has([...sources.keys()].find(key => sources.get(key) === good)!));
    } finally { renderer.dispose(); dom.window.close(); }
});

test('a late decoded GeoJSON from a removed entry cannot publish over the newly selected generation', async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const sources = new Map<string, StoredSource>(), layers = new Map<string, StoredLayer>(), decoded: ((value: unknown) => void)[] = [], statuses: StatusRecord[] = [];
    (dom.window as unknown as { fetch: () => Promise<Response> }).fetch = async () => Response.json({ type: 'FeatureCollection', features: [] });
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource(id: string, value: StoredSource) { sources.set(id, value); }, addLayer(value: StoredLayer) { layers.set(value.id, value); }, removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), moveLayer() {} };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind: 'geojson', source: { dataUrl: 'https://tiles.example.com/data.json' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
    const renderer = createRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} },
        parse: () => new Promise(resolve => decoded.push(resolve)), onStatus: (_id: string, value: StatusRecord) => statuses.push(value) });
    try {
        renderer.update([source as never]); for (let n = 0; n < 20 && decoded.length < 1; n++) await settle();
        renderer.update([]); renderer.update([source as never]); for (let n = 0; n < 20 && decoded.length < 2; n++) await settle();
        decoded[1]({ type: 'FeatureCollection', features: [], marker: 'new' }); await settle();
        const count = statuses.length; decoded[0]({ type: 'FeatureCollection', features: [], marker: 'old' }); await settle();
        assert.equal([...sources.values()][0].data!.marker, 'new'); assert.equal(statuses.length, count);
    } finally { renderer.dispose(); dom.window.close(); }
});

for (const kind of ['raster', 'mvt']) test(`3D ${kind} Retry initializes a missing source after metadata recovers`, async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const sources = new Map<string, StoredSource>(), layers = new Map<string, StoredLayer>(), statuses: StatusRecord[] = [];
    let calls = 0, fail = true, release: (() => void) | undefined;
    (dom.window as unknown as { fetch: () => Promise<Response> }).fetch = async () => {
        calls++; if (fail) throw new TypeError('Controlled offline');
        await new Promise<void>(resolve => { release = resolve; });
        return Response.json({ tilejson: '3.0.0', minzoom: 0, maxzoom: 18, tiles: [`https://tiles.example.com/{z}/{x}/{y}.${kind === 'raster' ? 'png' : 'pbf'}`] });
    };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource(id: string, value: StoredSource) { assert(!sources.has(id), 'one source per attempt'); sources.set(id, value); }, addLayer(value: StoredLayer) { layers.set(value.id, value); },
        removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), moveLayer() {} };
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind,
        source: { tiles: [], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: kind === 'raster' ? [] : [{ sourceLayer: 'trails', geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: .3 }] } };
    const renderer = createRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} }, parse: async () => {}, onStatus: (_id: string, value: StatusRecord) => statuses.push(value) });
    try {
        renderer.update([source as never]); for (let n = 0; n < 20 && !statuses.at(-1)?.error; n++) await settle();
        assert.equal(statuses.at(-1)!.error, true); assert.equal(sources.size, 0);
        fail = false; renderer.update([source as never], {}, { [source.id]: 1 });
        for (let n = 0; n < 20 && calls < 2; n++) await settle();
        assert.equal(calls, 2, 'Retry must perform a new metadata request');
        renderer.update([source as never], {}, { [source.id]: 2 });
        await settle(); assert.equal(calls, 2, 'repeated pending Retry must not duplicate initialization');
        release!(); for (let n = 0; n < 20 && !sources.size; n++) await settle();
        assert.equal(sources.size, 1); assert.equal(statuses.at(-1)!.error, false);
    } finally { renderer.dispose(); dom.window.close(); }
});

for (const kind of ['geojson', 'raster', 'mvt']) test(`a fresh ${kind} layer can be ordered before its asynchronous paint creates a pane`, async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/map/MasterMap.aspx' });
    (dom.window as unknown as { fetch: (_url: string, options: { signal: AbortSignal }) => Promise<never> }).fetch =
        (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError'))));
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind,
        source: kind === 'geojson' ? { dataUrl: 'https://tiles.example.com/data.geojson' } : { tiles: [], metadataUrl: 'https://tiles.example.com/meta.json' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
    const renderer = createRenderer({ win: dom.window, map: { getPane() {} }, parse: async () => {}, onStatus() {} });
    try {
        assert.doesNotThrow(() => renderer.update([source as never]));
        assert.doesNotThrow(() => renderer.update([source as never]));
        assert.doesNotThrow(() => renderer.update([]));
    } finally { renderer.dispose(); await settle(); dom.window.close(); }
});

test('GeoJSON refresh retains last good geometry on failure, opacity makes no request, and teardown cancels work', async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/map/MasterMap.aspx' });
    const sources = new Map<string, StoredSource>(), layers = new Map<string, StoredLayer>(), statuses: StatusRecord[] = [];
    let requests = 0, denied = false;
    (dom.window as unknown as { fetch: () => Promise<Response> }).fetch = async () => { requests++; if (denied) throw new TypeError('Failed to fetch'); return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { hostile: '<script>' }, geometry: { type: 'Point', coordinates: [1, 2] } }] }); };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource(id: string, value: StoredSource) { sources.set(id, { ...value, setData(data: unknown) { this.data = data as StoredSource['data']; } }); }, addLayer(value: StoredLayer) { layers.set(value.id, value); },
        removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id), moveLayer(id: string) { const layer = layers.get(id)!; layers.delete(id); layers.set(id, layer); }, setPaintProperty(id: string, key: string, value: unknown) { (layers.get(id)!.paint ||= {})[key] = value; } };
    const protocols = new Map<string, ProtocolHandler>(), renderer = createRenderer({ win: dom.window, map, maplibre: { addProtocol: (key: string, fn: ProtocolHandler) => protocols.set(key, fn), removeProtocol: (key: string) => protocols.delete(key) },
        parse: async (job: Parameters<typeof parseCustomData>[0]) => parseCustomData(job), onStatus: (_id: string, status: StatusRecord) => statuses.push(status) });
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind: 'geojson', source: { dataUrl: 'https://tiles.example.com/data.geojson' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [{ geometry: 'point', color: '#26734d', radius: 5 }] } };
    try {
        renderer.update([source as never]); for (let i = 0; i < 10 && !sources.size; i++) await settle();
        assert.equal(sources.size, 1); const original = [...sources.values()][0].data;
        renderer.update([source as never], { [source.id]: 25 }); assert.equal(requests, 1);
        denied = true; renderer.update([source as never], {}, { [source.id]: 1 });
        for (let i = 0; i < 10 && !statuses.at(-1)?.error; i++) await settle();
        assert.equal(statuses.at(-1)!.error, true); assert.equal(statuses.at(-1)!.partial, true);
        assert.strictEqual([...sources.values()][0].data, original); assert.equal(layers.size, 1);
        denied = false; renderer.update([source as never], {}, { [source.id]: 2 });
        for (let i = 0; i < 10 && (statuses.at(-1)?.error || statuses.at(-1)?.pending); i++) await settle();
        assert.equal(statuses.at(-1)!.error, false); assert.equal(requests, 3);
        renderer.update([]); assert.equal(layers.size, 0); assert.equal(sources.size, 0);
    } finally { renderer.dispose(); assert.equal(protocols.size, 0); dom.window.close(); }
});
test('early discovery retains multiple unnamed Leaflet maps and removes unloaded instances', async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const hooks: ((this: { on(_event: string, listener: () => void): void }) => void)[] = [];
    const listeners: (() => void)[] = [];
    const library = { Map: { addInitHook(fn: (this: { on(_event: string, listener: () => void): void }) => void) { hooks.push(fn); } } };
    const win = dom.window as unknown as NonNullable<Parameters<typeof installMapDiscovery>[0]> & { [key: symbol]: Set<unknown> };
    installMapDiscovery(win); win.L = library as NonNullable<Parameters<typeof installMapDiscovery>[0]>['L'];
    for (let i = 0; i < 2; i++) hooks[0].call({ on(_event, listener) { listeners.push(listener); } });
    await Promise.resolve(); assert.equal(win[Symbol.for('bpb.leafletMaps')].size, 2);
    listeners[0](); assert.equal(win[Symbol.for('bpb.leafletMaps')].size, 1);
    assert.strictEqual(win.L, library); dom.window.close();
});
test('parser workers terminate on a hard deadline and queued/active work cancels on disposal', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const workers: WorkerStub[] = [];
    class WorkerStub {
        terminated = false;
        onmessage?: (event: { data: unknown }) => void;
        constructor() { workers.push(this); }
        postMessage() {}
        terminate() { this.terminated = true; }
    }
    const parser = createCustomParser('packaged-worker.js', WorkerStub as unknown as typeof Worker);
    const job = { kind: 'mvt' as const, bytes: new ArrayBuffer(0) };
    const first = parser.parse(job); const timeout = assert.rejects(first, /too long/);
    t.mock.timers.tick(2001); await timeout; assert.equal(workers[0].terminated, true);
    const next = parser.parse(job); workers[1].onmessage!({ data: { ok: true, value: 'recovered' } }); assert.equal(await next, 'recovered');
    const pending = [parser.parse(job), parser.parse(job), parser.parse(job)]; const cancelled = pending.map(promise => assert.rejects(promise, { name: 'AbortError' }));
    assert.equal(workers.length, 4, 'two active workers, one queued'); parser.dispose(); await Promise.all(cancelled);
    assert.ok(workers.every(worker => worker.terminated)); await assert.rejects(parser.parse(job), { name: 'AbortError' });
});
test('saved order controls vector stacking without recreating sources or requesting data again', async () => {
    const dom = new FixtureDom('', { url: 'https://www.peakbagger.com/' });
    const sources = new Map<string, StoredSource>(), layers = new Map<string, StoredLayer>(); let requests = 0;
    (dom.window as unknown as { fetch: () => Promise<Response> }).fetch = async () => { requests++; return Response.json({ type: 'FeatureCollection', features: [] }); };
    const map = { getStyle: () => ({ layers: [...layers.values()] }), getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource(id: string, value: StoredSource) { sources.set(id, value); }, addLayer(layer: StoredLayer) { layers.set(layer.id, layer); },
        moveLayer(id: string) { const layer = layers.get(id)!; layers.delete(id); layers.set(id, layer); }, removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id) };
    const renderer = createRenderer({ win: dom.window, map, maplibre: { addProtocol() {}, removeProtocol() {} }, parse: async (job: Parameters<typeof parseCustomData>[0]) => parseCustomData(job), onStatus() {} });
    const first = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, kind: 'geojson', source: { dataUrl: 'https://tiles.example.com/first.json' },
        attribution: { text: '' }, appearance: { opacity: 60, rules: [{ geometry: 'point', color: '#26734d', radius: 5 }] } };
    const second = { ...first, id: 'custom:1537a032-271c-4d11-9b8c-0edc566b47c1', source: { dataUrl: 'https://tiles.example.com/second.json' } };
    try {
        renderer.update([first as never, second as never]); for (let i = 0; i < 10 && layers.size < 2; i++) await settle();
        assert.equal(layers.size, 2); assert.match([...layers.values()].at(-1)!.source!, /0537a032/);
        const originalSources = [...sources.values()]; renderer.update([second as never, first as never]);
        assert.match([...layers.values()].at(-1)!.source!, /1537a032/); assert.equal(requests, 2);
        assert.deepEqual([...sources.values()], originalSources, 'reorder keeps live source objects');
    } finally { renderer.dispose(); dom.window.close(); }
});
