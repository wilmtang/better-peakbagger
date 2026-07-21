// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The bridge imports settings, so tests provide the real chrome.storage shape
// that module reads from, plus the getURL the bridge needs. Push updates with
// chrome.storage.sync.set(...).
const chromeWith = settings => {
    const chrome = makeChromeStub({ bpbSettings: settings });
    chrome.runtime.getURL = path => `chrome-extension://test-id/${path}`;
    return chrome;
};
// The isolated in-page 3D bridge bundle, and the extension-owned terrain frame
// bundle (settings-schema + terrain-cache + terrain-frame). MapLibre is stubbed
// per test; the bundled terrain cache binds the supplied fetch stub.
const bridgeBundle = await readFile(path.join(root, 'dist', 'content', 'terrain-map.js'), 'utf8');
const frameBundle = await readFile(path.join(root, 'dist', 'terrain', 'terrain-frame.js'), 'utf8');

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
    window.chrome = chromeWith({ enable3dMap: true });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => window.setTimeout(resolve, 0)); // settings.get() resolves

    const dispatchPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));
    dispatchPage({
        type: 'init',
        routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
        routeLinks: [{ id: 3230293, label: '2026-06-12 - Fei (Kautz Glacier) TR-98' }],
        camera: { center: [48.72, -121.79], zoom: 12.5 },
        focus: [48.83115, -121.60214],
        focusZoom: 13,
        focusPeak: { id: 2829, name: 'Mount Shuksan', lat: 48.83115, lon: -121.60214, state: 'unclimbed' },
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
    assert.deepEqual(init.routeLinks, [{ id: 3230293, label: '2026-06-12 - Fei (Kautz Glacier) TR-98' }]);
    assert.deepEqual(JSON.parse(JSON.stringify(init.camera)), { center: [48.72, -121.79], zoom: 12.5 });
    assert.deepEqual(init.focus, [48.83115, -121.60214]);
    assert.equal(init.focusZoom, 13);
    assert.deepEqual(init.focusPeak,
        { id: 2829, name: 'Mount Shuksan', lat: 48.83115, lon: -121.60214, state: 'unclimbed' });
    assert.equal(init.routeStyle.color, '#347a3f');
    assert.equal(init.theme, 'dark');
    assert.equal(init.cacheLimitMb, 512);
    assert.equal(init.basemap.name, 'Open Topo Map');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true,
            dir: 'toParent',
            type: 'loaded',
            camera: { center: [48.73, -121.78], zoom: 13.25 }
        }
    }));
    assert.equal(frame.style.opacity, '1');
    assert.equal(frame.style.pointerEvents, 'auto');
    assert.equal(pageMessages.at(-1).type, 'loaded');
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1).camera)), { center: [48.73, -121.78], zoom: 13.25 });

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true,
            dir: 'toParent',
            type: 'camera',
            camera: { center: [48.74, -121.77], zoom: 14 }
        }
    }));
    assert.equal(pageMessages.at(-1).type, 'camera');
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1).camera)), { center: [48.74, -121.77], zoom: 14 });

    dispatchPage({ type: 'cameraRequest', requestId: 7 });
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1))), {
        __bpbTerrainFrame: true,
        dir: 'toFrame',
        type: 'cameraRequest',
        requestId: 7
    });
    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true,
            dir: 'toParent',
            type: 'camera',
            requestId: 7,
            camera: { center: [48.75, -121.76], zoom: 14.25 }
        }
    }));
    assert.equal(pageMessages.at(-1).requestId, 7,
        'the bridge preserves the request identity so an older camera event cannot win the switch race');

    dispatchPage({ type: 'highlight', coordinates: [-121.81, 48.71], series: 'time' });
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1))), {
        __bpbTerrainFrame: true,
        dir: 'toFrame',
        type: 'highlight',
        coordinates: [-121.81, 48.71],
        series: 'time'
    }, 'the isolated-world bridge preserves the series discriminator');

    // Compass: the frame streams its bearing/pitch to the page…
    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: { __bpbTerrainFrame: true, dir: 'toParent', type: 'view', bearing: 12.5, pitch: 47 }
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1))), {
        __bpbTerrain: true, dir: 'toPage', type: 'view', bearing: 12.5, pitch: 47
    }, 'the bridge relays the view stream to the page compass');

    // …and the page's reset command travels back to the frame.
    dispatchPage({ type: 'resetNorth' });
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1))), {
        __bpbTerrainFrame: true, dir: 'toFrame', type: 'resetNorth'
    }, 'the bridge relays the compass reset to the frame');

    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: false } });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null);
    assert.equal(pageMessages.at(-1).type, 'error');
    assert.equal(pageMessages.at(-1).reason, 'unavailable');

    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null);
    assert.equal(pageMessages.at(-1).type, 'destroyed');
    dom.window.close();
});

// Boot the bridge and drive one frame to 'loaded'. The bridge's only 5-minute
// setTimeout is the keep-alive TTL, so intercept it (by its delay) into `timers`
// for deterministic firing; every other timeout runs for real.
const bootLoadedFrame = async (initOverrides = {}) => {
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
    const timers = [];
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay) => {
        if (delay === 5 * 60 * 1000) { timers.push(fn); return timers.length; }
        return realSetTimeout(fn, delay);
    };
    window.chrome = chromeWith({ enable3dMap: true });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => realSetTimeout(resolve, 0));

    const dispatchPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));
    const initData = {
        type: 'init',
        routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
        camera: { center: [48.72, -121.79], zoom: 12.5 },
        routeStyle: { color: '#d9483b' },
        theme: 'light',
        cacheLimitMb: 512,
        ...initOverrides
    };
    dispatchPage(initData);
    await new Promise(resolve => realSetTimeout(resolve, 0));
    const frame = window.document.getElementById('bpb-terrain-frame');
    frame.contentWindow.postMessage = message => { frameMessages.push(message); };

    const dispatchFrame = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow, origin: 'chrome-extension://test-id',
        data: { __bpbTerrainFrame: true, dir: 'toParent', ...data }
    }));
    dispatchFrame({ type: 'ready' });
    dispatchFrame({ type: 'loaded', navTop: 96, camera: { center: [48.72, -121.79], zoom: 12.5 } });

    return { dom, window, frame, initData, dispatchPage, dispatchFrame, pageMessages, frameMessages, timers, realSetTimeout };
};

