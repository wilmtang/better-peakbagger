// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('initial partial failure waits for usable tiles after the one-time load event', async () => {
    const { outputFiles } = await build({ entryPoints: ['src/maps/vector-map-frame.js'], bundle: true, write: false, format: 'iife', plugins: [{
        name: 'frame-boundaries', setup(builder) {
            builder.onResolve({ filter: /^maplibre-gl$/ }, () => ({ path: 'renderer', namespace: 'fixture' }));
            builder.onResolve({ filter: /terrain-style\.js$/ }, () => ({ path: 'style', namespace: 'fixture' }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'renderer' ? `
                export const setWorkerUrl = () => {}, addProtocol = () => {};
                export class Map {
                    constructor() { window.renderer = this; this.events = {}; this.ready = false;
                        this.style = { tileManagers: { base: { getIds: () => ['failed', 'pending'], getRenderableIds: () => this.ready ? ['good'] : [] } } }; }
                    on(type, listener) { (this.events[type] ||= []).push(listener); }
                    once(type, listener) { this.on(type, listener); }
                    emit(type) { for (const listener of this.events[type] || []) listener(); }
                    resize() {} jumpTo() {} remove() {} areTilesLoaded() { return this.ready; }
                    getCanvas() { return document.getElementById('map'); }
                }` : 'export const terrainStyle = { createVectorStyleLoader: () => ({ load: async () => ({}) }) };' }));
        },
    }] });
    const dom = new JSDOM('<div id="map"></div>', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', runScripts: 'outside-only' });
    const win = dom.window, messages = [];
    win.postMessage = data => messages.push(data);
    win.chrome = { runtime: { sendMessage: async () => ({ ok: true }), getURL: value => `chrome-extension://fixture/${value}` } };
    try {
        vm.runInContext(outputFiles[0].text, dom.getInternalVMContext());
        win.dispatchEvent(new win.MessageEvent('message', { source: win, origin: win.location.origin, data: {
            __bpbVectorMap: true, dir: 'toFrame', type: 'init', activation: 'opaque', basemap: 'vector', view: { center: [0, 0], zoom: 3 },
        } }));
        await new Promise(resolve => setImmediate(resolve)); assert.ok(win.renderer);
        // MapLibre's source-error flag can satisfy Map.loaded() while other
        // tiles are still pending; areTilesLoaded() correctly remains false.
        win.renderer.emit('load'); assert.equal(messages.some(message => message.type === 'loaded'), false);
        win.renderer.ready = true; win.renderer.emit('idle');
        assert.equal(messages.some(message => message.type === 'loaded'), true, 'Settled usable data must finish initial loading without waiting for a second load event');
    } finally { win.dispatchEvent(new win.Event('pagehide')); win.close(); }
});
