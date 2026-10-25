import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { wildfireBoxes, wildfireWorldCopy, readWildfireFeature, wildfireRecords, readWildfireRecords, WILDFIRE_LIMITS } from '../../src/maps/wildfire-core.js';
import { wildfireQuery, fetchWildfireComponent } from '../../src/maps/wildfire-client.js';
import { createTerrainWildfires } from '../../src/terrain/terrain-wildfires.js';
import { createWildfireSession } from '../../src/maps/wildfire-session.js';
import { readLayerSnapshot, readLayerStatus } from '../../src/maps/map-layer-protocol.js';
import { wildfireFeature, wildfireFixture } from '../helpers/wildfire-fixture.mjs';
const bounds = [-122, 46, -121, 47];
const budget = () => ({ bytes: 0, vertices: 0 });
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/geo+json' } });
const normalize = (kind, feature = wildfireFeature(kind)) => readWildfireFeature(feature, kind, budget());
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn) { const deadline = Date.now() + 2000; while (!fn()) { if (Date.now() > deadline) throw new Error('Wildfire fixture did not settle'); await tick(); } }
test('fire queries are WF-only, field-allowlisted, credential-independent and wrapped', () => {
    for (const kind of ['incidents', 'perimeters']) {
        const url = new URL(wildfireQuery(kind, bounds)); assert.equal(url.hostname, 'services3.arcgis.com');
        assert.match(url.searchParams.get('where'), /='WF'$/); assert.equal(url.searchParams.get('outSR'), '4326');
        assert.equal(url.searchParams.get('resultRecordCount'), '500'); assert.ok(!url.searchParams.get('outFields').includes('*'));
    }
    assert.deepEqual(wildfireBoxes([179, 40, -179, 50]), [[179, 40, 180, 50], [-180, 40, -179, 50]]);
    assert.deepEqual(wildfireBoxes([238, 46, 239, 47]), [bounds]);
    assert.throws(() => wildfireQuery('arbitrary-url', bounds)); assert.throws(() => wildfireBoxes([NaN, 0, 1, 2]));
});
test('fire identity, perimeter holes and source dates remain distinct; names never join incidents', () => {
    const point = normalize('incidents'), perimeter = normalize('perimeters');
    assert.equal(perimeter.geometry.coordinates.length, 2);
    let records = wildfireRecords([point], [perimeter]); assert.equal(records.length, 1); assert.equal(records[0].hasPerimeter, true);
    assert.ok(records[0].perimeterObserved < records[0].perimeterEdited && records[0].perimeterEdited < records[0].incidentUpdated);
    const raw = wildfireFeature('perimeters'); raw.properties.poly_IRWINID = '11111111-1111-1111-1111-111111111111';
    records = wildfireRecords([point], [normalize('perimeters', raw)]); assert.equal(records.length, 2, 'conflicting IDs remain unassociated despite identical names');
    const noDate = wildfireFeature(); noDate.properties.ModifiedOnDateTime_dt = null; assert.equal(normalize('incidents', noDate).properties.incidentUpdated, null);
    assert.deepEqual(readWildfireRecords([{ id: 'evil:url', name: 'x' }]), []);
});
test('invalid points, open rings, empty polygons, prescribed burns and vertex overflow fail closed', () => {
    for (const mutate of [f => f.geometry.coordinates[0][0][0] = NaN, f => f.geometry.coordinates[0].pop(), f => f.geometry.coordinates = [], f => f.geometry.coordinates[1] = [[0,0],[1,0],[1,1],[0,0]], f => f.properties.attr_IncidentTypeCategory = 'RX']) {
        const f = wildfireFeature('perimeters'); mutate(f); assert.throws(() => normalize('perimeters', f));
    }
    const f = wildfireFeature(); f.geometry.coordinates[0] = 181; assert.throws(() => normalize('incidents', f));
    assert.throws(() => readWildfireFeature(wildfireFeature(), 'incidents', { vertices: WILDFIRE_LIMITS.vertices }), /Zoom in/);
});
test('pagination honors nested truncation flags, rejects repeated or incomplete pages, and budgets bytes', async () => {
    let calls = 0, init;
    const fetchImpl = async (url, options) => { init = options; calls++; if (calls === 2) assert.equal(new URL(url).searchParams.get('resultOffset'), '1', 'advance by returned records, not requested page size');
        return reply(calls === 1 ? { ...wildfireFixture(), properties: { exceededTransferLimit: true } } : { type: 'FeatureCollection', features: [] }); };
    const features = await fetchWildfireComponent('incidents', bounds, { fetchImpl }); assert.equal(features.length, 1); assert.equal(calls, 2);
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ ...wildfireFixture(), properties: { exceededTransferLimit: true } }) }), /changed/);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ type: 'FeatureCollection', features: [], properties: { exceededTransferLimit: true } }) }), /Incomplete/);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { budget: { bytes: WILDFIRE_LIMITS.bytes, vertices: 0 }, fetchImpl: async () => reply(wildfireFixture()) }), /Zoom in/);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ error: { code: 400 } }) }), /could not/);
});
test('wildfire transactions bound deadlines, body reads, cancellation, transient retries and rate limits', async () => {
    let calls = 0;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { signal: controller.signal, fetchImpl: async () => { calls++; return reply(wildfireFixture()); } }), { name: 'AbortError' }); assert.equal(calls, 0);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }), { name: 'TimeoutError' });
    calls = 0; await fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : reply(wildfireFixture()) }); assert.equal(calls, 2);
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => new Response('', { status: 429 }) }), e => e.retryAt > Date.now());
    await assert.rejects(fetchWildfireComponent('incidents', bounds, { fetchImpl: async () => reply({ error: { code: 429 } }) }), e => e.retryAt > Date.now());
});
function session(fetchImpl, options = {}) {
    const dom = new JSDOM('', { pretendToBeVisual: true }), states = [], displays = []; let view = { bounds, zoom: 10 };
    const owner = createWildfireSession({ document: dom.window.document, readView: () => view, fetchImpl, debounceMs: 0, onStatus: status => states.push(status), onData: result => displays.push(result), ...options });
    return { owner, states, displays, doc: dom.window.document, setView(next) { view = next; }, close() { owner.dispose(); dom.window.close(); } };
}
test('fires are off by default, publish each complete component and distinguish partial from empty', async () => {
    let calls = 0;
    const env = session(async url => { calls++; return url.includes('Interagency') ? new Response('', { status: 400 }) : reply(wildfireFixture()); });
    try {
        await tick(); assert.equal(calls, 0); env.owner.update({ enabled: true });
        await until(() => env.states.at(-1)?.pending === false);
        assert.equal(calls, 2); assert.equal(env.states.at(-1).partial, true); assert.equal(env.states.at(-1).count, 1);
        assert.equal(env.displays.at(-1).incidents.length, 1); assert.equal(env.displays.at(-1).perimeters.length, 0);
        env.owner.update({ enabled: true }); await tick(); assert.equal(calls, 2, 'status/menu snapshots do not replay a failed component');
        env.owner.update({ enabled: false }); assert.equal(env.displays.at(-1).incidents.length, 0);
    } finally { env.close(); }
    const empty = session(async () => reply({ type: 'FeatureCollection', features: [] }));
    try { empty.owner.update({ enabled: true }); await until(() => empty.states.at(-1)?.pending === false); assert.match(empty.states.at(-1).message, /No reported fires/); assert.equal(empty.states.at(-1).error, false); } finally { empty.close(); }
});
test('pan and page visibility cancel stale transports and never publish late results', async () => {
    const held = [];
    const env = session((url, init) => new Promise(resolve => held.push({ url, init, resolve })));
    try {
        env.owner.update({ enabled: true }); await until(() => held.length === 2); env.owner.moving();
        assert.ok(held.every(item => item.init.signal.aborted));
        held.forEach(item => item.resolve(reply(wildfireFixture(item.url.includes('Interagency') ? 'perimeters' : 'incidents'))));
        await tick(); assert.equal(env.displays.at(-1).incidents.length, 0);
        Object.defineProperty(env.doc, 'visibilityState', { configurable: true, value: 'hidden' }); env.owner.update({ enabled: true }); await tick(); assert.equal(held.length, 2);
    } finally { env.close(); }
});
test('complete previous components survive failed refreshes, expire, and are cleared on pan', async () => {
    let now = Date.now(), bad = false;
    const env = session(async url => bad ? new Response('', { status: 400 }) : reply(wildfireFixture(url.includes('Interagency') ? 'perimeters' : 'incidents')), { now: () => now });
    try {
        env.owner.update({ enabled: true }); await until(() => env.states.at(-1)?.pending === false);
        bad = true; env.owner.retry(); await until(() => env.states.at(-1)?.pending === false);
        assert.equal(env.states.at(-1).saved, true); assert.equal(env.displays.at(-1).perimeters.length, 1);
        now += 1800001; env.owner.retry(); await until(() => env.states.at(-1)?.pending === false);
        assert.equal(env.displays.at(-1).incidents.length, 0); assert.equal(env.states.at(-1).saved, false);
        env.setView({ bounds: [-120, 45, -119, 46], zoom: 10 }); env.owner.refresh(); assert.equal(env.displays.at(-1).perimeters.length, 0);
    } finally { env.close(); }
});
test('wildfire handoffs and bridge metadata are typed and cannot carry arbitrary URLs or geometry', () => {
    const snapshot = readLayerSnapshot({ revision: 1, state: { wildfire: { enabled: true, opacity: 0 } } }); assert.equal(snapshot.state.wildfire.opacity, 100);
    const raw = { id: 'nifc:incident:1', name: 'X', hasPerimeter: true, geometry: { evil: true }, url: 'https://evil.example', incidentUpdated: Infinity };
    const status = readLayerStatus({ id: 'wildfire', count: Infinity, fires: [raw], loadedAt: Infinity, saved: true, overflow: true });
    assert.equal(status.count, 0); assert.equal(status.loadedAt, 0); assert.equal(status.fires[0].incidentUpdated, null);
    assert.equal(Object.hasOwn(status.fires[0], 'url'), false); assert.equal(Object.hasOwn(status.fires[0], 'geometry'), false);
});

