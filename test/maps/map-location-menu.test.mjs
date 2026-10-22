// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMapLocationMenu, readMapPoint } from '../../src/maps/map-location-menu.js';
import { bindMapLocationMenu } from '../../src/maps/peak-weather-map.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
    const dom = new JSDOM('<!doctype html><html><head></head><body><iframe id="Gmap"></iframe><div id="map" tabindex="0"></div></body></html>', {
        url: 'https://www.peakbagger.com/Peak.aspx?pid=1', pretendToBeVisual: true,
    });
    const win = dom.window, calls = [], messages = [], target = win.document.getElementById('map');
    win.postMessage = data => messages.push(data);
    target.getBoundingClientRect = () => ({ left: 20, top: 20, right: 650, bottom: 450, width: 630, height: 430 });
    const menu = createMapLocationMenu({ window: win, client: {
        lookup(point, { signal }) { return new Promise((resolve, reject) => calls.push({ point, signal, resolve, reject })); }, clear() {},
    } });
    const node = win.document.getElementById('bpb-peak-weather-menu');
    const show = (extra = {}) => menu.show({ latitude: 46.8, longitude: -121.7, x: 50, y: 60, ...extra }, target);
    return { dom, win, target, menu, node, calls, messages, show, close() { menu.dispose(); win.close(); } };
}

test('read-only elevation and coordinates work without weather; stale results and dismissed lookups cannot repaint', async () => {
    const env = setup();
    try {
        env.show(); assert.equal(env.node.hidden, false);
        assert.equal(env.node.querySelector('button').hidden, true);
        assert.equal(env.node.querySelector('.bpb-weather-menu-coordinates').textContent, '46.8000, -121.7000');
        env.show({ latitude: 40 }); assert.equal(env.calls[0].signal.aborted, true);
        env.calls[0].resolve(999); await flush(); assert.equal(env.node.dataset.state, 'loading');
        env.calls[1].resolve(-430); await flush(); assert.equal(env.node.dataset.state, 'ready');
        assert.match(env.node.querySelector('.bpb-map-location-value').textContent, /−?1,411|-1,411/);
        env.menu.setUnits({ units: 'metric' }); assert.match(env.node.querySelector('.bpb-map-location-value').textContent, /-430 m/);
        env.show(); env.menu.close(); assert.equal(env.calls[2].signal.aborted, true);
        env.calls[2].resolve(0); await flush(); assert.equal(env.node.hidden, true);
    } finally { env.close(); }
});

test('no data, timeouts and rate limits stay explicit; sizing reservations are hidden and noninteractive', async () => {
    const env = setup();
    try {
        for (const result of [null, new Error('timeout'), Object.assign(new Error('limited'), { code: 'rate-limit' })]) {
            env.show(); const call = env.calls.at(-1);
            if (result instanceof Error) call.reject(result); else call.resolve(result);
            await flush(); assert.notEqual(env.node.dataset.state, 'ready');
            assert.match(env.node.querySelector('.bpb-map-location-value').textContent, /unavailable/i);
        }
        assert.ok(env.node.querySelectorAll('[data-sizing-text][aria-hidden="true"]').length >= 5);
        assert.equal(env.node.querySelectorAll('[data-sizing-text] :is(button,a,input)').length, 0);
        env.node.dispatchEvent(new env.win.Event('scroll')); assert.equal(env.node.hidden, false, 'a short viewport may scroll the menu');
        env.win.dispatchEvent(new env.win.Event('scroll')); assert.equal(env.node.hidden, true, 'page scrolling dismisses the menu');
        env.show(); env.calls.at(-1).resolve(0); await flush(); assert.match(env.node.querySelector('.bpb-map-location-value').textContent, /≈ 0 ft/);
    } finally { env.close(); }
});

test('the sole forecast action respects card availability, cooldown, pointer and keyboard dismissal', async () => {
    const env = setup();
    try {
        const card = env.win.document.createElement('section'); card.id = 'bpb-peak-weather'; card.dataset.bpbMapWeather = 'limited'; env.win.document.body.append(card);
        const action = env.node.querySelector('button');
        env.show(); assert.equal(action.hidden, false); assert.equal(action.disabled, true);
        action.click(); assert.equal(env.messages.length, 0);
        card.dataset.bpbMapWeather = 'ready'; env.win.document.dispatchEvent(new env.win.Event('bpb-map-weather-change'));
        assert.equal(action.disabled, false); assert.equal(env.win.document.activeElement, action);
        action.click(); assert.equal(env.node.hidden, true); assert.equal(env.messages[0].type, 'select');
        assert.equal(env.messages[0].latitude, 46.8);
        for (const key of ['Escape', 'Tab']) {
            env.show(); const event = new env.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            env.node.dispatchEvent(event); assert.equal(event.defaultPrevented, true); assert.equal(env.node.hidden, true);
            assert.equal(env.win.document.activeElement, env.target);
        }
        card.hidden = true; env.show(); assert.equal(action.hidden, true);
    } finally { env.close(); }
});

test('invalid and out-of-map points neither display nor fetch', () => {
    const env = setup();
    try {
        for (const extra of [{ latitude: 91 }, { longitude: NaN }, { x: 0 }, { y: Infinity }]) env.show(extra);
        assert.equal(env.node.hidden, true); assert.equal(env.calls.length, 0);
        assert.equal(readMapPoint({ latitude: '1', longitude: 1, x: 1, y: 1 }), null);
    } finally { env.close(); }
});

test('native map binding scopes trusted projection, normalizes longitude, preserves controls and detaches', () => {
    const env = setup(), doc = env.win.document, handlers = new Map(), original = doc.addEventListener.bind(doc);
    doc.addEventListener = (type, handler, options) => { handlers.set(type, handler); original(type, handler, options); };
    let projected = 0, shown;
    const unbind = bindMapLocationMenu({ ownerWindow: env.win, map: {
        getContainer: () => env.target, getCenter: () => ({ lat: 40, lng: 0 }),
        mouseEventToLatLng: () => { projected++; return { lat: 46.8, lng: 238.3 }; },
    }, menu: { close() {}, show: data => { shown = data; } } });
    try {
        const event = { target: env.target, isTrusted: true, button: 2, clientX: 30, clientY: 40, preventDefault() {}, stopPropagation() {} };
        handlers.get('contextmenu')({ ...event, isTrusted: false }); assert.equal(projected, 0);
        handlers.get('contextmenu')(event); assert.equal(projected, 1); assert.ok(Math.abs(shown.longitude + 121.7) < 1e-8);
        const button = doc.createElement('button'); env.target.append(button);
        handlers.get('contextmenu')({ ...event, target: button }); assert.equal(projected, 1);
        handlers.get('contextmenu')({ ...event, button: 0, clientX: 0, clientY: 0 }); assert.equal(shown.latitude, 40);
        handlers.get('keydown')({ ...event, key: 'F10', shiftKey: true });
        assert.equal(shown.keyboard, true); assert.equal(shown.latitude, 40);
    } finally { unbind(); env.close(); }
});
