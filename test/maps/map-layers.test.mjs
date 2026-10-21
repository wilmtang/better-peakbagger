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
    const win = dom.window, messages = [], moves = [], removed = [], popups = [], rasterPaints = [], events = new Map(); let currentBounds = bounds;
    const container = win.document.getElementById('map');
    container.getBoundingClientRect = () => ({ left: 20, top: 40, bottom: 440, width: 800, height: 400 });
    const map = { getBounds: () => ({ getWest: () => currentBounds[0], getSouth: () => currentBounds[1], getEast: () => currentBounds[2], getNorth: () => currentBounds[3] }),
        getCenter: () => ({ lat: 46.85, lng: -121.76 }), getZoom: () => 17, getSize: () => ({ x: 800, y: 400 }),
        getContainer: () => container, eachLayer() {}, removeLayer: layer => removed.push(layer), getPane: () => ({}),
        latLngToContainerPoint: ([lat, lon]) => ({ x: lon >= currentBounds[0] && lon <= currentBounds[2] && lat >= currentBounds[1] && lat <= currentBounds[3] ? 400 : -1000, y: 200 }),
        on(name, handler) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(handler); },
        off(name, handler) { events.get(name)?.delete(handler); }, flyToBounds: (...args) => moves.push(args), stop() {} };
    win.mapsPlaceholder = map; win.fetch = async () => { throw new Error('Unexpected provider request'); };
    win.L = { GridLayer: { extend: () => class {
        constructor(options) { this.id = options.pane.replace('bpb-overlay-', ''); }
        on() { return this; } addTo() { return this; }
        setOpacity(opacity) { rasterPaints.push([this.id, opacity]); return this; }
    } }, marker: () => ({ bindPopup(content) { popups.push(content); return this; }, addTo() { return this; } }),
    divIcon: () => ({}), layerGroup: () => ({ addTo() {} }) };
    win.postMessage = message => messages.push(message);
    const owner = installMapLayers(win);
    const send = (detail, kind = '__bpbMapLayers') => win.dispatchEvent(new win.MessageEvent('message', {
        source: win, origin: win.location.origin, data: { [kind]: true, dir: 'toPage', ...detail } }));
    send({ type: 'preferences', snotel: true });
    if (terrain) { send({ type: 'loaded' }, '__bpbTerrain'); send({ type: 'layerView', bounds, zoom: 16 }, '__bpbTerrain'); }
    const toggle = () => win.document.querySelector('[data-layer="snotel"] input').click();
    const request = () => messages.filter(message => message.__bpbMapLayers && message.type === 'stations').at(-1);
    const pan = () => { for (const handler of events.get('moveend') || []) handler({ target: map }); };
    return { win, messages, moves, removed, popups, rasterPaints, send, toggle, request, pan,
        view(value) { currentBounds = value; if (terrain) send({ type: 'layerView', bounds: value, zoom: 16 }, '__bpbTerrain'); else pan(); },
        close() { owner.dispose(); win.close(); } };
}

for (const terrain of [false, true]) test(`${terrain ? '3D' : 'native'} opacity dragging updates only the edited overlay`, () => {
    const env = setup(terrain), doc = env.win.document;
    try {
        for (const id of ['slope', 'land']) doc.querySelector(`[data-layer="${id}"] input`).click();
        env.toggle(); env.send({ type: 'stations', requestId: env.request().requestId, stations: [station] });
        doc.querySelector('.bpb-layers-trigger').click(); doc.querySelector('[data-layer="slope"] button').click();
        env.rasterPaints.length = 0; env.messages.length = 0;
        const slider = doc.querySelector('[aria-label="Slope angle opacity"]'); slider.focus();
        for (const opacity of [30, 40, 50]) { slider.value = String(opacity); slider.dispatchEvent(new env.win.Event('input')); }
        assert.equal(doc.activeElement, slider);
        assert.equal(doc.querySelector('[data-layer="slope"] .bpb-layers-value-number').textContent, '50%', 'feedback updates in the input event');
        if (terrain) assert.equal(env.messages.filter(message => message.type === 'snowStations').length, 0, 'opacity does not resend station markers');
        else assert.deepEqual(env.rasterPaints, [['slope', .3], ['slope', .4], ['slope', .5]], 'opacity does not repaint unrelated raster layers');
        assert.equal(env.messages.filter(message => message.type === 'stations').length, 0);
        const state = env.messages.filter(message => message.type === 'handoffState').at(-1).snapshot.state;
        assert.equal(state.land.enabled, true); assert.equal(state.snotel.enabled, true); assert.equal(state.slope.opacity, 50);
    } finally { env.close(); }
});

