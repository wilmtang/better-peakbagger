// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installMapLayers } from '../../src/maps/map-layers.js';

const station = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78266, longitude: -121.74767, elevation: 1570 };
const bounds = [-121.77, 46.84, -121.75, 46.86];
function setup(terrain = false) {
    const dom = new JSDOM('<body><div id="map"></div></body>', { url: 'https://www.peakbagger.com/Peak.aspx?pid=2296', pretendToBeVisual: true });
    const win = dom.window, messages = [], moves = [], events = new Map();
    const container = win.document.getElementById('map');
    container.getBoundingClientRect = () => ({ left: 20, top: 40, bottom: 440, width: 800, height: 400 });
    const map = { getBounds: () => ({ getWest: () => bounds[0], getSouth: () => bounds[1], getEast: () => bounds[2], getNorth: () => bounds[3] }),
        getCenter: () => ({ lat: 46.85, lng: -121.76 }), getZoom: () => 17, getSize: () => ({ x: 800, y: 400 }),
        getContainer: () => container, eachLayer() {}, removeLayer() {}, latLngToContainerPoint: () => ({ x: -1000, y: -1000 }),
        on(name, handler) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(handler); },
        off(name, handler) { events.get(name)?.delete(handler); }, flyToBounds: (...args) => moves.push(args), stop() {} };
    win.mapsPlaceholder = map; win.fetch = async () => { throw new Error('Unexpected provider request'); };
    win.L = { GridLayer: {}, marker: () => ({ bindPopup() { return this; }, addTo() { return this; } }),
        divIcon: () => ({}), layerGroup: () => ({ addTo() {} }) };
    win.postMessage = message => messages.push(message);
    const owner = installMapLayers(win);
    const send = (detail, kind = '__bpbMapLayers') => win.dispatchEvent(new win.MessageEvent('message', {
        source: win, origin: win.location.origin, data: { [kind]: true, dir: 'toPage', ...detail } }));
    send({ type: 'preferences', snotel: true });
    if (terrain) { send({ type: 'loaded' }, '__bpbTerrain'); send({ type: 'layerView', bounds, zoom: 16 }, '__bpbTerrain'); }
    const toggle = () => win.document.querySelector('[data-layer="snotel"] input').click();
    const request = () => messages.filter(message => message.__bpbMapLayers && message.type === 'stations').at(-1);
    return { win, messages, moves, send, toggle, request, pan: () => { for (const handler of events.get('moveend') || []) handler({ target: map }); },
        close() { owner.dispose(); win.close(); } };
}

for (const terrain of [false, true]) test(`${terrain ? '3D' : 'native'} SNOTEL activation reveals once and ignores passive updates`, () => {
    const env = setup(terrain);
    try {
        env.toggle(); const request = env.request(); assert.equal(request.reveal, true);
        env.send({ type: 'stations', requestId: request.requestId, stations: [station], nearby: true });
        env.send({ type: 'preferences', snotel: true });
        if (terrain) assert.equal(env.messages.filter(message => message.type === 'snowStations' && message.reveal === true).length, 1);
        else assert.equal(env.moves.length, 1);
    } finally { env.close(); }
});

for (const terrain of [false, true]) test(`${terrain ? '3D' : 'native'} user movement cancels a pending station reveal`, () => {
    const env = setup(terrain);
    try {
        env.toggle(); const request = env.request();
        if (terrain) env.send({ type: 'layerView', bounds: [-121.78, 46.84, -121.76, 46.86], zoom: 16 }, '__bpbTerrain');
        else env.pan();
        env.send({ type: 'stations', requestId: request.requestId, stations: [station], nearby: true });
        assert.equal(env.moves.length, 0);
        assert.equal(env.messages.some(message => message.type === 'snowStations' && message.reveal === true), false);
        assert.equal(env.messages.at(-1).type, 'cancel');
    } finally { env.close(); }
});

test('turning SNOTEL off rejects late reveal data, while retry retains unfulfilled activation intent', () => {
    const env = setup();
    try {
        env.toggle(); let request = env.request(); env.toggle();
        env.send({ type: 'stations', requestId: request.requestId, stations: [station], nearby: true }); assert.equal(env.moves.length, 0);
        env.toggle(); request = env.request(); env.send({ type: 'stations', requestId: request.requestId, error: true });
        env.win.document.querySelector('.bpb-layers-trigger').click(); env.win.document.querySelector('[data-layer="snotel"] button').click();
        env.win.document.querySelector('[aria-label="SNOTEL stations settings"] .bpb-layers-retry').click();
        const retry = env.request(); assert.ok(retry.requestId > request.requestId); assert.equal(retry.reveal, true);
        env.send({ type: 'stations', requestId: retry.requestId, stations: [station], nearby: true }); assert.equal(env.moves.length, 1);
    } finally { env.close(); }
});
