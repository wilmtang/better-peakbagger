// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDom, browserWindow, type FixtureWindow } from '../helpers/fixture-dom.mts';
import { createSnotelMapSource, type SnotelMapSourceWindow } from '../../src/snow/snotel-map-source.ts';
import { readSnotelMapStations, readSnotelMapOcclusion, readSnotelMapOcclusions, type SnotelMapStation } from '../../src/snow/snotel-map-data.ts';
import { createTerrainSnotelMarkers } from '../../src/snow/snotel-map-marker.ts';
import { validateSnotelStations, nearbySnotelStations, type SnotelNearbyStation, type SnotelStation } from '../../src/snow/snotel-data.ts';
import { snotelStations } from '../helpers/snotel-fixture.mts';

const stations = readSnotelMapStations(validateSnotelStations(snotelStations()))!;
const [first, second] = stations as [SnotelMapStation, SnotelMapStation, ...SnotelMapStation[]];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
type LngLat = [number, number];
type MarkerOptions = { element: HTMLElement };
// A fixture frame is a real window; these narrow it to the surfaces the
// source and renderer accept.
const sourceWindow = (win: FixtureWindow) => browserWindow(win) as unknown as SnotelMapSourceWindow;
const markerDocument = (win: FixtureWindow) => browserWindow(win).document;
test('map metadata is bounded, rebuilt and rejects identity, HTML URL and coordinate tricks', () => {
    assert.equal(readSnotelMapStations(Array(51).fill(first)), null);
    assert.equal(readSnotelMapStations([first, first]), null);
    for (const patch of [{ id: 'javascript:x' }, { latitude: NaN }, { longitude: 181 }, { elevation: '1000' }, { name: 'bad\nname' }]) {
        assert.equal(readSnotelMapStations([{ ...first, ...patch }]), null);
    }
    const safe = readSnotelMapStations([{ ...first, html: '<script>', url: 'https://evil.example/' }]);
    assert.deepEqual(safe, [first]);
    const many = Array.from({ length: 8 }, (_, i) => ({ ...first, id: `${i}:WA:SNTL` }));
    assert.equal(nearbySnotelStations(many, first).length, 3);
    assert.equal(nearbySnotelStations(many, first, 50).length, 8);
    assert.throws(() => nearbySnotelStations(many, first, 51));
});