test('a loaded 3D frame suspends on destroy and resumes on re-entry without a new iframe', async () => {
    const ctx = await bootLoadedFrame();
    const { window, frame, initData, dispatchPage, dispatchFrame, pageMessages, frameMessages } = ctx;
    assert.equal(frame.style.opacity, '1', 'the loaded frame is visible');

    // destroy → suspend: the iframe stays, parked at opacity 0.
    frameMessages.length = 0;
    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame'), frame, 'the frame stays in the DOM');
    assert.equal(frame.style.opacity, '0');
    assert.equal(frame.style.pointerEvents, 'none');
    assert.equal(frameMessages.at(-1).type, 'suspend', 'the frame is told to suspend');
    assert.equal(pageMessages.at(-1).type, 'destroyed', 'the page still gets its destroyed ack');
    assert.equal(ctx.timers.length, 1, 'a keep-alive TTL is armed');

    // re-entry → resume: no new iframe, a resume posted carrying the fresh payload.
    frameMessages.length = 0;
    dispatchPage(initData);
    await new Promise(resolve => ctx.realSetTimeout(resolve, 0));
    assert.equal(window.document.querySelectorAll('#bpb-terrain-frame').length, 1, 'no second iframe is built');
    assert.equal(window.document.getElementById('bpb-terrain-frame'), frame, 'the same iframe is reused');
    const resume = frameMessages.find(message => message.type === 'resume');
    assert.ok(resume, 'a resume is posted instead of a fresh boot');
    assert.equal(frameMessages.some(message => message.type === 'init'), false, 'no init handshake on resume');
    assert.deepEqual(JSON.parse(JSON.stringify(resume.camera)), { center: [48.72, -121.79], zoom: 12.5 });

    // The frame's normal 'loaded' reply restores the frame to visible.
    dispatchFrame({ type: 'loaded', navTop: 96, camera: { center: [48.72, -121.79], zoom: 12.5 } });
    assert.equal(frame.style.opacity, '1');
    ctx.dom.window.close();
});

test('the keep-alive TTL hard-destroys the parked frame when it expires', async () => {
    const ctx = await bootLoadedFrame();
    const { window, frame, dispatchPage, frameMessages, timers } = ctx;
    dispatchPage({ type: 'destroy' });
    assert.equal(frame.style.opacity, '0');
    assert.equal(timers.length, 1);

    frameMessages.length = 0;
    timers[0](); // fire the 5-minute TTL
    assert.equal(frameMessages.at(-1).type, 'destroy', 'the frame is fully destroyed at expiry');
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null, 'the iframe is removed');
    ctx.dom.window.close();
});

