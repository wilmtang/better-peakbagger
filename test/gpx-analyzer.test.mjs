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
// tz-lookup stays a separately-loaded vendor global (its absence is a tested
// degradation path); the MAIN-world analyzer bundle carries metrics, basemap,
// the peak-marker feed, schema, and the analyzer itself.
const tzLookupSource = await readFile(path.join(root, 'dist', 'vendor', 'tz-lookup.js'), 'utf8');
const analyzerBundle = await readFile(path.join(root, 'dist', 'content', 'gpx-analyzer.js'), 'utf8');

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
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx?cy=48.7&cx=-121.8&z=14&t=A&d=1&c=900001&hj=0"></iframe><br>
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
    let chartConfig = null;
    const baseTileLayer = {
        _url: 'https://{s}.tile.example.com/{z}/{x}/{y}{r}.png',
        options: {
            subdomains: 'abc',
            tileSize: 256,
            minZoom: 2,
            maxZoom: 17,
            attribution: '<a href="https://example.com/copyright">© Example Maps</a>'
        }
    };
    const labelTileLayer = {
        _url: 'https://labels.example.com/{z}/{x}/{y}.png',
        options: { zIndex: -1, attribution: 'Labels' }
    };
    // Peakbagger builds basemaps on demand with no per-layer global, so the 3D
    // picker mirrors the #selmap codes via built-in drape specs rather than
    // reading globals; every code below maps to a spec, so all four are offered.
    const calTopoLayer = {
        _url: 'https://ct.example.com/{z}/{x}/{y}.png',
        options: { minZoom: 3, maxZoom: 16, attribution: 'CalTopo' }
    };
    const openTopoLayer = {
        _url: 'https://ot.example.com/{z}/{x}/{y}.png',
        options: { attribution: 'OpenTopo' }
    };
    const makeMap = () => ({
        layers: [],
        _layers: { labels: labelTileLayer, base: baseTileLayer },
        invalidateCalls: 0,
        center: { lat: 48.72, lng: -121.79 },
        zoom: 15,
        setViewCalls: [],
        hasLayer(layer) { return layer === baseTileLayer || layer === labelTileLayer; },
        getCenter() { return this.center; },
        getZoom() { return this.zoom; },
        setView(center, zoom, options) {
            this.center = { lat: center[0], lng: center[1] };
            this.zoom = zoom;
            this.setViewCalls.push({ center: [...center], zoom, options: { ...options } });
        },
        invalidateSize() { this.invalidateCalls++; },
        removeLayer(layer) {
            this.layers = this.layers.filter(candidate => candidate !== layer);
            layer._map = null;
        }
    });
    const map = makeMap();
    const L = {
        Browser: { retina: false },
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
        value: { mapsPlaceholder: map, L, L_CT: calTopoLayer, L_MT: baseTileLayer, L_OT: openTopoLayer, document: iframeDocument, location: { href: 'https://www.peakbagger.com/map/MasterMap.aspx' } }
    });

    window.matchMedia = () => ({ matches: false });
    window.HTMLCanvasElement.prototype.getContext = () => ({});
    const peakFeedRequests = [];
    const peakFeedXml = `<?xml version='1.0' encoding='UTF-8'?><ts>`
        + `<t i="58603" n="Iron Mountain" a="48.72" o="-121.79" c="1" r="246"/>`
        + `<t i="-114297" n="Peak 5000 (Prov)" a="48.74" o="-121.82" c="2" r="10"/>`
        + `</ts>`;
    window.fetch = async url => {
        if (String(url).includes('/Async/PLLBB.aspx')) {
            peakFeedRequests.push(String(url));
            return { ok: true, text: async () => peakFeedXml };
        }
        return { ok: true, text: async () => gpx };
    };
    window.Chart = class ChartStub {
        constructor(context, config) {
            chartConfig = config;
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
        sendSettings({ units: 'imperial', theme: 'light', chartDefaultSeries: 'time', enable3dMap: true });
    };

    Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
    window.eval(analyzerBundle);
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
    assert.equal(terrainToggle.disabled, false);
    assert.equal(window.document.getElementById('bpb-terrain-disclosure'), null);
    terrainToggle.click();
    await waitFor(dom, () => terrainMessages.some(message => message.type === 'init'));
    assert.equal(window.document.getElementById('bpb-terrain-message').textContent, '',
        'the toggle button is the only loading cue; no separate loading banner');
    assert.equal(window.document.getElementById('bpb-terrain-message').style.display, 'none');
    assert.equal(terrainToggle.disabled, false, 'the loading state remains cancelable');
    assert.equal(terrainToggle.getAttribute('aria-label'), 'Cancel loading 3D terrain');
    const terrainInit = terrainMessages.find(message => message.type === 'init');
    assert.deepEqual(JSON.parse(JSON.stringify(terrainInit.routeSegments)), expectedSegments);
    assert.deepEqual(Object.keys(terrainInit).sort(), ['__bpbTerrain', 'basemap', 'basemaps', 'cacheLimitMb', 'camera', 'dir', 'routeSegments', 'routeStyle', 'theme', 'type']);
    assert.deepEqual(JSON.parse(JSON.stringify(terrainInit.camera)), { center: [48.72, -121.79], zoom: 14 });
    assert.equal(terrainInit.cacheLimitMb, 512);
    // The active layer (the test selects L_MT above) drapes from its shared
    // spec so it dedupes cleanly against the picker list.
    assert.deepEqual(JSON.parse(JSON.stringify(terrainInit.basemap)), {
        name: 'MyTopo USA/Canada',
        tiles: ['https://tileserver.trimbleoutdoors.com/SecureTile/TileHandler.ashx?mapType=Topo&partnerID=12153&hash=b19f07d8-6f01-4981-9146-40875a18d2fa&x={x}&y={y}&z={z}'],
        tileSize: 256,
        minzoom: 9,
        maxzoom: 16,
        scheme: 'xyz',
        stockLod: false,
        attribution: '&copy; <a href="https://mytopo.com" target="_blank" rel="noopener noreferrer">MyTopo</a>'
    });
    // The picker mirrors the full native #selmap menu of drape-able layers,
    // not just the one active layer — the core of the multi-layer picker fix.
    assert.deepEqual(JSON.parse(JSON.stringify(terrainInit.basemaps.map(basemap => basemap.name))),
        ['CalTopo', 'MyTopo USA/Canada', 'Open Topo Map', 'Open Street Map']);
    assert.deepEqual(JSON.parse(JSON.stringify(terrainInit.basemaps[3])), {
        name: 'Open Street Map',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 18,
        scheme: 'xyz',
        stockLod: false,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
    });
    assert.equal(JSON.stringify(terrainInit).includes('<gpx'), false);
    assert.equal(JSON.stringify(terrainInit).includes('2026-07-10'), false);

    terrainToggle.click();
    assert.equal(terrainMessages.at(-1).type, 'destroy', 'clicking the loading toggle cancels the frame boot');
    assert.equal(terrainToggle.textContent, '3D');
    terrainToggle.click();
    await waitFor(dom, () => terrainMessages.filter(message => message.type === 'init').length === 2);

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'loaded' }
    }));
    assert.equal(iframe.style.visibility, 'hidden');
    assert.equal(iframe.getAttribute('aria-hidden'), 'true');
    assert.equal(terrainToggle.textContent, '2D');
    assert.equal(terrainToggle.getAttribute('aria-pressed'), 'true');
    // The floating toggle overlays the map, not the panel below it.
    assert.equal(terrainToggle.parentElement.id, 'bpb-map-viewport');

    assert.equal(chartConfig.data.datasets[0].hidden, true);
    assert.equal(chartConfig.data.datasets[1].hidden, false);
    chartConfig.options.onHover(null, [{ datasetIndex: 1, index: 0 }]);
    assert.deepEqual(JSON.parse(JSON.stringify(terrainMessages.at(-1))), {
        __bpbTerrain: true,
        dir: 'toCS',
        type: 'highlight',
        coordinates: [-121.8, 48.7],
        series: 'time'
    }, 'hovering the blue time series identifies it to the 3D chaser');

    // The frame asks for peak dots; the analyzer serves them from the same
    // PLLBB feed the native map uses, parameterized from the iframe URL.
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true, dir: 'toPage', type: 'peaksRequest',
            requestId: 1, bounds: { miny: 48.65, maxy: 48.8, minx: -121.9, maxx: -121.7 }
        }
    }));
    await waitFor(dom, () => terrainMessages.some(message => message.type === 'peaks'));
    assert.deepEqual(peakFeedRequests, [
        'https://www.peakbagger.com/Async/PLLBB.aspx?miny=48.65&maxy=48.8&minx=-121.9&maxx=-121.7&t=A&cid=900001'
    ], 'the feed request mirrors the native query: type and climber id, no pid on ascent maps');
    const peaksReply = terrainMessages.find(message => message.type === 'peaks');
    assert.equal(peaksReply.requestId, 1);
    assert.notEqual(peaksReply.unavailable, true);
    assert.deepEqual(JSON.parse(JSON.stringify(peaksReply.peaks)), [
        { id: 58603, name: 'Iron Mountain', lat: 48.72, lon: -121.79, state: 'climbed' },
        { id: -114297, name: 'Peak 5000 (Prov)', lat: 48.74, lon: -121.82, state: 'unknown' }
    ]);

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toPage',
            type: 'camera',
            camera: { center: [48.8, -121.7], zoom: 13.75 }
        }
    }));
    sendSettings({ units: 'imperial', theme: 'light', chartDefaultSeries: 'both', enable3dMap: false });
    await waitFor(dom, () => terrainMessages.at(-1).type === 'cameraRequest');
    const cameraRequestId = terrainMessages.at(-1).requestId;
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toPage',
            type: 'camera',
            requestId: cameraRequestId,
            camera: { center: [48.8, -121.7], zoom: 13.75 }
        }
    }));
    await waitFor(dom, () => terrainMessages.at(-1).type === 'destroy');
    assert.deepEqual(JSON.parse(JSON.stringify(map.setViewCalls)), [{
        center: [48.8, -121.7],
        zoom: 14.75,
        options: { animate: false }
    }], 'the current terrain camera is applied before the native ascent map returns');
    assert.equal(terrainToggle.hidden, false, 'the 3D entry point stays visible while the feature is off');
    assert.equal(terrainToggle.disabled, false);
    assert.equal(iframe.style.visibility, 'visible');
    assert.equal(iframe.hasAttribute('aria-hidden'), false);
    assert.equal(terrainMessages.at(-1).type, 'destroy');
    assert.equal(terrainToggle.textContent, '3D');

    const initCountBeforeConsent = terrainMessages.filter(message => message.type === 'init').length;
    terrainToggle.click();
    assert.equal(terrainMessages.at(-1).type, 'requestConsent');
    assert.equal(terrainMessages.filter(message => message.type === 'init').length, initCountBeforeConsent,
        'clicking while disabled must request confirmation, not start external tile requests');
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'consentResult', enabled: false }
    }));

    sendSettings({ units: 'imperial', theme: 'light', chartDefaultSeries: 'both', enable3dMap: true });
    terrainToggle.click();
    await waitFor(dom, () => terrainMessages.filter(message => message.type === 'init').length === initCountBeforeConsent + 1);
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'error', reason: 'maplibre' }
    }));
    assert.equal(iframe.style.visibility, 'visible');
    assert.equal(terrainToggle.textContent, '3D');
    assert.match(window.document.getElementById('bpb-terrain-message').textContent, /could not render 3D terrain/);

    sendSettings({
        units: 'imperial', theme: 'light', chartDefaultSeries: 'both',
        mapRouteColor: '#2457a7', mapRouteWidth: 7,
        mapRouteCasingColor: '#f1eadc', mapRouteCasingWidth: 13,
        mapViewportWidth: 700, mapViewportHeight: 600,
        rememberMapLayer: true, mapLastLayer: 'L_OT', enable3dMap: true
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
    mapResizeHandle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
    assert.equal(mapViewport.style.height, '638px');
    assert.equal(sentPatches.some(patch => 'mapViewportHeight' in patch), false,
        'keyboard resize must not persist on every keystroke');
    await waitFor(dom, () => sentPatches.some(patch => 'mapViewportHeight' in patch));
    assert.equal(sentPatches.filter(patch => 'mapViewportHeight' in patch).length, 1,
        'repeated keystrokes should persist once, after the last step');
    assert.equal(sentPatches.at(-1).mapViewportHeight, 620);

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
    assert.equal(mapViewport.style.height, '688px');
    assert.equal(sentPatches.at(-1).mapViewportWidth, 800);
    assert.equal(sentPatches.at(-1).mapViewportHeight, 670);

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
        value: { mapsPlaceholder: reloadedMap, L, L_MT: baseTileLayer, document: iframeDocument, location: { href: 'https://www.peakbagger.com/map/MasterMap.aspx' } }
    });
    iframe.dispatchEvent(new window.Event('load'));
    await waitFor(dom, () => polylineCalls.length === 8);

    assert.equal(map.layers.length, 0, 'layers from the discarded map should be removed');
    assert.equal(reloadedMap.layers.length, 2, 'route casing should be recreated on the new map');

    dom.window.close();
});

