// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const terrainSource = await readFile(path.join(root, 'src', 'terrain-map.js'), 'utf8');

test('3D terrain validates coordinate-only routes before loading public DEM tiles', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport">
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      </div>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages = [];
    const maps = [];
    let workerUrl = '';

    class MapStub {
        constructor(options) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.paint = [];
            this.controls = [];
            this.removed = false;
            maps.push(this);
        }
        addControl(control, position) { this.controls.push({ control, position }); }
        once(type, callback) {
            if (type === 'load') window.queueMicrotask(callback);
        }
        addSource(id, source) {
            const stored = {
                ...source,
                setData(data) { this.data = data; }
            };
            this.sources.set(id, stored);
        }
        addLayer(layer) { this.layers.push(layer); }
        getSource(id) { return this.sources.get(id); }
        setPaintProperty(...args) { this.paint.push(args); }
        fitBounds(bounds, options) { this.fitted = { bounds, options }; }
        resize() { this.resizeCalled = true; }
        remove() { this.removed = true; }
    }

    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.maplibregl = {
        Map: MapStub,
        NavigationControl: class NavigationControl {},
        ScaleControl: class ScaleControl {},
        setWorkerUrl(url) { workerUrl = url; }
    };
    window.postMessage = message => { messages.push(message); };
    window.eval(terrainSource);

    const dispatch = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
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
        theme: 'dark'
    });
    await new Promise(resolve => window.queueMicrotask(resolve));

    assert.equal(maps.length, 1);
    const map = maps[0];
    assert.equal(workerUrl, 'chrome-extension://test-id/vendor/maplibre-gl-csp-worker.js');
    assert.equal(map.options.style.sources.terrain.url, 'https://tiles.mapterhorn.com/tilejson.json');
    assert.equal(map.options.style.sources.terrain.encoding, 'terrarium');
    assert.equal(map.options.style.terrain.exaggeration, 1, 'terrain must not distort mountaineering geometry');
    assert.deepEqual(Object.keys(map.options.style.sources), ['terrain'], 'the prototype must not contact a second basemap provider');
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-route').data.geometry)), {
        type: 'MultiLineString',
        coordinates: [
            [[-121.8, 48.7], [-121.81, 48.71]],
            [[-121.82, 48.75], [-121.815, 48.76]]
        ]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(map.fitted.bounds)), [[-121.82, 48.7], [-121.8, 48.76]]);
    assert.equal(window.document.getElementById('bpb-terrain-map').style.visibility, 'visible');
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

    dispatch({ type: 'destroy' });
    assert.equal(map.removed, true);
    assert.equal(window.document.getElementById('bpb-terrain-map'), null);
    assert.equal(messages.at(-1).type, 'destroyed');

    dom.window.close();
});
