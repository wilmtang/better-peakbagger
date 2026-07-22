// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub, waitFor } from '../helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The BigMap page loads the isolated settings-bridge bundle then the MAIN-world
// enhancer bundle (which carries metrics, basemap, and the peak-marker feed).
const bridgeBundle = await readFile(path.join(root, 'dist', 'content', 'big-map-bridge.js'), 'utf8');
const mainBundle = await readFile(path.join(root, 'dist', 'content', 'big-map.js'), 'utf8');

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
    class Marker {
        constructor(latLng, iconUrl) {
            this.latLng = latLng;
            this.options = { icon: { options: { iconUrl } } };
            this._map = null;
        }
        getLatLng() { return this.latLng; }
    }
    class MapStub {
        constructor(layers = []) {
            this.layers = [];
            this.events = {};
            this.center = { lat: 44.155, lng: -121.765 };
            this.zoom = 14;
            this.setViewCalls = [];
            layers.forEach(layer => this.addLayer(layer));
        }
        eachLayer(callback) { this.layers.slice().forEach(callback); }
        on(type, handler) { (this.events[type] ||= []).push(handler); return this; }
        getCenter() { return this.center; }
        getZoom() { return this.zoom; }
        setView(center, zoom, options) {
            this.center = { lat: center[0], lng: center[1] };
            this.zoom = zoom;
            this.setViewCalls.push({ center: [...center], zoom, options: { ...options } });
            return this;
        }
        addLayer(layer) {
            layer._map = this;
            this.layers.push(layer);
            for (const handler of this.events.layeradd || []) handler({ layer });
            return this;
        }
    }
    window.L = { Polyline, Polygon, Marker, Map: MapStub };
    return { Polyline, Polygon, Marker, MapStub };
};