for (const terrain of [false, true]) test(`${terrain ? '3D' : 'native'} delayed snow-card availability updates existing station actions without a pan`, () => {
    const env = setup(terrain);
    const card = detail => env.send(detail, '__bpbPeakSnow');
    const gets = () => env.messages.filter(message => message.__bpbPeakSnow && message.type === 'get');
    const hasConditions = () => terrain
        ? env.messages.filter(message => message.type === 'snowStations').at(-1)?.conditions.includes(station.id)
        : Boolean(env.popups.at(-1)?.querySelector('.bpb-snotel-show-conditions'));
    try {
        env.toggle(); env.send({ type: 'stations', requestId: env.request().requestId, stations: [station], nearby: true });
        assert.equal(hasConditions(), false);
        card({ type: 'availability', enabled: true });
        assert.equal(gets().length, 1, 'card readiness loads authorized membership immediately');
        card({ type: 'availability', enabled: true }); assert.equal(gets().length, 1, 'pending membership is not duplicated');
        const requestId = gets()[0].requestId;
        card({ type: 'stations', requestId, stations: [station] });
        assert.equal(hasConditions(), true, 'already rendered popups gain Show conditions');
        card({ type: 'availability', enabled: false });
        assert.equal(hasConditions(), false, 'card unavailability removes stale popup actions immediately');
        card({ type: 'stations', requestId, stations: [station] }); assert.equal(hasConditions(), false, 'late membership cannot restore an unavailable action');
        card({ type: 'availability', enabled: true }); assert.equal(gets().length, 2);
    } finally { env.close(); }
});

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

for (const terrain of [false, true]) test(`${terrain ? '3D' : 'native'} leaving SNOTEL coverage turns it off, rejects late stations and requires explicit re-enablement`, () => {
    const env = setup(terrain);
    try {
        env.toggle(); const request = env.request();
        const cancellations = env.messages.filter(message => message.type === 'cancel').length;
        env.view([7.6, 45.9, 7.7, 46]);
        const checkbox = env.win.document.querySelector('[data-layer="snotel"] input');
        assert.equal(checkbox.disabled, true); assert.equal(checkbox.checked, false);
        for (const id of ['slope', 'land']) assert.equal(env.win.document.querySelector(`[data-layer="${id}"] input`).disabled, true);
        assert.ok(env.messages.filter(message => message.type === 'cancel').length > cancellations);
        env.send({ type: 'stations', requestId: request.requestId, stations: [station], nearby: true });
        assert.equal(env.moves.length, 0);
        assert.equal(env.messages.filter(message => message.type === 'handoffState').at(-1).snapshot.state.snotel.enabled, false,
            'the parked renderer and Full Screen receive the disabled state');
        env.view(bounds); assert.equal(checkbox.disabled, false); assert.equal(checkbox.checked, false);
        env.toggle(); assert.ok(env.request().requestId > request.requestId);
    } finally { env.close(); }
});

