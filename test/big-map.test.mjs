// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub, waitFor } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsSource = await readFile(path.join(root, 'src', 'settings.js'), 'utf8');
const bridgeSource = await readFile(path.join(root, 'src', 'big-map-bridge.js'), 'utf8');
const bigMapSource = await readFile(path.join(root, 'src', 'big-map.js'), 'utf8');

const makeLeaflet = window => {
    class Polyline {
        constructor(latLngs, options = {}) {
            this.latLngs = latLngs;
            this.options = { ...options };
            this._events = {};
            this._map = null;
            this.styleCalls = [];
        }
        getLatLngs() { return this.latLngs; }
        setStyle(style) {
            this.styleCalls.push({ ...style });
            Object.assign(this.options, style);
            return this;
        }
        on(type, handler) {
            (this._events[type] ||= []).push(handler);
            return this;
        }
        fire(type) {
            for (const handler of this._events[type] || []) handler({ type, target: this });
        }
    }
    class Polygon extends Polyline {}
    class MapStub {
        constructor(layers = []) {
            this.layers = [];
            this.events = {};
            layers.forEach(layer => this.addLayer(layer));
        }
        eachLayer(callback) { this.layers.slice().forEach(callback); }
        on(type, handler) { (this.events[type] ||= []).push(handler); return this; }
        addLayer(layer) {
            layer._map = this;
            this.layers.push(layer);
            for (const handler of this.events.layeradd || []) handler({ layer });
            return this;
        }
    }
    window.L = { Polyline, Polygon, Map: MapStub };
    return { Polyline, Polygon, MapStub };
};

const loadBigMap = async ({ type = 'G', width = 7, settings = {} } = {}) => {
    const dom = new JSDOM('<!doctype html><body><div id="map"></div></body>', {
        url: `https://www.peakbagger.com/Map/BigMap.aspx?t=${type}&d=2414&gt=rc`,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const messages = [];
    window.chrome = makeChromeStub({ bpbSettings: { mapRouteWidth: width, ...settings } });
    const nativePostMessage = message => window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: message
    })));
    window.postMessage = message => {
        messages.push(structuredClone(message));
        nativePostMessage(message);
    };
    const leaflet = makeLeaflet(window);
    return { dom, window, messages, leaflet, evaluate: () => {
        window.eval(settingsSource);
        window.eval(bridgeSource);
        window.eval(bigMapSource);
    } };
};