test('cancelling a pending viewport does not cache the failed attempt for five minutes', async () => {
    const held = [];
    const env = session((url, init) => new Promise(resolve => held.push({ url, init, resolve })));
    try {
        env.owner.update({ enabled: true }); await until(() => held.length === 2);
        env.owner.moving(); env.owner.refresh(); await until(() => held.length === 4);
        assert.ok(held.slice(0, 2).every(item => item.init.signal.aborted));
    } finally { env.close(); }
});

test('terrain fire layers preserve native interaction priority and survive style replacement', async t => {
    t.mock.method(globalThis, 'fetch', async url => reply(wildfireFixture(url.includes('Interagency') ? 'perimeters' : 'incidents')));
    const dom = new JSDOM('', { pretendToBeVisual: true }), listeners = new Map(), sources = new Map(), layers = new Map([['bpb-route-main', { id: 'bpb-route-main', type: 'line' }]]), before = [];
    let hits = [], popups = 0;
    const map = { getBounds: () => ({ getWest: () => -122, getSouth: () => 46, getEast: () => -121, getNorth: () => 47 }), getZoom: () => 9,
        on: (event, handler) => listeners.set(event, handler), off: event => listeners.delete(event), getStyle: () => ({ layers: [...layers.values()] }),
        getSource: id => sources.get(id), getLayer: id => layers.get(id),
        addSource(id, value) { const source = { ...value, setData(data) { source.data = data; } }; sources.set(id, source); },
        addLayer(layer, reference) { layers.set(layer.id, layer); before.push(reference); }, moveLayer() {}, removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id),
        queryRenderedFeatures: () => hits };
    const maplibre = { Popup: class { constructor() { popups++; } setLngLat() { return this; } setDOMContent() { return this; } addTo() { return this; } remove() {} } };
    const owner = createTerrainWildfires({ map, maplibre, document: dom.window.document, onStatus() {} });
    try {
        owner.update({ enabled: true }); await until(() => sources.get('bpb-wildfires')?.data.features.length === 2);
        assert.ok(before.every(reference => reference === 'bpb-route-main'));
        const fire = { layer: { id: 'bpb-fire-points' }, properties: { id: 'nifc:incident:1' } };
        hits = [{ layer: { id: 'bpb-route-main' } }, fire]; listeners.get('click')({ point: {}, lngLat: {} }); assert.equal(popups, 0);
        hits = [fire]; listeners.get('click')({ point: {}, lngLat: {} }); assert.equal(popups, 1);
        const marker = dom.window.document.createElement('div'); marker.className = 'maplibregl-marker';
        listeners.get('click')({ point: {}, lngLat: {}, originalEvent: { target: marker } }); assert.equal(popups, 1);
        sources.clear(); for (const id of [...layers.keys()]) if (id !== 'bpb-route-main') layers.delete(id);
        owner.paint(); assert.equal(sources.get('bpb-wildfires').data.features.length, 2);
        owner.dispose(); assert.deepEqual([...layers.keys()], ['bpb-route-main']);
    } finally { owner.dispose(); dom.window.close(); }
});

