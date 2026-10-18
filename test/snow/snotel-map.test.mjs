// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPeakSnowMap } from '../../src/maps/peak-snow-map.js';
import { createSnotelMapSource } from '../../src/snow/snotel-map-source.js';
import { readSnotelMapStations } from '../../src/snow/snotel-map-data.js';
import { createTerrainSnotelMarkers } from '../../src/snow/snotel-map-marker.js';
import { validateSnotelStations, nearbySnotelStations } from '../../src/snow/snotel-data.js';
import { snotelStations } from '../helpers/snotel-fixture.mjs';

const stations = readSnotelMapStations(validateSnotelStations(snotelStations()));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
    const env = new JSDOM('<!doctype html><div id="mount"></div>', { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296' });
    const win = env.window, messages = [], terrain = [], native = { layers: new Set(['basemap', 'summit', 'route']) }, groups = [];
    win.postMessage = message => messages.push(message);
    const emit = (data, origin = win.location.origin) => win.dispatchEvent(new win.MessageEvent('message', {
        source: win, origin, data: { __bpbPeakSnow: true, dir: 'toPage', ...data },
    }));
    const L = {
        divIcon: options => options,
        layerGroup() {
            const group = { markers: [], addTo(map) { this.map = map; map.layers.add(this); return this; }, remove() { this.map?.layers.delete(this); } };
            groups.push(group); return group;
        },
        marker(point, options) { return { point, options, bindPopup(content, popupOptions) { this.content = content; this.popupOptions = popupOptions; return this; }, addTo(group) { group.markers.push(this); return this; } }; },
    };
    let context = { win: { L, document: win.document }, map: native };
    const layer = createPeakSnowMap({ mount: win.document.querySelector('#mount'), getContext: () => context, postTerrain: (type, data) => terrain.push({ type, ...data }) });
    const button = win.document.querySelector('#bpb-snow-map-toggle');
    return { win, messages, terrain, native, groups, layer, button, emit, setContext: value => { context = value; },
        close: () => { layer.dispose(); win.close(); } };
}

test('map metadata is bounded, rebuilt and rejects identity, HTML URL and coordinate tricks', () => {
    assert.equal(readSnotelMapStations(Array(51).fill(stations[0])), null);
    assert.equal(readSnotelMapStations([stations[0], stations[0]]), null);
    for (const patch of [{ id: 'javascript:x' }, { latitude: NaN }, { longitude: 181 }, { elevation: '1000' }, { name: 'bad\nname' }]) {
        assert.equal(readSnotelMapStations([{ ...stations[0], ...patch }]), null);
    }
    const safe = readSnotelMapStations([{ ...stations[0], html: '<script>', url: 'https://evil.example/' }]);
    assert.deepEqual(safe, [stations[0]]);
    const many = Array.from({ length: 8 }, (_, i) => ({ ...stations[0], id: `${i}:WA:SNTL` }));
    assert.equal(nearbySnotelStations(many, stations[0]).length, 3);
    assert.equal(nearbySnotelStations(many, stations[0], 50).length, 8);
    assert.throws(() => nearbySnotelStations(many, stations[0], 51));
});

test('snow toggle preserves native layers, camera and focus, and shares a sanitized 3D snapshot', () => {
    const env = setup();
    try {
        assert.equal(env.button.hidden, true); env.emit({ type: 'availability', enabled: true });
        assert.equal(env.button.textContent, 'SNOTEL');
        assert.equal(env.button.hidden, false); assert.equal(env.button.getAttribute('aria-pressed'), 'false');
        env.button.focus(); env.button.click();
        const request = env.messages.at(-1); assert.equal(request.type, 'get');
        assert.equal(env.button.getAttribute('aria-busy'), 'true');
        env.emit({ type: 'stations', requestId: request.requestId, stations });
        assert.equal(env.groups[0].markers.length, 2); assert.equal(env.native.layers.size, 4);
        assert.deepEqual(env.groups[0].markers[0].popupOptions.autoPanPadding, [12, 12]);
        assert.match(env.groups[0].markers[0].content.textContent, /Paradise.*SNOTEL.*View NRCS/);
        const action = env.groups[0].markers[0].content.querySelector('.bpb-snotel-show-conditions');
        assert.equal(action.type, 'button'); action.click();
        assert.deepEqual(env.messages.at(-1), { __bpbPeakSnow: true, dir: 'toCS', type: 'select', stationId: stations[0].id });
        assert.equal(env.win.document.activeElement, env.button);
        assert.deepEqual(env.layer.snapshot(), stations); assert.deepEqual(env.terrain.at(-1).snowStations, stations);
        env.button.click(); assert.deepEqual([...env.native.layers], ['basemap', 'summit', 'route']);
        assert.deepEqual(env.terrain.at(-1).snowStations, []);
        const requests = env.messages.filter(message => message.type === 'get').length;
        env.button.click(); assert.equal(env.messages.filter(message => message.type === 'get').length, requests);
        env.layer.suspend(); assert.equal(env.native.layers.size, 3);
        env.layer.resume(); assert.equal(env.native.layers.size, 4, 'a cached overlay returns after BFCache restoration');
        env.layer.attach(); assert.equal(env.native.layers.size, 4, 'frame reload replaces only its own overlay');
        env.emit({ type: 'availability', enabled: false });
        assert.equal(env.button.hidden, true); assert.equal(env.native.layers.size, 3); assert.deepEqual(env.layer.snapshot(), []);
    } finally { env.close(); }
});

test('cancellation, stale/foreign replies, failures, retry and empty coverage are explicit', () => {
    const env = setup();
    try {
        env.emit({ type: 'availability', enabled: true }); env.button.click(); const first = env.messages.at(-1).requestId;
        env.button.click(); env.emit({ type: 'stations', requestId: first, stations }); assert.equal(env.groups.length, 0);
        env.button.click(); const current = env.messages.at(-1).requestId;
        env.emit({ type: 'stations', requestId: current, stations }, 'https://evil.example'); assert.equal(env.groups.length, 0);
        env.emit({ type: 'stations', requestId: current, stations: [{ ...stations[0], longitude: 181 }] });
        const retry = env.win.document.querySelector('.bpb-snow-map-notice button');
        assert.equal(retry.hidden, false); assert.match(retry.parentElement.textContent, /unavailable/);
        retry.click(); const next = env.messages.at(-1).requestId; assert.ok(next > current);
        env.emit({ type: 'stations', requestId: next, stations: [] });
        assert.match(retry.parentElement.textContent, /No SNOTEL stations within 50 km/);
        assert.equal(retry.hidden, true); assert.equal(env.button.getAttribute('aria-busy'), 'false');
        env.layer.suspend(); env.layer.resume(); assert.equal(env.groups.length, 0);
    } finally { env.close(); }
});

test('isolated source gates requests, filters locally, coalesces readers, and cancels late work', async () => {
    const env = new JSDOM('', { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296' }), win = env.window, messages = [];
    win.postMessage = message => messages.push(message);
    let calls = 0, finish, signal;
    const source = createSnotelMapSource({ ownerWindow: win, subject: { latitude: 46.85, longitude: -121.76 }, client: {
        stations(options) { calls++; signal = options.signal; return new Promise(resolve => { finish = resolve; }); },
    } });
    const emit = data => win.dispatchEvent(new win.MessageEvent('message', { source: win, origin: win.location.origin,
        data: { __bpbPeakSnow: true, dir: 'toCS', ...data } }));
    try {
        emit({ type: 'get', requestId: 1 }); assert.equal(calls, 0);
        source.setEnabled(true); emit({ type: 'get', requestId: 1 }); emit({ type: 'get', requestId: 2 }); assert.equal(calls, 1);
        finish([...validateSnotelStations(snotelStations()), { ...stations[0], id: '999:CO:SNTL', latitude: 38 }]); await tick();
        assert.equal(messages.at(-1).requestId, 2); assert.equal(messages.at(-1).stations.length, 2);
        assert.deepEqual(Object.keys(messages.at(-1).stations[0]).sort(), ['elevation', 'id', 'latitude', 'longitude', 'name']);
        emit({ type: 'get', requestId: 3 }); source.setEnabled(false); assert.equal(signal.aborted, true);
        const count = messages.length; finish(stations); await tick(); assert.equal(messages.length, count);
        source.suspend(); source.setEnabled(true); emit({ type: 'get', requestId: 4 }); assert.equal(calls, 2);
    } finally { source.dispose(); win.close(); }
});

test('a rate limit stays visible after off/on and blocks retry activation', () => {
    const env = setup();
    try {
        env.emit({ type: 'availability', enabled: true }); env.button.click();
        const requestId = env.messages.at(-1).requestId;
        env.emit({ type: 'stations', requestId, error: true, retryAt: Date.now() + 60_000 });
        const retry = env.win.document.querySelector('.bpb-snow-map-notice button');
        assert.equal(retry.getAttribute('aria-disabled'), 'true');
        env.button.click(); env.button.click();
        assert.equal(retry.parentElement.hidden, false); assert.match(retry.parentElement.textContent, /NRCS is busy/);
        const requests = env.messages.filter(message => message.type === 'get').length;
        retry.click(); assert.equal(env.messages.filter(message => message.type === 'get').length, requests);
        assert.equal(env.button.getAttribute('aria-busy'), 'false');
    } finally { env.close(); }
});

test('map selections resolve only exposed nearby catalog identities while active and enabled', async () => {
    const env = new JSDOM('', { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296' }), win = env.window, selected = [];
    win.postMessage = () => {};
    const source = createSnotelMapSource({ ownerWindow: win, subject: { latitude: 46.85, longitude: -121.76 },
        client: { stations: async () => [...validateSnotelStations(snotelStations()), { ...stations[0], id: '999:CO:SNTL', latitude: 38 }] },
        onSelect: (station, nearby) => selected.push({ station, nearby }) });
    const emit = (data, origin = win.location.origin) => win.dispatchEvent(new win.MessageEvent('message', {
        source: win, origin, data: { __bpbPeakSnow: true, dir: 'toCS', ...data },
    }));
    try {
        source.setEnabled(true);
        emit({ type: 'select', stationId: stations[0].id }); assert.equal(selected.length, 0);
        emit({ type: 'get', requestId: 1 }); await tick();
        for (const stationId of ['999:CO:SNTL', 'https://evil.example/', {}, null]) emit({ type: 'select', stationId });
        emit({ type: 'select', stationId: stations[0].id }, 'https://evil.example'); assert.equal(selected.length, 0);
        emit({ type: 'select', stationId: stations[0].id, latitude: 0, offset: 14 });
        assert.equal(selected.length, 1); assert.equal(selected[0].station.latitude, stations[0].latitude);
        assert.equal(selected[0].station.offset, -8); assert.equal(selected[0].nearby.length, 2);
        emit({ type: 'cancel' }); emit({ type: 'select', stationId: stations[1].id });
        assert.equal(selected.length, 2, 'cached off/on does not discard catalog membership');
        source.suspend(); emit({ type: 'select', stationId: stations[0].id }); assert.equal(selected.length, 2);
        source.resume(); source.setEnabled(false); emit({ type: 'select', stationId: stations[0].id });
        source.setEnabled(true); emit({ type: 'select', stationId: stations[0].id }); assert.equal(selected.length, 2);
    } finally { source.dispose(); win.close(); }
});

test('terrain stations use keyboard buttons, local DOM text, one popup, and complete teardown', () => {
    const env = new JSDOM(''), doc = env.window.document, pins = [], popups = [];
    class Popup {
        constructor() { this.events = {}; popups.push(this); }
        setDOMContent(node) { this.node = node; return this; }
        setLngLat(point) { this.point = point; return this; }
        addTo() { this.open = true; return this; }
        on(type, handler) { this.events[type] = handler; return this; }
        remove() { this.events.close?.(); this.removed = true; }
    }
    class Marker {
        constructor(options) { this.options = options; pins.push(this); }
        setLngLat(point) { this.point = point; return this; }
        setPopup(popup) { this.popup = popup; return this; }
        addTo() { return this; }
        remove() { this.removed = true; }
    }
    const selected = [];
    const renderer = createTerrainSnotelMarkers({ maplibre: { Marker, Popup }, document: doc, onSelect: id => selected.push(id) });
    try {
        assert.equal(renderer.replace({}, stations), true);
        assert.deepEqual(pins[0].point, [stations[0].longitude, stations[0].latitude]);
        assert.equal(pins[0].options.element.tagName, 'BUTTON'); assert.equal(pins[0].options.element.type, 'button');
        assert.match(pins[0].options.element.getAttribute('aria-label'), /Paradise.*SNOTEL/);
        pins[0].options.element.click(); pins[1].options.element.click(); assert.equal(popups[0].removed, true);
        popups[1].node.querySelector('.bpb-snotel-show-conditions').click(); assert.deepEqual(selected, [stations[1].id]);
        assert.equal(renderer.closePopup(), true); assert.equal(renderer.closePopup(), false);
        renderer.clear(); assert.ok(pins.every(pin => pin.removed));
    } finally { env.window.close(); }
});
