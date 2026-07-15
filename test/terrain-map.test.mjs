// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const terrainBridgeSource = await readFile(path.join(root, 'src', 'terrain-map.js'), 'utf8');
const terrainFrameSource = await readFile(path.join(root, 'src', 'terrain-frame.js'), 'utf8');

test('3D terrain waits for the extension frame handshake before sending route coordinates', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport">
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      </div>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const pageMessages = [];
    const frameMessages = [];
    let settingsListener = null;
    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.BPBSettings = {
        get: async () => ({ enable3dMap: true }),
        subscribe(listener) { settingsListener = listener; return () => {}; }
    };
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(terrainBridgeSource);

    const dispatchPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));
    dispatchPage({
        type: 'init',
        routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
        routeStyle: { color: '#d9483b' },
        theme: 'light',
        cacheLimitMb: 512,
        basemap: {
            name: 'Open Topo Map',
            tiles: ['https://a.tile.example.com/{z}/{x}/{y}.png']
        }
    });
    await new Promise(resolve => window.setTimeout(resolve, 0));

    const frame = window.document.getElementById('bpb-terrain-frame');
    assert.ok(frame);
    assert.equal(frame.src, 'chrome-extension://test-id/terrain/terrain.html');
    assert.equal(frameMessages.length, 0, 'route coordinates must wait until the frame listener is ready');
    frame.contentWindow.postMessage = message => { frameMessages.push(message); };

    dispatchPage({ type: 'update', routeStyle: { color: '#347a3f' }, theme: 'dark' });
    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: { __bpbTerrainFrame: true, dir: 'toParent', type: 'ready' }
    }));
    const init = frameMessages.find(message => message.type === 'init');
    assert.ok(init);
    assert.deepEqual(init.routeSegments, [[[48.7, -121.8], [48.71, -121.81]]]);
    assert.equal(init.routeStyle.color, '#347a3f');
    assert.equal(init.theme, 'dark');
    assert.equal(init.cacheLimitMb, 512);
    assert.equal(init.basemap.name, 'Open Topo Map');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: { __bpbTerrainFrame: true, dir: 'toParent', type: 'loaded' }
    }));
    assert.equal(frame.style.opacity, '1');
    assert.equal(frame.style.pointerEvents, 'auto');
    assert.equal(pageMessages.at(-1).type, 'loaded');

    settingsListener({ enable3dMap: false });
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null);
    assert.equal(pageMessages.at(-1).type, 'error');
    assert.equal(pageMessages.at(-1).reason, 'unavailable');

    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null);
    assert.equal(pageMessages.at(-1).type, 'destroyed');
    dom.window.close();
});

test('3D terrain bridge refuses page requests unless the stored feature gate is enabled', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport">
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      </div>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const messages = [];
    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.BPBSettings = {
        get: async () => ({ enable3dMap: false }),
        subscribe() { return () => {}; }
    };
    window.postMessage = message => { messages.push(message); };
    window.eval(terrainBridgeSource);

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toCS',
            type: 'init',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]]
        }
    }));
    await new Promise(resolve => window.setTimeout(resolve, 0));

    assert.equal(window.document.getElementById('bpb-terrain-frame'), null);
    assert.equal(messages.at(-1).type, 'error');
    assert.equal(messages.at(-1).reason, 'unavailable');
    dom.window.close();
});

test('a newer feature-gate push wins over a stale initial storage read', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport">
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      </div>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    let resolveInitialSettings;
    let settingsListener;
    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.BPBSettings = {
        get: () => new Promise(resolve => { resolveInitialSettings = resolve; }),
        subscribe(listener) { settingsListener = listener; return () => {}; }
    };
    window.postMessage = () => {};
    window.eval(terrainBridgeSource);

    settingsListener({ enable3dMap: true });
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toCS',
            type: 'init',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]]
        }
    }));
    resolveInitialSettings({ enable3dMap: false });
    await new Promise(resolve => window.setTimeout(resolve, 0));

    assert.ok(window.document.getElementById('bpb-terrain-frame'),
        'the stale initial read must not undo the newer enabled setting');
    dom.window.close();
});