for (const terrain of [false, true]) test(`${terrain ? '3D' : 'native'} SNOTEL refresh failures keep loaded markers without claiming an empty view or repeating auto-zoom`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const env = setup(terrain), visibleStation = { ...station, latitude: 46.85, longitude: -121.76 };
    try {
        env.toggle(); env.send({ type: 'stations', requestId: env.request().requestId, stations: [visibleStation] });
        env.win.document.querySelector('.bpb-layers-trigger').click();
        env.view(bounds); t.mock.timers.tick(300);
        env.send({ type: 'stations', requestId: env.request().requestId, error: true });
        assert.equal(env.win.document.querySelector('[data-layer="snotel"] .bpb-layers-row-status').textContent, 'Refresh failed');
        assert.match(env.win.document.querySelector('.bpb-layers-detail:not([hidden])').textContent, /Showing loaded locations/);
        assert.equal(env.removed.length, 0, 'the existing marker group remains intact');
        env.win.document.querySelector('[aria-label="SNOTEL stations settings"] .bpb-layers-retry').click();
        assert.equal(env.request().reveal, false, 'retry cannot repeat the activation auto-zoom');
        env.send({ type: 'stations', requestId: env.request().requestId, stations: [visibleStation] });
        assert.equal(env.moves.length, 0);
        env.view([-122,45,-121,46]); t.mock.timers.tick(300);
        env.send({ type: 'stations', requestId: env.request().requestId, error: true });
        assert.equal(env.win.document.querySelector('[data-layer="snotel"] .bpb-layers-row-status').textContent, 'Couldn’t load');
        assert.doesNotMatch(env.win.document.querySelector('.bpb-layers-detail:not([hidden])').textContent, /No SNOTEL stations/);
    } finally { env.close(); }
});

test('SNOTEL overflow asks for a closer view instead of claiming zero stations', () => {
    const env = setup();
    try {
        env.toggle(); env.send({ type: 'stations', requestId: env.request().requestId, stations: [], overflow: true });
        env.win.document.querySelector('.bpb-layers-trigger').click();
        assert.equal(env.win.document.querySelector('[data-layer="snotel"] .bpb-layers-row-status').textContent, 'Zoom in');
        assert.match(env.win.document.querySelector('.bpb-layers-detail:not([hidden])').textContent, /More than 50 stations/);
        assert.equal(env.moves.length, 0);
    } finally { env.close(); }
});

test('turning SNOTEL off clears loaded-location feedback even during a provider cooldown', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const env = setup(), visibleStation = { ...station, latitude: 46.85, longitude: -121.76 };
    try {
        env.toggle(); env.send({ type: 'stations', requestId: env.request().requestId, stations: [visibleStation] });
        env.win.document.querySelector('.bpb-layers-trigger').click();
        env.pan(); t.mock.timers.tick(300);
        env.send({ type: 'stations', requestId: env.request().requestId, error: true, retryAt: Date.now() + 120000 });
        assert.equal(env.win.document.querySelector('[data-layer="snotel"] .bpb-layers-row-status').textContent, 'Refresh failed');
        env.toggle(); env.toggle();
        assert.equal(env.win.document.querySelector('[data-layer="snotel"] .bpb-layers-row-status').textContent, 'Service busy');
        assert.doesNotMatch(env.win.document.querySelector('.bpb-layers-detail:not([hidden])').textContent, /Showing loaded locations/);
    } finally { env.close(); }
});

for (const terrain of [false, true]) test(`${terrain ? '3D' : 'native'} user movement cancels a pending station reveal`, () => {
    const env = setup(terrain);
    try {
        env.toggle(); const request = env.request();
        const cancellations = env.messages.filter(message => message.type === 'cancel').length;
        if (terrain) env.send({ type: 'layerView', bounds: [-121.78, 46.84, -121.76, 46.86], zoom: 16 }, '__bpbTerrain');
        else env.pan();
        env.send({ type: 'stations', requestId: request.requestId, stations: [station], nearby: true });
        assert.equal(env.moves.length, 0);
        assert.equal(env.messages.some(message => message.type === 'snowStations' && message.reveal === true), false);
        assert.ok(env.messages.filter(message => message.type === 'cancel').length > cancellations, 'the pan cancels the pending reveal request');
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