const loadBigMap = async ({ type = 'G', width = 7, settings = {}, html, query } = {}) => {
    const dom = new JSDOM(html || '<!doctype html><body><div id="map"></div></body>', {
        url: `https://www.peakbagger.com/Map/BigMap.aspx?${query || `t=${type}&d=2414&gt=rc`}`,
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
        window.eval(bridgeBundle);
        window.eval(mainBundle);
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

    // Change the stored width; the bridge's storage.onChanged listener pushes it
    // to the MAIN-world enhancer (settings is no longer a page global).
    await window.chrome.storage.sync.set({ bpbSettings: { ...window.chrome._store.bpbSettings, mapRouteWidth: 9 } });
    await waitFor(dom, () => routeA.options.weight === 9 && routeB.options.weight === 9 && lateRoute.options.weight === 9);
    // mapRouteCasingWidth defaults to 9 but is clamped to width + 2 = 11.
    await waitFor(dom, () => casingsOf().every(casing => casing.options.weight === 11));
    assert.equal(casingsOf().length, 3, 're-applying the style must not duplicate casings');

    const bridgeReply = messages.find(message => message.__bpbBigMap === true && message.dir === 'toPage');
    assert.deepEqual(Object.keys(bridgeReply).sort(),
        ['__bpbBigMap', 'casingColor', 'casingWidth', 'dir', 'enable3dMap', 'routeColor', 'routeWidth', 'terrainCacheLimitMb', 'theme']);
    // The bridge forwards validated style values plus the 3D gate/theme/cache
    // budget, never the raw settings keys or a write path.
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

test('idle terrain updates check route presence without recollecting route geometry', async () => {
    const fixture = await loadBigMap({ type: 'A', width: 6 });
    const { dom, window, leaflet } = fixture;
    const route = new leaflet.Polyline([
        { lat: 44.15, lng: -121.78 },
        { lat: 44.16, lng: -121.76 },
        { lat: 44.17, lng: -121.75 }
    ], { color: '#d9483b', weight: 3 });
    let geometryReads = 0;
    const nativeGetLatLngs = route.getLatLngs.bind(route);
    route.getLatLngs = () => {
        geometryReads++;
        return nativeGetLatLngs();
    };
    window.map = new leaflet.MapStub([route]);
    fixture.evaluate();

    await waitFor(dom, () => window.document.getElementById('bpb-terrain-toggle')?.disabled === false);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    geometryReads = 0;

    window.map.addLayer({ options: { attribution: 'late tiles' } });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.ok(geometryReads <= 1,
        'an unrelated layer event should identify the route without collecting and copying its coordinates');

    dom.window.close();
});

test('Full Screen maps case native tracks that live in the MasterMap child iframe', async () => {
    // The real Full Screen page is a shell: its Leaflet map and GPS tracks live
    // in a same-origin MasterMap.aspx child iframe, not the top window. The
    // enhancer must reach into that frame — checking only the top window (the
    // previous behavior) never found the tracks, so no casing was applied.
    const dom = new JSDOM(
        '<!doctype html><body><iframe id="if" src="MasterMap.aspx?t=G&d=1&l=L_CT"></iframe></body>',
        { url: 'https://www.peakbagger.com/Map/BigMap.aspx?t=G&d=1&gt=rc', runScripts: 'outside-only' }
    );
    const { window } = dom;
    window.chrome = makeChromeStub({ bpbSettings: { mapRouteWidth: 8 } });
    window.postMessage = message => window.queueMicrotask(() => window.dispatchEvent(
        new window.MessageEvent('message', { source: window, origin: window.location.origin, data: message })));

    const iframe = window.document.getElementById('if');
    const mapWin = iframe.contentWindow;
    assert.ok(mapWin && mapWin !== window, 'the child iframe exposes its own contentWindow');
    const leaflet = makeLeaflet(mapWin);
    const track = new leaflet.Polyline(
        [{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#FF0000', weight: 2 });
    track.on('mouseover', () => track.setStyle({ weight: 11 }));
    track.on('click', () => {});
    track._popup = { content: 'Native Peakbagger trip report' };
    mapWin.mapsPlaceholder = new leaflet.MapStub([track]);

    window.eval(bridgeBundle);
    window.eval(mainBundle);

    await waitFor(dom, () => track.options.weight === 8);
    assert.equal(track.options.color, '#FF0000', 'group tracks keep their native color');
    const casingsOf = () => mapWin.mapsPlaceholder.layers.filter(
        layer => layer instanceof leaflet.Polyline && layer.options.interactive === false);
    assert.equal(casingsOf().length, 1, 'the child-iframe track gains exactly one white casing');
    assert.equal(casingsOf()[0].options.color, '#ffffff');

    // A track added to the child map after binding is also cased.
    const late = new leaflet.Polyline(
        [{ lat: 44.14, lng: -121.77 }, { lat: 44.17, lng: -121.74 }], { color: '#0000FF', weight: 2 });
    late.on('mouseover', () => {});
    late.on('click', () => {});
    late._popup = { content: 'report' };
    mapWin.mapsPlaceholder.addLayer(late);
    await waitFor(dom, () => late.options.weight === 8);
    assert.equal(casingsOf().length, 2, 'a track added to the child map later also gains a casing');
    dom.window.close();
});

test('Full Screen peak maps offer route-free 3D terrain without styling native lines', async () => {
    const fixture = await loadBigMap({
        type: 'P',
        width: 10,
        settings: { enable3dMap: true },
        html: '<!doctype html><body><a href="../peak.aspx?pid=2414">Mount Hood</a><div id="map"></div></body>',
        query: 't=P&d=2414&cy=45.373496&cx=-121.695937&z=14&c=900001&cyn=1'
    });
    const { dom, window, messages, leaflet } = fixture;
    const line = new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#555555', weight: 2 });
    const marker = new leaflet.Marker(
        { lat: 45.373496, lng: -121.695937 }, '../image/MainPeakGreenCircle.gif');
    window.mapsPlaceholder = new leaflet.MapStub([marker, line]);
    window.mapsPlaceholder.center = { lat: 45.373496, lng: -121.695937 };
    window.mapsPlaceholder.zoom = 14;
    fixture.evaluate();

    await waitFor(dom, () => window.document.getElementById('bpb-terrain-toggle')?.disabled === false);
    assert.equal(line.options.weight, 2);
    assert.equal(line.styleCalls.length, 0);
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    assert.equal(toggle.title, 'View this peak on 3D terrain');
    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    const init = messages.find(message => message.__bpbTerrain === true && message.type === 'init');
    assert.deepEqual(init.focus, [45.373496, -121.695937]);
    assert.equal(init.focusZoom, 13);
    assert.deepEqual(init.focusPeak, {
        id: 2414,
        name: 'Mount Hood',
        lat: 45.373496,
        lon: -121.695937,
        state: 'climbed'
    });
    assert.equal(Object.hasOwn(init, 'routeSegments'), false,
        'a summit-only map must not reinterpret unrelated native lines as a route');
    dom.window.close();
});

test('Full Screen peak maps fail closed when the heading and subject marker do not agree', async () => {
    const fixture = await loadBigMap({
        type: 'P',
        settings: { enable3dMap: true },
        html: '<!doctype html><body><a href="../peak.aspx?pid=999">Wrong peak</a><div id="map"></div></body>',
        query: 't=P&d=2414&cy=45.373496&cx=-121.695937&z=14'
    });
    const { dom, window, leaflet } = fixture;
    window.mapsPlaceholder = new leaflet.MapStub([
        new leaflet.Marker({ lat: 45.373496, lng: -121.695937 }, '../image/MainPeakGreenCircle.gif')
    ]);
    fixture.evaluate();
    await new Promise(resolve => window.setTimeout(resolve, 20));
    assert.equal(window.document.getElementById('bpb-terrain-toggle'), null);
    dom.window.close();
});

test('Full Screen maps offer a 3D toggle that carries the native tracks into the shared terrain view', async () => {
    const fixture = await loadBigMap({ type: 'A', width: 6, settings: { enable3dMap: true } });
    const { dom, window, messages, leaflet } = fixture;
    const points = [{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }, { lat: 44.17, lng: -121.75 }];
    const route = new leaflet.Polyline(points, { color: '#d9483b', weight: 3 });
    window.map = new leaflet.MapStub([route]);
    fixture.evaluate();

    await waitFor(dom, () => route.options.weight === 6);
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    assert.ok(toggle, 'a floating 3D toggle appears once the feature is enabled');
    assert.equal(toggle.parentElement.id, 'bpb-map-viewport');
    assert.ok(toggle.parentElement.classList.contains('bpb-terrain-mount-fullscreen'));
    await waitFor(dom, () => toggle.disabled === false);
    assert.equal(toggle.textContent, '3D');

    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    const init = messages.find(message => message.__bpbTerrain === true && message.type === 'init');
    assert.equal(init.dir, 'toCS');
    // The native Leaflet track becomes the 3D route, lat/lon order preserved.
    assert.deepEqual(init.routeSegments, [[[44.15, -121.78], [44.16, -121.76], [44.17, -121.75]]]);
    assert.deepEqual(init.camera, { center: [44.155, -121.765], zoom: 13 },
        'the current 2D center and equivalent zoom seed the terrain camera');
    assert.equal(toggle.textContent, '3D');
    assert.equal(toggle.getAttribute('aria-busy'), 'true', 'the toggle shows a loading state while the frame loads');

    // Simulate the extension frame reporting it is ready.
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'loaded' }
    }));
    assert.equal(toggle.textContent, '2D');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(window.document.getElementById('map').style.visibility, 'hidden');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toPage',
            type: 'camera',
            camera: { center: [44.22, -121.69], zoom: 14.5 }
        }
    }));

    // Toggling back applies the settled terrain camera before revealing 2D.
    toggle.click();
    assert.equal(messages.at(-1).type, 'cameraRequest');
    const cameraRequestId = messages.at(-1).requestId;
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toPage',
            type: 'camera',
            requestId: cameraRequestId,
            camera: { center: [44.22, -121.69], zoom: 14.5 }
        }
    }));
    assert.equal(messages.at(-1).type, 'destroy');
    assert.deepEqual(window.map.setViewCalls, [{
        center: [44.22, -121.69],
        zoom: 15.5,
        options: { animate: false }
    }]);
    assert.equal(window.document.getElementById('map').style.visibility, 'visible');
    assert.equal(toggle.textContent, '3D');
    // Let the queued postMessage dispatches drain before closing the window.
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Full Screen 3D loading can be canceled and renderer failures are announced', async () => {
    const fixture = await loadBigMap({ type: 'A', settings: { enable3dMap: true } });
    const { dom, window, messages, leaflet } = fixture;
    window.map = new leaflet.MapStub([
        new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#d9483b', weight: 3 })
    ]);
    fixture.evaluate();

    const toggle = window.document.getElementById('bpb-terrain-toggle');
    await waitFor(dom, () => toggle.disabled === false);
    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute('aria-label'), 'Cancel loading 3D terrain');
    toggle.click();
    assert.equal(messages.at(-1).type, 'destroy');
    assert.equal(toggle.textContent, '3D');

    toggle.click();
    await waitFor(dom, () => messages.filter(message => message.__bpbTerrain === true && message.type === 'init').length === 2);
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'loaded' }
    }));
    assert.equal(window.document.getElementById('map').style.visibility, 'hidden');
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'error', reason: 'maplibre' }
    }));
    const failure = window.document.getElementById('bpb-terrain-failure');
    assert.equal(failure.getAttribute('role'), 'status');
    assert.equal(failure.hidden, false);
    assert.match(failure.textContent, /could not render 3D terrain/);
    assert.equal(toggle.textContent, '3D');
    assert.equal(window.document.getElementById('map').style.visibility, 'visible',
        'an active renderer failure restores the native map');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Full Screen 3D group routes carry only validated native ascent-link metadata', async () => {
    const fixture = await loadBigMap({ type: 'G', settings: { enable3dMap: true } });
    const { dom, window, messages, leaflet } = fixture;
    const routeA = new leaflet.Polyline(
        [{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }],
        { color: '#e34a33', weight: 3 });
    const routeB = new leaflet.Polyline(
        [{ lat: 44.14, lng: -121.77 }, { lat: 44.17, lng: -121.74 }],
        { color: '#3182bd', weight: 3 });
    for (const route of [routeA, routeB]) {
        route.on('mouseover', () => {});
        route.on('click', () => {});
    }
    routeA._popup = {
        getContent: () => "<a href='../climber/ascent.aspx?aid=3230293' target='_blank'> 2026-06-12 - Fei   (Kautz Glacier) TR-98 </a>"
    };
    routeB._popup = {
        getContent: () => "<a href='https://example.com/climber/ascent.aspx?aid=7'>Untrusted destination</a>"
    };
    window.map = new leaflet.MapStub([routeA, routeB]);
    fixture.evaluate();

    await waitFor(dom, () => window.document.getElementById('bpb-terrain-toggle')?.disabled === false);
    window.document.getElementById('bpb-terrain-toggle').click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    const init = messages.find(message => message.__bpbTerrain === true && message.type === 'init');
    assert.deepEqual(init.routeColors, ['#e34a33', '#3182bd']);
    assert.deepEqual(init.routeLinks, [
        { id: 3230293, label: '2026-06-12 - Fei (Kautz Glacier) TR-98' },
        null
    ], 'page-owned markup is reduced to a same-origin ascent id and plain-text label');

    dom.window.close();
});