test('3D terrain frame validates coordinate-only routes before loading public DEM tiles', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages = [];
    const maps = [];
    const protocolHandlers = new Map();
    let workerUrl = '';

    class MapStub {
        constructor(options) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.paint = [];
            this.controls = [];
            this.handlers = new Map();
            this.removed = false;
            maps.push(this);
        }
        addControl(control, position) { this.controls.push({ control, position }); }
        once(type, callback) {
            if (type === 'load') window.queueMicrotask(callback);
        }
        on(type, callback) { this.handlers.set(type, callback); }
        addSource(id, source) {
            const stored = {
                ...source,
                setData(data) { this.data = data; }
            };
            this.sources.set(id, stored);
        }
        addLayer(layer) { this.layers.push(layer); }
        getLayer(id) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id) { return this.sources.get(id); }
        removeSource(id) { this.sources.delete(id); }
        setPaintProperty(...args) { this.paint.push(args); }
        fitBounds(bounds, options) { this.fitted = { bounds, options }; }
        resize() { this.resizeCalled = true; }
        remove() { this.removed = true; }
    }

    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.BPBTerrainCache = {
        PROTOCOL: 'bpb-dem',
        create({ limitMb }) {
            return { limitMb, load() {}, flush() { return Promise.resolve(); } };
        }
    };
    window.maplibregl = {
        Map: MapStub,
        NavigationControl: class NavigationControl {},
        ScaleControl: class ScaleControl {},
        setWorkerUrl(url) { workerUrl = url; },
        addProtocol(name, handler) { protocolHandlers.set(name, handler); },
        removeProtocol(name) { protocolHandlers.delete(name); }
    };
    window.postMessage = message => { messages.push(message); };
    window.eval(terrainFrameSource);

    const dispatch = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrainFrame: true, dir: 'toFrame', ...data }
    }));

    dispatch({ type: 'init', routeSegments: [[[48.7, -121.8, 1000], [48.71, -121.81, 1200]]] });
    assert.equal(maps.length, 0, 'points with extra elevation data must fail closed');
    assert.equal(messages.at(-1).type, 'error');

    const oversizedRoute = Array.from({ length: 3001 }, (_, index) => [48.7 + index / 1000000, -121.8]);
    dispatch({ type: 'init', routeSegments: [oversizedRoute] });
    assert.equal(maps.length, 0, 'routes above the 3,000-point privacy and rendering cap must fail closed');
    assert.equal(messages.at(-1).type, 'error');

    const routeSegments = [
        [[48.7, -121.8], [48.71, -121.81]],
        [[48.75, -121.82], [48.76, -121.815]]
    ];
    dispatch({
        type: 'init',
        routeSegments,
        routeStyle: { color: '#2457a7', width: 7, casingColor: '#f1eadc', casingWidth: 13 },
        theme: 'dark',
        cacheLimitMb: 384,
        basemap: {
            name: 'Open Topo Map',
            tiles: ['https://a.tile.example.com/{z}/{x}/{y}.png'],
            tileSize: 256,
            minzoom: 2,
            maxzoom: 17,
            scheme: 'xyz',
            attribution: '<a href="https://example.com/copyright">© Example Maps</a><script>alert(1)</script>'
        }
    });
    await new Promise(resolve => window.queueMicrotask(resolve));

    assert.equal(maps.length, 1);
    const map = maps[0];
    assert.equal(workerUrl, 'chrome-extension://test-id/vendor/maplibre-gl-csp-worker.js');
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.style.sources.terrain.tiles)), ['bpb-dem://{z}/{x}/{y}.webp']);
    assert.equal(map.options.style.sources.terrain.encoding, 'terrarium');
    assert.ok(protocolHandlers.has('bpb-dem'));
    assert.equal(map.options.style.terrain.exaggeration, 1, 'terrain must not distort mountaineering geometry');
    assert.deepEqual(Object.keys(map.options.style.sources), ['terrain', 'basemap']);
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.style.sources.basemap.tiles)), ['https://a.tile.example.com/{z}/{x}/{y}.png']);
    assert.equal(map.options.style.sources.basemap.tileSize, 256);
    assert.match(map.options.style.sources.basemap.attribution, /https:\/\/example\.com\/copyright/);
    assert.doesNotMatch(map.options.style.sources.basemap.attribution, /script|alert/i);
    assert.equal(map.options.style.layers.find(layer => layer.id === 'basemap').paint['raster-opacity'], 0.78);
    const picker = () => window.document.querySelector('.bpb-terrain-picker');
    const notice = () => window.document.querySelector('.bpb-terrain-notice');
    assert.ok(picker(), 'a drape picker is shown when a layer is offered');
    assert.equal(picker().options[picker().selectedIndex].textContent, 'Open Topo Map',
        'the picker labels and selects the active drape');
    assert.ok(Array.from(picker().options).some(option => option.textContent === 'Terrain only'),
        'the picker always offers a terrain-only choice');
    const hint = window.document.querySelector('.bpb-terrain-hint');
    assert.ok(hint, 'a persistent gesture hint is shown');
    assert.match(hint.textContent, /Drag to pan/);
    assert.match(hint.textContent, /scroll to zoom/);
    assert.match(hint.textContent, /right-drag to tilt/);
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-route').data.geometry)), {
        type: 'MultiLineString',
        coordinates: [
            [[-121.8, 48.7], [-121.81, 48.71]],
            [[-121.82, 48.75], [-121.815, 48.76]]
        ]
    });
    // The camera is framed on the route at construction, not re-fitted after
    // 'load' — fitting later would load a throwaway tileset for the placeholder
    // view and rebuild the terrain mesh, the dominant chunk of load time.
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.bounds)), [[-121.82, 48.7], [-121.8, 48.76]]);
    assert.equal(map.options.fitBoundsOptions.maxZoom, 15.5);
    assert.equal(map.options.fitBoundsOptions.pitch, 60);
    assert.equal(map.fitted, undefined, 'no redundant post-load fitBounds');
    assert.equal(window.document.getElementById('bpb-terrain-map').style.pointerEvents, 'auto');
    assert.equal(messages.at(-1).type, 'loaded');

    dispatch({ type: 'highlight', coordinates: [-121.81, 48.71] });
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-highlight').data.geometry)), {
        type: 'Point', coordinates: [-121.81, 48.71]
    });

    dispatch({
        type: 'update',
        routeStyle: { color: '#347a3f', width: 6, casingColor: '#ffffff', casingWidth: 10 },
        theme: 'light'
    });
    assert.ok(map.paint.some(call => call[0] === 'bpb-route' && call[1] === 'line-color' && call[2] === '#347a3f'));
    assert.equal(window.document.getElementById('bpb-terrain-map').dataset.theme, 'light');

    // A drape that loaded at least one tile must survive sparse later tile
    // failures: one error is no longer enough to tear the whole layer down.
    map.handlers.get('data')({ sourceId: 'basemap', dataType: 'source', tile: {} });
    map.handlers.get('error')({ sourceId: 'basemap' });
    map.handlers.get('idle')();
    assert.equal(picker().value, '0', 'a drape that rendered a tile stays selected');
    assert.equal(picker().options[0].disabled, false, 'a working drape is not disabled');
    assert.equal(notice().hidden, true, 'no failure notice for a drape that rendered a tile');

    dispatch({ type: 'destroy' });
    assert.equal(map.removed, true);
    assert.equal(protocolHandlers.has('bpb-dem'), false);
    assert.equal(window.document.getElementById('bpb-terrain-map'), null);
    assert.equal(messages.at(-1).type, 'destroyed');

    dispatch({
        type: 'init',
        routeSegments,
        basemap: {
            name: 'Unsafe local layer',
            tiles: ['https://127.0.0.1/{z}/{x}/{y}.png']
        }
    });
    await new Promise(resolve => window.queueMicrotask(resolve));
    assert.deepEqual(Object.keys(maps[1].options.style.sources), ['terrain'],
        'the extension frame must reject private-network tile templates');

    // A drape whose every tile fails (e.g. a whole layer blocked by CORS)
    // loads no tile, so it is dropped to terrain-only at the first idle.
    dispatch({ type: 'destroy' });
    dispatch({
        type: 'init',
        routeSegments,
        basemap: {
            name: 'Blocked Layer',
            tiles: ['https://a.tile.example.com/{z}/{x}/{y}.png']
        }
    });
    await new Promise(resolve => window.queueMicrotask(resolve));
    const blocked = maps[2];
    assert.equal(picker().options[picker().selectedIndex].textContent, 'Blocked Layer',
        'the picker starts on the layer name before any tile is attempted');
    blocked.handlers.get('error')({ sourceId: 'basemap' });
    blocked.handlers.get('error')({ sourceId: 'basemap' });
    blocked.handlers.get('idle')();
    assert.equal(picker().value, 'terrain',
        'a drape whose every tile fails is dropped to terrain-only at the first idle');
    assert.equal(picker().options[0].disabled, true, 'the blocked layer is disabled in the picker');
    assert.equal(notice().hidden, false);
    assert.match(notice().textContent, /Blocked Layer.*blocks cross-origin/,
        'the notice names the blocked layer and explains why');

    dom.window.close();
});