// Hourly track at lat 48.7 / lon −121.8 (America/Vancouver, PDT in July;
// solar-estimate fallback UTC−8) climbing 05:00Z–11:00Z: mountain-local
// evening through the small hours of the next day. The route crosses the
// mountain's local midnight but not UTC midnight, so the Day 2 labels and
// the camping spot below only appear when day boundaries are computed in
// the mountain's timezone — regardless of the machine running this test.
const loadOvernightAnalyzer = async ({ withTzLookup, elevations = [1000, 1200, 1400, 1600, 2000, 1600, 1200] }) => {
    const points = elevations.map((ele, index) =>
        `<trkpt lat="${(48.7 + index * 0.01).toFixed(2)}" lon="-121.8000"><ele>${ele}</ele>`
        + `<time>2026-07-10T${String(5 + index).padStart(2, '0')}:00:00Z</time></trkpt>`).join('\n');
    const overnightGpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${points}</trkseg></trk></gpx>`;

    const dom = new JSDOM(`<!doctype html><body>
      <p><a href="https://www.peakbagger.com/demo.gpx">Download this GPS track</a></p>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    window.matchMedia = () => ({ matches: false });
    window.HTMLCanvasElement.prototype.getContext = () => ({});
    window.fetch = async () => ({ ok: true, text: async () => overnightGpx });
    window.Chart = class ChartStub {
        constructor(context, config) {
            this.data = config.data;
            this.options = config.options;
        }
        destroy() {}
    };
    window.postMessage = message => {
        if (!message || message.dir !== 'toCS' || message.kind !== 'get') return;
        window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: { __bpb: true, dir: 'toPage', settings: { units: 'imperial', theme: 'light' } }
        })));
    };

    Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
    if (withTzLookup) window.eval(tzLookupSource);
    window.eval(analyzerBundle);
    const analysisText = () => window.document.getElementById('bpb-gpx-analysis')?.textContent || '';
    await waitFor(dom, () => analysisText().includes('Possible Camping'));
    return { dom, analysisText };
};