test('Full Screen 3D shows a compass that tracks the view and resets north', async () => {
    const fixture = await loadBigMap({ type: 'A', width: 6, settings: { enable3dMap: true } });
    const { dom, window, messages, leaflet } = fixture;
    const route = new leaflet.Polyline(
        [{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }, { lat: 44.17, lng: -121.75 }],
        { color: '#d9483b', weight: 3 });
    window.map = new leaflet.MapStub([route]);
    fixture.evaluate();

    const toggle = window.document.getElementById('bpb-terrain-toggle');
    const compass = window.document.getElementById('bpb-terrain-compass');
    const disc = compass.querySelector('.bpb-map-compass-disc');
    assert.ok(compass, 'the compass lives next to the toggle in the fullscreen mount');
    assert.equal(compass.parentElement.id, 'bpb-map-viewport');
    assert.equal(compass.getAttribute('type'), 'button');
    assert.equal(compass.getAttribute('aria-label'), 'Reset the view to north, looking straight down');
    assert.equal(compass.hidden, true, 'hidden until 3D is active');

    await waitFor(dom, () => toggle.disabled === false);
    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    assert.equal(compass.hidden, true, 'still hidden while the frame loads');

    const dispatchPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', ...data }
    }));
    dispatchPage({ type: 'loaded' });
    assert.equal(compass.hidden, false, 'the compass appears with the terrain view');
    assert.equal(compass.dataset.theme, 'light');

    // A streamed view rotates the disc; bearing normalizes to [0,360), pitch clamps to [0,85].
    dispatchPage({ type: 'view', bearing: 450, pitch: 60 });
    assert.equal(disc.style.transform, 'rotateX(60deg) rotateZ(-90deg)');
    dispatchPage({ type: 'view', bearing: -30, pitch: 120 });
    assert.equal(disc.style.transform, 'rotateX(85deg) rotateZ(30deg)');

    dispatchPage({ type: 'view', bearing: 350, pitch: 60 });
    const beforeNorth = Number(/rotateZ\((-?[\d.]+)deg\)/.exec(disc.style.transform)[1]);
    dispatchPage({ type: 'view', bearing: 10, pitch: 60 });
    const afterNorth = Number(/rotateZ\((-?[\d.]+)deg\)/.exec(disc.style.transform)[1]);
    assert.ok(Math.abs(afterNorth - beforeNorth) < 180,
        'crossing north advances the transformed needle along the short arc');

    // Clicking the compass posts a resetNorth command toward the frame.
    compass.click();
    assert.equal(messages.at(-1).type, 'resetNorth');
    assert.equal(messages.at(-1).dir, 'toCS');

    // Returning to 2D hides the compass — the moment a stop is pending, and after.
    toggle.click();
    assert.equal(compass.hidden, true, 'hidden the moment a stop is pending');
    const cameraRequestId = messages.at(-1).requestId;
    dispatchPage({ type: 'camera', requestId: cameraRequestId, camera: { center: [44.22, -121.69], zoom: 14.5 } });
    assert.equal(compass.hidden, true, 'stays hidden after returning to 2D');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('hovering the idle 3D toggle prefetches the route DEM tiles once per window', async () => {
    const fixture = await loadBigMap({ type: 'A', width: 6, settings: { enable3dMap: true } });
    const { dom, window, messages, leaflet } = fixture;
    const route = new leaflet.Polyline([
        { lat: 44.15, lng: -121.78 },
        { lat: 44.16, lng: -121.76 },
        { lat: 44.17, lng: -121.75 }
    ], { color: '#d9483b', weight: 3 });
    window.map = new leaflet.MapStub([route]);
    fixture.evaluate();

    // Wait for the configured width to land, which proves the settings message
    // (and thus terrainEnabled) has been applied — not just the route bound.
    await waitFor(dom, () => route.options.weight === 6);
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    assert.equal(toggle.disabled, false);

    const prefetches = () => messages.filter(message => message.__bpbTerrain === true && message.type === 'prefetch');
    assert.equal(prefetches().length, 0, 'no prefetch merely because the page loaded');

    toggle.dispatchEvent(new window.Event('pointerenter'));
    assert.equal(prefetches().length, 1, 'hover warms the cache exactly once');
    const prefetch = prefetches()[0];
    assert.equal(prefetch.dir, 'toCS');
    assert.deepEqual(prefetch.bounds, { minLat: 44.15, minLon: -121.78, maxLat: 44.17, maxLon: -121.75 },
        'the route bounds seed the prefetch');
    assert.equal(Number.isFinite(prefetch.viewport.width) && prefetch.viewport.width > 0, true);
    assert.equal(Number.isFinite(prefetch.viewport.height) && prefetch.viewport.height > 0, true);

    // A second hover inside the throttle window posts nothing more.
    toggle.dispatchEvent(new window.Event('focus'));
    toggle.dispatchEvent(new window.Event('pointerenter'));
    assert.equal(prefetches().length, 1, 'the 15 s throttle suppresses a second hover');
    // Let the queued postMessage dispatches drain before closing the window.
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Full Screen 3D maps serve peak-dot requests from the native PLLBB feed', async () => {
    const fixture = await loadBigMap({ type: 'A', width: 6, settings: { enable3dMap: true } });
    const { dom, window, messages, leaflet } = fixture;
    window.document.body.insertAdjacentHTML('beforeend',
        '<iframe id="if" src="https://www.peakbagger.com/map/MasterMap.aspx?cy=44.16&cx=-121.76&z=14&t=A&d=2414&c=900001&hj=0"></iframe>');
    const route = new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#d9483b', weight: 3 });
    window.map = new leaflet.MapStub([route]);
    const feedRequests = [];
    window.fetch = async url => {
        feedRequests.push(String(url));
        return {
            ok: true,
            text: async () => `<ts><t i="58603" n="Iron Mountain" a="44.155" o="-121.77" c="1" r="246"/></ts>`
        };
    };
    fixture.evaluate();

    await waitFor(dom, () => route.options.weight === 6);
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    await waitFor(dom, () => toggle.disabled === false);
    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));

    const dispatchToPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', ...data }
    }));
    dispatchToPage({ type: 'loaded' });
    dispatchToPage({
        type: 'peaksRequest',
        requestId: 7,
        bounds: { miny: 44.1, maxy: 44.2, minx: -121.85, maxx: -121.7 }
    });
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'peaks'));

    assert.deepEqual(feedRequests, [
        'https://www.peakbagger.com/Async/PLLBB.aspx?miny=44.1&maxy=44.2&minx=-121.85&maxx=-121.7&t=A&cid=900001'
    ], 'the feed request mirrors the native query built from the MasterMap iframe URL');
    const reply = messages.find(message => message.__bpbTerrain === true && message.type === 'peaks');
    assert.equal(reply.requestId, 7);
    assert.notEqual(reply.unavailable, true);
    assert.deepEqual(reply.peaks, [{ id: 58603, name: 'Iron Mountain', lat: 44.155, lon: -121.77, state: 'climbed' }]);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Full Screen 3D group maps answer peak-dot requests as unavailable, like the native map', async () => {
    const fixture = await loadBigMap({ type: 'G', width: 6, settings: { enable3dMap: true } });
    const { dom, window, messages, leaflet } = fixture;
    window.document.body.insertAdjacentHTML('beforeend',
        '<iframe id="if" src="https://www.peakbagger.com/map/MasterMap.aspx?cy=44.16&cx=-121.76&z=14&t=G&d=2414&c=900001"></iframe>');
    const route = new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], {
        color: '#3388ff', weight: 3,
        // Group-map tracks need native hover/click handlers to be recognized.
    });
    route.on('mouseover', () => {});
    route.on('click', () => {});
    window.map = new leaflet.MapStub([route]);
    window.fetch = async () => { throw new Error('a group map must never hit the peak feed'); };
    fixture.evaluate();

    await waitFor(dom, () => route.options.weight === 6);
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    await waitFor(dom, () => toggle.disabled === false);
    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true, dir: 'toPage', type: 'peaksRequest',
            requestId: 1, bounds: { miny: 44.1, maxy: 44.2, minx: -121.85, maxx: -121.7 }
        }
    }));
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'peaks'));
    const reply = messages.find(message => message.__bpbTerrain === true && message.type === 'peaks');
    assert.equal(reply.unavailable, true);
    assert.deepEqual(reply.peaks, []);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Full Screen maps keep the 3D toggle visible and request consent when the feature is disabled', async () => {
    const fixture = await loadBigMap({ type: 'A', width: 6 });
    const { dom, window, messages, leaflet } = fixture;
    const route = new leaflet.Polyline([{ lat: 44.15, lng: -121.78 }, { lat: 44.16, lng: -121.76 }], { color: '#d9483b', weight: 3 });
    window.map = new leaflet.MapStub([route]);
    fixture.evaluate();

    await waitFor(dom, () => route.options.weight === 6);
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    assert.ok(toggle);
    assert.equal(toggle.disabled, false);
    assert.ok(window.document.getElementById('bpb-map-viewport'));
    toggle.click();
    assert.equal(messages.at(-1).type, 'requestConsent');
    assert.equal(messages.some(message => message.__bpbTerrain === true && message.type === 'init'), false,
        'the page must not start terrain before the isolated-world confirmation succeeds');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'consentResult', enabled: true }
    }));
    assert.ok(messages.some(message => message.__bpbTerrain === true && message.type === 'init'),
        'the confirmed action should continue directly into the requested 3D view');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});