test('a destroy that races the boot hard-destroys instead of suspending', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport"><iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe></div>
    </body>`, { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', runScripts: 'outside-only' });
    const { window } = dom;
    const pageMessages = [];
    window.chrome = chromeWith({ enable3dMap: true });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    const dispatchPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));
    dispatchPage({ type: 'init', routeSegments: [[[48.7, -121.8], [48.71, -121.81]]], theme: 'light', cacheLimitMb: 512 });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.ok(window.document.getElementById('bpb-terrain-frame'), 'the iframe was created');

    // No 'loaded' yet → destroy tears it down (nothing worth suspending).
    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null, 'the un-loaded frame is removed');
    assert.equal(pageMessages.at(-1).type, 'destroyed');
    dom.window.close();
});

test('disabling 3D tears down even a suspended frame immediately', async () => {
    const ctx = await bootLoadedFrame();
    const { window, frame, dispatchPage, timers } = ctx;
    dispatchPage({ type: 'destroy' });
    assert.equal(frame.style.opacity, '0', 'the frame is suspended');
    assert.equal(timers.length, 1);

    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: false } });
    await new Promise(resolve => ctx.realSetTimeout(resolve, 0));
    assert.equal(window.document.getElementById('bpb-terrain-frame'), null, 'the suspended frame is removed at once');
    ctx.dom.window.close();
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
    window.chrome = chromeWith({ enable3dMap: false });
    window.postMessage = message => { messages.push(message); };
    window.eval(bridgeBundle);

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

test('3D terrain consent is extension-owned, discloses the actual providers, and rejects scripted acceptance', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="bpb-terrain-toggle">3D</button><div id="bpb-map-viewport"></div></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages = [];
    window.chrome = chromeWith({ enable3dMap: false, theme: 'light' });
    window.postMessage = message => { messages.push(message); };
    window.eval(bridgeBundle);

    const requestConsent = () => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', type: 'requestConsent' }
    }));
    requestConsent();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    let dialog = window.document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'the isolated-world bridge should own the confirmation UI');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.match(dialog.textContent, /Mapterhorn/);
    assert.match(dialog.textContent, /OpenFreeMap/);
    assert.match(dialog.textContent, /OSM vector tiles, when selected/);
    assert.match(dialog.textContent, /selected 2D map layer.*provider named/i);
    assert.match(dialog.textContent, /enable them later in Better Peakbagger Settings/i);
    assert.deepEqual(Array.from(dialog.querySelectorAll('a'), link => [link.textContent, new URL(link.href).hostname]), [
        ['Privacy notice', 'mapterhorn.com'],
        ['Privacy notice', 'openfreemap.org']
    ]);
    const featureEnabled = async () =>
        (await window.chrome.storage.sync.get('bpbSettings')).bpbSettings.enable3dMap;
    assert.equal(await featureEnabled(), false, 'opening the confirmation must not change the setting');

    dialog.querySelector('.bpb-terrain-consent-secondary').click();
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.equal(messages.at(-1).type, 'consentResult');
    assert.equal(messages.at(-1).enabled, false);
    assert.equal(await featureEnabled(), false, 'declining must keep the feature off');

    requestConsent();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dialog = window.document.querySelector('[role="dialog"]');
    dialog.querySelector('.bpb-terrain-consent-primary').click();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(await featureEnabled(), false,
        'host-page script must not enable an extension feature through DOM click()');
    assert.ok(window.document.querySelector('[role="dialog"]'), 'scripted acceptance must leave the confirmation open');
    dialog.querySelector('.bpb-terrain-consent-secondary').click();
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
    window.chrome = chromeWith({ enable3dMap: false });
    // Defer the initial storage read so a subscribe push can land before it.
    let resolveInitialGet;
    window.chrome.storage.sync.get = () => new Promise(resolve => {
        resolveInitialGet = () => resolve({ bpbSettings: { enable3dMap: false } });
    });
    window.postMessage = () => {};
    window.eval(bridgeBundle);

    // A newer enabling push arrives before the initial read resolves.
    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: true } });
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
    resolveInitialGet(); // the stale initial read resolves (disabled), after the push
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
    const popups = [];
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
            this.renderCalls = [];
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
        getCenter() {
            const center = this.cameraCenter || this.options.center || [
                (this.options.bounds[0][0] + this.options.bounds[1][0]) / 2,
                (this.options.bounds[0][1] + this.options.bounds[1][1]) / 2
            ];
            return { lng: center[0], lat: center[1] };
        }
        getZoom() { return this.cameraZoom ?? this.options.zoom ?? 12; }
        queryRenderedFeatures() { return this.routeHit ? [this.routeHit] : []; }
        resize() { this.renderCalls.push('resize'); }
        redraw() { this.renderCalls.push('redraw'); }
        remove() { this.removed = true; }
    }

    class PopupStub {
        constructor(options) { this.options = options; popups.push(this); }
        setLngLat(lngLat) { this.lngLat = lngLat; return this; }
        setDOMContent(node) { this.node = node; return this; }
        addTo(target) { this.target = target; return this; }
        remove() { this.removedPopup = true; }
    }

    const resizeObservers = [];
    window.ResizeObserver = class {
        constructor(callback) {
            this.callback = callback;
            this.observed = [];
            resizeObservers.push(this);
        }
        observe(element) { this.observed.push(element); }
        disconnect() { this.disconnected = true; }
    };

    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.maplibregl = {
        Map: MapStub,
        Popup: PopupStub,
        NavigationControl: class NavigationControl {},
        ScaleControl: class ScaleControl {},
        AttributionControl: class AttributionControl {},
        setWorkerUrl(url) { workerUrl = url; },
        addProtocol(name, handler) { protocolHandlers.set(name, handler); },
        removeProtocol(name) { protocolHandlers.delete(name); }
    };
    window.postMessage = message => { messages.push(message); };
    // terrain-frame imports the real terrain-cache; its create() binds fetch
    // (never invoked here, as no tiles load in jsdom), so provide a stub.
    window.fetch = () => Promise.resolve();
    window.eval(frameBundle);

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

    dispatch({ type: 'init', focus: [99, -121.8] });
    assert.equal(maps.length, 0, 'an invalid summit focus must fail before public DEM tiles can load');
    assert.equal(messages.at(-1).type, 'error');

    const routeSegments = [
        [[48.7, -121.8], [48.71, -121.81]],
        [[48.75, -121.82], [48.76, -121.815]]
    ];
    dispatch({
        type: 'init',
        routeSegments,
        routeLinks: [
            { id: 3230293, label: '2026-06-12 - Fei (Kautz Glacier) TR-98' },
            { id: 7, label: 'bad\u0000label' }
        ],
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
    assert.deepEqual(Object.keys(map.options.style.sources), ['terrain'],
        'the constructor style stays terrain-only so a pending drape cannot gate MapLibre load');
    assert.equal(map.options.style.layers.some(layer => layer.id === 'basemap'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(map.getSource('basemap').tiles)), ['https://a.tile.example.com/{z}/{x}/{y}.png']);
    assert.equal(map.getSource('basemap').tileSize, 256);
    assert.match(map.getSource('basemap').attribution, /https:\/\/example\.com\/copyright/);
    assert.doesNotMatch(map.getSource('basemap').attribution, /script|alert/i);
    assert.equal(map.layers.find(layer => layer.id === 'basemap').paint['raster-opacity'], 0.78);
    assert.equal(map.options.style.layers.find(layer => layer.id === 'terrain-hillshade').paint['hillshade-illumination-anchor'], 'map',
        'hillshade is anchored to the map, so rotating/tilting the camera does not swing the light and flip the shading');
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
    assert.doesNotMatch(hint.textContent, /⌘|Ctrl/,
        'plain scroll zooms — the hint must not demand a modifier key');
    assert.ok(!map.options.cooperativeGestures,
        'cooperative gestures would require a modifier to scroll-zoom, unlike the 2D map');
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-route').data)), {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { ascentId: 3230293, label: '2026-06-12 - Fei (Kautz Glacier) TR-98' },
                geometry: { type: 'LineString', coordinates: [[-121.8, 48.7], [-121.81, 48.71]] }
            },
            { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-121.82, 48.75], [-121.815, 48.76]] } }
        ]
    });
    map.routeHit = map.sources.get('bpb-route').data.features[0];
    map.handlers.get('click')({ point: { x: 200, y: 150 }, lngLat: { lng: -121.805, lat: 48.705 } });
    assert.equal(popups.length, 1, 'clicking a route with validated metadata opens its ascent popup');
    const routeLink = popups[0].node.querySelector('a');
    assert.equal(routeLink.href, 'https://www.peakbagger.com/climber/ascent.aspx?aid=3230293');
    assert.equal(routeLink.textContent, '2026-06-12 - Fei (Kautz Glacier) TR-98');
    assert.equal(routeLink.target, '_blank');
    assert.equal(routeLink.rel, 'noopener noreferrer');
    // The camera is framed on the route at construction, not re-fitted after
    // 'load' — fitting later would load a throwaway tileset for the placeholder
    // view and rebuild the terrain mesh, the dominant chunk of load time.
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.bounds)), [[-121.82, 48.7], [-121.8, 48.76]]);
    assert.equal(map.options.fitBoundsOptions.maxZoom, 15.5);
    assert.equal(map.options.fitBoundsOptions.pitch, 60);
    assert.equal(map.fitted, undefined, 'no redundant post-load fitBounds');
    assert.equal(window.document.getElementById('bpb-terrain-map').style.pointerEvents, 'auto');
    assert.equal(messages.at(-1).type, 'loaded');
    assert.equal(map.handlers.has('data'), true,
        'the frame reports loaded without waiting for a drape tile data event');

    // macOS Firefox rewrites Ctrl + primary-button mousedown to button=2 but
    // leaves buttons=1. MapLibre cannot continue that internally inconsistent
    // gesture when the following moves arrive as primary-button events.
    const canvas = window.document.getElementById('bpb-terrain-canvas');
    const gestureTarget = window.document.createElement('span');
    canvas.append(gestureTarget);
    const starts = [];
    canvas.addEventListener('mousedown', event => starts.push({
        button: event.button,
        buttons: event.buttons,
        ctrlKey: event.ctrlKey
    }));
    gestureTarget.dispatchEvent(new window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        button: 2,
        buttons: 1
    }));
    assert.deepEqual(starts, [{ button: 0, buttons: 1, ctrlKey: true }],
        'the Firefox-shaped Ctrl + primary start reaches MapLibre as a primary-button start');
    gestureTarget.dispatchEvent(new window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        button: 2,
        buttons: 2
    }));
    assert.deepEqual(starts.at(-1), { button: 2, buttons: 2, ctrlKey: true },
        'a real Ctrl + secondary-button start must not be rewritten');

    // Dragging the host page's resize handle reshapes the frame many times per
    // second. Each map.resize() re-allocates the canvas backing store, which
    // the browser clears, and MapLibre's own repaint waits for the next
    // animation frame — one blank composited frame per drag step, a visible 3D
    // flicker. The observer callback must redraw synchronously, before paint.
    const frameObserver = resizeObservers[0];
    assert.ok(frameObserver, 'the frame watches its own element for size changes');
    assert.ok(frameObserver.observed.includes(window.document.getElementById('bpb-terrain-map')));
    frameObserver.callback();
    assert.deepEqual(map.renderCalls, ['resize', 'redraw'],
        'a resize repaints in the same task so the cleared canvas is never composited');

    dispatch({ type: 'highlight', coordinates: [-121.81, 48.71], series: 'time' });
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-highlight').data.geometry)), {
        type: 'Point', coordinates: [-121.81, 48.71]
    });
    assert.ok(map.paint.some(call => call[0] === 'bpb-highlight'
        && call[1] === 'circle-color' && call[2] === '#0055ff'),
        'the time-series chaser is blue in 3D');

    dispatch({ type: 'highlight', coordinates: [-121.81, 48.71], series: 'unsupported' });
    assert.deepEqual(map.paint.at(-1), ['bpb-highlight', 'circle-color', '#ff3b30'],
        'the terrain frame does not treat an unknown series as a color');

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

    // Group maps hand the frame a native color per track; each stays distinct
    // instead of collapsing to the single preferred route color.
    dispatch({ type: 'destroy' });
    dispatch({
        type: 'init',
        routeSegments,
        routeColors: ['#e34a33', '#3182bd'],
        camera: { center: [47.61, -122.33], zoom: 12.25 },
        routeStyle: { color: '#2457a7', width: 7, casingColor: '#ffffff', casingWidth: 12 }
    });
    await new Promise(resolve => window.queueMicrotask(resolve));
    const grouped = maps.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(grouped.options.center)), [-122.33, 47.61],
        'a validated 2D camera overrides the route-wide initial framing');
    assert.equal(grouped.options.zoom, 12.25);
    assert.equal(grouped.options.bounds, undefined);
    assert.deepEqual(
        JSON.parse(JSON.stringify(grouped.sources.get('bpb-route').data.features.map(feature => feature.properties.color))),
        ['#e34a33', '#3182bd'],
        'each group-map track keeps its own native color');
    assert.deepEqual(
        JSON.parse(JSON.stringify(grouped.layers.find(layer => layer.id === 'bpb-route').paint['line-color'])),
        ['coalesce', ['get', 'color'], '#2457a7'],
        'the route line is painted from each track color, not one flat color');
    grouped.cameraCenter = [-122.29, 47.64];
    grouped.cameraZoom = 13.5;
    grouped.handlers.get('moveend')();
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
        __bpbTerrainFrame: true,
        dir: 'toParent',
        type: 'camera',
        camera: { center: [47.64, -122.29], zoom: 13.5 }
    }, 'the terrain frame reports each settled camera for the return to 2D');
    dispatch({ type: 'cameraRequest', requestId: 11 });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
        __bpbTerrainFrame: true,
        dir: 'toParent',
        type: 'camera',
        requestId: 11,
        camera: { center: [47.64, -122.29], zoom: 13.5 }
    }, 'an explicit switch request reads the live camera instead of relying on event timing');

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
    const blocked = maps.at(-1);
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

    // Peak pages have no GPX route. They initialize the same renderer around
    // one summit, with an explicit subject marker that must survive a nearby-
    // peak feed reporting itself unavailable (t=P feeds may exclude it).
    dispatch({ type: 'destroy' });
    dispatch({
        type: 'init',
        focus: [48.83115, -121.60214],
        focusZoom: 13,
        focusPeak: {
            id: 2829,
            name: 'Mount Shuksan',
            lat: 48.83115,
            lon: -121.60214,
            state: 'unclimbed'
        }
    });
    await new Promise(resolve => window.queueMicrotask(resolve));
    const focused = maps.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(focused.options.center)), [-121.60214, 48.83115]);
    assert.equal(focused.options.zoom, 13);
    assert.equal(focused.options.bounds, undefined, 'a summit view does not synthesize route bounds');
    assert.deepEqual(JSON.parse(JSON.stringify(focused.getSource('bpb-route').data)), {
        type: 'FeatureCollection', features: []
    }, 'a summit view carries an honest empty route source');
    const focusedPeaks = () => JSON.parse(JSON.stringify(focused.getSource('bpb-peaks').data.features));
    assert.deepEqual(focusedPeaks(), [{
        type: 'Feature',
        properties: { id: 2829, name: 'Mount Shuksan', state: 'unclimbed' },
        geometry: { type: 'Point', coordinates: [-121.60214, 48.83115] }
    }]);
    dispatch({ type: 'peaks', unavailable: true });
    assert.equal(focusedPeaks().length, 1, 'the subject peak remains when the nearby feed is unavailable');

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
        once(type, callback) { if (type === 'load') this.loadCallback = callback; }
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
    window.maplibregl = {
        Map: MapStub,
        NavigationControl: class {},
        ScaleControl: class {},
        AttributionControl: class {},
        setWorkerUrl() {},
        addProtocol() {},
        removeProtocol() {}
    };
    window.postMessage = () => {};
    // terrain-frame imports the real terrain-cache; its create() binds fetch
    // (never invoked here, as no tiles load in jsdom), so provide a stub.
    window.fetch = () => Promise.resolve();
    window.eval(frameBundle);

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
    const picker = () => window.document.querySelector('.bpb-terrain-picker');
    const map = maps[0];
    assert.deepEqual(Array.from(picker().options, option => option.textContent),
        ['CalTopo', 'MyTopo', 'OpenTopo', 'OSM Vector (experimental)', 'Terrain only'],
        'the picker offers every layer plus the vector entry and terrain-only');
    assert.equal(picker().options[picker().selectedIndex].textContent, 'MyTopo',
        'the initially-selected native layer is preselected');

    const swap = value => {
        picker().value = value;
        picker().dispatchEvent(new window.Event('change'));
    };

    assert.deepEqual(Object.keys(map.options.style.sources), ['terrain'],
        'even a configured drape is absent from the constructor style');
    swap('0');
    assert.equal(map.getSource('basemap'), undefined,
        'a picker change made during boot is queued instead of mutating an unloaded style');
    map.loadCallback();
    await new Promise(resolve => window.queueMicrotask(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(map.getSource('basemap').tiles)),
        ['https://ct.example.com/{z}/{x}/{y}.png'], 'the queued pre-load selection applies as soon as terrain is ready');
    assert.equal(picker().options[picker().selectedIndex].textContent, 'CalTopo');

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

test('the extension-provided vector entry grafts the provider style under the extension layers', async () => {
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
            this.sources = new Map(Object.entries(options.style.sources).map(([id, source]) => [id, { ...source }]));
            this.layers = options.style.layers.map(layer => ({ ...layer }));
            this.handlers = new Map();
            this.glyphs = null;
            this.sprite = null;
            maps.push(this);
        }
        addControl() {}
        once(type, callback) { if (type === 'load') window.queueMicrotask(callback); }
        on(type, callback) { this.handlers.set(type, callback); }
        addSource(id, source) { this.sources.set(id, { ...source, setData() {} }); }
        addLayer(layer, before) {
            const index = before ? this.layers.findIndex(existing => existing.id === before) : -1;
            if (index >= 0) this.layers.splice(index, 0, layer);
            else this.layers.push(layer);
        }
        getLayer(id) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id) { return this.sources.get(id); }
        removeSource(id) { this.sources.delete(id); }
        getStyle() {
            return {
                ...this.options.style,
                ...(this.glyphs ? { glyphs: this.glyphs } : {}),
                ...(this.sprite ? { sprite: this.sprite } : {})
            };
        }
        setGlyphs(url) { this.glyphs = url; }
        setSprite(url) { this.sprite = url; }
        setPaintProperty() {}
        fitBounds() {}
        resize() {}
        remove() {}
    }

    const providerStyle = {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
        sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
        layers: [
            { id: 'land', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover' },
            { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
            { id: 'place-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place' }
        ]
    };
    const fetches = [];
    let failFetch = true;
    window.fetch = url => {
        fetches.push(url);
        if (failFetch) return Promise.reject(new Error('offline'));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(providerStyle) });
    };
    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.maplibregl = {
        Map: MapStub,
        NavigationControl: class {},
        ScaleControl: class {},
        AttributionControl: class {},
        setWorkerUrl() {},
        addProtocol() {},
        removeProtocol() {}
    };
    window.postMessage = () => {};
    // This test sets its own recording fetch above; real terrain-cache binds it
    // at create (tile loads never fire here), so keep it — do not overwrite.
    window.eval(frameBundle);

    // No page-offered raster layers: the vector entry must exist regardless.
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrainFrame: true, dir: 'toFrame', type: 'init',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]]
        }
    }));
    await new Promise(resolve => window.queueMicrotask(resolve));

    const picker = () => window.document.querySelector('.bpb-terrain-picker');
    const map = maps[0];
    const frameGlyphs = 'chrome-extension://test-id/fonts/{fontstack}/{range}.pbf';
    const frameSprite = 'chrome-extension://test-id/sprites/terrain';
    map.glyphs = frameGlyphs;
    map.sprite = frameSprite;
    assert.deepEqual(Array.from(picker().options, option => option.textContent),
        ['OSM Vector (experimental)', 'Terrain only'],
        'the vector entry and terrain-only are offered even without page layers');
    assert.equal(picker().value, 'terrain', 'terrain-only stays the default — vector is opt-in');
    assert.equal(fetches.length, 0, 'no provider traffic before the user selects the vector entry');

    // A failed style fetch reverts to terrain-only with a visible reason and
    // is forgotten, so the next selection retries instead of staying broken.
    picker().value = 'vector';
    picker().dispatchEvent(new window.Event('change'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.deepEqual(fetches, ['https://tiles.openfreemap.org/styles/liberty'],
        'selecting the entry requests the provider style');
    assert.equal(picker().value, 'terrain', 'a failed style fetch reverts to terrain-only');
    assert.match(window.document.querySelector('.bpb-terrain-notice').textContent, /OSM Vector \(experimental\) is unavailable/);

    failFetch = false;
    picker().value = 'vector';
    picker().dispatchEvent(new window.Event('change'));
    await new Promise(resolve => window.setTimeout(resolve, 0));

    assert.equal(fetches.length, 2, 'a failed fetch is retried, not cached');
    assert.equal(map.glyphs, providerStyle.glyphs, 'the provider glyphs are installed');
    assert.equal(map.sprite, providerStyle.sprite, 'the provider sprite is installed');
    assert.ok(map.getSource('bpb-vector:openmaptiles'), 'provider sources are added under prefixed ids');
    const ids = map.layers.map(layer => layer.id);
    assert.ok(ids.indexOf('bpb-vector:land') < ids.indexOf('terrain-hillshade'),
        'ground geometry sits below the extension hillshade');
    assert.ok(ids.indexOf('bpb-vector:place-label') > ids.indexOf('bpb-route'),
        'labels sit above the route so text stays readable');
    assert.ok(ids.indexOf('bpb-vector:place-label') < ids.indexOf('bpb-highlight'),
        'labels stay below the hover highlight');
    assert.equal(map.layers.find(layer => layer.id === 'bpb-vector:land').source, 'bpb-vector:openmaptiles',
        'grafted layers point at the prefixed source');

    picker().value = 'terrain';
    picker().dispatchEvent(new window.Event('change'));
    assert.equal(map.getSource('bpb-vector:openmaptiles'), undefined, 'terrain-only removes the vector sources');
    assert.ok(!map.layers.some(layer => layer.id.startsWith('bpb-vector:')), 'terrain-only removes every vector layer');
    assert.equal(map.glyphs, frameGlyphs, 'terrain-only restores the frame glyph configuration');
    assert.equal(map.sprite, frameSprite, 'terrain-only restores the frame sprite configuration');

    // Re-selecting reuses the cached style without another fetch.
    picker().value = 'vector';
    picker().dispatchEvent(new window.Event('change'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(fetches.length, 2, 'a successful style fetch is cached for the frame lifetime');
    assert.ok(map.getSource('bpb-vector:openmaptiles'), 'the cached style is re-grafted');

    dom.window.close();
});

test('the bridge forwards peak-feed requests to the page and replies to the frame', async () => {
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
    window.chrome = chromeWith({ enable3dMap: true });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => window.setTimeout(resolve, 0)); // settings.get() resolves

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true, dir: 'toCS', type: 'init',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]]
        }
    }));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    const frame = window.document.getElementById('bpb-terrain-frame');
    frame.contentWindow.postMessage = message => { frameMessages.push(message); };

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true, dir: 'toParent', type: 'peaksRequest',
            requestId: 3, bounds: { miny: 48.6, maxy: 48.8, minx: -121.9, maxx: -121.7 }
        }
    }));
    const request = pageMessages.at(-1);
    assert.equal(request.type, 'peaksRequest');
    assert.equal(request.dir, 'toPage');
    assert.equal(request.requestId, 3);
    assert.deepEqual(request.bounds, { miny: 48.6, maxy: 48.8, minx: -121.9, maxx: -121.7 });

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true, dir: 'toCS', type: 'peaks',
            requestId: 3,
            peaks: [{ id: 58603, name: 'Iron Mountain', lat: 48.72, lon: -121.79, state: 'climbed' }]
        }
    }));
    const reply = frameMessages.at(-1);
    assert.equal(reply.type, 'peaks');
    assert.equal(reply.dir, 'toFrame');
    assert.equal(reply.requestId, 3);
    assert.deepEqual(reply.peaks, [{ id: 58603, name: 'Iron Mountain', lat: 48.72, lon: -121.79, state: 'climbed' }]);
    dom.window.close();
});

test('the bridge relays a bounded DEM prefetch to the background worker only while 3D is on', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="bpb-map-viewport"></div></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const sent = [];
    window.chrome = chromeWith({ enable3dMap: true });
    window.chrome.runtime.sendMessage = message => { sent.push(message); return Promise.resolve({ ok: true }); };
    window.postMessage = () => {};
    window.eval(bridgeBundle);
    await new Promise(resolve => window.setTimeout(resolve, 0)); // settings.get() resolves → terrainEnabled

    const dispatchPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));

    // A route prefetch forwards route bounds + viewport as a TERRAIN_PREFETCH.
    dispatchPage({
        type: 'prefetch',
        bounds: { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 },
        viewport: { width: 1280, height: 800 }
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'TERRAIN_PREFETCH');
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].bounds)), { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 });
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].viewport)), { width: 1280, height: 800 });
    assert.equal('center' in sent[0], false, 'a bounds prefetch does not also carry a centre');

    // A peak prefetch forwards center + zoom instead.
    dispatchPage({ type: 'prefetch', center: [48.83, -121.6], zoom: 13, viewport: { width: 1000, height: 425 } });
    assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(sent[1].center)), [48.83, -121.6]);
    assert.equal(sent[1].zoom, 13);

    // A prefetch that names neither a valid bounds nor a valid centre is dropped.
    dispatchPage({ type: 'prefetch', viewport: { width: 1000, height: 425 } });
    assert.equal(sent.length, 2, 'a prefetch with no view is not forwarded');

    // Turning the feature off closes the relay: no prefetch reaches the worker.
    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: false } });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dispatchPage({
        type: 'prefetch',
        bounds: { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 },
        viewport: { width: 1280, height: 800 }
    });
    assert.equal(sent.length, 2, 'the bridge does not relay a prefetch while 3D is disabled');
    dom.window.close();
});

test('3D peak markers request Peakbagger dots on camera settle and render only validated batches', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages = [];
    const maps = [];
    const popups = [];
    const camera = {
        zoom: 13,
        center: { lng: -121.805, lat: 48.73 },
        bounds: { south: 48.6, north: 48.86, west: -121.95, east: -121.66 }
    };
    // Screen positions the stubbed map.project reports per 'lon,lat' key, like
    // a pitched terrain camera would; unlisted peaks project far off-screen.
    const projections = new Map();

    class MapStub {
        constructor(options) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.paint = [];
            this.handlers = new Map();
            this.canvas = { clientWidth: 800, clientHeight: 600, style: {} };
            maps.push(this);
        }
        addControl() {}
        once(type, callback) { if (type === 'load') window.queueMicrotask(callback); }
        on(type, layerOrCallback, maybeCallback) {
            const key = typeof layerOrCallback === 'string' ? `${type}:${layerOrCallback}` : type;
            this.handlers.set(key, typeof layerOrCallback === 'function' ? layerOrCallback : maybeCallback);
        }
        addSource(id, source) {
            this.sources.set(id, { ...source, setData(data) { this.data = data; } });
        }
        addLayer(layer) { this.layers.push(layer); }
        getLayer(id) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id) { return this.sources.get(id); }
        removeSource(id) { this.sources.delete(id); }
        setPaintProperty(...args) { this.paint.push(args); }
        getZoom() { return camera.zoom; }
        getCenter() { return camera.center; }
        getBounds() {
            const box = camera.bounds;
            return {
                getSouth: () => box.south,
                getNorth: () => box.north,
                getWest: () => box.west,
                getEast: () => box.east
            };
        }
        getCanvas() { return this.canvas; }
        project([lng, lat]) {
            return projections.get(`${lng},${lat}`) || { x: -10000, y: -10000 };
        }
        resize() {}
        remove() { this.removed = true; }
    }
    class PopupStub {
        constructor(options) { this.options = options; popups.push(this); }
        setLngLat(lngLat) { this.lngLat = lngLat; return this; }
        setDOMContent(node) { this.node = node; return this; }
        addTo(target) { this.target = target; return this; }
        remove() { this.removedPopup = true; }
    }

    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.maplibregl = {
        Map: MapStub,
        Popup: PopupStub,
        NavigationControl: class {},
        ScaleControl: class {},
        AttributionControl: class {},
        setWorkerUrl() {},
        addProtocol() {},
        removeProtocol() {}
    };
    window.postMessage = message => { messages.push(message); };
    // terrain-frame imports the real terrain-cache; its create() binds fetch
    // (never invoked here, as no tiles load in jsdom), so provide a stub.
    window.fetch = () => Promise.resolve();
    window.eval(frameBundle);

    const dispatch = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrainFrame: true, dir: 'toFrame', ...data }
    }));
    const settle = () => new Promise(resolve => window.setTimeout(resolve, 320));

    dispatch({ type: 'init', routeSegments: [[[48.7, -121.8], [48.71, -121.81]]] });
    await new Promise(resolve => window.queueMicrotask(resolve));
    const map = maps[0];
    assert.ok(map.getLayer('bpb-peaks-ring'), 'the peak ring layer exists');
    assert.ok(map.getSource('bpb-peaks'), 'the peak source exists');
    const ringPaint = map.getLayer('bpb-peaks-ring').paint;
    assert.deepEqual(JSON.parse(JSON.stringify(ringPaint['circle-stroke-color'])),
        ['match', ['get', 'state'], 'climbed', '#00ff00', 'unclimbed', '#ff6699', 'unknown', '#ffcc33', '#ffcc33'],
        'ring colors are data-driven from the marker spec');
    assert.equal(ringPaint['circle-pitch-scale'], 'viewport',
        'rings keep a constant screen size so the drawn extent matches the screen-space hit radius');

    await settle();
    const request = messages.at(-1);
    assert.equal(request.type, 'peaksRequest', 'the frame asks for dots after load settles');
    assert.equal(request.requestId, 1);
    const bounds = request.bounds;
    assert.ok(bounds.miny > camera.bounds.south && bounds.maxy < camera.bounds.north,
        'the request is clamped inside the raw view latitudes');
    assert.ok(bounds.minx > camera.bounds.west && bounds.maxx < camera.bounds.east,
        'the request is clamped inside the raw view longitudes');
    assert.ok(bounds.miny < camera.center.lat && camera.center.lat < bounds.maxy);
    assert.ok(bounds.minx < camera.center.lng && camera.center.lng < bounds.maxx);

    dispatch({
        type: 'peaks',
        requestId: 1,
        peaks: [
            { id: 58603, name: 'Iron Mountain', lat: 48.72, lon: -121.79, state: 'climbed' },
            { id: -114297, name: 'Peak 5000 (Prov)', lat: 48.74, lon: -121.82, state: 'unknown' },
            { id: 12, name: 'Weird State', lat: 48.75, lon: -121.83, state: 'purple' }
        ]
    });
    const rendered = () => JSON.parse(JSON.stringify(map.getSource('bpb-peaks').data.features));
    assert.equal(rendered().length, 3);
    assert.deepEqual(rendered()[0], {
        type: 'Feature',
        properties: { id: 58603, name: 'Iron Mountain', state: 'climbed' },
        geometry: { type: 'Point', coordinates: [-121.79, 48.72] }
    });
    assert.equal(rendered()[2].properties.state, 'unknown', 'an unrecognized state falls back safely');

    dispatch({
        type: 'peaks',
        requestId: 999,
        peaks: [{ id: 1, name: 'Stale Peak', lat: 48.7, lon: -121.8, state: 'climbed' }]
    });
    assert.equal(rendered().length, 3, 'a reply for a different request is ignored');

    dispatch({
        type: 'peaks',
        requestId: 1,
        peaks: [
            { id: 5, name: 'Fine Peak', lat: 48.7, lon: -121.8, state: 'climbed' },
            { id: 6, name: 'Broken Peak', lat: 99, lon: -121.8, state: 'climbed' }
        ]
    });
    assert.equal(rendered().length, 0, 'one malformed row drops the whole batch');

    // Clicks and hover are hit-tested in screen space against map.project —
    // MapLibre's layer-scoped events resolve the cursor through the terrain
    // surface behind the pixel and go dead when the camera pitches toward
    // horizontal, so they must never come back.
    assert.ok(!map.handlers.get('click:bpb-peaks-ring'), 'no layer-scoped click handler exists');
    assert.ok(!map.handlers.get('mouseenter:bpb-peaks-ring'), 'no layer-scoped hover handler exists');
    const click = map.handlers.get('click');
    assert.ok(click, 'the map hit-tests clicks itself');
    dispatch({
        type: 'peaks',
        requestId: 1,
        peaks: [
            { id: 58603, name: 'Iron <b>&</b> Mountain', lat: 48.72, lon: -121.79, state: 'climbed' },
            { id: 38375, name: 'Near Miss', lat: 48.74, lon: -121.82, state: 'unclimbed' }
        ]
    });
    projections.set('-121.79,48.72', { x: 400, y: 300 });
    projections.set('-121.82,48.74', { x: 418, y: 300 });

    click({ point: { x: 431, y: 300 } });
    assert.equal(popups.length, 0, 'a click just past a ring\'s edge opens nothing');
    click({ point: { x: 410, y: 301 } });
    assert.equal(popups.length, 1, 'a click within a drawn ring opens its popup');
    assert.deepEqual(JSON.parse(JSON.stringify(popups[0].lngLat)), [-121.82, 48.74],
        'overlapping rings resolve to the nearest center');

    click({ point: { x: 403, y: 297 } });
    assert.equal(popups.length, 2, 'a pitched-camera ring is clickable wherever it is drawn');
    const link = popups[1].node.querySelector('a');
    assert.equal(link.href, 'https://www.peakbagger.com/peak.aspx?pid=58603',
        'the link is built from the integer peak id only');
    assert.equal(link.textContent, 'Iron <b>&</b> Mountain', 'the name renders as text, never as markup');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.deepEqual(JSON.parse(JSON.stringify(popups[1].lngLat)), [-121.79, 48.72]);

    // The hover cursor runs through the same hit test, one frame behind the
    // pointer.
    const nextFrame = () => new Promise(resolve => window.requestAnimationFrame(resolve));
    map.handlers.get('mousemove')({ point: { x: 401, y: 299 } });
    await nextFrame();
    assert.equal(map.canvas.style.cursor, 'pointer', 'hovering a ring shows the pointer cursor');
    map.handlers.get('mousemove')({ point: { x: 500, y: 500 } });
    await nextFrame();
    assert.equal(map.canvas.style.cursor, '', 'leaving the ring restores the default cursor');
    map.handlers.get('mousemove')({ point: { x: 401, y: 299 } });
    await nextFrame();
    map.handlers.get('mouseout')();
    assert.equal(map.canvas.style.cursor, '', 'leaving the map restores the default cursor');

    dispatch({
        type: 'peaks',
        requestId: 1,
        peaks: [{ id: 7, name: 'Fresh Peak', lat: 48.71, lon: -121.81, state: 'unclimbed' }]
    });
    assert.equal(popups.at(-1).removedPopup, true,
        'refreshing the dots closes an open popup, like the native marker rebuild');

    const beforeZoomOut = messages.filter(message => message.type === 'peaksRequest').length;
    camera.zoom = 9;
    map.handlers.get('moveend')();
    await settle();
    assert.equal(messages.filter(message => message.type === 'peaksRequest').length, beforeZoomOut,
        'no request below the native zoom cutoff');
    assert.equal(rendered().length, 0, 'dots are cleared when the map covers too big an area');

    camera.zoom = 13;
    dispatch({ type: 'peaks', unavailable: true });
    map.handlers.get('moveend')();
    await settle();
    assert.equal(messages.filter(message => message.type === 'peaksRequest').length, beforeZoomOut,
        'a surface without a peak feed is never asked again');

    dispatch({ type: 'destroy' });
    assert.equal(map.removed, true);
    dom.window.close();
});

test('3D peak dots snap uphill to the local DEM summit, and only to a genuine one', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const maps = [];
    const camera = {
        zoom: 13,
        center: { lng: -121.805, lat: 48.73 },
        bounds: { south: 48.6, north: 48.86, west: -121.95, east: -121.66 }
    };

    // Synthetic terrain in meters around four feed coordinates:
    // - a 45° cone whose apex sits ~40 m northeast of Cone Peak's database
    //   point — the realistic smoothed-DEM envelope, whose gain must stay
    //   under the rise leash even for the zoom-15 re-climb (~71 m),
    // - a relentless eastward ramp under Ramp Peak (no summit within reach),
    // - nothing (elevation 0, MapLibre's "tile not loaded") under Void Peak,
    // - a 79° tower wall ~280 m above Flank Peak's database point, with its
    //   own genuine apex inside the horizontal leash (a taller neighbor, not
    //   a plausible coordinate correction).
    const METERS_PER_DEG_LAT = 111320;
    const metersBetween = (a, b) => Math.hypot(
        (a[0] - b[0]) * METERS_PER_DEG_LAT * Math.cos(b[1] * Math.PI / 180),
        (a[1] - b[1]) * METERS_PER_DEG_LAT
    );
    const conePeakFeed = [-121.79, 48.72];
    const apexOffsetM = (offsetM, from = conePeakFeed) => [
        from[0] + offsetM / (METERS_PER_DEG_LAT * Math.cos(from[1] * Math.PI / 180)),
        from[1] + offsetM / METERS_PER_DEG_LAT
    ];
    let coneApex = apexOffsetM(28);
    const rampPeakFeed = [-121.82, 48.74];
    const voidPeakFeed = [-121.83, 48.75];
    const flankPeakFeed = [-121.84, 48.76];
    const towerApex = apexOffsetM(40, flankPeakFeed);
    let voidPeakElevation = 0;
    let coneReadable = true;
    let elevationQueries = 0;
    const elevationOf = ([lng, lat]) => {
        elevationQueries += 1;
        if (coneReadable && metersBetween([lng, lat], conePeakFeed) < 500) {
            return 3000 - metersBetween([lng, lat], coneApex);
        }
        if (metersBetween([lng, lat], rampPeakFeed) < 500) {
            return 1000 + 10 * (lng - rampPeakFeed[0]) * METERS_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
        }
        if (metersBetween([lng, lat], voidPeakFeed) < 500 && voidPeakElevation > 0) {
            return voidPeakElevation - 2 * metersBetween([lng, lat], apexOffsetM(20, voidPeakFeed));
        }
        if (metersBetween([lng, lat], flankPeakFeed) < 500) {
            return Math.max(0, 2600 - 5 * metersBetween([lng, lat], towerApex));
        }
        return 0;
    };

    class MapStub {
        constructor() {
            this.sources = new Map();
            this.layers = [];
            this.handlers = new Map();
            this.canvas = { clientWidth: 800, clientHeight: 600, style: {} };
            maps.push(this);
        }
        addControl() {}
        once(type, callback) { if (type === 'load') window.queueMicrotask(callback); }
        on(type, callback) { this.handlers.set(type, callback); }
        addSource(id, source) { this.sources.set(id, { ...source, setData(data) { this.data = data; } }); }
        addLayer(layer) { this.layers.push(layer); }
        getLayer(id) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id) { return this.sources.get(id); }
        removeSource(id) { this.sources.delete(id); }
        setPaintProperty() {}
        getZoom() { return camera.zoom; }
        getCenter() { return camera.center; }
        getBounds() {
            const box = camera.bounds;
            return {
                getSouth: () => box.south,
                getNorth: () => box.north,
                getWest: () => box.west,
                getEast: () => box.east
            };
        }
        getCanvas() { return this.canvas; }
        project() { return { x: -10000, y: -10000 }; }
        queryTerrainElevation(lngLat) { return elevationOf(lngLat); }
        resize() {}
        remove() {}
    }

    window.chrome = { runtime: { getURL: path => `chrome-extension://test-id/${path}` } };
    window.maplibregl = {
        Map: MapStub,
        Popup: class { remove() {} },
        NavigationControl: class {},
        ScaleControl: class {},
        AttributionControl: class {},
        setWorkerUrl() {},
        addProtocol() {},
        removeProtocol() {}
    };
    window.postMessage = () => {};
    // terrain-frame imports the real terrain-cache; its create() binds fetch
    // (never invoked here, as no tiles load in jsdom), so provide a stub.
    window.fetch = () => Promise.resolve();
    window.eval(frameBundle);

    const dispatch = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrainFrame: true, dir: 'toFrame', ...data }
    }));

    dispatch({ type: 'init', routeSegments: [[[48.7, -121.8], [48.71, -121.81]]] });
    await new Promise(resolve => window.queueMicrotask(resolve));
    await new Promise(resolve => window.setTimeout(resolve, 320));
    const sendBatch = () => dispatch({
        type: 'peaks',
        requestId: 1,
        peaks: [
            { id: 1, name: 'Cone Peak', lat: conePeakFeed[1], lon: conePeakFeed[0], state: 'climbed' },
            { id: 2, name: 'Ramp Peak', lat: rampPeakFeed[1], lon: rampPeakFeed[0], state: 'unclimbed' },
            { id: 3, name: 'Void Peak', lat: voidPeakFeed[1], lon: voidPeakFeed[0], state: 'climbed' },
            { id: 4, name: 'Flank Peak', lat: flankPeakFeed[1], lon: flankPeakFeed[0], state: 'unclimbed' }
        ]
    });
    const rendered = () => JSON.parse(JSON.stringify(maps[0].getSource('bpb-peaks').data.features));

    sendBatch();
    let features = rendered();
    assert.equal(features.length, 4);
    const firstSnap = features[0].geometry.coordinates;
    assert.ok(metersBetween(firstSnap, coneApex) < 5,
        `a dot near a local summit snaps onto it (landed ${metersBetween(firstSnap, coneApex).toFixed(1)} m away)`);
    assert.ok(metersBetween(firstSnap, conePeakFeed) > 20,
        'the snapped dot really moved off the database coordinate');
    assert.deepEqual(features[1].geometry.coordinates, rampPeakFeed,
        'a dot on ground that keeps rising past the leash keeps the feed coordinates — that is a neighboring slope, not its summit');
    assert.deepEqual(features[2].geometry.coordinates, voidPeakFeed,
        'a dot whose DEM reads 0 (tile not loaded / the sea) keeps the feed coordinates');
    assert.deepEqual(features[3].geometry.coordinates, flankPeakFeed,
        'a climb gaining more than the rise leash summited a taller neighbor inside the horizontal leash — the dot keeps the feed coordinates');

    // Simulate a tilt changing the loaded DEM resolution without changing the
    // zoom. A cached verdict must hold: the dot must not wander between
    // settles, and must not re-climb at all.
    coneApex = apexOffsetM(50);
    elevationQueries = 0;
    sendBatch();
    features = rendered();
    assert.deepEqual(features[0].geometry.coordinates, firstSnap,
        'at an unchanged zoom the dot stays where the first verdict put it, whatever the DEM now reads');
    assert.deepEqual(features[1].geometry.coordinates, rampPeakFeed, 'a kept-at-feed verdict is cached too');
    assert.ok(elevationQueries <= 40,
        `cached verdicts skip the climbs; only the unreadable dot retries (${elevationQueries} queries)`);

    // Crossing into a higher integer zoom level is the one event allowed to
    // adopt a potentially finer terrain sample and re-open the verdict.
    camera.zoom = 15;
    sendBatch();
    features = rendered();
    assert.ok(metersBetween(features[0].geometry.coordinates, apexOffsetM(50)) < 5,
        'a higher zoom level re-climbs on the new terrain sample and refines the dot');

    // An unreadable start was missing data, not a verdict: once its DEM
    // loads, the dot snaps without waiting for a zoom change.
    voidPeakElevation = 2000;
    sendBatch();
    assert.ok(metersBetween(rendered()[2].geometry.coordinates, apexOffsetM(20, voidPeakFeed)) < 5,
        'a dot whose DEM was unreadable snaps as soon as its terrain loads, without a zoom change');

    // The reverse race: a higher integer zoom re-opens the verdict, but the
    // finer DEM tile may not have streamed in yet. The held verdict must keep
    // rendering — the dot used to fall back to the raw feed coordinates here,
    // so every zoom-in hopped it off the summit and back across two settles.
    const zoom15Snap = rendered()[0].geometry.coordinates;
    camera.zoom = 17;
    coneReadable = false;
    sendBatch();
    assert.deepEqual(rendered()[0].geometry.coordinates, zoom15Snap,
        'zooming in ahead of the DEM stream holds the last verdict, never the feed coordinates');

    // The held verdict kept its old zoom, so it stays re-openable: the finer
    // sample is adopted on the next batch after its tile loads.
    coneApex = apexOffsetM(60);
    coneReadable = true;
    sendBatch();
    assert.ok(metersBetween(rendered()[0].geometry.coordinates, apexOffsetM(60)) < 5,
        'the finer DEM is adopted on the next batch after it streams in, without another zoom change');

    dom.window.close();
});
