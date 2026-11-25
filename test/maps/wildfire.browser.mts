/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { wildfireBoxes, wildfireWorldCopy, readWildfireFeature, wildfireRecords, readWildfireRecords, WILDFIRE_LIMITS } from '../../src/maps/wildfire-core.ts';
import { wildfireQuery, fetchWildfireComponent } from '../../src/maps/wildfire-client.ts';
import { createTerrainWildfires } from '../../src/terrain/terrain-wildfires.ts';
import { createWildfireSession } from '../../src/maps/wildfire-session.ts';
import { readLayerSnapshot, readLayerStatus } from '../../src/maps/map-layer-protocol.ts';
import { wildfireFeature, wildfireFixture } from '../helpers/wildfire-fixture.mts';
// Provider features as the validation tests build and mutate them.
interface WireFeature { type?: string; geometry: { coordinates: unknown }; properties: Record<string, unknown> }
const ringsOf = (feature: { geometry?: { coordinates: unknown } }) => feature.geometry!.coordinates as number[][][];
const positionOf = (feature: { geometry?: { coordinates: unknown } }) => feature.geometry!.coordinates as number[];
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
interface HeldRequest { url: string; init: RequestInit; resolve: (response: Response) => void }
interface WildfireStatus { pending?: boolean; partial?: boolean; count?: number; message?: string; error?: boolean; saved?: boolean; fires?: unknown[] }
interface WildfireDisplay { incidents: unknown[]; perimeters: unknown[] }
const env0 = { hold: false };
const fetchComponent = fetchWildfireComponent as unknown as (kind: string, box: number[], options: { signal: AbortSignal; fetchImpl: FetchImpl }) => Promise<unknown[]>;
const bounds = [-122, 46, -121, 47];
const budget = () => ({ bytes: 0, vertices: 0 });
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/geo+json' } });
const normalize = (kind: string, feature: WireFeature = wildfireFeature(kind)) => readWildfireFeature(feature, kind, budget());
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn: () => unknown) { const deadline = Date.now() + 2000; while (!fn()) { if (Date.now() > deadline) throw new Error('Wildfire fixture did not settle'); await tick(); } }
test('fire queries are WF-only, field-allowlisted, credential-independent and wrapped', () => {
    for (const kind of ['incidents', 'perimeters']) {
        const url = new URL(wildfireQuery(kind, bounds)); assert.equal(url.hostname, 'services3.arcgis.com');
        assert.match(url.searchParams.get('where')!, /='WF'$/); assert.equal(url.searchParams.get('outSR'), '4326');
        assert.equal(url.searchParams.get('resultRecordCount'), '500'); assert.ok(!url.searchParams.get('outFields')!.includes('*'));
    }
    assert.deepEqual(wildfireBoxes([179, 40, -179, 50]), [[179, 40, 180, 50], [-180, 40, -179, 50]]);
    assert.deepEqual(wildfireBoxes([238, 46, 239, 47]), [bounds]);
    assert.throws(() => wildfireQuery('arbitrary-url', bounds)); assert.throws(() => wildfireBoxes([NaN, 0, 1, 2]));
});
test('fire identity, perimeter holes and source dates remain distinct; names never join incidents', () => {
    const point = normalize('incidents'), perimeter = normalize('perimeters');
    assert.equal(ringsOf(perimeter).length, 2);
    let records = wildfireRecords([point], [perimeter]); assert.equal(records.length, 1); assert.equal(records[0].hasPerimeter, true);
    assert.ok(records[0].perimeterObserved! < records[0].perimeterEdited! && records[0].perimeterEdited! < records[0].incidentUpdated!);
    const raw = wildfireFeature('perimeters'); raw.properties.poly_IRWINID = '11111111-1111-1111-1111-111111111111';
    records = wildfireRecords([point], [normalize('perimeters', raw)]); assert.equal(records.length, 2, 'conflicting IDs remain unassociated despite identical names');
    const noDate = wildfireFeature(); (noDate.properties as Record<string, unknown>).ModifiedOnDateTime_dt = null; assert.equal(normalize('incidents', noDate).properties.incidentUpdated, null);
    assert.deepEqual(readWildfireRecords([{ id: 'evil:url', name: 'x' }]), []);
});
test('invalid points, open rings, empty polygons, prescribed burns and vertex overflow fail closed', () => {
    for (const mutate of [(f: WireFeature) => { ringsOf(f)[0][0][0] = NaN; }, (f: WireFeature) => { ringsOf(f)[0].pop(); }, (f: WireFeature) => { f.geometry.coordinates = []; }, (f: WireFeature) => { ringsOf(f)[1] = [[0, 0], [1, 0], [1, 1], [0, 0]]; }, (f: WireFeature) => { f.properties.attr_IncidentTypeCategory = 'RX'; }]) {
        const f = wildfireFeature('perimeters'); mutate(f); assert.throws(() => normalize('perimeters', f));
    }
    const f: WireFeature = wildfireFeature(); positionOf(f)[0] = 181; assert.throws(() => normalize('incidents', f));
    assert.throws(() => readWildfireFeature(wildfireFeature(), 'incidents', { vertices: WILDFIRE_LIMITS.vertices }), /Zoom in/);
});
test('pagination honors nested truncation flags, rejects repeated or incomplete pages, and budgets bytes', async () => {
    let calls = 0, init: RequestInit | undefined;
    const fetchImpl = async (url: string, options: RequestInit) => { init = options; calls++; if (calls === 2) assert.equal(new URL(url).searchParams.get('resultOffset'), '1', 'advance by returned records, not requested page size');
        return reply(calls === 1 ? { ...wildfireFixture(), properties: { exceededTransferLimit: true } } : { type: 'FeatureCollection', features: [] }); };
    const features = await fetchWildfireComponent('incidents', bounds, { fetchImpl: fetchImpl as typeof fetch }); assert.equal(features.length, 1); assert.equal(calls, 2);
    assert.equal(init!.credentials, 'omit'); assert.equal(init!.referrerPolicy, 'no-referrer');
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ ...wildfireFixture(), properties: { exceededTransferLimit: true } }) }), /changed/);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ type: 'FeatureCollection', features: [], properties: { exceededTransferLimit: true } }) }), /Incomplete/);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { budget: { bytes: WILDFIRE_LIMITS.bytes, vertices: 0 }, fetchImpl: async () => reply(wildfireFixture()) }), /Zoom in/);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ error: { code: 400 } }) }), /could not/);
});
test('wildfire transactions bound deadlines, body reads, cancellation, transient retries and rate limits', async () => {
    let calls = 0;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchComponent('incidents', bounds, { signal: controller.signal, fetchImpl: async () => { calls++; return reply(wildfireFixture()); } }), { name: 'AbortError' }); assert.equal(calls, 0);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }), { name: 'TimeoutError' });
    calls = 0; await fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : reply(wildfireFixture()) }); assert.equal(calls, 2);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => new Response('', { status: 429 }) }), (e: { retryAt: number }) => e.retryAt > Date.now());
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ error: { code: 429 } }) }), (e: { retryAt: number }) => e.retryAt > Date.now());
});
function session(fetchImpl: FetchImpl, options = {}) {
    const dom = new FixtureDom(''), states: WildfireStatus[] = [], displays: WildfireDisplay[] = []; let view = { bounds, zoom: 10 };
    const owner = createWildfireSession({ document: dom.window.document as unknown as Document, readView: () => view, fetchImpl: fetchImpl as typeof fetch, debounceMs: 0, onStatus: status => states.push(status), onData: result => displays.push(result), ...options });
    return { owner, states, displays, doc: dom.window.document, setView(next: typeof view) { view = next; }, close() { owner.dispose(); dom.window.close(); } };
}
test('fires are off by default, publish each complete component and distinguish partial from empty', async () => {
    let calls = 0;
    const env = session(async (url: string) => { calls++; return url.includes('Interagency') ? new Response('', { status: 400 }) : reply(wildfireFixture()); });
    try {
        await tick(); assert.equal(calls, 0); env.owner.update({ enabled: true });
        await until(() => env.states.at(-1)?.pending === false);
        assert.equal(calls, 2); assert.equal(env.states.at(-1)!.partial, true); assert.equal(env.states.at(-1)!.count, 1);
        assert.equal(env.displays.at(-1)!.incidents.length, 1); assert.equal(env.displays.at(-1)!.perimeters.length, 0);
        env.owner.update({ enabled: true }); await tick(); assert.equal(calls, 2, 'status/menu snapshots do not replay a failed component');
        env.owner.update({ enabled: false }); assert.equal(env.displays.at(-1)!.incidents.length, 0);
    } finally { env.close(); }
    const empty = session(async () => reply({ type: 'FeatureCollection', features: [] }));
    try { empty.owner.update({ enabled: true }); await until(() => empty.states.at(-1)?.pending === false); assert.match(empty.states.at(-1)!.message!, /No reported fires/); assert.equal(empty.states.at(-1)!.error, false); } finally { empty.close(); }
});
test('pan and page visibility cancel stale transports and never publish late results', async () => {
    const held: HeldRequest[] = [];
    const env = session((url: string, init: RequestInit) => new Promise<Response>(resolve => held.push({ url, init, resolve })));
    try {
        env.owner.update({ enabled: true }); await until(() => held.length === 2); env.owner.moving();
        assert.ok(held.every((item: HeldRequest) => item.init.signal!.aborted));
        held.forEach((item: HeldRequest) => item.resolve(reply(wildfireFixture(item.url.includes('Interagency') ? 'perimeters' : 'incidents'))));
        await tick(); assert.equal(env.displays.some((display: WildfireDisplay) => display.incidents.length), false, 'A cancelled answer is never drawn');
        Object.defineProperty(env.doc, 'visibilityState', { configurable: true, value: 'hidden' }); env.owner.update({ enabled: true }); await tick(); assert.equal(held.length, 2);
    } finally { env.close(); }
});
test('a pan keeps the old fires drawn but uncounted until the new view replaces them whole', async () => {
    let bad = false; const held: (() => void)[] = [];
    const env = session(async (url: string) => { if (bad) return new Response('', { status: 400 }); if (env0.hold) await new Promise<void>(resolve => held.push(resolve)); return reply(wildfireFixture(url.includes('Interagency') ? 'perimeters' : 'incidents')); }, { now: () => Date.now() });
    try {
        env.owner.update({ enabled: true }); await until(() => env.states.at(-1)?.pending === false);
        const drawn = env.displays.at(-1), displays = env.displays.length;
        assert.ok(drawn!.incidents.length && env.states.at(-1)!.count! > 0);
        env0.hold = true;
        env.setView({ bounds: [-120, 45, -119, 46], zoom: 10 }); env.owner.refresh();
        assert.equal(env.displays.length, displays, 'Nothing blinks out on a pan');
        assert.equal(env.states.at(-1)!.count, 0, 'The old result is never the count for the new view');
        assert.deepEqual(env.states.at(-1)!.fires, []);
        await until(() => held.length === 2);
        held.shift()!(); await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.displays.length, displays, 'One finished component cannot mix bounding boxes');
        held.shift()!(); await until(() => env.states.at(-1)?.pending === false);
        assert.ok(env.displays.at(-1)!.incidents.length && env.states.at(-1)!.count! > 0, 'The complete answer replaces the old one');
        env0.hold = false; bad = true;
        env.setView({ bounds: [-118, 44, -117, 45], zoom: 10 }); env.owner.refresh();
        await until(() => env.states.at(-1)?.pending === false);
        assert.equal(env.displays.at(-1)!.incidents.length + env.displays.at(-1)!.perimeters.length, 0, 'A view that cannot be answered drops the old fires');
        assert.equal(env.states.at(-1)!.saved, false);
        assert.doesNotMatch(env.states.at(-1)!.message!, /Refresh failed/);
    } finally { env.close(); }
});
test('complete previous components survive failed refreshes and expire', async () => {
    let now = Date.now(), bad = false;
    const env = session(async (url: string) => bad ? new Response('', { status: 400 }) : reply(wildfireFixture(url.includes('Interagency') ? 'perimeters' : 'incidents')), { now: () => now });
    try {
        env.owner.update({ enabled: true }); await until(() => env.states.at(-1)?.pending === false);
        bad = true; env.owner.retry(); await until(() => env.states.at(-1)?.pending === false);
        assert.equal(env.states.at(-1)!.saved, true); assert.equal(env.displays.at(-1)!.perimeters.length, 1);
        now += 1800001; env.owner.retry(); await until(() => env.states.at(-1)?.pending === false);
        assert.equal(env.displays.at(-1)!.incidents.length, 0); assert.equal(env.states.at(-1)!.saved, false);
    } finally { env.close(); }
});
test('wildfire handoffs and bridge metadata are typed and cannot carry arbitrary URLs or geometry', () => {
    const snapshot = readLayerSnapshot({ revision: 1, state: { wildfire: { enabled: true, opacity: 0 } } }); assert.equal(snapshot!.state.wildfire.opacity, 100);
    const raw = { id: 'nifc:incident:1', name: 'X', hasPerimeter: true, geometry: { evil: true }, url: 'https://evil.example', incidentUpdated: Infinity };
    const status = readLayerStatus({ id: 'wildfire', count: Infinity, fires: [raw], loadedAt: Infinity, saved: true, overflow: true });
    assert.equal(status!.count, 0); assert.equal(status!.loadedAt, 0); assert.equal(status!.fires![0].incidentUpdated, null);
    assert.equal(Object.hasOwn(status!.fires![0], 'url'), false); assert.equal(Object.hasOwn(status!.fires![0], 'geometry'), false);
});