test('isolated source gates requests, filters locally, coalesces readers, and cancels late work', async () => {
    const env = new FixtureDom('', { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296' }), win = env.window;
    const messages: { requestId?: number; stations: Record<string, unknown>[] }[] = [];
    win.postMessage = ((message: typeof messages[number]) => { messages.push(message); }) as typeof win.postMessage;
    let calls = 0, finish: ((stations: SnotelStation[]) => void) | undefined, signal: AbortSignal | undefined;
    const source = createSnotelMapSource({ ownerWindow: sourceWindow(win), subject: { latitude: 46.85, longitude: -121.76 }, client: {
        stations(options) { calls++; signal = options?.signal ?? undefined; return new Promise(resolve => { finish = resolve; }); },
    } });
    const emit = (data: Record<string, unknown>) => win.dispatchEvent(new win.MessageEvent('message', { source: browserWindow(win), origin: win.location.origin,
        data: { __bpbPeakSnow: true, dir: 'toCS', ...data } }));
    try {
        emit({ type: 'get', requestId: 1 }); assert.equal(calls, 0);
        source.setEnabled(true); emit({ type: 'get', requestId: 1 }); emit({ type: 'get', requestId: 2 }); assert.equal(calls, 1);
        finish!([...validateSnotelStations(snotelStations()), { ...first, id: '999:CO:SNTL', latitude: 38 } as SnotelStation]); await tick();
        assert.equal(messages.at(-1)!.requestId, 2); assert.equal(messages.at(-1)!.stations.length, 2);
        assert.deepEqual(Object.keys(messages.at(-1)!.stations[0]!).sort(), ['elevation', 'id', 'latitude', 'longitude', 'name']);
        emit({ type: 'get', requestId: 3 }); source.setEnabled(false); assert.equal(signal!.aborted, true);
        const count = messages.length; finish!(stations as SnotelStation[]); await tick(); assert.equal(messages.length, count);
        source.suspend(); source.setEnabled(true); emit({ type: 'get', requestId: 4 }); assert.equal(calls, 2);
    } finally { source.dispose(); win.close(); }
});

test('map selections resolve only exposed nearby catalog identities while active and enabled', async () => {
    const env = new FixtureDom('', { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296' }), win = env.window;
    const selected: { station: SnotelNearbyStation; nearby: SnotelNearbyStation[] }[] = [];
    win.postMessage = () => {};
    const source = createSnotelMapSource({ ownerWindow: sourceWindow(win), subject: { latitude: 46.85, longitude: -121.76 },
        client: { stations: async () => [...validateSnotelStations(snotelStations()), { ...first, id: '999:CO:SNTL', latitude: 38 } as SnotelStation] },
        onSelect: (station, nearby) => { selected.push({ station, nearby }); } });
    const emit = (data: Record<string, unknown>, origin = win.location.origin) => win.dispatchEvent(new win.MessageEvent('message', {
        source: browserWindow(win), origin, data: { __bpbPeakSnow: true, dir: 'toCS', ...data },
    }));
    try {
        source.setEnabled(true);
        emit({ type: 'select', stationId: first.id }); assert.equal(selected.length, 0);
        emit({ type: 'get', requestId: 1 }); await tick();
        for (const stationId of ['999:CO:SNTL', 'https://evil.example/', {}, null]) emit({ type: 'select', stationId });
        emit({ type: 'select', stationId: first.id }, 'https://evil.example'); assert.equal(selected.length, 0);
        emit({ type: 'select', stationId: first.id, latitude: 0, offset: 14 });
        assert.equal(selected.length, 1); assert.equal(selected[0]!.station.latitude, first.latitude);
        assert.equal(selected[0]!.station.offset, -8); assert.equal(selected[0]!.nearby.length, 2);
        emit({ type: 'cancel' }); emit({ type: 'select', stationId: second.id });
        assert.equal(selected.length, 2, 'cached off/on does not discard catalog membership');
        source.suspend(); emit({ type: 'select', stationId: first.id }); assert.equal(selected.length, 2);
        source.resume(); source.setEnabled(false); emit({ type: 'select', stationId: first.id });
        source.setEnabled(true); emit({ type: 'select', stationId: first.id }); assert.equal(selected.length, 2);
    } finally { source.dispose(); win.close(); }
});

test('terrain stations use keyboard buttons, local DOM text, one popup, and complete teardown', () => {
    const env = new FixtureDom(''), doc = markerDocument(env.window);
    const pins: Marker[] = [], popups: Popup[] = [];
    class Popup {
        events: Record<string, () => void> = {}; node?: HTMLElement; point?: LngLat; open = false; removed = false;
        constructor() { popups.push(this); }
        setDOMContent(node: HTMLElement) { this.node = node; return this; }
        setLngLat(point: LngLat) { this.point = point; return this; }
        addTo() { this.open = true; return this; }
        on(type: string, handler: () => void) { this.events[type] = handler; return this; }
        remove() { this.events.close?.(); this.removed = true; }
    }
    class Marker {
        options: MarkerOptions; point?: LngLat; removed = false;
        constructor(options: MarkerOptions) { this.options = options; pins.push(this); }
        setLngLat(point: LngLat) { this.point = point; return this; }
        addTo() { return this; }
        remove() { this.removed = true; }
    }
    const selected: string[] = [];
    const renderer = createTerrainSnotelMarkers({ maplibre: { Marker, Popup }, document: doc, onSelect: id => { selected.push(id); } });
    try {
        assert.equal(renderer.replace({}, stations), true);
        assert.deepEqual(pins[0]!.point, [first.longitude, first.latitude]);
        assert.equal(pins[0]!.options.element.tagName, 'BUTTON'); assert.equal((pins[0]!.options.element as HTMLButtonElement).type, 'button');
        assert.match(pins[0]!.options.element.getAttribute('aria-label') ?? '', /Paradise.*SNOTEL/);
        pins[0]!.options.element.click(); pins[1]!.options.element.click(); assert.equal(popups[0]!.removed, true);
        popups[1]!.node!.querySelector<HTMLElement>('.bpb-snotel-show-conditions')!.click(); assert.deepEqual(selected, [second.id]);
        assert.equal(renderer.closePopup(), true); assert.equal(renderer.closePopup(), false);
        renderer.clear(); assert.ok(pins.every(pin => pin.removed));
    } finally { env.window.close(); }
});

test('terrain membership updates keep an existing station popup and its focused link', () => {
    const env = new FixtureDom('<body></body>'), doc = markerDocument(env.window);
    const pins: Marker[] = [], popups: Popup[] = [];
    let allowed = false;
    class Popup {
        events: Record<string, () => void> = {}; node?: HTMLElement; removed = false;
        constructor() { popups.push(this); }
        setDOMContent(node: HTMLElement) { this.node = node; return this; }
        setLngLat() { return this; }
        addTo() { doc.body.append(this.node!); return this; }
        on(type: string, handler: () => void) { this.events[type] = handler; return this; }
        remove() { this.node!.remove(); this.events.close?.(); this.removed = true; }
    }
    class Marker {
        options: MarkerOptions; removed = false;
        constructor(options: MarkerOptions) { this.options = options; pins.push(this); }
        setLngLat() { return this; }
        addTo() { return this; }
        remove() { this.removed = true; }
    }
    const renderer = createTerrainSnotelMarkers({ maplibre: { Marker, Popup }, document: doc, canSelect: () => allowed, onSelect() {} });
    try {
        renderer.replace({}, stations); pins[0]!.options.element.click();
        const link = popups[0]!.node!.querySelector('a')!; link.focus();
        allowed = true; renderer.replace({}, stations);
        assert.equal(pins.length, stations.length, 'membership changes reuse existing markers');
        assert.notEqual(popups[0]!.removed, true, 'the open popup survives'); assert.equal(doc.activeElement, link);
        popups[0]!.node!.querySelector('button')!.focus(); allowed = false; renderer.replace({}, stations);
        assert.equal(popups[0]!.node!.querySelector('button'), null); assert.equal(doc.activeElement, link);
    } finally { renderer.clear(); env.window.close(); }
});


test('map occlusion is a copied normalized screen rectangle at each renderer boundary', () => {
    const rect = [.02, .1, .7, .9];
    const clean = readSnotelMapOcclusion(rect); assert.deepEqual(clean, rect); assert.notEqual(clean, rect);
    for (const invalid of [undefined, null, {}, [0, 0, 1], [0, 0, 1, 1, 0], [0, 0, Infinity, 1], [-1, 0, 1, 1], [0, 0, 2, 1], [.9, 0, .1, 1]]) {
        assert.equal(readSnotelMapOcclusion(invalid), null);
    }
});


test('outer map chrome rectangles are bounded and revalidated together', () => {
    assert.deepEqual(readSnotelMapOcclusions([[0,0,.6,.8],[.8,.6,1,.9]]), [[0,0,.6,.8],[.8,.6,1,.9]]);
    for (const invalid of [undefined, {}, Array(9).fill([0,0,1,1]), [[0,0,.5,.5],[0,0,2,1]]]) assert.deepEqual(readSnotelMapOcclusions(invalid), []);
});
