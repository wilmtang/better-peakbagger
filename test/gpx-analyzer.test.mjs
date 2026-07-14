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
      <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      <a href="https://www.peakbagger.com/demo.gpx">Download this GPS track</a>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const polylineCalls = [];
    const makeMap = () => ({
        layers: [],
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
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: { mapsPlaceholder: map, L }
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

    window.postMessage = message => {
        if (!message || message.dir !== 'toCS' || message.kind !== 'get') return;
        window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: {
                __bpb: true,
                dir: 'toPage',
                settings: { units: 'imperial', theme: 'light', chartDefaultSeries: 'both' }
            }
        })));
    };

    Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
    window.eval(analyzerSource);
    await waitFor(dom, () => polylineCalls.length === 2);

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

    const reloadedMap = makeMap();
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: { mapsPlaceholder: reloadedMap, L }
    });
    iframe.dispatchEvent(new window.Event('load'));
    await waitFor(dom, () => polylineCalls.length === 4);

    assert.equal(map.layers.length, 0, 'layers from the discarded map should be removed');
    assert.equal(reloadedMap.layers.length, 2, 'route casing should be recreated on the new map');

    dom.window.close();
});