test('chart times use the mountain’s IANA timezone, not the viewer’s', async () => {
    const { dom, analysisText } = await loadOvernightAnalyzer({ withTzLookup: true });

    assert.match(analysisText(), /Summit time: Day 2/,
        'the summit after mountain-local midnight must be labelled Day 2');
    assert.match(analysisText(), /Possible Camping: Day 1/);
    assert.ok(analysisText().includes('Times in the mountain’s local time (PDT)'),
        'the stats bar must name the timezone resolved from the track start');

    dom.window.close();
});

test('without the timezone raster, times fall back to a labelled longitude estimate', async () => {
    const { dom, analysisText } = await loadOvernightAnalyzer({ withTzLookup: false });

    assert.match(analysisText(), /Summit time: Day 2/);
    assert.match(analysisText(), /Possible Camping: Day 1/);
    assert.ok(analysisText().includes('Times in the mountain’s local time (UTC−8, estimated from longitude)'),
        'the stats bar must disclose the estimated mountain timezone');

    dom.window.close();
});

test('overnight camping remains visible when the track starts at its highest point', async () => {
    const { dom, analysisText } = await loadOvernightAnalyzer({
        withTzLookup: true,
        elevations: [2200, 2000, 1800, 1600, 1400, 1200, 1000]
    });

    assert.doesNotMatch(analysisText(), /Summit time:/,
        'a summit-time breakdown is not meaningful when the summit is the first sample');
    assert.match(analysisText(), /Possible Camping: Day 1/,
        'camping is a day-boundary result and must not depend on summit timing');

    dom.window.close();
});

