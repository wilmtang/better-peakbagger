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

test('3D terrain waits for the extension frame handshake before sending route coordinates', () => {
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
    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
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

    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null);
    assert.equal(pageMessages.at(-1).type, 'destroyed');
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
    assert.match(window.document.querySelector('.bpb-terrain-badge').textContent, /Open Topo Map · 3D terrain/);
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-route').data.geometry)), {
        type: 'MultiLineString',
        coordinates: [
            [[-121.8, 48.7], [-121.81, 48.71]],
            [[-121.82, 48.75], [-121.815, 48.76]]
        ]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(map.fitted.bounds)), [[-121.82, 48.7], [-121.8, 48.76]]);
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

    map.handlers.get('error')({ sourceId: 'basemap' });
    assert.match(window.document.querySelector('.bpb-terrain-badge').textContent, /^Terrain only/,
        'a selected layer that fails CORS must not take down the terrain renderer');

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

    dom.window.close();
});
