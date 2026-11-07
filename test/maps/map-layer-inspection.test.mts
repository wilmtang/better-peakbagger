/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';
import { readSnowDepthLegend } from '../../src/maps/snow-depth.js';
import { readFile } from 'node:fs/promises';
import { SnowDepthLayer, PublicLandLayer, SlopeLayer, snowDepthPointReading,
    POINT_INSPECTION_DECISIONS, inspectionContext, createInspectionLayers } from '../../src/maps/map-layer-inspection.ts';
import type { LayerInspectionContext, InspectionPoint, InspectableMapLayer, LayerReading } from '../../src/maps/map-layer-inspection.ts';
import { createMapLayerControl } from '../../src/maps/map-layer-control.ts';
import { createMapLocationMenu } from '../../src/maps/map-location-menu.ts';

// Keep the untyped jsdom dependency behind the DOM contract consumed here.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: {url: string; pretendToBeVisual: boolean}) => {window: Window & typeof globalThis};
};
const legend = readSnowDepthLegend(JSON.parse(await readFile(new URL('../fixtures/maps/snow-depth-legend.json', import.meta.url), 'utf8')));
const point: InspectionPoint = {latitude: 46.85, longitude: -121.76, x: 100, y: 120};
const context = (): LayerInspectionContext => ({state: Schema.mapOverlayState({snow: {enabled: true}, land: {enabled: true}, slope: {enabled: true}}),
    landTypes: Schema.mapLandTypes(), statuses: {snow: {legendEntries: legend}}, zoom: 12, coverage: {}});