test('short pages marked incomplete cannot hide later reported fires', async () => {
    const all = [1, 2, 3].map(id => wildfireFeature('incidents', id));
    const features = await fetchWildfireComponent('incidents', bounds, { fetchImpl: async url => {
        const offset = Number(new URL(url).searchParams.get('resultOffset'));
        return reply({ type: 'FeatureCollection', features: offset === 0 ? all.slice(0, 1) : all.slice(offset), properties: { exceededTransferLimit: offset === 0 } });
    } });
    assert.equal(features.length, 3, 'all three reported fires must be visible after a short incomplete first page');
});

test('wrapped Leaflet worlds preserve provider geometry and unsplit dateline rings fail closed', () => {
    const original = normalize('incidents');
    const copy = wildfireWorldCopy(original, 238);
    assert.equal(copy.geometry.coordinates[0], original.geometry.coordinates[0] + 360);
    assert.equal(original.geometry.coordinates[0], -121.76);
    const perimeter = normalize('perimeters'), polygon = wildfireWorldCopy(perimeter, 238);
    assert.equal(polygon.geometry.coordinates[0][0][0], perimeter.geometry.coordinates[0][0][0] + 360);
    assert.equal(polygon.geometry.coordinates.length, 2, 'holes move with their outer ring');
    const raw = wildfireFeature('perimeters'); raw.geometry.coordinates = [[[179, 45], [-179, 45], [-179, 46], [179, 45]]];
    assert.throws(() => normalize('perimeters', raw), /invalid/);
});
