// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { waitFor } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analyzerSource = await readFile(path.join(root, 'src', 'gpx-analyzer.js'), 'utf8');

const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="48.7000" lon="-121.8000"><ele>1000</ele><time>2026-07-10T12:00:00Z</time></trkpt>
      <trkpt lat="48.7100" lon="-121.8100"><ele>1200</ele><time>2026-07-10T12:30:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="48.7500" lon="-121.8200"><ele>1800</ele><time>2026-07-10T13:00:00Z</time></trkpt>
      <trkpt lat="48.7600" lon="-121.8150"><ele>2000</ele><time>2026-07-10T13:30:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

test('GPX analyzer adds a thick, segment-preserving route casing behind native Leaflet layers', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <p>
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe><br>
        GPS Waypoints - Hover or click to see name and lat/long<br>
        <a href="https://www.peakbagger.com/map/BigMap.aspx">Click Here for a Full Screen Map</a><br>
        <span>Note: GPS Tracks may not be accurate.</span>
      </p>
      <p><a href="https://www.peakbagger.com/demo.gpx">Download this GPS track</a></p>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const polylineCalls = [];
    const sentPatches = [];
    const terrainMessages = [];
    const makeMap = () => ({
        layers: [],
        invalidateCalls: 0,
        invalidateSize() { this.invalidateCalls++; },
        removeLayer(layer) {
            this.layers = this.layers.filter(candidate => candidate !== layer);
            layer._map = null;
        }
    });
    const map = makeMap();
    const L = {
        polyline(latLngs, options) {
            const layer = {
                _map: null,
                broughtToBack: false,
                addTo(targetMap) {
                    this._map = targetMap;
                    targetMap.layers.push(this);
                    return this;
                },
                bringToBack() {
                    this.broughtToBack = true;
                    return this;
                }
            };
            polylineCalls.push({ latLngs, options, layer });
            return layer;
        },
        circleMarker() {
            throw new Error('hover marker should not be needed to install the route overlay');
        }
    };

    const iframe = window.document.querySelector('iframe');
    const layerSelect = window.document.createElement('select');
    layerSelect.id = 'selmap';
    layerSelect.innerHTML = '<option value="L_CT">CalTopo</option><option value="L_MT">MyTopo USA/Canada</option><option value="L_OT">Open Topo Map</option><option value="L_OS">Open Street Map</option>';
    let nativeLayerChanges = 0;
    layerSelect.addEventListener('change', () => { nativeLayerChanges++; });
    const iframeDocument = { getElementById: id => id === 'selmap' ? layerSelect : null };
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: { mapsPlaceholder: map, L, document: iframeDocument }
    });

    window.matchMedia = () => ({ matches: false });
    window.HTMLCanvasElement.prototype.getContext = () => ({});
    window.fetch = async () => ({ text: async () => gpx });
    window.Chart = class ChartStub {
        constructor(context, config) {
            this.data = config.data;
            this.options = config.options;
        }
        destroy() {}
        update() {}
        setDatasetVisibility() {}
        isDatasetVisible() { return true; }
    };

    const sendSettings = settings => window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpb: true, dir: 'toPage', settings }
    })));
    window.postMessage = message => {
        if (message && message.__bpbTerrain === true) {
            terrainMessages.push(message);
            return;
        }
        if (!message || message.dir !== 'toCS') return;
        if (message.kind === 'set') {
            sentPatches.push(message.patch);
            return;
        }
        if (message.kind !== 'get') return;
        sendSettings({ units: 'imperial', theme: 'light', chartDefaultSeries: 'both' });
    };

    Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
    window.eval(analyzerSource);
    await waitFor(dom, () => polylineCalls.length === 2);

    const analysis = window.document.getElementById('bpb-gpx-analysis');
    const fullScreenMapLink = window.document.querySelector('a[href*="BigMap.aspx"]');
    assert.ok(analysis, 'the analysis panel should be added');
    assert.ok(iframe.compareDocumentPosition(analysis) & window.Node.DOCUMENT_POSITION_FOLLOWING,
        'the analysis should render below the map');
    assert.ok(analysis.compareDocumentPosition(fullScreenMapLink) & window.Node.DOCUMENT_POSITION_FOLLOWING,
        'the analysis should render above the Full Screen Map section');

    const mapViewport = window.document.getElementById('bpb-map-viewport');
    const mapResizeHandle = window.document.getElementById('bpb-map-resize-handle');
    assert.equal(mapViewport.style.width, '450px');
    assert.equal(mapViewport.style.maxWidth, '100%');
    assert.equal(mapViewport.style.height, '468px');
    assert.equal(iframe.style.width, '100%');
    assert.equal(iframe.style.maxWidth, '100%');
    await waitFor(dom, () => map.invalidateCalls > 0);

    layerSelect.value = 'L_MT';
    layerSelect.dispatchEvent(new window.Event('change'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(sentPatches.some(patch => patch.mapLastLayer), false,
        'the native layer control should remain unpersisted while the setting is off');

    const calls = polylineCalls.map(call => ({
        latLngs: JSON.parse(JSON.stringify(call.latLngs)),
        options: call.options,
        broughtToBack: call.layer.broughtToBack
    }));

    const expectedSegments = [
        [[48.7, -121.8], [48.71, -121.81]],
        [[48.75, -121.82], [48.76, -121.815]]
    ];
    assert.deepEqual(calls.map(call => call.latLngs), [expectedSegments, expectedSegments],
        'the outline and route should receive the original segments without bridging the gap');
    assert.deepEqual(calls.map(call => [call.options.color, call.options.weight]), [
        ['#ffffff', 9],
        ['#d9483b', 5]
    ]);
    assert.ok(calls.every(call => call.options.interactive === false));
    assert.ok(calls.every(call => call.broughtToBack));

    const terrainToggle = window.document.getElementById('bpb-terrain-toggle');
    const terrainDisclosure = window.document.getElementById('bpb-terrain-disclosure');
    assert.equal(terrainToggle.disabled, false);
    terrainToggle.click();
    assert.equal(terrainDisclosure.style.display, 'block');
    assert.match(terrainDisclosure.textContent, /service receives the viewed map area and request metadata/i);
    assert.equal(terrainMessages.some(message => message.type === 'init'), false,
        'opening the privacy notice must not initialize terrain or request tiles');

    window.document.querySelector('#bpb-terrain-disclosure button').click();
    await waitFor(dom, () => terrainMessages.some(message => message.type === 'init'));
    const terrainInit = terrainMessages.find(message => message.type === 'init');
    assert.deepEqual(JSON.parse(JSON.stringify(terrainInit.routeSegments)), expectedSegments);
    assert.deepEqual(Object.keys(terrainInit).sort(), ['__bpbTerrain', 'dir', 'routeSegments', 'routeStyle', 'theme', 'type']);
    assert.equal(JSON.stringify(terrainInit).includes('<gpx'), false);
    assert.equal(JSON.stringify(terrainInit).includes('2026-07-10'), false);

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'loaded' }
    }));
    assert.equal(iframe.style.visibility, 'hidden');
    assert.equal(iframe.getAttribute('aria-hidden'), 'true');
    assert.equal(terrainToggle.textContent, '2D map');
    assert.equal(terrainToggle.getAttribute('aria-pressed'), 'true');

    terrainToggle.click();
    assert.equal(iframe.style.visibility, 'visible');
    assert.equal(iframe.hasAttribute('aria-hidden'), false);
    assert.equal(terrainMessages.at(-1).type, 'destroy');
    assert.equal(terrainToggle.textContent, '3D terrain');

    sendSettings({
        units: 'imperial', theme: 'light', chartDefaultSeries: 'both',
        mapRouteColor: '#2457a7', mapRouteWidth: 7,
        mapRouteCasingColor: '#f1eadc', mapRouteCasingWidth: 13,
        mapViewportWidth: 700, mapViewportHeight: 600,
        rememberMapLayer: true, mapLastLayer: 'L_OT'
    });
    await waitFor(dom, () => polylineCalls.length === 4);
    await waitFor(dom, () => layerSelect.value === 'L_OT');
    assert.deepEqual(polylineCalls.slice(-2).map(call => [call.options.color, call.options.weight]), [
        ['#f1eadc', 13],
        ['#2457a7', 7]
    ]);
    assert.equal(mapViewport.style.width, '700px');
    assert.equal(mapViewport.style.height, '618px');
    assert.ok(nativeLayerChanges >= 2, 'the saved layer should be applied through the native change handler');

    layerSelect.value = 'L_OS';
    layerSelect.dispatchEvent(new window.Event('change'));
    assert.equal(sentPatches.at(-1).mapLastLayer, 'L_OS');
    assert.equal(polylineCalls.length, 4, 'changing the native basemap should not rebuild the route overlay');

    mapResizeHandle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
    assert.equal(mapViewport.style.height, '628px');
    assert.equal(sentPatches.at(-1).mapViewportHeight, 610);

    mapViewport.parentElement.getBoundingClientRect = () => ({ left: 0, right: 800, width: 800 });
    mapViewport.getBoundingClientRect = () => ({ left: 80, right: 720, width: 640 });
    const dispatchPointer = (type, values) => {
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])));
        mapResizeHandle.dispatchEvent(event);
    };
    dispatchPointer('pointerdown', { button: 0, pointerId: 1, clientX: 720, clientY: 0 });
    dispatchPointer('pointermove', { pointerId: 1, clientX: 800, clientY: 50 });
    dispatchPointer('pointerup', { pointerId: 1 });
    assert.equal(mapViewport.style.width, '800px');
    assert.equal(mapViewport.style.height, '678px');
    assert.equal(sentPatches.at(-1).mapViewportWidth, 800);
    assert.equal(sentPatches.at(-1).mapViewportHeight, 660);

    const routeColor = window.document.getElementById('bpb-map-route-color');
    const casingColor = window.document.getElementById('bpb-map-route-casing-color');
    assert.equal(routeColor.value, '#2457a7');
    assert.equal(casingColor.value, '#f1eadc');

    routeColor.value = '#347a3f';
    routeColor.dispatchEvent(new window.Event('change'));
    await waitFor(dom, () => polylineCalls.length === 6);
    assert.equal(sentPatches.at(-1).mapRouteColor, '#347a3f');
    assert.deepEqual(polylineCalls.slice(-2).map(call => [call.options.color, call.options.weight]), [
        ['#f1eadc', 13],
        ['#347a3f', 7]
    ]);

    const reloadedMap = makeMap();
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: { mapsPlaceholder: reloadedMap, L, document: iframeDocument }
    });
    iframe.dispatchEvent(new window.Event('load'));
    await waitFor(dom, () => polylineCalls.length === 8);

    assert.equal(map.layers.length, 0, 'layers from the discarded map should be removed');
    assert.equal(reloadedMap.layers.length, 2, 'route casing should be recreated on the new map');

    dom.window.close();
});