test('Full Screen recent-track maps preserve native colors, hover, and click behavior while applying width', async () => {
    const fixture = await loadBigMap({ type: 'G', width: 7 });
    const { dom, window, messages, leaflet } = fixture;
    const routeA = new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#e34a33', weight: 3 });
    const routeB = new leaflet.Polyline([{ lat: 44.14, lng: -121.77 }, { lat: 44.17, lng: -121.74 }], { color: '#3182bd', weight: 3 });
    const hoverEffect = new leaflet.Polyline(routeA.getLatLngs(), { color: '#ffff00', weight: 12 });
    const area = new leaflet.Polygon(routeA.getLatLngs(), { color: '#555555', weight: 2, fill: true });
    let clicks = 0;
    for (const route of [routeA, routeB]) {
        route.on('mouseover', () => route.setStyle({ weight: 11 }));
        route.on('mouseout', () => route.setStyle({ weight: 3 }));
        route.on('click', () => { clicks++; });
        route._popup = { content: 'Native Peakbagger trip report' };
    }
    window.mapsPlaceholder = new leaflet.MapStub([routeA, routeB, hoverEffect, area, { options: { attribution: 'tiles' } }]);
    fixture.evaluate();

    await waitFor(dom, () => routeA.options.weight === 7 && routeB.options.weight === 7);
    assert.equal(routeA.options.color, '#e34a33');
    assert.equal(routeB.options.color, '#3182bd');
    assert.ok(routeA.styleCalls.every(call => Object.keys(call).length === 1 && 'weight' in call));
    assert.ok(routeB.styleCalls.every(call => Object.keys(call).length === 1 && 'weight' in call));
    assert.deepEqual(routeA.styleCalls.at(-1), { weight: 7 });
    assert.deepEqual(routeB.styleCalls.at(-1), { weight: 7 });
    assert.equal(hoverEffect.options.weight, 12, 'transient hover polylines must not be flattened to the base width');
    assert.equal(area.options.weight, 2, 'polygons are not GPS tracks');

    // Each native track gains one white casing underlay; the hover effect and
    // the polygon do not.
    const casingsOf = () => window.mapsPlaceholder.layers.filter(layer =>
        layer instanceof leaflet.Polyline && layer.options.interactive === false);
    assert.equal(casingsOf().length, 2, 'each native track gains exactly one casing');
    assert.ok(casingsOf().every(casing => casing.options.color === '#ffffff' && casing.options.weight === 9),
        'casings use the configured casing color and width');

    routeA.fire('mouseover');
    assert.equal(routeA.options.weight, 11, 'native hover highlighting should remain visible');
    routeA.fire('click');
    assert.equal(clicks, 1, 'native click handlers should remain attached');
    routeA.fire('mouseout');
    await new Promise(resolve => window.queueMicrotask(resolve));
    assert.equal(routeA.options.weight, 7, 'the preferred base width should return after native mouseout');

    const lateRoute = new leaflet.Polyline(routeB.getLatLngs(), { color: '#31a354', weight: 3 });
    lateRoute.on('mouseover', () => lateRoute.setStyle({ weight: 10 }));
    lateRoute.on('click', () => {});
    window.mapsPlaceholder.addLayer(lateRoute);
    await waitFor(dom, () => lateRoute.options.weight === 7);
    assert.equal(lateRoute.options.color, '#31a354', 'group tracks keep their native color');
    assert.equal(casingsOf().length, 3, 'a track added later also gains a casing');

    await window.BPBSettings.set({ mapRouteWidth: 9 });
    await waitFor(dom, () => routeA.options.weight === 9 && routeB.options.weight === 9 && lateRoute.options.weight === 9);
    // mapRouteCasingWidth defaults to 9 but is clamped to width + 2 = 11.
    await waitFor(dom, () => casingsOf().every(casing => casing.options.weight === 11));
    assert.equal(casingsOf().length, 3, 're-applying the style must not duplicate casings');

    const bridgeReply = messages.find(message => message.__bpbBigMap === true && message.dir === 'toPage');
    assert.deepEqual(Object.keys(bridgeReply).sort(),
        ['__bpbBigMap', 'casingColor', 'casingWidth', 'dir', 'routeColor', 'routeWidth']);
    // The bridge forwards validated style values, never the raw settings keys.
    assert.equal(JSON.stringify(bridgeReply).includes('mapRoute'), false);
    dom.window.close();
});

test('Full Screen single-ascent maps recolor the native track and add a casing', async () => {
    const fixture = await loadBigMap({ type: 'A', width: 6, settings: {
        mapRouteColor: '#112233', mapRouteCasingColor: '#eeddcc', mapRouteCasingWidth: 10
    } });
    const { dom, window, leaflet } = fixture;
    const route = new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#d9483b', weight: 3 });
    window.map = new leaflet.MapStub([route]);
    fixture.evaluate();
    await waitFor(dom, () => route.options.weight === 6);
    assert.equal(route.options.color, '#112233', 'the single track is recolored to the route color');

    const casing = window.map.layers.find(layer =>
        layer instanceof leaflet.Polyline && layer.options.interactive === false);
    assert.ok(casing, 'a casing underlay is added behind the track');
    assert.equal(casing.options.color, '#eeddcc');
    assert.equal(casing.options.weight, 10, 'casing width honors the setting (>= route width + 2)');
    dom.window.close();
});

test('non-GPS BigMap modes are left entirely native', async () => {
    const fixture = await loadBigMap({ type: 'P', width: 10 });
    const { dom, window, leaflet } = fixture;
    const line = new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#555555', weight: 2 });
    window.mapsPlaceholder = new leaflet.MapStub([line]);
    fixture.evaluate();
    await new Promise(resolve => window.setTimeout(resolve, 20));
    assert.equal(line.options.weight, 2);
    assert.equal(line.styleCalls.length, 0);
    dom.window.close();
});