test('a failed GPS track download reports the HTTP error instead of a parse message', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <p><a href="https://www.peakbagger.com/demo.gpx">Download this GPS track</a></p>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    window.matchMedia = () => ({ matches: false });
    window.HTMLCanvasElement.prototype.getContext = () => ({});
    window.fetch = async () => ({ ok: false, status: 404, text: async () => 'not found' });
    window.Chart = class ChartStub { destroy() {} };
    window.postMessage = message => {
        if (!message || message.dir !== 'toCS' || message.kind !== 'get') return;
        window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: { __bpb: true, dir: 'toPage', settings: { units: 'imperial', theme: 'light' } }
        })));
    };

    Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
    window.eval(analyzerBundle);
    const analysisText = () => window.document.getElementById('bpb-gpx-analysis')?.textContent || '';
    await waitFor(dom, () => analysisText().includes('HTTP 404'));
    assert.match(analysisText(), /The GPS track download failed \(HTTP 404\)\./);
    assert.doesNotMatch(analysisText(), /No track points found/);

    dom.window.close();
});

const loadElevationAnalyzer = async gpxSource => {
    const dom = new JSDOM(`<!doctype html><body>
      <p><a href="https://www.peakbagger.com/demo.gpx">Download this GPS track</a></p>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    let chartConfig = null;
    window.matchMedia = () => ({ matches: false });
    window.HTMLCanvasElement.prototype.getContext = () => ({});
    window.fetch = async () => ({ ok: true, text: async () => gpxSource });
    window.Chart = class ChartStub {
        constructor(context, config) {
            chartConfig = config;
            this.data = config.data;
            this.options = config.options;
        }
        destroy() {}
    };
    window.postMessage = message => {
        if (!message || message.dir !== 'toCS' || message.kind !== 'get') return;
        window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: { __bpb: true, dir: 'toPage', settings: { units: 'metric', theme: 'light' } }
        })));
    };

    Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
    window.eval(analyzerBundle);
    const analysisText = () => window.document.getElementById('bpb-gpx-analysis')?.textContent || '';
    return { dom, analysisText, chartConfig: () => chartConfig };
};

test('GPX analyzer drops points whose elevation is missing or invalid', async () => {
    const source = `<?xml version="1.0"?><gpx><trk><trkseg>
      <trkpt lat="47" lon="-121"><ele>100</ele></trkpt>
      <trkpt lat="47" lon="-121.001"></trkpt>
      <trkpt lat="47" lon="-121.002"><ele>unknown</ele></trkpt>
      <trkpt lat="47" lon="-121.003"></trkpt>
      <trkpt lat="47" lon="-121.004"><ele>110</ele></trkpt>
    </trkseg></trk></gpx>`;
    const { dom, chartConfig } = await loadElevationAnalyzer(source);

    await waitFor(dom, () => chartConfig() !== null);
    const chartPoints = chartConfig().data.datasets[0].data;
    assert.deepEqual(Array.from(chartPoints, point => point._raw.rawEleM), [100, 110]);
    assert.ok(chartPoints.every(point => point.y > 0),
        'missing elevation must not become a charted dip to sea level');

    dom.window.close();
});

test('GPX analyzer labels a track with no usable elevation instead of reporting zero gain', async () => {
    const source = `<?xml version="1.0"?><gpx><trk><trkseg>
      <trkpt lat="47" lon="-121"></trkpt>
      <trkpt lat="47" lon="-121.001"><ele>unknown</ele></trkpt>
    </trkseg></trk></gpx>`;
    const { dom, analysisText, chartConfig } = await loadElevationAnalyzer(source);

    await waitFor(dom, () => analysisText().includes('no usable elevation data'));
    assert.match(analysisText(), /This GPS track has no usable elevation data\./);
    assert.doesNotMatch(analysisText(), /0 (?:m|ft) gain/);
    assert.equal(chartConfig(), null);

    dom.window.close();
});
