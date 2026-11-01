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
                export const setWorkerUrl = () => {}, addProtocol = (_name, handler) => { window.protocol = handler; };
                export class Map {
                    constructor() { window.renderer = this; this.events = {}; this.ready = false;
                        this.style = { tileManagers: { base: { getSource: () => ({ type: 'vector' }), getTileByID: () => ({ tileID: { canonical: { z: 0, x: 0, y: 0 } } }), getIds: () => ['failed', 'pending'], getRenderableIds: () => this.usable || this.ready ? ['good'] : [] } } }; }
                    on(type, listener) { (this.events[type] ||= []).push(listener); }
                    once(type, listener) { this.on(type, listener); }
                    emit(type) { for (const listener of this.events[type] || []) listener(); }
                    redraw() { this.emit('render'); }
                    resize() { this.resizes = (this.resizes || 0) + 1; } jumpTo() { this.jumps = (this.jumps || 0) + 1; } setStyle(style) { this.lastStyle = style; } remove() {} areTilesLoaded() { return this.ready; }
                    getCanvas() { return document.getElementById('map'); }
                }` : 'export const terrainStyle = { renderingStyle: style => style, createVectorStyleLoader: () => ({ load: async () => ({}) }) };' }));
        },
    }] });
    const dom = new JSDOM('<div id="map"></div>', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', runScripts: 'outside-only' });
    const win = dom.window, messages = [];
    const snapshots = [];
    const deadlines = [], setTimeout = win.setTimeout.bind(win);
    win.setTimeout = (callback, ms, ...args) => { if (ms === 15000) deadlines.push(callback); return setTimeout(callback, ms, ...args); };
    win.structuredClone = structuredClone;
    win.createImageBitmap = () => new Promise(resolve => snapshots.push(resolve));
    Object.defineProperties(win.document.getElementById('map'), { clientWidth: { value: 640 }, clientHeight: { value: 480 } });
    let fetches = 0, pendingSignal;
    win.fetch = (_url, { signal }) => { fetches++; pendingSignal = signal; return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }); };
    win.postMessage = data => messages.push(data);
    win.chrome = { runtime: { sendMessage: async () => ({ ok: true }), getURL: value => `chrome-extension://fixture/${value}` } };
    try {
        vm.runInContext(outputFiles[0].text, dom.getInternalVMContext());
        win.dispatchEvent(new win.MessageEvent('message', { source: win, origin: win.location.origin, data: {
            __bpbVectorMap: true, dir: 'toFrame', type: 'init', activation: 'opaque', generation: 1, basemap: 'vector', view: { center: [0, 0], zoom: 3 },
        } }));
        await new Promise(resolve => setImmediate(resolve)); assert.ok(win.renderer);
        // MapLibre's source-error flag can satisfy Map.loaded() while other
        // tiles are still pending; areTilesLoaded() correctly remains false.
        win.renderer.emit('load'); assert.equal(messages.some(message => message.type === 'loaded'), false);
        win.renderer.usable = true; win.renderer.emit('render');
        assert.equal(messages.some(message => message.type === 'loaded'), false, 'Loading must include image capture, rather than only renderer readiness');
        win.renderer.emit('render'); assert.equal(snapshots.length, 1, 'Bitmap creation is bounded to one in-flight capture');
        snapshots.shift()({ width: 640, height: 480, close() {} }); await new Promise(resolve => setImmediate(resolve));
        const painted = messages.find(message => message.type === 'painted');
        assert.equal(messages.some(message => message.type === 'loaded'), true, 'Usable imagery appears while secondary tiles are still pending');
        assert.deepEqual(JSON.parse(JSON.stringify(painted.view)), { center: [0, 0], zoom: 3 });
        assert.equal(painted.width, 640); assert.equal(painted.height, 480); assert.equal(painted.generation, 1);
        win.renderer.ready = true; win.renderer.emit('idle');
        assert.equal(messages.some(message => message.type === 'loaded'), true, 'Settled usable data must finish initial loading without waiting for a second load event');
        const before = { resizes: win.renderer.resizes, jumps: win.renderer.jumps };
        win.dispatchEvent(new win.MessageEvent('message', { source: win, origin: win.location.origin, data: {
            __bpbVectorMap: true, dir: 'toFrame', type: 'view', view: { center: [0, 0], zoom: 3 },
        } }));
        assert.deepEqual({ resizes: win.renderer.resizes, jumps: win.renderer.jumps }, before, 'Identical view messages do not resize or reapply the camera');
        const send = data => win.dispatchEvent(new win.MessageEvent('message', { source: win, origin: win.location.origin,
            data: { __bpbVectorMap: true, dir: 'toFrame', ...data } }));
        const ticks = [];
        const cancelled = win.requestAnimationFrame(() => ticks.push('cancelled'));
        win.cancelAnimationFrame(cancelled);
        win.requestAnimationFrame(timestamp => { ticks.push(timestamp); win.requestAnimationFrame(() => ticks.push('next')); });
        send({ type: 'render', generation: 0 }); assert.equal(ticks.length, 0, 'An old activation cannot drive the renderer clock');
        send({ type: 'render', generation: 1 }); assert.equal(ticks.length, 1); assert.equal(typeof ticks[0], 'number');
        send({ type: 'render', generation: 1 }); assert.deepEqual(ticks.slice(1), ['next'], 'Reentrant callbacks wait for the next visible frame');
        win.renderer.emit('render');
        const count = messages.filter(message => message.type === 'painted').length;
        send({ type: 'view', view: { center: [2, 2], zoom: 4 } });
        let obsoleteClosed = false;
        snapshots.shift()({ width: 640, height: 480, close() { obsoleteClosed = true; } }); await new Promise(resolve => setImmediate(resolve));
        assert.equal(obsoleteClosed, false, 'An older coupled image remains useful while the next camera loads');
        assert.equal(messages.filter(message => message.type === 'painted').length, count + 1);
        assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).view)), { center: [0, 0], zoom: 3 }, 'The image keeps its actual painted camera');
        const request = win.protocol({ url: 'bpb-vector://https://tiles.openfreemap.org/tile.pbf', type: 'arrayBuffer' }, new win.AbortController());
        const rejected = assert.rejects(request, error => error.name === 'AbortError');
        send({ type: 'release' }); await rejected;
        assert.equal(pendingSignal.aborted, true, 'Parking aborts the actual provider socket');
        assert.equal(Object.keys(win.renderer.lastStyle.sources).length, 0, 'A parked renderer owns no provider sources');
        await assert.rejects(win.protocol({ url: 'bpb-vector://https://tiles.openfreemap.org/tile.pbf' }, new win.AbortController()), /inactive/);
        assert.equal(fetches, 1, 'A renderer cannot start requests while parked');
        const original = win.renderer;
        send({ type: 'resume', activation: 'fresh', generation: 2, view: { center: [1, 1], zoom: 4 } });
        await new Promise(resolve => setImmediate(resolve)); win.renderer.emit('render');
        snapshots.shift()({ width: 640, height: 480, close() {} }); await new Promise(resolve => setImmediate(resolve));
        assert.equal(win.renderer, original); assert.equal(messages.at(-1).generation, 2, 'Warm output belongs to its new activation');
        win.renderer.emit('render'); let closed = false; send({ type: 'release' });
        snapshots.shift()({ width: 640, height: 480, close() { closed = true; } }); await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, true, 'A snapshot completing after suspension releases its GPU bitmap');
        send({ type: 'resume', activation: 'fresh-again', generation: 3, view: { center: [1, 1], zoom: 4 } });
        await new Promise(resolve => setImmediate(resolve)); win.renderer.emit('render');
        deadlines.at(-1)();
        assert.equal(messages.at(-1).type, 'error', 'A hung GPU capture has a deadline, including after the initial load');
        let expiredClosed = false;
        snapshots.shift()({ width: 640, height: 480, close() { expiredClosed = true; } }); await new Promise(resolve => setImmediate(resolve));
        assert.equal(expiredClosed, true, 'An image arriving after the deadline is closed');
    } finally { win.dispatchEvent(new win.Event('pagehide')); win.close(); }
});