test('cancelling a pending viewport does not cache the failed attempt for five minutes', async () => {
    const held: HeldRequest[] = [];
    const env = session((url: string, init: RequestInit) => new Promise<Response>(resolve => held.push({ url, init, resolve })));
    try {
        env.owner.update({ enabled: true }); await until(() => held.length === 2);
        env.owner.moving(); env.owner.refresh(); await until(() => held.length === 4);
        assert.ok(held.slice(0, 2).every((item: HeldRequest) => item.init.signal!.aborted));
    } finally { env.close(); }
});

test('terrain fire layers preserve native interaction priority and survive style replacement', async t => {
    t.mock.method(globalThis, 'fetch', async (url: string) => reply(wildfireFixture(url.includes('Interagency') ? 'perimeters' : 'incidents')));
    const dom = new FixtureDom(''), listeners = new Map<string, (event: object) => void>(), sources = new Map<string, Record<string, unknown> & { data?: { features: unknown[] } }>(),
        layers = new Map<string, { id: string; type?: string }>([['bpb-route-main', { id: 'bpb-route-main', type: 'line' }]]), before: unknown[] = [];
    let hits: object[] = [], popups = 0;
    const map = { getBounds: () => ({ getWest: () => -122, getSouth: () => 46, getEast: () => -121, getNorth: () => 47 }), getZoom: () => 9,
        on: (event: string, handler: (event: object) => void) => listeners.set(event, handler), off: (event: string) => listeners.delete(event), getLayersOrder: () => [...layers.keys()], getStyle: () => ({ layers: [...layers.values()] }),
        getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
        addSource(id: string, value: Record<string, unknown>) { const source: Record<string, unknown> & { data?: { features: unknown[] } } = { ...value, setData(data: { features: unknown[] }) { source.data = data; } }; sources.set(id, source); },
        addLayer(layer: { id: string; type?: string }, reference: unknown) { layers.set(layer.id, layer); before.push(reference); }, moveLayer() {}, removeLayer: (id: string) => layers.delete(id), removeSource: (id: string) => sources.delete(id),
        queryRenderedFeatures: () => hits };
    const maplibre = { Popup: class { constructor() { popups++; } setLngLat() { return this; } setDOMContent() { return this; } addTo() { return this; } remove() {} } };
    const owner = createTerrainWildfires({ map, maplibre, document: dom.window.document, onStatus() {} } as never);
    try {
        owner.update({ enabled: true }); await until(() => sources.get('bpb-wildfires')?.data!.features.length === 2);
        assert.ok(before.every((reference: unknown) => reference === 'bpb-route-main'));
        const fire = { layer: { id: 'bpb-fire-points' }, properties: { id: 'nifc:incident:1' } };
        hits = [{ layer: { id: 'bpb-route-main' } }, fire]; listeners.get('click')!({ point: {}, lngLat: {} }); assert.equal(popups, 0);
        hits = [fire]; listeners.get('click')!({ point: {}, lngLat: {} }); assert.equal(popups, 1);
        const marker = dom.window.document.createElement('div'); marker.className = 'maplibregl-marker';
        listeners.get('click')!({ point: {}, lngLat: {}, originalEvent: { target: marker } }); assert.equal(popups, 1);
        sources.clear(); for (const id of [...layers.keys()]) if (id !== 'bpb-route-main') layers.delete(id);
        owner.paint(); assert.equal(sources.get('bpb-wildfires')!.data!.features.length, 2);
        owner.dispose(); assert.deepEqual([...layers.keys()], ['bpb-route-main']);
    } finally { owner.dispose(); dom.window.close(); }
});