const signal = () => new AbortController().signal;
const json = (data: unknown) => new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('every built-in overlay has an explicit point-inspection decision', () => {
    assert.deepEqual(Object.keys(POINT_INSPECTION_DECISIONS).sort(), [...Schema.MAP_OVERLAY_IDS].sort());
    assert.deepEqual(createInspectionLayers(fetch).map(layer => layer.id).sort(),
        Object.entries(POINT_INSPECTION_DECISIONS).filter(([, decision]) => decision === 'query').map(([id]) => id).sort());
});
test('snow reads the displayed class, never labels the raw pixel value as inches; zero is distinct from no data', () => {
    const identify = (index: unknown) => ({results: [{layerId: 3, attributes: {'Service Pixel Value': '74.72', 'Classify.Class value': index}}]});
    assert.equal(snowDepthPointReading(identify(11), legend).value, '394–787 in');
    assert.equal(snowDepthPointReading(identify(0), legend).value, '0–0.39 in');
    for (const index of [null, -1, 12, 1.5, 'NoData']) assert.equal(snowDepthPointReading(identify(index), legend).value, 'Unavailable');
    assert.equal(snowDepthPointReading(identify(1), []).value, 'Unavailable');
    assert.equal(snowDepthPointReading({results: []}, legend).value, 'Unavailable');
});
test('queries use fixed public services, omit credentials and scope snow to the renderer and point', async () => {
    const calls: {url: URL; options?: RequestInit}[] = [];
    const layer = new SnowDepthLayer(async (input, options) => {
        calls.push({url: new URL(String(input)), options});
        return json({results: [{layerId: 3, attributes: {'Classify.Class value': '1'}}]});
    });
    assert.equal((await layer.rightClick(point, context(), signal())).value, '0.39–2.0 in');
    const call = calls[0];
    assert.equal(call.url.hostname, 'mapservices.weather.noaa.gov');
    assert.equal(call.url.searchParams.get('layers'), 'all:3');
    assert.equal(call.url.searchParams.get('geometry'), '-121.76,46.85');
    assert.equal(call.options?.credentials, 'omit'); assert.equal(call.options?.referrerPolicy, 'no-referrer');
    assert.equal(call.options?.redirect, 'error');
    for (const patch of [{enabled: false}, {opacity: 0}]) {
        const c = context(); Object.assign(c.state.snow, patch);
        assert.equal(layer.applicable(c, point), false);
        await assert.rejects(layer.rightClick(point, c, signal()), /not applicable/);
    }
    assert.equal(layer.applicable(context(), {...point, longitude: 20}), false);
    assert.equal(layer.applicable({...context(), zoom: 7}, point), false);
    assert.equal(layer.applicable({...context(), coverage: {snow: false}}, point), false);
    assert.equal(calls.length, 1);
});
test('land ownership respects selected manager/owner types, never equates no parcel with private or access', async () => {
    let url: URL | undefined;
    const layer = new PublicLandLayer(async input => {
        url = new URL(String(input));
        return json({features: [
            {attributes: {Own_Type: 'FED', Mang_Name: 'USFS', Unit_Nm: 'National forest'}},
            {attributes: {Own_Type: 'FED', Mang_Name: 'BLM'}}, {attributes: {Own_Type: 'PVT'}},
        ]});
    });
    const c = context(); c.landTypes = ['USFS'];
    const reading = await layer.rightClick(point, c, signal());
    assert.equal(reading.value, 'USFS'); assert.match(reading.detail, /National forest.*does not establish access/);
    assert.match(url!.searchParams.get('where')!, /Own_Type='FED' AND Mang_Name='USFS'/);
    assert.equal(url!.searchParams.get('returnGeometry'), 'false');
    assert.equal(url!.searchParams.get('outFields'), 'Own_Type,Mang_Name,Unit_Nm');
    c.landTypes = ['USFS', 'BLM'];
    assert.equal((await layer.rightClick(point, c, signal())).value, '2 land types');
    c.landTypes = ['STAT']; assert.equal((await layer.rightClick(point, c, signal())).value, 'No mapped parcel');
    c.landTypes = []; assert.equal(layer.applicable(c, point), false);
    assert.equal((await layer.rightClick({...point, latitude: 50, longitude: -123}, context(), signal())).value, 'Unavailable');
});
test('Alberta point reads request only ownership class; BC never bypasses the optional image permission boundary', async () => {
    let calls = 0;
    const layer = new PublicLandLayer(async input => {
        calls++; const url = new URL(String(input));
        assert.equal(url.hostname, 'geospatial.alberta.ca');
        assert.equal(url.searchParams.get('outFields'), 'crownclass');
        return json({features: [{attributes: {crownclass: 'Provincial'}}]});
    });
    assert.equal((await layer.rightClick({...point, latitude: 51, longitude: -115}, context(), signal())).value, 'Crown land');
    await layer.rightClick({...point, latitude: 50, longitude: -123}, context(), signal()); assert.equal(calls, 1);
});
test('slope validates units/range and partial or malformed responses fail closed', async () => {
    for (const [value, expected] of [['0', '≈ 0.0°'], ['31.25', '≈ 31.3°'], ['NoData', 'Unavailable'], [91, 'Unavailable']]) {
        const layer = new SlopeLayer(async input => {
            assert.deepEqual(JSON.parse(new URL(String(input)).searchParams.get('renderingRule')!), {rasterFunction: 'Slope Degrees'});
            return json({value});
        });
        assert.equal((await layer.rightClick(point, context(), signal())).value, expected);
    }
    const layer = new PublicLandLayer(async () => json({features: [], exceededTransferLimit: true}));
    await assert.rejects(layer.rightClick(point, context(), signal()), /Incomplete/);
});
test('deadline, cancellation, body bound and 429 cooldown cover the entire point request', async () => {
    const hanging = new SnowDepthLayer(() => new Promise<Response>(() => {}), 20);
    await assert.rejects(hanging.rightClick(point, context(), signal()), {name: 'TimeoutError'});
    const cancel = new AbortController(), pending = new SnowDepthLayer(() => new Promise<Response>(() => {}));
    const request = pending.rightClick(point, context(), cancel.signal); cancel.abort();
    await assert.rejects(request, {name: 'AbortError'});
    let count = 0;
    const limited = new SnowDepthLayer(async () => { count++; return new Response('', {status: 429, headers: {'retry-after': '120'}}); });
    await assert.rejects(limited.rightClick(point, context(), signal()), /Service busy/);
    await assert.rejects(limited.rightClick(point, context(), signal()), /Service busy/); assert.equal(count, 1);
    const oversized = new SnowDepthLayer(async () => json({data: 'x'.repeat(70_000)}));
    await assert.rejects(oversized.rightClick(point, context(), signal()), /large|limit/i);
});
test('control supplies document-local context; menu cancels stale rows and invalidates changed layer settings', async () => {
    const dom = new JSDOM('<!doctype html><div id="map" tabindex="0"></div><section id="bpb-peak-weather" data-bpb-map-weather="ready"></section>',
        {url: 'https://www.peakbagger.com/Peak.aspx?pid=1', pretendToBeVisual: true});
    const win = dom.window, doc = win.document, target = doc.getElementById('map')!;
    target.getBoundingClientRect = () => new win.DOMRect(0, 0, 500, 500);
    const control = createMapLayerControl({document: doc}); doc.body.append(control.element);
    const c = context(); control.render(c); control.position(target.getBoundingClientRect());
    const calls: {resolve: (reading: LayerReading) => void; signal: AbortSignal}[] = [];
    const layer: InspectableMapLayer = {id: 'snow', label: 'Snow depth', applicable: () => true,
        rightClick: (_point, _context, requestSignal) => new Promise(resolve => calls.push({resolve, signal: requestSignal}))};
    const menu = createMapLocationMenu({window: win, layers: [layer], client: {lookup: async () => 100, clear() {}}});
    const node = doc.getElementById('bpb-peak-weather-menu')!;
    try {
        assert.ok(inspectionContext(doc, point)); assert.equal(inspectionContext(doc, {...point, x: 600}), null);
        menu.show(point, target); await flush();
        assert.equal(node.querySelectorAll('.bpb-map-location-layer').length, 1);
        menu.show(point, target); await flush(); assert.equal(calls[0].signal.aborted, true);
        calls[0].resolve({value: 'old', detail: ''}); await flush(); assert.doesNotMatch(node.textContent!, /old/);
        calls[1].resolve({value: '2–3.9 in', detail: 'Modeled band'}); await flush(); assert.match(node.textContent!, /2–3.9 in/);
        c.state.snow.enabled = false; control.render(c); assert.equal(node.hidden, true);
        assert.equal(calls[1].signal.aborted, true);
        control.dispose(); assert.equal(inspectionContext(doc, point), null);
        menu.show(point, target); assert.equal(node.querySelectorAll('.bpb-map-location-layer').length, 0);
    } finally { menu.dispose(); control.dispose(); win.close(); }
});