test('the 3D drape picker offers every layer and swaps the draped raster live', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const maps = [];

    class MapStub {
        constructor(options) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.handlers = new Map();
            maps.push(this);
        }
        addControl() {}
        once(type, callback) { if (type === 'load') window.queueMicrotask(callback); }
        on(type, callback) { this.handlers.set(type, callback); }
        addSource(id, source) { this.sources.set(id, { ...source, setData() {} }); }
        addLayer(layer) { this.layers.push(layer); }
        getLayer(id) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id) { return this.sources.get(id); }
        removeSource(id) { this.sources.delete(id); }
        setPaintProperty() {}
        fitBounds() {}
        resize() {}
        remove() {}
    }

    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.BPBTerrainCache = { PROTOCOL: 'bpb-dem', create: () => ({ load() {}, flush: () => Promise.resolve() }) };
    window.maplibregl = {
        Map: MapStub,
        NavigationControl: class {},
        ScaleControl: class {},
        setWorkerUrl() {},
        addProtocol() {},
        removeProtocol() {}
    };
    window.postMessage = () => {};
    window.eval(terrainFrameSource);

    const routeSegments = [[[48.7, -121.8], [48.71, -121.81]]];
    const layer = (name, host) => ({ name, tiles: [`https://${host}/{z}/{x}/{y}.png`] });
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrainFrame: true, dir: 'toFrame', type: 'init', routeSegments,
            basemap: layer('MyTopo', 'mt.example.com'),
            basemaps: [layer('CalTopo', 'ct.example.com'), layer('MyTopo', 'mt.example.com'), layer('OpenTopo', 'ot.example.com')]
        }
    }));
    await new Promise(resolve => window.queueMicrotask(resolve));

    const picker = () => window.document.querySelector('.bpb-terrain-picker');
    const map = maps[0];
    assert.deepEqual(Array.from(picker().options, option => option.textContent),
        ['CalTopo', 'MyTopo', 'OpenTopo', 'Terrain only'], 'the picker offers every layer plus terrain-only');
    assert.equal(picker().options[picker().selectedIndex].textContent, 'MyTopo',
        'the initially-selected native layer is preselected');

    const swap = value => {
        picker().value = value;
        picker().dispatchEvent(new window.Event('change'));
    };

    swap('0');
    assert.deepEqual(JSON.parse(JSON.stringify(map.getSource('basemap').tiles)),
        ['https://ct.example.com/{z}/{x}/{y}.png'], 'selecting a layer re-drapes it live');

    swap('terrain');
    assert.equal(map.getSource('basemap'), undefined, 'terrain-only removes the drape');
    assert.equal(map.getLayer('basemap'), undefined);

    // Manually selecting a layer that then fails every tile disables it.
    swap('2');
    assert.equal(JSON.parse(JSON.stringify(map.getSource('basemap').tiles))[0], 'https://ot.example.com/{z}/{x}/{y}.png');
    map.handlers.get('error')({ sourceId: 'basemap' });
    map.handlers.get('idle')();
    assert.equal(picker().value, 'terrain', 'a failed manual selection reverts to terrain-only');
    assert.equal(picker().options[2].disabled, true, 'the failed layer is disabled');
    assert.match(window.document.querySelector('.bpb-terrain-notice').textContent, /OpenTopo/);

    dom.window.close();
});