test('short pages marked incomplete cannot hide later reported fires', async () => {
    const all = [1, 2, 3].map(id => wildfireFeature('incidents', id));
    const features = await fetchWildfireComponent('incidents', bounds, { fetchImpl: async url => {
        const offset = Number(new URL(url as string).searchParams.get('resultOffset'));
        return reply({ type: 'FeatureCollection', features: offset === 0 ? all.slice(0, 1) : all.slice(offset), properties: { exceededTransferLimit: offset === 0 } });
    } });
    assert.equal(features.length, 3, 'all three reported fires must be visible after a short incomplete first page');
});

test('wrapped Leaflet worlds preserve provider geometry and unsplit dateline rings fail closed', () => {
    const original = normalize('incidents');
    const copy = wildfireWorldCopy(original, 238);
    assert.equal(positionOf(copy)[0], positionOf(original)[0] + 360);
    assert.equal(positionOf(original)[0], -121.76);
    const perimeter = normalize('perimeters'), polygon = wildfireWorldCopy(perimeter, 238);
    assert.equal(ringsOf(polygon)[0][0][0], ringsOf(perimeter)[0][0][0] + 360);
    assert.equal(ringsOf(polygon).length, 2, 'holes move with their outer ring');
    const raw = wildfireFeature('perimeters'); (raw as WireFeature).geometry.coordinates = [[[179, 45], [-179, 45], [-179, 46], [179, 45]]];
    assert.throws(() => normalize('perimeters', raw), /invalid/);
});
