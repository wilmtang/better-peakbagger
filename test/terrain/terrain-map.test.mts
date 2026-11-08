// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { nativeMapDarkCss } from '../../src/theme/native-map-theme.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM as TestJSDOM } from '../helpers/test-dom.mts';
import type { TestDom, TestDomOptions, TestWindow } from '../helpers/test-dom.mts';
import { fireTrustedEvent, makeChromeStub } from '../helpers/load-page.mjs';
import { terrainFailure } from '../../src/terrain/terrain-failure.js';
import { TERRAIN_FRAME_KEEP_ALIVE_MS } from '../../src/terrain/terrain-lifecycle.js';


// Loose fixtures for a harness that drives the bundled bridge and frame through
// the same untyped messages and MapLibre calls they exchange in production.
interface TestMessage {
    type?: string; reason?: string; generation?: number; activation?: string; id?: string; action?: string; selection?: string; provider?: string;
    camera?: { center?: unknown; zoom?: number; [field: string]: unknown } | null; routeStyle?: { color?: string; width?: number; [field: string]: unknown } | null; conditions?: string[]; occlusions?: number[][]; captures?: { title: string }[]; capture?: string; routeSegments?: unknown; basemap?: { name?: string; tiles?: string[]; kind?: string; provider?: string; [field: string]: unknown } | null; basemaps?: unknown; theme?: string; retryAt?: number;
    stationId?: string; revision?: number; snapshot?: unknown; bounds?: unknown; zoom?: number; footer?: number; [field: string]: unknown;
}
type StubEvent = { sourceId?: string; dataType?: string; tile?: unknown; error?: unknown; point?: unknown; lngLat?: unknown; originalEvent?: unknown; [field: string]: unknown };
type Handler = (event?: StubEvent) => unknown;
interface StubLayer { id: string; type?: string; source?: string; paint?: Record<string, unknown>; layout?: Record<string, unknown>; [field: string]: unknown; }
interface StubSourceData { features: { properties: Record<string, unknown>; geometry: { coordinates: unknown } }[]; [field: string]: unknown }
interface StubSource { type?: string; tiles?: string[]; tileSize?: number; attribution?: string; data?: StubSourceData; setData?(data: StubSourceData): unknown; [field: string]: unknown; }
interface StubOptions {
    style: { sources: Record<string, StubSource>; layers: StubLayer[]; terrain?: { exaggeration?: number }; [field: string]: unknown };
    container?: HTMLElement; center?: unknown; bounds?: number[][]; fitBoundsOptions?: { maxZoom?: number; pitch?: number }; zoom?: number; pitch?: number; bearing?: number; transformRequest?(url: string, type?: string): unknown; [field: string]: unknown;
}
interface StubMap {
    options: StubOptions; sources: Map<string, StubSource>; layers: StubLayer[]; handlers: Map<string, Handler>; removed?: boolean;
    getSource(id: string): StubSource; getLayer(id: string): StubLayer | undefined; canvas: HTMLCanvasElement; paint: unknown[][]; layout: unknown[][];
    controls: StubControl[]; sprites: { id: string; url: string }[]; sourceDataOutcomes: Map<string, unknown[]>; loadCallback: Handler; [field: string]: unknown;
}
interface StubControl { onAdd?(map: unknown): Node | undefined; onRemove?(): void; options?: { customAttribution?: string }; }
interface StubPopup { node: Element; lngLat: unknown; removedPopup?: boolean; options?: unknown; target?: unknown; }
type StubProtocol = (parameters: { url: string; type?: string }, controller: AbortController) => Promise<unknown>;
const withResolvers = <T = void,>() => {
    let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    return { promise, resolve, reject };
};
type HarnessWindow = TestWindow & { chrome: unknown; maplibregl: unknown; authorizeTerrain?: unknown };
const JSDOM = TestJSDOM as unknown as new (html?: string, options?: TestDomOptions) => Omit<TestDom, 'window'> & { window: HarnessWindow };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const makeWebp = () => {
    const bytes = new Uint8Array(24);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WEBP'), 8);
    bytes.set(new TextEncoder().encode('VP8L'), 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.byteLength - 8, true);
    view.setUint32(16, bytes.byteLength - 20, true);
    return bytes;
};
// The bridge imports settings, so tests provide the real chrome.storage shape
// that module reads from, plus the getURL the bridge needs. Push updates with
// chrome.storage.sync.set(...).
const chromeWith = (settings: Record<string, unknown>) => {
    const chrome = makeChromeStub({ bpbSettings: settings });
    chrome.runtime.getURL = (resource: string) => `chrome-extension://test-id/${resource}`;
    return chrome;
};
const armTerrain = (window: HarnessWindow, type = 'click') => {
    let toggle = window.document.getElementById('bpb-terrain-toggle');
    if (!toggle) {
        toggle = window.document.createElement('button');
        toggle.id = 'bpb-terrain-toggle';
        window.document.body.append(toggle);
    }
    fireTrustedEvent(toggle, type, { bubbles: true });
    return toggle;
};
// The isolated in-page 3D bridge bundle and a classic test harness around the
// frame's injectable runtime. Production loads the tiny native-ESM entry that
// imports MapLibre directly; lifecycle tests pass a stub so jsdom never allocates
// WebGL. The bundled terrain cache still binds each test's supplied fetch stub.
const bridgeBundle = await readFile(path.join(root, 'dist', 'content', 'terrain-map.js'), 'utf8');
const frameHarnessBuild = await build({
    stdin: {
        contents: `import { startTerrainFrame } from ${JSON.stringify(path.join(root, 'src', 'terrain', 'terrain-frame-runtime.ts'))};\nconst originalPost=window.parent.postMessage.bind(window.parent); window.parent.postMessage=(message,...args)=>{if(message.type==='layerBasemaps')window.__testLayerBasemaps=message;return originalPost(message,...args)};
startTerrainFrame(globalThis.maplibregl, { authorize: request => globalThis.authorizeTerrain ? globalThis.authorizeTerrain(request) : true });\n`,
        resolveDir: root,
        sourcefile: 'terrain-frame-test-harness.js',
        loader: 'js',
    },
    bundle: true,
    format: 'iife',
    target: ['node22'],
    platform: 'browser',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
});
const frameBundle = frameHarnessBuild.outputFiles[0].text;

function framePicker(window: HarnessWindow) {
    return window.document.querySelector<HTMLSelectElement>('.bpb-terrain-controls select[aria-label="Base map"]')!;
}

const terrainCss = await readFile(path.join(root, 'src', 'terrain', 'terrain-map.css'), 'utf8');

// Share frame wiring, while each case retains its own renderer and failure model.
const bootTerrainFrame = (window: HarnessWindow, MapStub: unknown, {
    messages = [], popups, maplibre = {}, fetch = () => Promise.resolve()
}: { messages?: TestMessage[]; popups?: StubPopup[]; maplibre?: Record<string, unknown>; fetch?: (url: string, options: RequestInit) => unknown } = {}) => {
    Object.assign(window, { chrome: { runtime: { getURL: (resource: string) => `chrome-extension://test-id/${resource}` } } });
    window.maplibregl = {
        Map: MapStub,
        NavigationControl: class NavigationControl {},
        ScaleControl: class ScaleControl {},
        AttributionControl: class AttributionControl {},
        setWorkerUrl() {},
        addProtocol() {},
        removeProtocol() {},
        ...(popups ? { Popup: class {
            declare options: unknown; declare lngLat: unknown; declare node: Element; declare target: unknown; declare removedPopup: boolean;
            constructor(options: StubOptions) { this.options = options; popups!.push(this as unknown as StubPopup); }
            setLngLat(lngLat: [number, number]) { this.lngLat = lngLat; return this; }
            setDOMContent(node: Element) { this.node = node; return this; }
            addTo(target: unknown) { this.target = target; return this; }
            remove() { this.removedPopup = true; }
        } } : {}),
        ...maplibre
    };
    window.postMessage = message => { messages.push(message); };
    Object.assign(window, { fetch });
    window.eval(frameBundle);
    return (data: TestMessage) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrainFrame: true, dir: 'toFrame', ...data }
    }));
};

test('3D terrain waits for the extension frame handshake before sending route coordinates', async () => {
    const snowStation = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78, longitude: -121.74, elevation: 1570 };
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport">
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      </div>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const pageMessages: TestMessage[] = [];
    const frameMessages: TestMessage[] = [];
    Object.assign(window, { chrome: chromeWith({ enable3dMap: true }) });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => window.setTimeout(resolve, 0)); // settings.get() resolves

    const dispatchPage = (data: TestMessage) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));
    armTerrain(window);
    dispatchPage({
        type: 'init',
        routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
        routeLinks: [{ id: 3230293, label: '2026-06-12 - Fei (Kautz Glacier) TR-98' }],
        routeTracks: [0],
        camera: { center: [48.72, -121.79], zoom: 12.5 },
        focus: [48.83115, -121.60214],
        focusZoom: 13,
        focusPeak: { id: 2829, name: 'Mount Shuksan', lat: 48.83115, lon: -121.60214, state: 'unclimbed' },
        snowStations: [{ ...snowStation, url: 'https://untrusted.example/', html: '<script>' }],
        routeStyle: { color: '#d9483b' },
        theme: 'light',
        cacheLimitMb: 512,
        basemap: {
            name: 'Open Topo Map',
            tiles: ['https://a.tile.example.com/{z}/{x}/{y}.png']
        }
    });
    await new Promise(resolve => window.setTimeout(resolve, 0));

    const frame = window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null;
    assert.ok(frame);
    assert.equal(frame.src, 'chrome-extension://test-id/terrain/terrain.html');
    assert.equal(frameMessages.length, 0, 'route coordinates must wait until the frame listener is ready');
    frame.contentWindow!.postMessage = (message: TestMessage) => { frameMessages.push(message); };

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
    assert.deepEqual(init.routeTracks, [0], 'the hover identity travels with the route it belongs to');
    assert.deepEqual(JSON.parse(JSON.stringify(init.camera)), { center: [48.72, -121.79], zoom: 12.5 });
    assert.deepEqual(init.focus, [48.83115, -121.60214]);
    assert.equal(init.focusZoom, 13);
    assert.deepEqual(init.focusPeak,
        { id: 2829, name: 'Mount Shuksan', lat: 48.83115, lon: -121.60214, state: 'unclimbed' });
    assert.equal(init.routeStyle!.color, '#347a3f');
    assert.equal(init.theme, 'dark');
    assert.equal(init.cacheLimitMb, 512);
    assert.equal(init.basemap!.name, 'Open Topo Map');
    assert.deepEqual(JSON.parse(JSON.stringify(init.snowStations)), [snowStation], 'the frame receives only bounded public station fields');
    assert.match(init.activation!, /^test-terrain-activation-/,
        'the private frame message carries the isolated-world capability');

    const beforeInvalidSnow = frameMessages.length;
    dispatchPage({ type: 'snowStations', snowStations: [{ ...snowStation, longitude: 181 }] });
    assert.equal(frameMessages.length, beforeInvalidSnow, 'invalid map metadata cannot cross the isolated bridge');
    dispatchPage({ type: 'snowStations', snowStations: [snowStation], reveal: true });
    assert.equal(frameMessages.at(-1)!.reveal, true, 'explicit reveal reaches a loading frame');
    dispatchPage({ type: 'snowStations', snowStations: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1)!.snowStations)), [], 'toggle-off reaches a loading frame');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true,
            dir: 'toParent',
            type: 'loaded',
            generation: init.generation,
            camera: { center: [48.73, -121.78], zoom: 13.25 }
        }
    }));
    assert.equal(frame.style.opacity, '1');
    assert.equal(frame.style.pointerEvents, 'auto');
    assert.equal(frameMessages.at(-1)!.type, 'snowStations');
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1)!.snowStations)), [], 'ready replays toggle-off even if authorization dropped its earlier update');
    assert.equal(frameMessages.at(-1)!.reveal, false, 'toggle-off clears a queued reveal before the renderer is ready');
    assert.equal(pageMessages.at(-1)!.type, 'loaded');
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1)!.camera)), { center: [48.73, -121.78], zoom: 13.25 });

    const beforeFireRetry = frameMessages.length;
    dispatchPage({ type: 'layerAction', action: 'retry', id: 'wildfire', url: 'https://untrusted.example', fires: [{ geometry: 'untrusted' }] });
    assert.equal(frameMessages.length, beforeFireRetry + 1, 'a validated wildfire Refresh must reach the active renderer');
    assert.equal(frameMessages.at(-1)!.action, 'retry'); assert.equal(frameMessages.at(-1)!.id, 'wildfire');
    assert.equal(Object.hasOwn(frameMessages.at(-1)!, 'url'), false); assert.equal(Object.hasOwn(frameMessages.at(-1)!, 'fires'), false);
    const afterFireRetry = frameMessages.length;
    dispatchPage({ type: 'layerAction', action: 'capture', id: 'wildfire' });
    dispatchPage({ type: 'layerAction', action: 'retry', id: 'arbitrary' });
    assert.equal(frameMessages.length, afterFireRetry, 'wildfires expose retry only; unknown layers remain blocked');

    const snowSelect = (stationId: string, generation = init.generation) => window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow, origin: 'chrome-extension://test-id',
        data: { __bpbTerrainFrame: true, dir: 'toParent', type: 'snowSelect', generation, stationId },
    }));
    const beforeSnowSelect = pageMessages.length;
    snowSelect('https://untrusted.example/'); snowSelect(snowStation.id, init.generation! + 1);
    assert.equal(pageMessages.length, beforeSnowSelect, 'invalid and stale station actions cannot reach the card');
    snowSelect(snowStation.id);
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1))), {
        __bpbPeakSnow: true, dir: 'toCS', type: 'select', stationId: snowStation.id,
    });

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true,
            dir: 'toParent',
            type: 'camera',
            generation: init.generation,
            camera: { center: [48.74, -121.77], zoom: 14 }
        }
    }));
    assert.equal(pageMessages.at(-1)!.type, 'camera');
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1)!.camera)), { center: [48.74, -121.77], zoom: 14 });

    dispatchPage({ type: 'cameraRequest', requestId: 7 });
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1))), {
        __bpbTerrainFrame: true,
        dir: 'toFrame',
        type: 'cameraRequest',
        generation: init.generation,
        requestId: 7
    });
    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true,
            dir: 'toParent',
            type: 'camera',
            generation: init.generation,
            requestId: 7,
            camera: { center: [48.75, -121.76], zoom: 14.25 }
        }
    }));
    assert.equal(pageMessages.at(-1)!.requestId, 7,
        'the bridge preserves the request identity so an older camera event cannot win the switch race');

    dispatchPage({ type: 'highlight', coordinates: [-121.81, 48.71], series: 'time' });
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1))), {
        __bpbTerrainFrame: true,
        dir: 'toFrame',
        type: 'highlight',
        generation: init.generation,
        coordinates: [-121.81, 48.71],
        series: 'time'
    }, 'the isolated-world bridge preserves the series discriminator');

    // Compass: the frame streams its bearing/pitch to the page…
    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true, dir: 'toParent', type: 'view',
            generation: init.generation, bearing: 12.5, pitch: 47
        }
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1))), {
        __bpbTerrain: true, dir: 'toPage', type: 'view', bearing: 12.5, pitch: 47
    }, 'the bridge relays the view stream to the page compass');

    // …and the page's reset command travels back to the frame.
    dispatchPage({ type: 'resetNorth' });
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1))), {
        __bpbTerrainFrame: true, dir: 'toFrame', type: 'resetNorth', generation: init.generation
    }, 'the bridge relays the compass reset to the frame');

    // Escape inside the cross-origin frame reaches the page only as a request.
    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'chrome-extension://test-id',
        data: { __bpbTerrainFrame: true, dir: 'toParent', type: 'exit', generation: init.generation }
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1))), {
        __bpbTerrain: true, dir: 'toPage', type: 'exit'
    }, 'the bridge relays the frame’s Escape to the page coordinator');

    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: false } });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, null);
    assert.equal(pageMessages.at(-1)!.type, 'error');
    assert.equal(pageMessages.at(-1)!.reason, 'unavailable');

    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, null);
    assert.equal(pageMessages.at(-1)!.type, 'destroyed');
    dom.window.close();
});

// Boot the bridge and drive one frame to 'loaded'. The bridge's only keep-alive
// setTimeout is the keep-alive TTL, so intercept it (by its delay) into `timers`
// for deterministic firing; every other timeout runs for real.
const bootLoadedFrame = async (initOverrides = {}, { deferLoaded = false } = {}) => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport">
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      </div>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const pageMessages: TestMessage[] = [];
    const frameMessages: TestMessage[] = [];
    const timers: Handler[] = [];
    const realSetTimeout = window.setTimeout.bind(window);
    (window as unknown as Record<string, unknown>).setTimeout = (fn: Handler, delay: number) => {
        if (delay === TERRAIN_FRAME_KEEP_ALIVE_MS) { timers.push(fn); return timers.length; }
        return realSetTimeout(fn, delay);
    };
    Object.assign(window, { chrome: chromeWith({ enable3dMap: true }) });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => realSetTimeout(resolve, 0));

    const dispatchPage = (data: TestMessage) => window.dispatchEvent(new window.MessageEvent('message', {
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
    armTerrain(window);
    dispatchPage(initData);
    await new Promise(resolve => realSetTimeout(resolve, 0));
    const frame = window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null;
    frame!.contentWindow!.postMessage = (message: TestMessage) => { frameMessages.push(structuredClone(message)); };

    const dispatchFrame = (data: TestMessage) => {
        const outboundGeneration = [...frameMessages].reverse()
            .find(message => message.type === 'init' || message.type === 'resume')?.generation;
        window.dispatchEvent(new window.MessageEvent('message', {
            source: frame!.contentWindow, origin: 'chrome-extension://test-id',
            data: {
                __bpbTerrainFrame: true,
                dir: 'toParent',
                ...(data.type !== 'ready' ? { generation: outboundGeneration } : {}),
                ...data,
            }
        }));
    };
    dispatchFrame({ type: 'ready' });
    if (!deferLoaded) dispatchFrame({ type: 'loaded', navTop: 96, camera: { center: [48.72, -121.79], zoom: 12.5 } });

    return { dom, window, frame, initData, dispatchPage, dispatchFrame, pageMessages, frameMessages, timers, realSetTimeout };
};

for (const action of ['init', 'resume']) test(`terrain ${action} replays style, theme and station membership changed during authorization`, async () => {
    const env = await bootLoadedFrame({}, { deferLoaded: action === 'init' });
    const { window, dispatchPage, dispatchFrame, frameMessages, initData, realSetTimeout } = env;
    const station = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78, longitude: -121.74, elevation: 1570 };
    try {
        if (action === 'resume') {
            dispatchPage({ type: 'destroy' }); armTerrain(window); dispatchPage(initData);
            await new Promise(resolve => realSetTimeout(resolve, 0));
        }
        const original = frameMessages.filter(message => message.type === action).at(-1);
        assert.equal(original!.theme, 'light');
        dispatchPage({ type: 'update', routeStyle: { color: '#347a3f', width: 6 } });
        dispatchPage({ type: 'update', theme: 'dark' });
        dispatchPage({ type: 'snowStations', snowStations: [station], conditions: [station.id, 'not-a-station'], reveal: true, occlusions: [[0, 0, .2, .4]] });
        const beforeLoaded = frameMessages.length;
        dispatchFrame({ type: 'loaded' });
        const replay = frameMessages.slice(beforeLoaded);
        assert.equal(replay.find(message => message.type === 'update')?.theme, 'dark', 'authorization must not drop the new theme');
        assert.equal(replay.find(message => message.type === 'update')?.routeStyle!.color, '#347a3f');
        assert.deepEqual(Array.from(replay.find(message => message.type === 'snowStations')!.conditions || []), [station.id], 'membership crosses the ready replay');
        assert.equal(replay.find(message => message.type === 'snowStations')!.reveal, true);
        assert.deepEqual(Array.from(replay.find(message => message.type === 'snowStations')!.occlusions || [], row => Array.from(row)), [[0, 0, .2, .4]]);
        assert.equal(original!.theme, 'light', 'the fixture models structured message serialization');
    } finally { window.close(); }
});

for (const action of ['init', 'resume']) test(`terrain ${action} retains updates while the worker issues its activation`, async () => {
    const env = await bootLoadedFrame();
    const { window, dispatchPage, frameMessages, initData, timers, realSetTimeout } = env;
    const pending: ((value: unknown) => void)[] = [], station = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78, longitude: -121.74, elevation: 1570 };
    try {
        dispatchPage({ type: 'destroy' });
        if (action === 'init') timers[0]();
        frameMessages.length = 0;
        Object.defineProperty(window.chrome.runtime, 'sendMessage', { value: () => new Promise(resolve => pending.push(resolve)) });
        armTerrain(window); dispatchPage(initData);
        dispatchPage({ type: 'update', routeStyle: { color: '#347a3f' }, theme: 'dark' });
        dispatchPage({ type: 'snowStations', snowStations: [station], conditions: [station.id] });
        pending.shift()!({ ok: true, token: 'deferred-activation', expiresAt: Date.now() + 10000 });
        await new Promise(resolve => realSetTimeout(resolve, 0));
        if (action === 'init') {
            const frame = window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null;
            frame!.contentWindow!.postMessage = (message: TestMessage) => frameMessages.push(structuredClone(message));
            window.dispatchEvent(new window.MessageEvent('message', { source: frame!.contentWindow, origin: 'chrome-extension://test-id',
                data: { __bpbTerrainFrame: true, dir: 'toParent', type: 'ready' } }));
        }
        const payload = frameMessages.find(message => message.type === action);
        assert.equal(payload?.theme, 'dark', 'the issued capability must carry the latest theme');
        assert.equal(payload.routeStyle!.color, '#347a3f');
        assert.deepEqual(Array.from(payload.conditions || []), [station.id]);
    } finally { dispatchPage({ type: 'destroy' }); window.close(); }
});

test('terrain station actions require explicit membership, preserve omitted updates and reset on resume', async () => {
    const dom = new JSDOM('<body></body>', { url: 'https://www.peakbagger.com/Peak.aspx?pid=1', runScripts: 'outside-only', pretendToBeVisual: true });
    const popups: StubPopup[] = [], messages: TestMessage[] = []; let map;
    class MapStub {
        declare layers: StubLayer[];
        declare load: Handler;
        declare sources: Map<string, StubSource>;
        constructor(options: StubOptions) { map = this as unknown as StubMap; this.layers = options.style.layers; this.sources = new Map(); }
        addControl() {} once(type: string, callback: Handler) { if (type === 'load') this.load = callback; } on() {}
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData() {} }); }
        getSource(id: string) { return this.sources.get(id); } removeSource(id: string) { this.sources.delete(id); }
        addLayer(layer: StubLayer) { this.layers.push(layer); } getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        setPaintProperty() {} fitBounds() {} resize() {} remove() {}
        getZoom() { return 12; } getCenter() { return { lng: -121.74, lat: 46.78 }; }
    }
    class Marker { setLngLat() { return this; } addTo() { return this; } remove() {} }
    class Popup {
        declare node: Node;
        constructor() { popups.push(this as unknown as StubPopup); } setDOMContent(node: Element) { this.node = node; return this; }
        on() { return this; } remove() {}
    }
    const dispatch = bootTerrainFrame(dom.window, MapStub, { messages, maplibre: { Marker, Popup } });
    const station = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78, longitude: -121.74, elevation: 1570 };
    const payload = { focus: [46.78, -121.74], snowStations: [station] };
    const action = () => popups.at(-1)!.node.querySelector<HTMLElement>('.bpb-snotel-show-conditions');
    try {
        dispatch({ type: 'init', ...payload }); map!.load();
        assert.ok(messages.some(message => message.type === 'loaded'), 'the renderer stub reached the loaded state');
        assert.equal(action(), null, 'unknown membership must not offer an unavailable weather action');
        dispatch({ type: 'snowStations', snowStations: [station], conditions: [station.id] }); assert.ok(action());
        dispatch({ type: 'snowStations', snowStations: [station] }); assert.ok(action(), 'an omitted membership update preserves known conditions');
        dispatch({ type: 'snowStations', snowStations: [station], conditions: [] }); assert.equal(action(), null);
        dispatch({ type: 'snowStations', snowStations: [station], conditions: [station.id] });
        dispatch({ type: 'suspend' }); dispatch({ type: 'resume', ...payload });
        assert.equal(action(), null, 'a fresh activation cannot inherit stale weather-card membership');
    } finally { dispatch({ type: 'destroy' }); dom.window.close(); }
});

test('a parked terrain frame cannot reveal stations and resume does not replay that request', async () => {
    const harness = await bootLoadedFrame();
    const { window, dispatchPage, dispatchFrame, frameMessages, initData } = harness;
    try {
        const station = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78, longitude: -121.74, elevation: 1570 };
        dispatchPage({ type: 'snowStations', snowStations: [station], reveal: true });
        assert.equal(frameMessages.at(-1)!.reveal, true);
        dispatchPage({ type: 'destroy' });
        dispatchPage({ type: 'snowStations', snowStations: [station], reveal: true });
        assert.equal(frameMessages.at(-1)!.reveal, false, 'hidden terrain must not animate');
        armTerrain(window); dispatchPage({ ...initData, snowStations: [station] });
        await new Promise(resolve => harness.realSetTimeout(resolve, 0));
        dispatchFrame({ type: 'loaded', navTop: 96 });
        assert.equal(frameMessages.at(-1)!.type, 'snowStations');
        assert.equal(frameMessages.at(-1)!.reveal, false, 'an ordinary handoff only restores the layer');
    } finally { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); }
});

test('3D location points require the active frame generation and valid coordinates, independently of weather', async () => {
    const harness = await bootLoadedFrame();
    const { window, frame, dispatchPage, dispatchFrame, pageMessages, frameMessages, initData } = harness;
    try {
        const card = window.document.createElement('section'); card.id = 'bpb-peak-weather'; window.document.body.append(card);
        frame!.getBoundingClientRect = () => ({ left: 100, top: 50, width: 600, height: 400 }) as DOMRect;
        const context = { type: 'locationContext', latitude: 46.8, longitude: -121.7, x: 20, y: 30 };
        dispatchFrame(context);
        assert.deepEqual(JSON.parse(JSON.stringify(pageMessages.at(-1))), { __bpbMapLocation: true, type: 'context', map: 'terrain', latitude: 46.8, longitude: -121.7, x: 120, y: 80 });
        const count = pageMessages.length;
        for (const invalid of [{ latitude: 91 }, { x: 601 }, { longitude: '1' }, { generation: -1 }]) dispatchFrame({ ...context, ...invalid });
        assert.equal(pageMessages.length, count);
        card.hidden = true; dispatchFrame(context); assert.equal(pageMessages.length, count + 1);
        card.hidden = false; dispatchFrame({ type: 'locationDismiss' }); assert.equal(pageMessages.at(-1)!.type, 'dismiss');
        const oldGeneration = frameMessages.find(message => message.type === 'init')!.generation;
        dispatchPage({ type: 'destroy' });
        const parkedCount = pageMessages.length;
        dispatchFrame(context); dispatchFrame({ type: 'locationDismiss' });
        assert.equal(pageMessages.length, parkedCount, 'a parked renderer cannot open or dismiss a weather menu');
        armTerrain(window); dispatchPage(initData);
        await new Promise(resolve => harness.realSetTimeout(resolve, 0));
        dispatchFrame({ type: 'loaded', navTop: 96 });
        const resumedCount = pageMessages.length;
        dispatchFrame({ ...context, generation: oldGeneration }); assert.equal(pageMessages.length, resumedCount);
        dispatchFrame(context); assert.equal(pageMessages.at(-1)!.type, 'context');
    } finally { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); }
});

test('a loaded 3D frame suspends on destroy and resumes on re-entry without a new iframe', async () => {
    const ctx = await bootLoadedFrame();
    const { window, frame, initData, dispatchPage, dispatchFrame, pageMessages, frameMessages } = ctx;
    assert.equal(frame!.style.opacity, '1', 'the loaded frame is visible');

    // destroy → suspend: the iframe stays, parked at opacity 0.
    frameMessages.length = 0;
    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, frame, 'the frame stays in the DOM');
    assert.equal(frame!.style.opacity, '0');
    assert.equal(frame!.style.pointerEvents, 'none');
    assert.equal(frameMessages.at(-1)!.type, 'suspend', 'the frame is told to suspend');
    assert.equal(pageMessages.at(-1)!.type, 'destroyed', 'the page still gets its destroyed ack');
    assert.equal(ctx.timers.length, 1, 'a keep-alive TTL is armed');

    // re-entry → resume: no new iframe, a resume posted carrying the fresh payload.
    frameMessages.length = 0;
    armTerrain(window);
    dispatchPage(initData);
    await new Promise(resolve => ctx.realSetTimeout(resolve, 0));
    assert.equal(window.document.querySelectorAll('#bpb-terrain-frame').length, 1, 'no second iframe is built');
    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, frame, 'the same iframe is reused');
    const resume = frameMessages.find(message => message.type === 'resume');
    assert.ok(resume, 'a resume is posted instead of a fresh boot');
    assert.equal(frameMessages.some(message => message.type === 'init'), false, 'no init handshake on resume');
    assert.deepEqual(JSON.parse(JSON.stringify(resume.camera)), { center: [48.72, -121.79], zoom: 12.5 });
    assert.match(resume.activation!, /^test-terrain-activation-/);

    // The frame's normal 'loaded' reply restores the frame to visible.
    dispatchFrame({ type: 'loaded', navTop: 96, camera: { center: [48.72, -121.79], zoom: 12.5 } });
    assert.equal(frame!.style.opacity, '1');
    ctx.dom.window.close();
});

test('the bridge ignores wrong-origin and stale-generation replies from the current frame window', async () => {
    const ctx = await bootLoadedFrame();
    const { window, frame, dispatchPage, frameMessages, pageMessages } = ctx;
    const firstGeneration = frameMessages.find(message => message.type === 'init')!.generation;

    dispatchPage({ type: 'destroy' });
    frameMessages.length = 0;
    pageMessages.length = 0;
    for (const data of [
        { type: 'ready' },
        { type: 'loaded', camera: { center: [48.7, -121.8], zoom: 12 } },
        { type: 'camera', camera: { center: [48.7, -121.8], zoom: 12 } },
        { type: 'metrics', navTop: 20 },
        { type: 'view', bearing: 90, pitch: 45 },
        { type: 'peaksRequest', requestId: 8, bounds: {} },
        { type: 'exit' },
        { type: 'error', reason: 'renderer' },
    ]) {
        window.dispatchEvent(new window.MessageEvent('message', {
            source: frame!.contentWindow,
            origin: 'https://attacker.example',
            data: { __bpbTerrainFrame: true, dir: 'toParent', generation: firstGeneration, ...data },
        }));
    }
    assert.equal(frame!.style.opacity, '0');
    assert.equal(frame!.style.pointerEvents, 'none');
    assert.deepEqual(frameMessages, [], 'wrong-origin ready must not disclose the pending route');
    assert.deepEqual(pageMessages, [], 'wrong-origin replies must not reach the page coordinator');

    armTerrain(window);
    dispatchPage(ctx.initData);
    await new Promise(resolve => ctx.realSetTimeout(resolve, 0));
    const resumed = (frameMessages as TestMessage[]).find(message => message.type === 'resume');
    assert.ok(resumed!.generation! > firstGeneration!);
    pageMessages.length = 0;
    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame!.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true,
            dir: 'toParent',
            type: 'loaded',
            generation: firstGeneration,
            camera: { center: [0, 0], zoom: 1 },
        },
    }));
    assert.equal(frame!.style.opacity, '0', 'a stale loaded reply cannot expose the resumed frame');
    assert.deepEqual(pageMessages, []);

    ctx.dom.window.close();
});

test('the keep-alive TTL hard-destroys the parked frame when it expires', async () => {
    const ctx = await bootLoadedFrame();
    const { window, frame, dispatchPage, frameMessages, timers } = ctx;
    dispatchPage({ type: 'destroy' });
    assert.equal(frame!.style.opacity, '0');
    assert.equal(timers.length, 1);

    frameMessages.length = 0;
    timers[0](); // fire the 5-minute TTL
    assert.equal(frameMessages.at(-1)!.type, 'destroy', 'the frame is fully destroyed at expiry');
    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, null, 'the iframe is removed');
    ctx.dom.window.close();
});

test('a destroy that races the boot hard-destroys instead of suspending', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport"><iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe></div>
    </body>`, { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', runScripts: 'outside-only' });
    const { window } = dom;
    const pageMessages: TestMessage[] = [];
    Object.assign(window, { chrome: chromeWith({ enable3dMap: true }) });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    const dispatchPage = (data: TestMessage) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));
    armTerrain(window);
    dispatchPage({ type: 'init', routeSegments: [[[48.7, -121.8], [48.71, -121.81]]], theme: 'light', cacheLimitMb: 512 });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.ok(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, 'the iframe was created');

    // No 'loaded' yet → destroy tears it down (nothing worth suspending).
    dispatchPage({ type: 'destroy' });
    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, null, 'the un-loaded frame is removed');
    assert.equal(pageMessages.at(-1)!.type, 'destroyed');
    dom.window.close();
});

test('disabling 3D tears down even a suspended frame immediately', async () => {
    const ctx = await bootLoadedFrame();
    const { window, frame, dispatchPage, timers } = ctx;
    dispatchPage({ type: 'destroy' });
    assert.equal(frame!.style.opacity, '0', 'the frame is suspended');
    assert.equal(timers.length, 1);

    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: false } });
    await new Promise(resolve => ctx.realSetTimeout(resolve, 0));
    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, null, 'the suspended frame is removed at once');
    ctx.dom.window.close();
});

test('cancelling 3D while activation is pending cannot mount an abandoned frame', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="bpb-map-viewport"></div></body>', {
        url: 'https://www.peakbagger.com/peak.aspx?pid=1', runScripts: 'outside-only',
    });
    const { window } = dom;
    const pending: ((value: unknown) => void)[] = [];
    Object.assign(window, { chrome: chromeWith({ enable3dMap: true }) });
    Object.defineProperty(window.chrome.runtime, 'sendMessage', {
        value: () => new Promise(resolve => pending.push(resolve)),
    });
    window.postMessage = () => {};
    window.eval(bridgeBundle);
    const dispatch = (type: string) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', type, focus: [48.7, -121.8] },
    }));
    const settle = () => new Promise(resolve => window.setTimeout(resolve, 0));
    try {
        await settle();
        armTerrain(window); dispatch('init'); dispatch('destroy');
        pending.shift()!({ ok: true, token: 'cancelled-activation', expiresAt: Date.now() + 10000 });
        await settle();
        assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, null,
            'a late activation cannot reopen a cancelled view');

        armTerrain(window); dispatch('init');
        pending.shift()!({ ok: true, token: 'fresh-activation', expiresAt: Date.now() + 10000 });
        await settle();
        assert.ok(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, 'a new user attempt still opens 3D');
    } finally { dispatch('destroy'); dom.window.close(); }
});

test('a real 3D request whose activation lapsed answers at once, and the analyzer view switch can restart 3D', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="bpb-map-viewport"></div><button class="bpb-gpx-segment-view">Original</button></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', runScripts: 'outside-only',
    });
    const { window } = dom, messages: TestMessage[] = [];
    let reply: unknown = { ok: false }, issued = 0;
    Object.assign(window, { chrome: chromeWith({ enable3dMap: true }) });
    Object.defineProperty(window.chrome.runtime, 'sendMessage', { value: async () => { issued++; return reply; } });
    window.postMessage = message => { messages.push(message); };
    window.eval(bridgeBundle);
    const dispatch = (type: string) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin, data: { __bpbTerrain: true, dir: 'toCS', type, focus: [48.7, -121.8] },
    }));
    const settle = () => new Promise(resolve => window.setTimeout(resolve, 0));
    try {
        await settle();
        armTerrain(window); dispatch('requestConsent'); await settle();
        assert.deepEqual(messages.filter(item => item.type === 'consentResult').map(item => item.enabled), [false], 'A lapsed consent request releases the click');
        armTerrain(window); dispatch('init'); await settle();
        assert.equal(messages.at(-1)!.type, 'error'); assert.equal(messages.at(-1)!.reason, 'timeout');

        const before = issued;
        fireTrustedEvent(window.document.querySelector('.bpb-gpx-segment-view')!, 'click', { bubbles: true });
        assert.equal(issued, before, 'The switch mints nothing while 3D is closed');
        reply = { ok: true, token: 'open', expiresAt: Date.now() + 10000 };
        armTerrain(window); dispatch('init'); await settle();
        assert.ok(window.document.getElementById('bpb-terrain-frame'));
        const open = issued;
        fireTrustedEvent(window.document.querySelector('.bpb-gpx-segment-view')!, 'click', { bubbles: true });
        assert.equal(issued, open + 1, 'The trusted switch authorizes the restart it causes');
        fireTrustedEvent(window.document.getElementById('bpb-terrain-toggle')!, 'click', { bubbles: true });
        assert.equal(issued, open + 1, 'Leaving 3D mints nothing a forged message could spend');
    } finally { dispatch('destroy'); dom.window.close(); }
});

test('3D terrain bridge refuses forged page requests without trusted activation', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="bpb-map-viewport">
        <iframe src="https://www.peakbagger.com/map/MasterMap.aspx"></iframe>
      </div>
    </body>`, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const messages: TestMessage[] = [];
    Object.assign(window, { chrome: chromeWith({ enable3dMap: false }) });
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

    assert.equal(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null, null);
    assert.equal(messages.length, 0, 'a forged request gets no bridge response or frame');
    dom.window.close();
});

test('3D terrain consent is extension-owned, discloses the actual providers, and rejects scripted acceptance', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="bpb-terrain-toggle">3D</button><div id="bpb-map-viewport"></div></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages: TestMessage[] = [];
    Object.assign(window, { chrome: chromeWith({ enable3dMap: false, theme: 'light' }) });
    window.postMessage = message => { messages.push(message); };
    window.eval(bridgeBundle);

    const requestConsent = ({ trusted = true } = {}) => {
        if (trusted) armTerrain(window);
        window.dispatchEvent(new window.MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: { __bpbTerrain: true, dir: 'toCS', type: 'requestConsent' }
        }));
    };
    requestConsent({ trusted: false });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(window.document.querySelector<HTMLElement>('[role="dialog"]'), null,
        'host-page script cannot open extension consent with a forged bridge message');
    requestConsent();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    let dialog = window.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, 'the isolated-world bridge should own the confirmation UI');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.match(dialog.textContent, /Mapterhorn/);
    assert.match(dialog.textContent, /Microsoft Planetary Computer/);
    assert.match(dialog.textContent, /Hiking map tiles, labels and icons, when selected/);
    assert.match(dialog.textContent, /selected 2D map layer.*provider named/i);
    assert.match(dialog.textContent, /enable them later in Better Peakbagger Settings/i);
    assert.deepEqual(Array.from(dialog.querySelectorAll('a'), link => [link.textContent, new URL(link.href).hostname]), [
        ['Privacy notice', 'mapterhorn.com'],
        ['Privacy notice', 'www.maptoolkit.org'],
        ['Privacy notice', 'privacy.microsoft.com']
    ]);
    const featureEnabled = async () =>
        (await window.chrome.storage.sync.get('bpbSettings') as { bpbSettings: { enable3dMap: boolean } }).bpbSettings.enable3dMap;
    assert.equal(await featureEnabled(), false, 'opening the confirmation must not change the setting');

    dialog.querySelector<HTMLElement>('.bpb-terrain-consent-secondary')!.click();
    assert.equal(window.document.querySelector<HTMLElement>('[role="dialog"]'), null);
    assert.equal(messages.at(-1)!.type, 'consentResult');
    assert.equal(messages.at(-1)!.enabled, false);
    assert.equal(await featureEnabled(), false, 'declining must keep the feature off');

    requestConsent();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dialog = window.document.querySelector<HTMLElement>('[role="dialog"]');
    dialog!.querySelector<HTMLElement>('.bpb-terrain-consent-primary')!.click();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(await featureEnabled(), false,
        'host-page script must not enable an extension feature through DOM click()');
    assert.ok(window.document.querySelector<HTMLElement>('[role="dialog"]'), 'scripted acceptance must leave the confirmation open');
    dialog!.querySelector<HTMLElement>('.bpb-terrain-consent-secondary')!.click();
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
    Object.assign(window, { chrome: chromeWith({ enable3dMap: false }) });
    // Defer the initial storage read so a subscribe push can land before it.
    let resolveInitialGet!: () => void;
    window.chrome.storage.sync.get = () => new Promise(resolve => {
        resolveInitialGet = () => resolve({ bpbSettings: { enable3dMap: false } } as never);
    });
    window.postMessage = () => {};
    window.eval(bridgeBundle);

    // A newer enabling push arrives before the initial read resolves.
    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: true } });
    armTerrain(window);
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
    resolveInitialGet!(); // the stale initial read resolves (disabled), after the push
    await new Promise(resolve => window.setTimeout(resolve, 0));

    assert.ok(window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null,
        'the stale initial read must not undo the newer enabled setting');
    dom.window.close();
});

test('the extension frame starts no renderer for missing, rejected, or replayed activation', () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const maps: StubMap[] = [];
    const messages: TestMessage[] = [];
    let removals = 0;
    const validTokens = new Set(['one-use']);
    window.authorizeTerrain = ({ token, action }: { token: string; action: string }) => {
        if (action !== 'init' || !validTokens.delete(token)) return false;
        return true;
    };
    class MapStub {
        declare options: StubOptions;
        constructor(options: StubOptions) { this.options = options; maps.push(this as unknown as StubMap); }
        addControl() {}
        once() {}
        on() {}
        remove() { removals += 1; }
    }
    Object.assign(window, { chrome: { runtime: { getURL: (resource: string) => `chrome-extension://test-id/${resource}` } } });
    window.maplibregl = {
        Map: MapStub,
        NavigationControl: class {},
        ScaleControl: class {},
        AttributionControl: class {},
        setWorkerUrl() {}, addProtocol() {}, removeProtocol() {}
    };
    (window as unknown as Record<string, unknown>).fetch = () => { throw new Error('authorization failure must not fetch'); };
    window.postMessage = message => { messages.push(message); };
    window.eval(frameBundle);
    const dispatch = (activation: string | undefined, generation: number) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrainFrame: true,
            dir: 'toFrame',
            type: 'init',
            activation,
            generation,
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
        }
    }));

    dispatch(undefined, 5);
    dispatch('guessed', 6);
    assert.equal(maps.length, 0);
    dispatch('one-use', 7);
    assert.equal(maps.length, 1);
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrainFrame: true, dir: 'toFrame', type: 'destroy', generation: 6 }
    }));
    assert.equal(removals, 0, 'a stale generation cannot tear down the active renderer');
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrainFrame: true, dir: 'toFrame', type: 'destroy', generation: 7 }
    }));
    assert.equal(removals, 1);
    assert.equal(messages.at(-1)!.type, 'destroyed');
    assert.equal(messages.at(-1)!.generation, 7, 'frame replies echo the generation that authorized them');
    dispatch('one-use', 8);
    assert.equal(maps.length, 1, 'the consumed token cannot build a second renderer');
    dom.window.close();
});

test('3D terrain frame validates coordinate-only routes before loading public DEM tiles', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages: TestMessage[] = [];
    const maps: StubMap[] = [];
    const protocolHandlers = new Map();
    const popups: StubPopup[] = [];
    const markers: { removed?: boolean; options: { opacityWhenCovered?: number; element: HTMLElement }; lngLat?: unknown; target?: unknown }[] = [];
    const gestureHintTimers: Handler[] = [];
    let workerUrl = '';

    const realSetTimeout = window.setTimeout.bind(window);
    (window as unknown as Record<string, unknown>).setTimeout = (callback: Handler, delay: number, ...args: unknown[]) => {
        if (delay === 6000) {
            gestureHintTimers.push(callback);
            return 6000;
        }
        return realSetTimeout(callback, delay, ...args);
    };

    class MapStub {
        declare cameraCenter: unknown;
        declare cameraZoom: number;
        declare canvas: HTMLCanvasElement;
        declare controls: StubControl[];
        declare data: unknown;
        declare fitted: unknown;
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare layout: unknown[];
        declare options: StubOptions;
        declare paint: unknown[];
        declare removed: boolean;
        declare renderCalls: unknown[];
        declare routeHit: unknown;
        declare sourceDataOutcomes: Map<string, unknown[]>;
        declare sources: Map<string, StubSource>;
        constructor(options: StubOptions) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.paint = [];
            this.layout = [];
            this.controls = [];
            this.handlers = new Map();
            this.removed = false;
            this.renderCalls = [];
            this.canvas = window.document.createElement('canvas');
            this.sourceDataOutcomes = new Map();
            maps.push(this as unknown as StubMap);
        }
        addControl(control: StubControl, position: [number, number]) { this.controls.push({ control, position } as StubControl); }
        once(type: string, callback: Handler) {
            if (type === 'load') window.queueMicrotask(callback);
        }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) {
            const outcomes = this.sourceDataOutcomes;
            const stored = {
                ...source,
                setData(data: StubSourceData) {
                    const outcome = outcomes.get(id)?.shift();
                    if (!outcome) {
                        this.data = data;
                        return undefined;
                    }
                    return Promise.resolve(outcome).then(() => { this.data = data; });
                }
            };
            this.sources.set(id, stored);
        }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); }
        getCanvas() { return this.canvas; }
        removeSource(id: string) { this.sources.delete(id); }
        setPaintProperty(...args: unknown[]) { this.paint.push(args); }
        setLayoutProperty(...args: unknown[]) { this.layout.push(args); }
        fitBounds(bounds: unknown, options: StubOptions) { this.fitted = { bounds, options }; }
        getCenter() {
            const center = (this.cameraCenter || this.options.center || [
                (this.options.bounds![0][0] + this.options.bounds![1][0]) / 2,
                (this.options.bounds![0][1] + this.options.bounds![1][1]) / 2
            ]) as number[];
            return { lng: center[0], lat: center[1] };
        }
        getZoom() { return this.cameraZoom ?? this.options.zoom ?? 12; }
        queryRenderedFeatures() { return this.routeHit ? [this.routeHit] : []; }
        resize() { this.renderCalls.push('resize'); }
        redraw() { this.renderCalls.push('redraw'); }
        remove() { this.removed = true; }
    }

    class MarkerStub {
        declare lngLat: unknown;
        declare options: StubOptions;
        declare removed: boolean;
        declare target: unknown;
        constructor(options: StubOptions) { this.options = options; markers.push(this as unknown as (typeof markers)[number]); }
        setLngLat(lngLat: [number, number]) { this.lngLat = lngLat; return this; }
        addTo(target: unknown) { this.target = target; return this; }
        remove() { this.removed = true; return this; }
    }

    const resizeObservers: { callback: Handler; observed: Element[]; disconnected?: boolean }[] = [];
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
        declare callback: Handler; declare observed: Element[]; declare disconnected: boolean;
        constructor(callback: Handler) {
            this.callback = callback;
            this.observed = [];
            resizeObservers.push(this as unknown as { callback: Handler; observed: Element[] });
        }
        observe(element: Element) { this.observed.push(element); }
        disconnect() { this.disconnected = true; }
    };

    const dispatch = bootTerrainFrame(window, MapStub, {
        messages, popups,
        maplibre: {
            Marker: MarkerStub,
            setWorkerUrl(url: string) { workerUrl = url; },
            addProtocol(name: string, handler: StubProtocol) { protocolHandlers.set(name, handler); },
            removeProtocol(name: string) { protocolHandlers.delete(name); }
        }
    });

    dispatch({ type: 'init', routeSegments: [[[48.7, -121.8, 1000], [48.71, -121.81, 1200]]] });
    assert.equal(maps.length, 0, 'points with extra elevation data must fail closed');
    assert.equal(messages.at(-1)!.type, 'error');

    const oversizedRoute = Array.from({ length: 3001 }, (_, index) => [48.7 + index / 1000000, -121.8]);
    dispatch({ type: 'init', routeSegments: [oversizedRoute] });
    assert.equal(maps.length, 0, 'routes above the 3,000-point privacy and rendering cap must fail closed');
    assert.equal(messages.at(-1)!.type, 'error');

    dispatch({ type: 'init', focus: [99, -121.8] });
    assert.equal(maps.length, 0, 'an invalid summit focus must fail before public DEM tiles can load');
    assert.equal(messages.at(-1)!.type, 'error');

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
        zoomControl: { right: 10, bottom: 43, width: 34, height: 64 },
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
    assert.equal(window.document.querySelector<HTMLElement>('.bpb-terrain-hint')?.hidden, true,
        'gesture instructions stay hidden while the terrain map is still loading');
    await new Promise<void>(resolve => window.queueMicrotask(resolve));

    assert.equal(maps.length, 1);
    const map = maps[0];
    const mapElement = window.document.getElementById('bpb-terrain-map');
    assert.equal(mapElement!.style.getPropertyValue('--bpb-zoom-bottom'), '43px');
    assert.equal(mapElement!.style.getPropertyValue('--bpb-zoom-width'), '34px');
    dispatch({ type: 'zoomControl', zoomControl: { right: 12, bottom: 60, width: 34, height: 64 } });
    assert.equal(mapElement!.style.getPropertyValue('--bpb-zoom-bottom'), '60px', 'resize updates the measured native zoom anchor');
    for (const bottom of [-1, Infinity, '80px', 10001]) {
        dispatch({ type: 'zoomControl', zoomControl: { right: 10, bottom, width: 34, height: 64 } });
        assert.equal(mapElement!.style.getPropertyValue('--bpb-zoom-bottom'), '60px', 'untrusted layout values cannot enter CSS');
    }
    assert.equal(workerUrl, 'chrome-extension://test-id/vendor/maplibre-gl-worker.mjs');
    assert.equal(map.options.zoomLevelsToOverscale, undefined,
        'the v6 overscaling default stays disabled until a separate measured decision');
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.style.sources.terrain.tiles)), ['bpb-dem://{z}/{x}/{y}.webp']);
    assert.equal(map.options.style.sources.terrain.encoding, 'terrarium');
    assert.ok(protocolHandlers.has('bpb-dem'));
    assert.equal(map.options.style.terrain!.exaggeration, 1, 'terrain must not distort mountaineering geometry');
    assert.deepEqual(Object.keys(map.options.style.sources), ['terrain'],
        'the constructor style stays terrain-only so a pending drape cannot gate MapLibre load');
    assert.equal(map.options.style.layers.some(layer => layer.id === 'basemap'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(map.getSource('basemap').tiles)), ['https://a.tile.example.com/{z}/{x}/{y}.png']);
    assert.equal(map.getSource('basemap').tileSize, 256);
    const osmTile = 'https://tile.openstreetmap.org/0/0/0.png';
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.transformRequest!(osmTile, 'Tile'))), { url: osmTile },
        'raster requests preserve browser caching and identity defaults without injecting headers or a cache bypass');
    assert.match(map.getSource('basemap').attribution!, /https:\/\/example\.com\/copyright/);
    assert.doesNotMatch(map.getSource('basemap').attribution!, /script|alert/i);
    assert.equal(map.layers.find(layer => layer.id === 'basemap')!.paint!['raster-opacity'], 0.78);
    assert.equal(map.options.style.layers.find(layer => layer.id === 'terrain-hillshade')!.paint!['hillshade-illumination-anchor'], 'map',
        'hillshade is anchored to the map, so rotating/tilting the camera does not swing the light and flip the shading');
    const picker = () => framePicker(window);
    const notice = () => window.document.querySelector<HTMLElement>('.bpb-terrain-notice');
    assert.ok(picker(), 'a drape picker is shown when a layer is offered');
    assert.equal(picker().options[picker().selectedIndex].textContent, 'Open Topo Map',
        'the picker labels and selects the active drape');
    assert.ok(Array.from(picker().options).some(option => option.textContent === 'Terrain only'),
        'the picker always offers a terrain-only choice');
    const hint = window.document.querySelector<HTMLElement>('.bpb-terrain-hint');
    assert.ok(hint, 'a gesture hint is shown when the terrain map becomes interactive');
    assert.equal(hint.hidden, false, 'the hint waits until the map is usable before starting its teaching window');
    assert.match(hint.textContent, /Drag to pan/);
    assert.match(hint.textContent, /scroll to zoom/);
    assert.match(hint.textContent, /right-drag to tilt/);
    assert.doesNotMatch(hint.textContent, /⌘|Ctrl/,
        'plain scroll zooms — the hint must not demand a modifier key');
    assert.equal(gestureHintTimers.length, 1, 'the gesture hint gets one post-load dismissal timer');
    window.document.getElementById('bpb-terrain-map')!.dispatchEvent(new window.Event('wheel', { bubbles: true }));
    assert.equal(hint.classList.contains('bpb-terrain-hint-dismissed'), true,
        'the first map interaction immediately dismisses the gesture hint');
    assert.equal(hint.getAttribute('aria-hidden'), 'true',
        'a dismissed visual hint also leaves the accessibility tree');
    hint.classList.remove('bpb-terrain-hint-dismissed');
    hint.removeAttribute('aria-hidden');
    gestureHintTimers[0]();
    assert.equal(hint.classList.contains('bpb-terrain-hint-dismissed'), true,
        'the post-load timeout dismisses an unread gesture hint');
    assert.match(terrainCss, /\.bpb-terrain-hint-dismissed\s*\{[^}]*opacity:\s*0/s,
        'the dismissed state visually clears the attribution');
    assert.ok(!map.options.cooperativeGestures,
        'cooperative gestures would require a modifier to scroll-zoom, unlike the 2D map');
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-route')!.data)), {
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
    map.routeHit = map.sources.get('bpb-route')!.data!.features[0];
    map.handlers.get('click')!({ point: { x: 200, y: 150 }, lngLat: { lng: -121.805, lat: 48.705 } });
    assert.equal(popups.length, 1, 'clicking a route with validated metadata opens its ascent popup');
    const routeLink = popups[0].node.querySelector('a');
    assert.equal(routeLink!.href, 'https://www.peakbagger.com/climber/ascent.aspx?aid=3230293');
    assert.equal(routeLink!.textContent, '2026-06-12 - Fei (Kautz Glacier) TR-98');
    assert.equal(routeLink!.target, '_blank');
    assert.equal(routeLink!.rel, 'noopener noreferrer');
    // The camera is framed on the route at construction, not re-fitted after
    // 'load' — fitting later would load a throwaway tileset for the placeholder
    // view and rebuild the terrain mesh, the dominant chunk of load time.
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.bounds)), [[-121.82, 48.7], [-121.8, 48.76]]);
    assert.equal(map.options.fitBoundsOptions!.maxZoom, 15.5);
    assert.equal(map.options.fitBoundsOptions!.pitch, 60);
    assert.equal(map.fitted, undefined, 'no redundant post-load fitBounds');
    assert.equal(window.document.getElementById('bpb-terrain-map')!.style.pointerEvents, 'auto');
    assert.equal(messages.filter(message => message.type !== 'locationDismiss').at(-1)!.type, 'loaded');
    assert.equal(map.handlers.has('data'), true,
        'the frame reports loaded without waiting for a drape tile data event');
    map.handlers.get('error')!({ sourceId: 'terrain', error: new Error('one DEM tile failed') });
    assert.equal(map.removed, false, 'a post-load source error remains a recoverable coverage gap');
    assert.equal(messages.filter(message => message.type !== 'locationDismiss').at(-1)!.type, 'loaded', 'recoverable source errors stay silent to the page');
    map.handlers.get('contextmenu')!({ lngLat: { lat: 48.7, wrap: () => ({ lng: -121.8 }) }, originalEvent: { clientX: 20, clientY: 30 } });
    assert.equal(messages.at(-1)!.type, 'locationContext', 'route terrain exposes a location without a focus peak');

    // macOS Firefox rewrites Ctrl + primary-button mousedown to button=2 but
    // leaves buttons=1. MapLibre cannot continue that internally inconsistent
    // gesture when the following moves arrive as primary-button events.
    const canvas = window.document.getElementById('bpb-terrain-canvas');
    const gestureTarget = window.document.createElement('span');
    canvas!.append(gestureTarget);
    const starts: unknown[] = [];
    canvas!.addEventListener('mousedown', event => starts.push({
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
    assert.ok(frameObserver.observed.includes(window.document.getElementById('bpb-terrain-map')!));
    frameObserver.callback();
    assert.deepEqual(map.renderCalls, ['resize', 'redraw'],
        'a resize repaints in the same task so the cleared canvas is never composited');

    dispatch({ type: 'highlight', coordinates: [-121.81, 48.71], series: 'time' });
    assert.deepEqual(JSON.parse(JSON.stringify(map.sources.get('bpb-highlight')!.data!.geometry)), {
        type: 'Point', coordinates: [-121.81, 48.71]
    });
    assert.ok(map.paint.some((call: unknown[]) => call[0] === 'bpb-highlight'
        && call[1] === 'circle-color' && call[2] === '#0055ff'),
    'the time-series chaser is blue in 3D');

    dispatch({ type: 'highlight', coordinates: [-121.81, 48.71], series: 'unsupported' });
    assert.deepEqual(map.paint.at(-1), ['bpb-highlight', 'circle-color', '#ff3b30'],
        'the terrain frame does not treat an unknown series as a color');

    const activeHighlight = withResolvers();
    map.sourceDataOutcomes.set('bpb-highlight', [activeHighlight.promise]);
    dispatch({ type: 'highlight', coordinates: [-121.805, 48.705], series: 'distance' });
    assert.deepEqual(map.layout.at(-1), ['bpb-highlight', 'visibility', 'none'],
        'an asynchronous highlight stays hidden until the worker accepts it');
    activeHighlight.reject(new Error('highlight worker rejected'));
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    assert.equal(map.removed, false, 'an optional highlight rejection does not kill healthy terrain');
    assert.deepEqual(map.layout.at(-1), ['bpb-highlight', 'visibility', 'none'],
        'an actively rejected highlight cannot leave its stale dot visible');

    const acceptedHighlight = withResolvers();
    map.sourceDataOutcomes.set('bpb-highlight', [acceptedHighlight.promise]);
    dispatch({ type: 'highlight', coordinates: [-121.806, 48.706], series: 'distance' });
    acceptedHighlight.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.deepEqual(map.layout.at(-1), ['bpb-highlight', 'visibility', 'visible'],
        'the current successful source update restores its overlay');

    // A scrub faster than worker acks must still show the dot: one update in
    // flight, the newest queued, and every superseded position skipped.
    const firstScrub = withResolvers(), lastScrub = withResolvers();
    map.sourceDataOutcomes.set('bpb-highlight', [firstScrub.promise, lastScrub.promise]);
    dispatch({ type: 'highlight', coordinates: [-121.801, 48.701], series: 'distance' });
    dispatch({ type: 'highlight', coordinates: [-121.802, 48.702], series: 'distance' });
    dispatch({ type: 'highlight', coordinates: [-121.803, 48.703], series: 'distance' });
    assert.equal(map.sourceDataOutcomes.get('bpb-highlight')!.length, 1, 'Only the in-flight update reached the worker');
    firstScrub.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(map.sourceDataOutcomes.get('bpb-highlight')!.length, 0, 'The newest queued position follows its ack');
    lastScrub.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.deepEqual(map.layout.at(-1), ['bpb-highlight', 'visibility', 'visible'], 'The dot appears once the newest position lands');

    dispatch({
        type: 'update',
        routeStyle: { color: '#347a3f', width: 6, casingColor: '#ffffff', casingWidth: 10 },
        theme: 'light'
    });
    assert.ok(map.paint.some((call: unknown[]) => call[0] === 'bpb-route' && call[1] === 'line-color' && call[2] === '#347a3f'));
    assert.equal(window.document.getElementById('bpb-terrain-map')!.dataset.theme, 'light');

    // A drape that loaded at least one tile must survive sparse later tile
    // failures: one error is no longer enough to tear the whole layer down.
    map.handlers.get('data')!({ sourceId: 'basemap', dataType: 'source', tile: {} });
    map.handlers.get('error')!({ sourceId: 'basemap' });
    map.handlers.get('idle')!();
    assert.equal(picker().value, '0', 'a drape that rendered a tile stays selected');
    assert.equal(picker().options[0].disabled, false, 'a working drape is not disabled');
    assert.equal(notice()!.hidden, true, 'no failure notice for a drape that rendered a tile');

    // A parked frame stays idle through host resizes and catches up once on resume.
    const sized: string[] = [], { resize: stubResize } = map as unknown as { resize: () => void };
    Object.assign(map, { resize() { sized.push('resize'); stubResize.call(map); }, redraw() { sized.push('redraw'); }, fitBounds() { sized.push('camera'); } });
    dispatch({ type: 'suspend' });
    for (const observer of resizeObservers) observer.callback();
    assert.deepEqual(sized, [], 'A parked frame does not redraw on host resize');
    dispatch({ type: 'resume', routeSegments, theme: 'light' });
    assert.deepEqual(sized, ['resize', 'camera', 'redraw'], 'Resume frames the route at the new size and refills the canvas');
    Object.assign(map, { resize: stubResize, redraw: undefined, fitBounds() {} });

    const staleHighlight = withResolvers();
    const rejectedRoute = withResolvers();
    map.sourceDataOutcomes.set('bpb-highlight', [staleHighlight.promise]);
    map.sourceDataOutcomes.set('bpb-route', [rejectedRoute.promise]);
    dispatch({ type: 'highlight', coordinates: [-121.807, 48.707], series: 'distance' });
    dispatch({ type: 'resume', routeSegments, theme: 'light' });
    rejectedRoute.reject(new Error('route worker rejected'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(map.removed, true,
        'rejecting the current route replacement restores authoritative 2D instead of showing the old trip');
    assert.equal(messages.at(-1)!.reason, 'renderer');
    const messagesAfterRouteFailure = messages.length;
    staleHighlight.reject(new Error('map was removed'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(messages.length, messagesAfterRouteFailure,
        'a source rejection after teardown is handled as stale work and reports no second failure');

    dispatch({ type: 'destroy' });
    assert.equal(map.removed, true);
    assert.equal(protocolHandlers.has('bpb-dem'), false);
    assert.equal(window.document.getElementById('bpb-terrain-map'), null);
    assert.equal(messages.at(-1)!.type, 'destroyed');

    dispatch({
        type: 'init',
        routeSegments,
        basemap: {
            name: 'Unsafe local layer',
            tiles: ['https://127.0.0.1/{z}/{x}/{y}.png']
        }
    });
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
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
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    const grouped = maps.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(grouped!.options.center)), [-122.33, 47.61],
        'a validated 2D camera overrides the route-wide initial framing');
    assert.equal(grouped!.options.zoom, 12.25);
    assert.equal(grouped!.options.bounds, undefined);
    assert.deepEqual(
        JSON.parse(JSON.stringify(grouped!.sources.get('bpb-route')!.data!.features.map(feature => feature.properties.color))),
        ['#e34a33', '#3182bd'],
        'each group-map track keeps its own native color');
    assert.deepEqual(
        JSON.parse(JSON.stringify(grouped!.layers.find(layer => layer.id === 'bpb-route')!.paint!['line-color'])),
        ['coalesce', ['get', 'color'], '#2457a7'],
        'the route line is painted from each track color, not one flat color');
    grouped!.cameraCenter = [-122.29, 47.64];
    grouped!.cameraZoom = 13.5;
    grouped!.handlers.get('moveend')!();
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
    grouped!.handlers.get('error')!({ error: new Error('renderer stopped') });
    assert.equal(grouped!.removed, true, 'a source-less post-load renderer error tears down the dead canvas');
    assert.equal(messages.at(-1)!.type, 'error');
    assert.equal(messages.at(-1)!.reason, 'renderer');

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
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    const blocked = maps.at(-1);
    assert.equal(picker().options[picker().selectedIndex].textContent, 'Blocked Layer',
        'the picker starts on the layer name before any tile is attempted');
    blocked!.handlers.get('error')!({ sourceId: 'basemap' });
    blocked!.handlers.get('error')!({ sourceId: 'basemap' });
    blocked!.handlers.get('idle')!();
    assert.equal(picker().value, 'terrain',
        'a drape whose every tile fails is dropped to terrain-only at the first idle');
    assert.equal(picker().options[0].disabled, false, 'a temporary failure must leave the layer available to retry');
    assert.equal(notice()!.hidden, false);
    assert.match(notice()!.textContent, /Blocked Layer.*couldn’t load.*Select it again to retry/s,
        'the notice names the layer and a recovery action without inventing a cause');

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
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    const focused = maps.at(-1);
    focused!.handlers.get('contextmenu')!({ lngLat: { lat: 46.8, wrap: () => ({ lng: -121.7 }) }, originalEvent: { clientX: 30, clientY: 40 } });
    assert.equal(messages.at(-1)!.type, 'locationContext');
    assert.equal(messages.at(-1)!.latitude, 46.8); assert.equal(messages.at(-1)!.longitude, -121.7);
    const pickerPointer = new window.Event('pointerdown', { bubbles: true, cancelable: true });
    window.document.getElementById('bpb-terrain-map')!.dispatchEvent(pickerPointer);
    assert.equal(pickerPointer.defaultPrevented, false); assert.ok(messages.slice(-2).some(message => message.type === 'locationDismiss'));
    const weatherWheel = new window.Event('wheel', { bubbles: true, cancelable: true });
    window.document.querySelector<HTMLElement>('#bpb-terrain-map')!.dispatchEvent(weatherWheel);
    assert.equal(weatherWheel.defaultPrevented, false); assert.ok(messages.slice(-2).some(message => message.type === 'locationDismiss'));
    assert.deepEqual(JSON.parse(JSON.stringify(focused!.options.center)), [-121.60214, 48.83115]);
    assert.equal(focused!.options.zoom, 13);
    assert.equal(focused!.options.bounds, undefined, 'a summit view does not synthesize route bounds');
    assert.deepEqual(JSON.parse(JSON.stringify(focused!.getSource('bpb-route').data)), {
        type: 'FeatureCollection', features: []
    }, 'a summit view carries an honest empty route source');
    const focusedPeaks = () => JSON.parse(JSON.stringify(focused!.getSource('bpb-peaks').data!.features));
    assert.deepEqual(focusedPeaks(), [{
        type: 'Feature',
        properties: { id: 2829, name: 'Mount Shuksan', state: 'unclimbed' },
        geometry: { type: 'Point', coordinates: [-121.60214, 48.83115] }
    }]);
    const focusMarker = markers.findLast(marker => !marker.removed);
    assert.ok(focusMarker, 'the summit ring uses MapLibre terrain-aware marker placement');
    assert.deepEqual(JSON.parse(JSON.stringify(focusMarker.lngLat)), [-121.60214, 48.83115]);
    assert.equal(focusMarker.options.opacityWhenCovered, 0.95,
        'coarse terrain depth cannot hide a navigational summit dot');
    assert.equal(focusMarker.options.element.tagName, 'BUTTON');
    assert.equal(focusMarker.options.element.getAttribute('aria-label'), 'Mount Shuksan');
    assert.equal(focusMarker.options.element.style.getPropertyValue('--bpb-peak-color'), '#ff6699');
    assert.match(terrainCss, /\.bpb-terrain-peak-marker\s*\{[^}]*cursor:\s*pointer/s,
        'the button owns its pointer cursor without mutating persistent canvas state');
    const popupsBeforeMarkerClick = popups.length;
    focusMarker.options.element.click();
    assert.equal(popups.length, popupsBeforeMarkerClick + 1,
        'the terrain-aware marker preserves the existing name-link popup');
    assert.equal(popups.at(-1)!.node.querySelector('a')!.href,
        'https://www.peakbagger.com/peak.aspx?pid=2829');

    const markersBeforeRefresh = markers.length;
    dispatch({ type: 'peaks', unavailable: true });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(markers.length, markersBeforeRefresh, 'An unchanged dot is reused, not rebuilt');
    assert.equal(focusMarker.removed, undefined, 'A reused dot keeps its element and keyboard focus');

    const rejectedPeaks = withResolvers();
    focused!.sourceDataOutcomes.set('bpb-peaks', [rejectedPeaks.promise]);
    dispatch({ type: 'peaks', unavailable: true });
    rejectedPeaks.reject(new Error('peak worker rejected'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(focused!.removed, false, 'an optional peak overlay rejection does not kill healthy terrain');
    assert.equal(markers.some(marker => !marker.removed), false,
        'an actively rejected peak update removes stale navigational dots');
    assert.deepEqual(focused!.layout.at(-1), ['bpb-peaks-ring', 'visibility', 'none']);

    dispatch({ type: 'peaks', unavailable: true });
    assert.equal(focusedPeaks().length, 1, 'the subject peak remains when the nearby feed is unavailable');

    const contextLoss = new window.Event('webglcontextlost', { cancelable: true });
    assert.equal(focused!.canvas.dispatchEvent(contextLoss), false,
        'the frame cancels MapLibre restoration when it deliberately falls back to 2D');
    assert.equal(focused!.removed, true, 'WebGL context loss tears down the unusable renderer');
    assert.equal(messages.at(-1)!.type, 'error');
    assert.equal(messages.at(-1)!.reason, 'renderer');

    dom.window.close();
});

test('the 3D drape picker offers every layer and swaps the draped raster live', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const maps: StubMap[] = [];

    class MapStub {
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare loadCallback: Handler;
        declare options: StubOptions;
        declare sources: Map<string, StubSource>;
        constructor(options: StubOptions) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.handlers = new Map();
            maps.push(this as unknown as StubMap);
        }
        addControl() {}
        once(type: string, callback: Handler) { if (type === 'load') this.loadCallback = callback; }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData() {} }); }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); }
        removeSource(id: string) { this.sources.delete(id); }
        setPaintProperty() {}
        fitBounds() {}
        resize() {}
        remove() {}
    }

    bootTerrainFrame(window, MapStub);

    const routeSegments = [[[48.7, -121.8], [48.71, -121.81]]];
    const layer = (name: string, host: string) => ({ name, tiles: [`https://${host}/{z}/{x}/{y}.png`] });
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrainFrame: true, dir: 'toFrame', type: 'init', routeSegments,
            basemap: layer('MyTopo', 'mt.example.com'),
            basemaps: [layer('CalTopo', 'ct.example.com'), layer('MyTopo', 'mt.example.com'), layer('OpenTopo', 'ot.example.com')]
        }
    }));
    const picker = () => framePicker(window);
    const map = maps[0];
    assert.deepEqual(Array.from(picker().options, option => option.textContent),
        ['CalTopo', 'MyTopo', 'OpenTopo', 'Maptoolkit Hiking (BPB experiment)', 'Terrain only'],
        'the picker offers every layer plus the vector entry and terrain-only');
    assert.equal(picker().options[picker().selectedIndex].textContent, 'MyTopo',
        'the initially-selected native layer is preselected');

    const swap = (value: string) => {
        picker().value = value;
        picker().dispatchEvent(new window.Event('change'));
    };

    assert.deepEqual(Object.keys(map.options.style.sources), ['terrain'],
        'even a configured drape is absent from the constructor style');
    swap('0');
    assert.equal(map.getSource('basemap'), undefined,
        'a picker change made during boot is queued instead of mutating an unloaded style');
    map.loadCallback();
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(map.getSource('basemap').tiles)),
        ['https://ct.example.com/{z}/{x}/{y}.png'], 'the queued pre-load selection applies as soon as terrain is ready');
    assert.equal(picker().options[picker().selectedIndex].textContent, 'CalTopo');

    swap('terrain');
    assert.equal(map.getSource('basemap'), undefined, 'terrain-only removes the drape');
    assert.equal(map.getLayer('basemap'), undefined);

    // A failed layer returns to terrain-only and stays available for retry.
    swap('2');
    assert.equal(JSON.parse(JSON.stringify(map.getSource('basemap').tiles))[0], 'https://ot.example.com/{z}/{x}/{y}.png');
    map.handlers.get('idle')!(); // An early settle must not disarm the failure check.
    map.handlers.get('error')!({ sourceId: 'basemap' });
    map.handlers.get('idle')!();
    assert.equal(picker().value, 'terrain', 'a failed manual selection reverts to terrain-only');
    assert.equal(picker().options[2].disabled, false, 'the failed layer remains retryable');
    const notice = window.document.querySelector<HTMLElement>('.bpb-terrain-notice');
    assert.match(notice!.textContent, /OpenTopo.*couldn’t load/);
    assert.doesNotMatch(notice!.textContent, /CORS|cross-origin/);
    picker().focus();
    picker().value = '2'; picker().dispatchEvent(new window.Event('change'));
    assert.equal(picker().value, '2', 'the same layer can be selected again after a transient block');
    assert.ok(map.getSource('basemap'), 'retry restores the raster source');
    assert.equal(notice!.hidden, true, 'retry clears the previous failure while the new tiles load');
    assert.equal(window.document.activeElement, picker(), 'retry retains keyboard focus on the existing picker');
    map.handlers.get('data')!({ sourceId: 'basemap', dataType: 'source', tile: {} });
    map.handlers.get('idle')!();
    assert.equal(picker().value, '2'); assert.equal(notice!.hidden, true);
    map.handlers.get('error')!({ sourceId: 'basemap', error: { status: 403 } });
    assert.equal(picker().value, 'terrain', 'an explicit policy denial is handled even after good tiles rendered');
    assert.match(notice!.textContent, /Select it again to retry/);
    picker().value = 'terrain'; picker().dispatchEvent(new window.Event('change'));
    assert.equal(notice!.hidden, true, 'a deliberate switch to terrain-only does not retain a stale provider warning');

    dom.window.close();
});

test('re-entering 3D drapes the raster layer chosen in 2D, without rebuilding an unchanged one', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const { window } = dom;
    let map!: StubMap, added = 0;
    class MapStub {
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare loadCallback: Handler;
        declare options: StubOptions;
        declare sources: Map<string, StubSource>;
        constructor(options: StubOptions) { this.options = options; this.sources = new Map(); this.layers = []; this.handlers = new Map(); map = this as unknown as StubMap; }
        addControl() {}
        once(type: string, callback: Handler) { if (type === 'load') this.loadCallback = callback; }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) { if (id === 'basemap') added++; this.sources.set(id, { ...source, setData() {} }); }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); }
        removeSource(id: string) { this.sources.delete(id); }
        setPaintProperty() {} fitBounds() {} resize() {} remove() {}
    }
    const dispatch = bootTerrainFrame(window, MapStub);
    try {
        const routeSegments = [[[48.7, -121.8], [48.71, -121.81]]];
        const layer = (name: string, host: string) => ({ name, tiles: [`https://${host}/{z}/{x}/{y}.png`] });
        const basemaps = [layer('CalTopo', 'ct.example.com'), layer('MyTopo', 'mt.example.com')];
        const tiles = () => JSON.parse(JSON.stringify(map.getSource('basemap').tiles))[0];
        dispatch({ type: 'init', routeSegments, basemap: basemaps[0], basemaps });
        map!.loadCallback();
        await new Promise<void>(resolve => window.queueMicrotask(resolve));
        assert.equal(tiles(), 'https://ct.example.com/{z}/{x}/{y}.png');
        assert.equal(added, 1);
        map!.handlers.get('data')!({ sourceId: 'basemap', dataType: 'source', tile: {} });

        dispatch({ type: 'suspend' });
        dispatch({ type: 'resume', routeSegments, basemap: basemaps[0], basemaps });
        assert.equal(added, 1, 'an unchanged layer keeps its loaded source across a mode switch');
        map!.handlers.get('error')!({ sourceId: 'basemap' }); map!.handlers.get('idle')!();
        assert.equal(framePicker(window).options[framePicker(window).selectedIndex].textContent, 'CalTopo',
            'a tile gap after resume does not discard a layer that already rendered');

        dispatch({ type: 'suspend' });
        dispatch({ type: 'resume', routeSegments, basemap: basemaps[1], basemaps });
        assert.equal(tiles(), 'https://mt.example.com/{z}/{x}/{y}.png', 'the layer chosen in 2D replaces the previous drape');
        assert.equal(framePicker(window).options[framePicker(window).selectedIndex].textContent, 'MyTopo');

        dispatch({ type: 'suspend' });
        dispatch({ type: 'resume', routeSegments, basemap: layer('OpenTopo', 'ot.example.com'), basemaps: [layer('OpenTopo', 'ot.example.com')] });
        assert.equal(tiles(), 'https://ot.example.com/{z}/{x}/{y}.png', 'an index that stays the same across lists is not the same layer');
    } finally { dom.window.close(); }
});

test('the extension-provided vector entry grafts the provider style under the extension layers', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const maps: StubMap[] = [];

    class MapStub {
        declare failAddLayerId: string;
        declare failRemoveLayerId: string | null;
        declare glyphs: string | null;
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare options: StubOptions;
        declare sources: Map<string, StubSource>;
        declare sprite: string | null;
        constructor(options: StubOptions) {
            this.options = options;
            this.sources = new Map(Object.entries(options.style.sources).map(([id, source]) => [id, { ...source }]));
            this.layers = options.style.layers.map((layer: StubLayer) => ({ ...layer }));
            this.handlers = new Map();
            this.glyphs = null;
            this.sprite = null;
            maps.push(this as unknown as StubMap);
        }
        addControl() {}
        once(type: string, callback: Handler) { if (type === 'load') window.queueMicrotask(callback); }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData() {} }); }
        addLayer(layer: StubLayer, before: string) {
            if (this.failAddLayerId === layer.id) throw new Error('injected addLayer failure');
            const index = before ? this.layers.findIndex(existing => existing.id === before) : -1;
            if (index >= 0) this.layers.splice(index, 0, layer);
            else this.layers.push(layer);
        }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) {
            if (this.failRemoveLayerId === id) {
                this.failRemoveLayerId = null;
                throw new Error('injected removeLayer failure');
            }
            this.layers = this.layers.filter(layer => layer.id !== id);
        }
        getSource(id: string) { return this.sources.get(id); }
        removeSource(id: string) { this.sources.delete(id); }
        getStyle() {
            return {
                ...this.options.style,
                ...(this.glyphs ? { glyphs: this.glyphs } : {}),
                ...(this.sprite ? { sprite: this.sprite } : {})
            };
        }
        setGlyphs(url: string) { this.glyphs = url; }
        setSprite(url: string) { this.sprite = url; }
        setPaintProperty() {}
        fitBounds() {}
        resize() {}
        remove() {}
    }

    const providerStyle = {
        version: 8,
        glyphs: 'https://tiles.maptoolkit.org/fonts/{fontstack}/{range}.pbf',
        sprite: 'https://tiles.maptoolkit.org/sprites/ofm_f384/ofm',
        sources: { openmaptiles: { type: 'vector', url: 'https://tiles.maptoolkit.org/planet' } },
        layers: [
            { id: 'land', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover' },
            { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
            { id: 'place-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place' }
        ]
    };
    const fetches: string[] = [];
    let failFetch = true;
    (window as unknown as Record<string, unknown>).fetch = (url: string) => {
        fetches.push(url);
        if (failFetch) return Promise.reject(new Error('offline'));
        return Promise.resolve({
            ok: true,
            status: 200,
            url,
            headers: { get: () => null },
            text: () => Promise.resolve(JSON.stringify(providerStyle)),
        });
    };
    bootTerrainFrame(window, MapStub, { fetch: window.fetch });

    // No page-offered raster layers: the vector entry must exist regardless.
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrainFrame: true, dir: 'toFrame', type: 'init',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]]
        }
    }));
    await new Promise<void>(resolve => window.queueMicrotask(resolve));

    const picker = () => framePicker(window);
    const map = maps[0];
    const frameGlyphs = 'chrome-extension://test-id/fonts/{fontstack}/{range}.pbf';
    const frameSprite = 'chrome-extension://test-id/sprites/terrain';
    map.glyphs = frameGlyphs;
    map.sprite = frameSprite;
    assert.deepEqual(Array.from(picker().options, option => option.textContent),
        ['Maptoolkit Hiking (BPB experiment)', 'Terrain only'],
        'the vector entry and terrain-only are offered even without page layers');
    assert.equal(picker().value, 'terrain', 'terrain-only stays the default — vector is opt-in');
    assert.equal(fetches.length, 0, 'no provider traffic before the user selects the vector entry');

    // A failed style fetch reverts to terrain-only with a visible reason and
    // is forgotten, so the next selection retries instead of staying broken.
    picker().value = 'maptoolkit';
    picker().dispatchEvent(new window.Event('change'));
    assert.equal(picker().value, 'maptoolkit', 'the requested vector map stays selected while its style is pending');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.deepEqual(fetches, ['https://styles.maptoolkit.org/hiking.json'],
        'selecting the entry requests the provider style');
    assert.equal(picker().value, 'terrain', 'a failed style fetch reverts to terrain-only');
    assert.match(window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.textContent, /Maptoolkit Hiking \(BPB experiment\) is unavailable/);

    failFetch = false;
    picker().value = 'maptoolkit';
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
    assert.equal(map.layers.find(layer => layer.id === 'bpb-vector:land')!.source, 'bpb-vector:openmaptiles',
        'grafted layers point at the prefixed source');

    picker().value = 'terrain';
    picker().dispatchEvent(new window.Event('change'));
    assert.equal(map.getSource('bpb-vector:openmaptiles'), undefined, 'terrain-only removes the vector sources');
    assert.ok(!map.layers.some(layer => layer.id.startsWith('bpb-vector:')), 'terrain-only removes every vector layer');
    assert.equal(map.glyphs, frameGlyphs, 'terrain-only restores the frame glyph configuration');
    assert.equal(map.sprite, frameSprite, 'terrain-only restores the frame sprite configuration');

    // Re-selecting reuses the cached style without another fetch.
    picker().value = 'maptoolkit';
    picker().dispatchEvent(new window.Event('change'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(fetches.length, 2, 'a successful style fetch is cached for the frame lifetime');
    assert.ok(map.getSource('bpb-vector:openmaptiles'), 'the cached style is re-grafted');
    assert.deepEqual(JSON.parse(JSON.stringify(map.options.transformRequest!(
        'https://tiles.maptoolkit.org/planet/1/2/3.pbf', 'Tile'))), {
        url: 'bpb-vector://https://tiles.maptoolkit.org/planet/1/2/3.pbf',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
    });
    assert.throws(() => map.options.transformRequest!('https://foreign.example/1/2/3.pbf', 'Tile'),
        /unapproved provider origin/,
        'a TileJSON response cannot redirect vector tiles to another provider');
    assert.throws(() => map.options.transformRequest!('https://foreign.example/source.json', 'Source'),
        /unapproved provider origin/);
    assert.throws(() => map.options.transformRequest!(
        'https://user:secret@tiles.maptoolkit.org/planet/1/2/3.pbf', 'Tile'),
    /unapproved provider origin/);
    assert.throws(() => map.options.transformRequest!(
        'https://tiles.maptoolkit.org/planet/1/2/3.pbf#fragment', 'Tile'),
    /unapproved provider origin/);

    map.handlers.get('error')!({ sourceId: 'bpb-vector:openmaptiles' });
    assert.equal(picker().value, 'terrain', 'a late TileJSON or tile failure rolls the vector graft back');
    assert.equal(map.getSource('bpb-vector:openmaptiles'), undefined);
    assert.ok(!map.layers.some(layer => layer.id.startsWith('bpb-vector:')));
    assert.match(window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.textContent, /unavailable/);

    // A later install failure rolls back every mutation. A one-shot cleanup
    // failure cannot skip the remaining layers or source, and is retried.
    map.failAddLayerId = 'bpb-vector:place-label';
    map.failRemoveLayerId = 'bpb-vector:road';
    picker().value = 'maptoolkit';
    picker().dispatchEvent(new window.Event('change'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(picker().value, 'terrain', 'an incomplete graft is never marked active');
    assert.equal(map.getSource('bpb-vector:openmaptiles'), undefined,
        'rollback removes the added source after independently retrying layer cleanup');
    assert.ok(!map.layers.some(layer => layer.id.startsWith('bpb-vector:')),
        'no provider layer survives a failed transaction');
    assert.equal(map.glyphs, frameGlyphs);
    assert.equal(map.sprite, frameSprite);
    assert.match(window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.textContent, /unavailable/);

    dom.window.close();
});

test('Maptoolkit terrain preserves its mesh and route, restores named sprites and enforces provider cooldowns', async () => {
    const dom = new JSDOM('<body></body>', { url: 'https://www.peakbagger.com/map/BigMap.aspx?t=A', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom, maps: StubMap[] = [], protocols = new Map<string, StubProtocol>(), calls: string[] = [];
    let finishStyle, rejectLate, now = Date.now(); window.Date.now = () => now;
    class MapStub {
        declare controls: StubControl[];
        declare glyphs: string | null;
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare options: StubOptions;
        declare sources: Map<string, StubSource>;
        declare sprites: { id: string; url: string }[];
        constructor(options: StubOptions) { this.options = options; this.sources = new Map(Object.entries(options.style.sources)); this.layers = [...options.style.layers]; this.controls = []; this.sprites = []; this.handlers = new Map(); maps.push(this as unknown as StubMap); }
        addControl(control: StubControl) { this.controls.push(control); const node = control.onAdd?.(this); if (node) this.options.container!.append(node); }
        removeControl(control: StubControl) { this.controls = this.controls.filter(item => item !== control); control.onRemove?.(); }
        once(type: string, callback: Handler) { if (type === 'load') window.queueMicrotask(callback); }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); } fitBounds() {} resize() {} remove() {} setPaintProperty() {}
        getBounds() { return { getWest: () => -122, getSouth: () => 46, getEast: () => -121, getNorth: () => 47 }; }
        getZoom() { return 10; }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData() {} }); }
        getSource(id: string) { return this.sources.get(id); } removeSource(id: string) { this.sources.delete(id); }
        addLayer(layer: StubLayer, before: string) { const index = this.layers.findIndex(item => item.id === before); this.layers.splice(index < 0 ? this.layers.length : index, 0, layer); }
        getLayer(id: string) { return this.layers.find(item => item.id === id); } removeLayer(id: string) { this.layers = this.layers.filter(item => item.id !== id); }
        getStyle() { return { ...this.options.style, sprite: this.sprites, glyphs: this.glyphs || null }; }
        setGlyphs(value: string | null) { this.glyphs = value; } setSprite(value: unknown) { this.sprites = typeof value === 'string' ? [{ id: 'default', url: value }] : []; }
        addSprite(id: string, url: string) { this.sprites.push({ id, url }); }
    }
    class AttributionControl { declare options: { customAttribution?: string }; constructor(options: { customAttribution?: string }) { this.options = options; } }
    const toolkitStyle = { version: 8, sources: { mtk: { type: 'vector', url: 'https://tiles.maptoolkit.org/mtk-contours.json' }, dem: { type: 'raster-dem', url: 'https://tiles.maptoolkit.org/terrainrgb.json', encoding: 'terrarium', tileSize: 8192 } },
        layers: [{ id: 'land', type: 'fill', source: 'mtk', 'source-layer': 'land' }], sprite: [{ id: 'sdf', url: 'https://icons.maptoolkit.org/sprite' }, { id: 'nature', url: 'https://icons.maptoolkit.org/nature' }] };
    const reply = (url: string, style: unknown) => ({ ok: true, status: 200, url, text: async () => JSON.stringify(style) });
    const fetch = async (url: string) => {
        calls.push(url);
        if (url.endsWith('/hiking.json')) return new Promise(resolve => { finishStyle = () => resolve(reply(url, toolkitStyle)); });
        if (url.endsWith('/late.pbf')) return new Promise((_resolve, reject) => { rejectLate = reject; });
        if (url.endsWith('.pbf')) return { status: 429, headers: new Headers({ 'retry-after': '120' }) };
        return reply(url, { version: 8, sources: {}, layers: [] });
    };
    const send = bootTerrainFrame(window, MapStub, { fetch, maplibre: { AttributionControl, addProtocol(name: string, handler: StubProtocol) { protocols.set(name, handler); } } });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const choose = (value: string) => { const picker = framePicker(window); picker.value = value; picker.dispatchEvent(new window.Event('change')); };
    try {
        send({ type: 'init', routeSegments: [[[46.85, -121.76], [46.86, -121.77]]], basemap: { kind: 'vector', provider: 'maptoolkit' } }); await tick();
        assert.equal(framePicker(window).value, 'maptoolkit', 'The 2D provider is honored on initial entry');
        const map = maps[0], terrain = map.getSource('terrain'), route = map.getLayer('bpb-route'); assert.ok(terrain && route);
        choose('terrain'); finishStyle!(); await tick(); assert.equal(map.getSource('bpb-vector:mtk'), undefined, 'A cancelled style cannot graft into the replacement choice');
        choose('maptoolkit'); await tick();
        assert.equal(map.getSource('terrain'), terrain); assert.equal(map.getLayer('bpb-route'), route);
        assert.equal(map.getSource('bpb-vector:dem'), undefined, 'Unused provider elevation must not load beside the terrain mesh'); assert.deepEqual(map.sprites.map(item => item.id), ['sdf', 'nature']);
        assert.match(map.controls.find((item: StubControl) => item instanceof AttributionControl)!.options!.customAttribution!, /Maptoolkit/);
        const request = protocols.get('bpb-vector');
        const originalSource = map.getSource('bpb-vector:mtk'); choose('maptoolkit'); await tick();
        assert.equal(map.getSource('bpb-vector:mtk'), originalSource, 'Reselecting the active provider must not rebuild its source graph');
        const controller = new AbortController();
        const late = request!({ url: 'bpb-vector://https://tiles.maptoolkit.org/late.pbf', type: 'arrayBuffer' }, controller);
        const ignored = assert.rejects(late, (error: Error) => error.name === 'AbortError');
        choose('terrain'); await tick(); assert.equal(controller.signal.aborted, true, 'A layer switch cancels the outgoing transport');
        rejectLate!(Object.assign(new Error('old provider failed'), { status: 503 })); await ignored;
        map.handlers.get('error')!({ sourceId: 'bpb-vector:mtk', error: Object.assign(new Error('cancelled'), { name: 'AbortError' }) });
        assert.equal(framePicker(window).value, 'terrain', 'An outgoing provider cannot change the replacement selection');
        choose('maptoolkit'); await tick();
        await assert.rejects(request!({ url: 'bpb-vector://https://tiles.maptoolkit.org/tile.pbf', type: 'arrayBuffer' }, new AbortController()), (error: Error & { status?: number }) => error.status === 429);
        assert.equal(framePicker(window).value, 'terrain'); assert.equal(framePicker(window).querySelector<HTMLOptionElement>('[value="maptoolkit"]')!.disabled, true);
        assert.match(window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.textContent, /Maptoolkit request limit/);
        const count = calls.length; choose('maptoolkit'); await tick(); assert.equal(calls.length, count, 'Retry cannot bypass the tile-level cooldown');
        now += 120001; choose('terrain'); choose('maptoolkit'); await tick();
        assert.equal(framePicker(window).value, 'maptoolkit'); assert.equal(map.getSource('terrain'), terrain); assert.equal(map.getLayer('bpb-route'), route);
        assert.equal(calls.filter(url => url.endsWith('/hiking.json')).length, 1, 'The accepted style is reused after expiry');
    } finally { dom.window.close(); }
});

test('the 3D base map control wears the native picker palette in both themes', async () => {
    const css = await readFile(new URL('../../src/terrain/terrain-map.css', import.meta.url), 'utf8');
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0];
    const value = (block: string, name: string) => new RegExp(`${name}: ([^;]+);`).exec(block)?.[1];
    const native = (selector: string) => nativeMapDarkCss.slice(nativeMapDarkCss.indexOf(`${selector} {`)).split('}')[0];
    const dark = '#bpb-terrain-map[data-theme="dark"]', box = native('html[data-bpb-theme="dark"] #selboxdiv');
    assert.equal(value(rule(`${dark} .bpb-terrain-picker-box`), 'background')?.toLowerCase(), value(box, 'background')?.replace(' !important', ''));
    assert.equal(value(rule(`${dark} .bpb-terrain-picker-box`), 'border-color'), value(box, 'border-color')?.replace(' !important', ''));
    assert.equal(value(rule(`${dark} .bpb-terrain-picker`), 'border-color'), value(native('html[data-bpb-theme="dark"] #selmap'), 'border-color')?.replace(' !important', ''));
    assert.equal(value(rule('#bpb-terrain-map .bpb-terrain-picker-box'), 'border'), '2px solid #000');
});

test('a lent 2D paint drapes above the loading vector map, retires once its tiles load and never outlives the choice', async () => {
    const dom = new JSDOM('<body></body>', { url: 'https://www.peakbagger.com/map/BigMap.aspx?t=A', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom, maps: StubMap[] = [];
    let finishStyle: (() => void) | undefined, sourcesLoaded = false;
    class Bitmap { width = 640; height = 480; closed = false; close() { this.closed = true; } }
    const drawn: unknown[] = [];
    Object.assign(window, { ImageBitmap: Bitmap });
    Object.assign(globalThis, { ImageBitmap: Bitmap });
    window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: (image: unknown) => drawn.push(image), measureText: () => ({ width: 100 }) })) as never;
    class MapStub {
        declare handlers: Map<string, Handler[]>; declare layers: StubLayer[]; declare options: StubOptions; declare sources: Map<string, StubSource>;
        declare moved: string[]; declare paints: unknown[][];
        constructor(options: StubOptions) { Object.assign(this, { options, sources: new Map(Object.entries(options.style.sources)), layers: [...options.style.layers], handlers: new Map(), moved: [], paints: [] }); maps.push(this as unknown as StubMap); }
        addControl(control: StubControl) { const node = control.onAdd?.(this); if (node) this.options.container!.append(node); } removeControl() {}
        once(type: string, callback: Handler) { if (type === 'load') window.queueMicrotask(callback); }
        on(type: string, callback: Handler) { this.handlers.set(type, [...this.handlers.get(type) || [], callback]); }
        off(type: string, callback: Handler) { this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item !== callback)); }
        fire(type: string) { for (const handler of this.handlers.get(type) || []) handler({}); }
        fitBounds() {} jumpTo() {} resize() {} remove() {} setTerrain() {} setSky() {} setFilter() {} setLayoutProperty() {} setPadding() {} getCanvas() { return null; }
        setPaintProperty(...args: unknown[]) { this.paints.push(args); }
        getBounds() { return { getWest: () => -122, getSouth: () => 46, getEast: () => -121, getNorth: () => 47 }; }
        getZoom() { return 10; } getBearing() { return 0; } getPitch() { return 60; } getCenter() { return { lng: -121.5, lat: 46.5, wrap() { return this; } }; }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData() {} }); }
        getSource(id: string) { return this.sources.get(id); } removeSource(id: string) { this.sources.delete(id); }
        addLayer(layer: StubLayer, before: string) { const index = this.layers.findIndex(item => item.id === before); this.layers.splice(index < 0 ? this.layers.length : index, 0, layer); }
        getLayer(id: string) { return this.layers.find(item => item.id === id); } removeLayer(id: string) { this.layers = this.layers.filter(item => item.id !== id); }
        moveLayer(id: string, before: string) { this.moved.push(id); const layer = this.getLayer(id)!; this.removeLayer(id); this.addLayer(layer, before); }
        isSourceLoaded() { return sourcesLoaded; } getStyle() { return { ...this.options.style, sprite: null, glyphs: null }; } setGlyphs() {} setSprite() {} addSprite() {}
    }
    const style = { version: 8, sources: { mtk: { type: 'vector', url: 'https://tiles.maptoolkit.org/mtk-contours.json' } }, layers: [{ id: 'land', type: 'fill', source: 'mtk', 'source-layer': 'land' }] };
    const fetch = async (url: string) => new Promise(resolve => { finishStyle = () => resolve({ ok: true, status: 200, url, text: async () => JSON.stringify(style) }); });
    const send = bootTerrainFrame(window, MapStub, { fetch });
    const paint = { view: { center: [46.5, -121.5], zoom: 9 }, width: 800, height: 600 };
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const lent = () => new Bitmap();
    try {
        const first = lent();
        send({ type: 'drape', generation: 1, bitmap: first, ...paint });
        assert.equal(first.closed, false, 'A drape can outrun the launch and waits for its map');
        send({ type: 'init', generation: 1, routeSegments: [[[46.85, -121.76], [46.86, -121.77]]], basemap: { kind: 'vector', provider: 'maptoolkit' } }); await tick();
        const map = maps[0] as unknown as MapStub;
        const ids = () => map.layers.map(layer => layer.id);
        assert.ok(map.getLayer('bpb-drape-2d'), 'The paint is on the terrain as soon as the map loads');
        assert.equal(first.closed, true); assert.deepEqual(drawn, [first]);
        assert.equal((map.getSource('bpb-drape-2d') as unknown as { type: string }).type, 'canvas', 'The drape requests nothing');
        assert.ok(ids().indexOf('bpb-drape-2d') < ids().indexOf('terrain-hillshade'), 'Relief still shades it');
        finishStyle!(); await tick();
        assert.ok(ids().indexOf('bpb-vector:land') < ids().indexOf('bpb-drape-2d'), 'Opaque vector ground cannot cover the stand-in');
        map.fire('idle'); assert.ok(map.getLayer('bpb-drape-2d'), 'Tiles still loading keep it');
        sourcesLoaded = true; map.fire('sourcedata');
        assert.ok(map.paints.some(([id, name, value]) => id === 'bpb-drape-2d' && name === 'raster-opacity' && value === 0), 'It fades once the vector tiles load');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(map.getLayer('bpb-drape-2d'), undefined); assert.equal(map.getSource('bpb-drape-2d'), undefined);
        assert.equal((map.handlers.get('sourcedata') || []).length, 0, 'A retired drape leaves no listeners');

        sourcesLoaded = false;
        const framePick = framePicker(window); framePick.value = 'terrain'; framePick.dispatchEvent(new window.Event('change'));
        const refused = lent();
        send({ type: 'drape', generation: 1, bitmap: refused, ...paint }); await tick();
        assert.equal(refused.closed, true, 'Terrain only has no vector map to stand in for');
        assert.equal(map.getLayer('bpb-drape-2d'), undefined);

        const invalid = lent();
        send({ type: 'drape', generation: 1, bitmap: invalid, ...paint, width: 0 });
        assert.equal(invalid.closed, true, 'An invalid camera cannot place pixels');
        send({ type: 'drape', generation: 1, bitmap: { width: 640 }, ...paint }); assert.equal(map.getLayer('bpb-drape-2d'), undefined, 'Only a real bitmap is accepted');

        // Re-entry after a 2D pan: parked sources report loaded for the old view.
        framePick.value = 'maptoolkit'; framePick.dispatchEvent(new window.Event('change')); await tick(); sourcesLoaded = true;
        send({ type: 'suspend', generation: 1 });
        const reentry = lent(); send({ type: 'drape', generation: 2, bitmap: reentry, ...paint });
        send({ type: 'resume', generation: 2, routeSegments: [[[46.85, -121.76], [46.86, -121.77]]], basemap: { kind: 'vector', provider: 'maptoolkit' } }); await tick();
        assert.ok(map.getLayer('bpb-drape-2d'), 'The stand-in covers the new camera until the next settle');
        map.fire('idle'); await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(map.getLayer('bpb-drape-2d'), undefined); sourcesLoaded = false;

        const held = lent(); send({ type: 'drape', generation: 2, bitmap: held, ...paint }); await tick();
        assert.ok(map.getLayer('bpb-drape-2d'));
        framePick.value = 'terrain'; framePick.dispatchEvent(new window.Event('change'));
        assert.equal(map.getLayer('bpb-drape-2d'), undefined, 'Choosing another map removes the stand-in at once');
    } finally { delete (globalThis as { ImageBitmap?: unknown }).ImageBitmap; dom.window.close(); }
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
    const pageMessages: TestMessage[] = [];
    const frameMessages: TestMessage[] = [];
    Object.assign(window, { chrome: chromeWith({ enable3dMap: true }) });
    window.postMessage = message => { pageMessages.push(message); };
    window.eval(bridgeBundle);
    await new Promise(resolve => window.setTimeout(resolve, 0)); // settings.get() resolves

    armTerrain(window);
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true, dir: 'toCS', type: 'init',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]]
        }
    }));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    const frame = window.document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null;
    frame!.contentWindow!.postMessage = (message: TestMessage) => { frameMessages.push(message); };

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame!.contentWindow,
        origin: 'chrome-extension://test-id',
        data: { __bpbTerrainFrame: true, dir: 'toParent', type: 'ready' }
    }));
    const generation = frameMessages.find(message => message.type === 'init')!.generation;

    window.dispatchEvent(new window.MessageEvent('message', {
        source: frame!.contentWindow,
        origin: 'chrome-extension://test-id',
        data: {
            __bpbTerrainFrame: true, dir: 'toParent', type: 'peaksRequest',
            generation,
            requestId: 3, bounds: { miny: 48.6, maxy: 48.8, minx: -121.9, maxx: -121.7 }
        }
    }));
    const request = pageMessages.at(-1);
    assert.equal(request!.type, 'peaksRequest');
    assert.equal(request!.dir, 'toPage');
    assert.equal(request!.requestId, 3);
    assert.deepEqual(request!.bounds, { miny: 48.6, maxy: 48.8, minx: -121.9, maxx: -121.7 });

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
    assert.equal(reply!.type, 'peaks');
    assert.equal(reply!.dir, 'toFrame');
    assert.equal(reply!.requestId, 3);
    assert.deepEqual(reply!.peaks, [{ id: 58603, name: 'Iron Mountain', lat: 48.72, lon: -121.79, state: 'climbed' }]);
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', type: 'peaks', requestId: 3, rateLimited: true, retryAt: Number.MAX_VALUE }
    }));
    assert.equal(frameMessages.at(-1)!.rateLimited, true);
    assert.equal(frameMessages.at(-1)!.retryAt, null, 'the bridge rejects an unreasonable retry time');

    dom.window.close();
});

test('the bridge relays a bounded DEM prefetch to the background worker only while 3D is on', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="bpb-map-viewport"></div></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const sent: TestMessage[] = [];
    Object.assign(window, { chrome: chromeWith({ enable3dMap: true }) });
    Object.assign((window.chrome as unknown as { runtime: object }).runtime, { sendMessage: (message: TestMessage) => { sent.push(message); return Promise.resolve({ ok: true }); } });
    window.postMessage = () => {};
    window.eval(bridgeBundle);

    const dispatchPage = (data: TestMessage) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toCS', ...data }
    }));

    // Public tags alone are not a warm-cache capability.
    dispatchPage({
        type: 'prefetch',
        bounds: { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 },
        viewport: { width: 1280, height: 800 }
    });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(sent.length, 0);

    // A route prefetch forwards route bounds + viewport as a TERRAIN_PREFETCH.
    armTerrain(window, 'pointerover');
    dispatchPage({
        type: 'prefetch',
        bounds: { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 },
        viewport: { width: 1280, height: 800 }
    });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'TERRAIN_PREFETCH',
        'a hover racing the initial settings read is relayed after the enabled gate resolves');
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].bounds)), { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 });
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].viewport)), { width: 1280, height: 800 });
    assert.equal('center' in sent[0], false, 'a bounds prefetch does not also carry a centre');

    // A peak prefetch forwards center + zoom instead.
    armTerrain(window, 'focus');
    dispatchPage({ type: 'prefetch', center: [48.83, -121.6], zoom: 13, viewport: { width: 1000, height: 425 } });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(sent[1].center)), [48.83, -121.6]);
    assert.equal(sent[1].zoom, 13);

    // A prefetch that names neither a valid bounds nor a valid centre is dropped.
    armTerrain(window, 'pointerover');
    dispatchPage({ type: 'prefetch', viewport: { width: 1000, height: 425 } });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(sent.length, 2, 'a prefetch with no view is not forwarded');

    // Turning the feature off closes the relay: no prefetch reaches the worker.
    await window.chrome.storage.sync.set({ bpbSettings: { enable3dMap: false } });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    armTerrain(window, 'pointerover');
    dispatchPage({
        type: 'prefetch',
        bounds: { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 },
        viewport: { width: 1280, height: 800 }
    });
    await new Promise(resolve => window.setTimeout(resolve, 0));
    assert.equal(sent.length, 2, 'the bridge does not relay a prefetch while 3D is disabled');
    dom.window.close();
});

test('terrain warming cancels for gestures and suspension without restarting from hidden map events', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const timers = new Map<number, { callback: Handler; ms: number }>(), requests: AbortSignal[] = [];
    let timerId = 0, map;
    (window as unknown as Record<string, unknown>).setTimeout = (callback: Handler, ms: number) => { timers.set(++timerId, { callback, ms }); return timerId; };
    (window as unknown as Record<string, unknown>).clearTimeout = (id: number) => timers.delete(id);
    const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const runWarmTimer = async () => {
        for (const [id, timer] of [...timers]) if (timer.ms === 350) {
            timers.delete(id); timer.callback();
        }
        await tick();
    };
    class MapStub {
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare sources: Map<string, StubSource>;
        constructor() { map = this as unknown as StubMap; this.sources = new Map(); this.layers = []; this.handlers = new Map(); }
        once(type: string, callback: Handler) { if (type === 'load') window.queueMicrotask(callback); }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        fire(type: string) { this.handlers.get(type)?.(); }
        addControl() {}
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData() {} }); }
        getSource(id: string) { return this.sources.get(id); }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        setPaintProperty() {}
        setLayoutProperty() {}
        getCanvas() { return { clientWidth: 800, clientHeight: 600 }; }
        getCenter() { return { lng: -121.8, lat: 48.7 }; }
        getZoom() { return 14; }
        getBounds() { return { getWest: () => -121.82, getEast: () => -121.78,
            getSouth: () => 48.68, getNorth: () => 48.72 }; }
        fitBounds() {}
        resize() {}
        stop() { this.fire('moveend'); }
        remove() {}
    }
    const dispatch = bootTerrainFrame(window, MapStub, { fetch: (_url, options) => {
        requests.push(options.signal!);
        return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () =>
            reject(new window.DOMException('Cancelled', 'AbortError')), { once: true }));
    } });
    try {
        const payload = { routeSegments: [[[48.7, -121.8], [48.71, -121.81]]], cacheLimitMb: 512 };
        dispatch({ type: 'init', ...payload });
        await tick(); await runWarmTimer();
        assert.equal(requests.length, 2, 'a still camera starts only two speculative downloads');
        map!.fire('movestart');
        await tick();
        assert.ok(requests.every(signal => signal.aborted), 'starting a gesture cancels speculative transport');
        await tick();

        dispatch({ type: 'suspend' });
        map!.fire('moveend'); map!.fire('idle');
        await runWarmTimer();
        assert.equal(requests.length, 2, 'hidden map events cannot restart warming');

        dispatch({ type: 'resume', ...payload });
        await tick();
        // The interval guard is intentionally independent of the idle timer.
        const originalNow = window.Date.now;
        window.Date.now = () => originalNow() + 1000;
        await runWarmTimer();
        assert.equal(requests.length, 4, 'resume retries cancelled tiles rather than remembering them as warmed');
        dispatch({ type: 'suspend' });
        await tick();
        assert.ok(requests.every(signal => signal.aborted), 'suspension cancels in-flight warming too');
        await tick();
        assert.equal(requests.length, 4, 'a cancelled pass cannot advance to its next tile');
    } finally { dispatch({ type: 'destroy' }); dom.window.close(); }
});

test('3D peak markers request Peakbagger dots on camera settle and render only validated batches', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages: TestMessage[] = [];
    const maps: StubMap[] = [];
    const popups: StubPopup[] = [];
    const camera = {
        zoom: 13,
        center: { lng: -121.805, lat: 48.73 },
        bounds: { south: 48.6, north: 48.86, west: -121.95, east: -121.66 }
    };
    // Screen positions the stubbed map.project reports per 'lon,lat' key, like
    // a pitched terrain camera would; unlisted peaks project far off-screen.
    const projections = new Map();

    class MapStub {
        declare canvas: HTMLCanvasElement;
        declare data: unknown;
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare options: StubOptions;
        declare paint: unknown[];
        declare removed: boolean;
        declare sources: Map<string, StubSource>;
        constructor(options: StubOptions) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.paint = [];
            this.handlers = new Map();
            this.canvas = { clientWidth: 800, clientHeight: 600, style: {} } as unknown as HTMLCanvasElement;
            maps.push(this as unknown as StubMap);
        }
        addControl() {}
        once(type: string, callback: Handler) { if (type === 'load') window.queueMicrotask(callback); }
        on(type: string, layerOrCallback: unknown, maybeCallback: Handler) {
            const key = typeof layerOrCallback === 'string' ? `${type}:${layerOrCallback}` : type;
            this.handlers.set(key, (typeof layerOrCallback === 'function' ? layerOrCallback : maybeCallback) as Handler);
        }
        addSource(id: string, source: StubSource) {
            this.sources.set(id, { ...source, setData(data) { this.data = data; } });
        }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); }
        removeSource(id: string) { this.sources.delete(id); }
        setPaintProperty(...args: unknown[]) { this.paint.push(args); }
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
        project([lng, lat]: [number, number]) {
            return projections.get(`${lng},${lat}`) || { x: -10000, y: -10000 };
        }
        resize() {}
        remove() { this.removed = true; }
    }
    const dispatch = bootTerrainFrame(window, MapStub, { messages, popups });
    const settle = () => new Promise(resolve => window.setTimeout(resolve, 320));

    dispatch({ type: 'init', routeSegments: [[[48.7, -121.8], [48.71, -121.81]]] });
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    const map = maps[0];
    assert.ok(map.getLayer('bpb-peaks-ring'), 'the peak ring layer exists');
    assert.ok(map.getSource('bpb-peaks'), 'the peak source exists');
    const ringPaint = map.getLayer('bpb-peaks-ring')!.paint;
    assert.deepEqual(JSON.parse(JSON.stringify(ringPaint!['circle-stroke-color'])),
        ['match', ['get', 'state'], 'climbed', '#00ff00', 'unclimbed', '#ff6699', 'unknown', '#ffcc33', '#ffcc33'],
        'ring colors are data-driven from the marker spec');
    assert.equal(ringPaint!['circle-pitch-scale'], 'viewport',
        'rings keep a constant screen size so the drawn extent matches the screen-space hit radius');

    await settle();
    const request = messages.at(-1);
    assert.equal(request!.type, 'peaksRequest', 'the frame asks for dots after load settles');
    assert.equal(request!.requestId, 1);
    const bounds = request!.bounds as Record<string, number>;
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
    const rendered = () => JSON.parse(JSON.stringify(map.getSource('bpb-peaks').data!.features));
    assert.equal(rendered().length, 3);
    assert.deepEqual(rendered()[0], {
        type: 'Feature',
        properties: { id: 58603, name: 'Iron Mountain', state: 'climbed' },
        geometry: { type: 'Point', coordinates: [-121.79, 48.72] }
    });
    assert.equal(rendered()[2].properties.state, 'unknown', 'an unrecognized state falls back safely');
    dispatch({ type: 'peaks', requestId: 1, rateLimited: true, retryAt: Number.MAX_VALUE });
    assert.equal(rendered().length, 3, 'rate limits retain the last marker set');
    assert.match(window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.textContent, /Peakbagger request limit reached/);
    assert.equal(window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.textContent.includes('Try again after'), false,
        'untrusted unreasonable retry timestamps cannot enter warning copy');


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
    assert.equal(link!.href, 'https://www.peakbagger.com/peak.aspx?pid=58603',
        'the link is built from the integer peak id only');
    assert.equal(link!.textContent, 'Iron <b>&</b> Mountain', 'the name renders as text, never as markup');
    assert.equal(link!.target, '_blank');
    assert.equal(link!.rel, 'noopener noreferrer');
    assert.deepEqual(JSON.parse(JSON.stringify(popups[1].lngLat)), [-121.79, 48.72]);

    // The hover cursor runs through the same hit test, one frame behind the
    // pointer.
    const nextFrame = () => new Promise(resolve => window.requestAnimationFrame(resolve));
    map.handlers.get('mousemove')!({ point: { x: 401, y: 299 } });
    await nextFrame();
    assert.equal(map.canvas.style.cursor, 'pointer', 'hovering a ring shows the pointer cursor');
    map.handlers.get('mousemove')!({ point: { x: 500, y: 500 } });
    await nextFrame();
    assert.equal(map.canvas.style.cursor, '', 'leaving the ring restores the default cursor');
    map.handlers.get('mousemove')!({ point: { x: 401, y: 299 } });
    await nextFrame();
    map.handlers.get('mouseout')!();
    assert.equal(map.canvas.style.cursor, '', 'leaving the map restores the default cursor');

    dispatch({
        type: 'peaks',
        requestId: 1,
        peaks: [{ id: 7, name: 'Fresh Peak', lat: 48.71, lon: -121.81, state: 'unclimbed' }]
    });
    assert.equal(popups.at(-1)!.removedPopup, true,
        'refreshing the dots closes an open popup, like the native marker rebuild');

    const beforeZoomOut = messages.filter(message => message.type === 'peaksRequest').length;
    camera.zoom = 9;
    map.handlers.get('moveend')!();
    await settle();
    assert.equal(messages.filter(message => message.type === 'peaksRequest').length, beforeZoomOut,
        'no request below the native zoom cutoff');
    assert.equal(rendered().length, 0, 'dots are cleared when the map covers too big an area');

    dispatch({ type: 'peaks', requestId: 1,
        peaks: [{ id: 7, name: 'Delayed Peak', lat: 48.71, lon: -121.81, state: 'unclimbed' }] });
    assert.equal(rendered().length, 0, 'a delayed response cannot restore dots below the zoom cutoff');

    camera.zoom = 13;
    dispatch({ type: 'peaks', requestId: 1,
        peaks: [{ id: 7, name: 'Old View', lat: 48.71, lon: -121.81, state: 'unclimbed' }] });
    assert.equal(rendered().length, 0, 'zooming back in cannot revive a request invalidated by the cutoff');

    camera.zoom = 13;
    dispatch({ type: 'peaks', unavailable: true });
    map.handlers.get('moveend')!();
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
    const maps: StubMap[] = [];
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
    const metersBetween = (a: number[], b: number[]) => Math.hypot(
        (a[0] - b[0]) * METERS_PER_DEG_LAT * Math.cos(b[1] * Math.PI / 180),
        (a[1] - b[1]) * METERS_PER_DEG_LAT
    );
    const conePeakFeed = [-121.79, 48.72];
    const apexOffsetM = (offsetM: number, from = conePeakFeed) => [
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
    const elevationOf = ([lng, lat]: number[]) => {
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
        declare canvas: HTMLCanvasElement;
        declare data: unknown;
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare sources: Map<string, StubSource>;
        constructor() {
            this.sources = new Map();
            this.layers = [];
            this.handlers = new Map();
            this.canvas = { clientWidth: 800, clientHeight: 600, style: {} } as unknown as HTMLCanvasElement;
            maps.push(this as unknown as StubMap);
        }
        addControl() {}
        once(type: string, callback: Handler) { if (type === 'load') window.queueMicrotask(callback); }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData(data) { this.data = data; } }); }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); }
        removeSource(id: string) { this.sources.delete(id); }
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
        queryTerrainElevation(lngLat: [number, number]) { return elevationOf(lngLat); }
        resize() {}
        remove() {}
    }

    const dispatch = bootTerrainFrame(window, MapStub, { maplibre: { Popup: class { remove() {} } } });

    dispatch({ type: 'init', routeSegments: [[[48.7, -121.8], [48.71, -121.81]]] });
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
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
    const rendered = () => JSON.parse(JSON.stringify(maps[0].getSource('bpb-peaks').data!.features));

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

test('3D group tracks highlight the hovered climber and Escape leaves the view', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/Map/BigMap.aspx?t=G&d=2414',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages: TestMessage[] = [];
    const maps: StubMap[] = [];
    const popups: StubPopup[] = [];

    class MapStub {
        declare canvas: HTMLCanvasElement;
        declare data: unknown;
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare options: StubOptions;
        declare paint: unknown[];
        declare removed: boolean;
        declare routeHits: unknown[];
        declare sources: Map<string, StubSource>;
        constructor(options: StubOptions) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.paint = [];
            this.handlers = new Map();
            // What queryRenderedFeatures answers, topmost first.
            this.routeHits = [];
            this.canvas = { style: {} } as HTMLCanvasElement;
            maps.push(this as unknown as StubMap);
        }
        addControl() {}
        once(type: string, callback: Handler) { if (type === 'load') window.queueMicrotask(callback); }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData(data) { this.data = data; } }); }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); }
        removeSource(id: string) { this.sources.delete(id); }
        setPaintProperty(...args: unknown[]) { this.paint.push(args); }
        queryRenderedFeatures() { return this.routeHits; }
        project() { return { x: -10000, y: -10000 }; }
        getCanvas() { return this.canvas; }
        getZoom() { return 13; }
        getCenter() { return { lng: -121.805, lat: 48.73 }; }
        fitBounds() {}
        resize() {}
        remove() { this.removed = true; }
    }
    const dispatch = bootTerrainFrame(window, MapStub, { messages, popups });
    const nextFrame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    const routeStyle = { color: '#2457a7', width: 5, casingColor: '#ffffff', casingWidth: 9 };
    const groupInit = (tracks: unknown) => ({
        type: 'init',
        // Two segments cut from one climber's track, then a second climber's.
        routeSegments: [
            [[48.70, -121.80], [48.71, -121.81]],
            [[48.72, -121.82], [48.73, -121.83]],
            [[48.75, -121.86], [48.76, -121.87]]
        ],
        routeColors: ['#e34a33', '#e34a33', '#3182bd'],
        routeTracks: tracks,
        routeStyle,
        theme: 'light'
    });
    const linePaint = (map: StubMap) => map.paint.filter((call: unknown[]) => call[0] === 'bpb-route');
    const escape = () => {
        const event = new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
        window.document.dispatchEvent(event);
        return event;
    };

    dispatch(groupInit([0, 0, 1]));
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    const map = maps.at(-1);
    const messagesBeforeControlEscape = messages.length;
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
        const modified = new window.KeyboardEvent('keydown', { key: 'Escape', [modifier]: true, cancelable: true, bubbles: true });
        window.document.dispatchEvent(modified);
        assert.equal(modified.defaultPrevented, false);
        assert.equal(messages.length, messagesBeforeControlEscape, `${modifier} Escape remains available to the browser`);
    }
    const pickerEscape = new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    const nativeSelect = window.document.createElement('select'); window.document.body.append(nativeSelect); nativeSelect.dispatchEvent(pickerEscape); nativeSelect.remove();
    assert.equal(pickerEscape.defaultPrevented, false);
    assert.equal(messages.length, messagesBeforeControlEscape, 'the native layer picker owns Escape');
    for (const tag of ['input', 'textarea']) {
        const control = window.document.createElement(tag); window.document.querySelector<HTMLElement>('#bpb-terrain-map')!.append(control);
        control.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }));
        assert.equal(messages.length, messagesBeforeControlEscape, `${tag} Escape stays local`); control.remove();
    }
    assert.deepEqual(
        JSON.parse(JSON.stringify(map!.sources.get('bpb-route')!.data!.features.map(feature => feature.properties.track))),
        [0, 0, 1],
        'every segment names the native track it was cut from');

    // Hovering either half of the first climber's track blackens and thickens
    // that whole track — Peakbagger's own 2D group-map hover cue — and leaves
    // every other track on its native color.
    map!.routeHits = [map!.sources.get('bpb-route')!.data!.features[1]];
    map!.handlers.get('mousemove')!({ point: { x: 120, y: 90 } });
    await nextFrame();
    const hovered = linePaint(map!).slice(-2);
    assert.deepEqual(JSON.parse(JSON.stringify(hovered)), [
        ['bpb-route', 'line-color',
            ['case', ['==', ['get', 'track'], 0], '#000000', ['coalesce', ['get', 'color'], '#2457a7']]],
        ['bpb-route', 'line-width', ['case', ['==', ['get', 'track'], 0], 7, 5]]
    ], 'only the hovered track takes the hover paint, and it stays inside its casing');
    assert.equal(map!.canvas.style.cursor, '', 'a track with no ascent link is not clickable');

    // Moving onto the other climber switches the highlight rather than adding one.
    map!.routeHits = [map!.sources.get('bpb-route')!.data!.features[2]];
    map!.handlers.get('mousemove')!({ point: { x: 200, y: 140 } });
    await nextFrame();
    assert.deepEqual(JSON.parse(JSON.stringify(linePaint(map!).at(-1))),
        ['bpb-route', 'line-width', ['case', ['==', ['get', 'track'], 1], 7, 5]]);

    // Leaving the canvas restores the plain route paint.
    map!.handlers.get('mouseout')!();
    assert.deepEqual(JSON.parse(JSON.stringify(linePaint(map!).slice(-2))), [
        ['bpb-route', 'line-color', ['coalesce', ['get', 'color'], '#2457a7']],
        ['bpb-route', 'line-width', 5]
    ], 'the hover cue is removed with the pointer');

    // A live style change while a track is hovered keeps the highlight.
    map!.routeHits = [map!.sources.get('bpb-route')!.data!.features[0]];
    map!.handlers.get('mousemove')!({ point: { x: 120, y: 90 } });
    await nextFrame();
    dispatch({
        type: 'update',
        routeStyle: { color: '#347a3f', width: 6, casingColor: '#ffffff', casingWidth: 10 },
        theme: 'light'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(linePaint(map!).at(-1))),
        ['bpb-route', 'line-width', ['case', ['==', ['get', 'track'], 0], 8, 6]],
        'a restyle re-applies the hover on top of the new width');

    // Escape asks the page to return to 2D; the page owns whether it can.
    const exitKey = escape();
    assert.equal(exitKey.defaultPrevented, true);
    assert.equal(messages.at(-1)!.type, 'exit');
    assert.equal(messages.at(-1)!.dir, 'toParent');

    // An open popup is the nearer layer: Escape dismisses it and stays in 3D.
    map!.routeHits = [{
        type: 'Feature',
        properties: { ascentId: 3230293, label: '2026-06-12 - Fei (Kautz Glacier) TR-98', track: 0 },
        geometry: { type: 'LineString', coordinates: [[-121.8, 48.7], [-121.81, 48.71]] }
    }];
    map!.handlers.get('click')!({ point: { x: 120, y: 90 }, lngLat: { lng: -121.805, lat: 48.705 } });
    assert.equal(popups.length, 1);
    const messagesBeforeEscape = messages.length;
    escape();
    assert.equal(popups[0].removedPopup, true, 'the popup closes first');
    assert.equal(messages.length, messagesBeforeEscape, 'and the view stays open');
    escape();
    assert.equal(messages.at(-1)!.type, 'exit', 'a second Escape leaves 3D');

    // Partly attributed segments would highlight half a track, so hover is off.
    dispatch({ type: 'destroy' });
    dispatch(groupInit([0, null, 1]));
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    const partial = maps.at(-1);
    partial!.routeHits = [partial!.sources.get('bpb-route')!.data!.features[0]];
    partial!.handlers.get('mousemove')!({ point: { x: 120, y: 90 } });
    await nextFrame();
    assert.deepEqual(linePaint(partial!), [],
        'an incompletely attributed route never repaints on hover');

    // The analyzer and single-ascent maps send no track identity at all.
    dispatch({ type: 'destroy' });
    dispatch({
        type: 'init',
        routeSegments: [[[48.70, -121.80], [48.71, -121.81]]],
        routeStyle,
        theme: 'light'
    });
    await new Promise<void>(resolve => window.queueMicrotask(resolve));
    const single = maps.at(-1);
    assert.equal(single!.sources.get('bpb-route')!.data!.features[0].properties.track, undefined);
    single!.routeHits = [single!.sources.get('bpb-route')!.data!.features[0]];
    single!.handlers.get('mousemove')!({ point: { x: 120, y: 90 } });
    await nextFrame();
    assert.deepEqual(linePaint(single!), [], 'a lone route has nothing to be told apart from');

    dom.window.close();
});

test('3D overlays retain a pinned pass and native base through suspend, refresh, retry and stale snapshots', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://www.peakbagger.com/map/BigMap.aspx?t=A&d=1', runScripts: 'outside-only', pretendToBeVisual: true });
    const messages: TestMessage[] = [], pending: { resolve(value: unknown): void; url: string; options: RequestInit }[] = [];
    let map!: StubMap;
    class MapStub {
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare loadCallback: Handler;
        declare sources: Map<string, StubSource>;
        declare tiles: unknown;
        constructor(options: StubOptions) { map = this as unknown as StubMap; this.sources = new Map(); this.layers = [...options.style.layers]; this.handlers = new Map(); }
        addControl() {} once(type: string, callback: Handler) { if (type === 'load') this.loadCallback = callback; }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData() {}, setTiles(tiles: string[]) { this.tiles = tiles; } }); }
        addLayer(layer: StubLayer, before: string) { const i = this.layers.findIndex(item => item.id === before); if (i < 0) this.layers.push(layer); else this.layers.splice(i, 0, layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); } removeSource(id: string) { this.sources.delete(id); }
        getStyle() { return { layers: this.layers }; } getLayersOrder() { return this.layers.map(layer => layer.id); } moveLayer() {}
        getBounds() { return { getWest: () => -122, getEast: () => -121, getSouth: () => 46, getNorth: () => 47 }; }
        getZoom() { return 13; } setPaintProperty() {} fitBounds() {} resize() {} remove() {}
    }
    const dispatch = bootTerrainFrame(dom.window, MapStub, { messages, fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })) });
    const payload = { routeSegments: [[[46.5, -121.5], [46.51, -121.51]]], basemap: { name: 'Native topo', tiles: ['https://example.com/{z}/{x}/{y}.png'] } };
    const time = Date.now() - 2 * 86400000;
    const catalog = [0, 1].map(index => ({ id: `scene_${index}`, collection: 'sentinel-2-l2a', properties: { datetime: new Date(time - index * 86400000).toISOString(), platform: 'Sentinel-2B', 'sat:relative_orbit': 13, 'eo:cloud_cover': 41 }, geometry: { type: 'Polygon', coordinates: [[[-122,46],[-121,46],[-121,47],[-122,47],[-122,46]]] } }));
    const answer = async (index: number) => { pending[index].resolve({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ features: catalog }) }); await new Promise(resolve => setImmediate(resolve)); };
    const snapshot = { revision: 1, state: { sentinel: { enabled: true, opacity: 50 } }, capture: { time: time - 86400000, platform: 'Sentinel-2B', orbit: '13' }, menuOpen: true };
    try {
        dispatch({ type: 'init', ...payload }); map!.loadCallback();
        assert.equal(pending.length, 0, 'providers stay idle until a validated overlay snapshot');
        dispatch({ type: 'layers', snapshot }); assert.equal(pending.length, 1); await answer(0);
        const sourceId = [...map!.sources.keys()].find(id => id.startsWith('bpb-overlay-sentinel-'));
        const currentSource = () => map.getSource([...map.sources.keys()].find(id => id.startsWith('bpb-overlay-sentinel-'))!);
        const source = currentSource(); assert.ok(source); assert.equal(source.maxzoom, 14);
        assert.ok(map!.getSource('basemap'), 'imagery keeps the native drape');
        assert.equal(dom.window.document.querySelector<HTMLElement>('.bpb-sentinel'), null, 'overlay settings stay in the outer shared menu');
        assert.ok(framePicker(dom.window), 'basemap has its separate frame-owned picker');
        const beforeInteraction = messages.length;
        dom.window.document.getElementById('bpb-terrain-map')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        assert.equal(messages.at(-1)!.type, 'exit', 'map Escape retains its normal exit behavior while Layers stays open');
        assert.equal(messages.slice(beforeInteraction).some(message => message.type === 'layerDismiss'), false, '3D interaction never dismisses Layers');
        const status = () => messages.filter(message => message.type === 'layerStatus').at(-1);
        // This renderer stub never requests protocol tiles. A completed catalog
        // must retain its metadata without claiming the imagery has loaded.
        assert.equal(status()!.message, 'Loading imagery'); assert.equal(status()!.pending, true); assert.equal(status()!.capturePending, false);
        assert.match(status()!.captures![0].title, /Clouds 41%/); assert.notEqual(status()!.capture, 'latest');
        dispatch({ type: 'layers', snapshot: { ...snapshot, revision: 2, state: { sentinel: { enabled: true, opacity: 75 } } } });
        assert.equal(status()!.revision, 2); assert.equal(status()!.message, 'Loading imagery');
        assert.equal(pending.length, 1, 'a newer opacity snapshot republishes status without another catalog request');
        map!.handlers.get('moveend')!(); t.mock.timers.tick(300); await answer(1);
        assert.equal(currentSource(), source, 'same scenes reuse decoded tile resources');
        dispatch({ type: 'layerAction', action: 'basemap', selection: 'terrain' });
        assert.equal(map!.getSource('basemap'), undefined); assert.equal(currentSource(), source);
        map!.handlers.get('error')!({ sourceId, error: new Error('tile unavailable') }); assert.equal(status()!.retry, true);
        dispatch({ type: 'layerAction', action: 'retry', id: 'sentinel' });
        assert.equal(pending.length, 2, 'imagery recovery does not repeat the catalog search');
        assert.equal(currentSource(), source, 'failed tiles reload in the existing source');
        dispatch({ type: 'suspend' }); assert.equal(currentSource(), undefined);
        const choicesBeforeResume = messages.filter(message => message.type === 'layerBasemaps').length;
        dispatch({ type: 'resume', ...payload }); dispatch({ type: 'layers', snapshot: { ...snapshot, revision: 3 } });
        assert.ok(messages.filter(message => message.type === 'layerBasemaps').length > choicesBeforeResume, 'resume republishes the preserved user-selected basemap');
        assert.equal(pending.length, 3);
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(pending[2].options.signal!.aborted, true, 'BFCache freeze releases the renderer catalog'); await answer(2);
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
        assert.equal(messages.at(-1)!.type, 'layerResume', 'the restored renderer requests the latest bridge snapshot');
        dispatch({ type: 'layers', snapshot: { ...snapshot, revision: 3 } }); assert.equal(pending.length, 4);
        dispatch({ type: 'layers', snapshot: { revision: 2, state: {} } }); assert.equal(pending[3].options.signal!.aborted, false, 'stale snapshots cannot turn off newer intent');
        dispatch({ type: 'layers', snapshot: { revision: 4, state: {} } }); assert.equal(pending[3].options.signal!.aborted, true);
        await answer(3); assert.equal(currentSource(), undefined, 'late catalogs cannot redraw a disabled overlay');
    } finally { dispatch({ type: 'destroy' }); dom.window.close(); }
});

// Boot the terrain frame against a MapLibre stub whose DEM protocol answers
// from `tileStatus`, so a region the provider does not cover can be replayed
// without a network or a renderer. Returns the pieces a coverage assertion
// needs: the posted messages, the live map stub, and the protocol handler
// MapLibre would call for each tile.
const bootFrameWithTileHost = ({ tileStatus, deferLoad = false }: { tileStatus?: (url: string) => number; deferLoad?: boolean } = {}) => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages: TestMessage[] = [];
    const maps: StubMap[] = [];
    const requested: string[] = [];
    let protocol: StubProtocol | null = null;
    let fireLoad: Handler | null = null;

    class MapStub {
        declare canvas: HTMLCanvasElement;
        declare data: unknown;
        declare handlers: Map<string, Handler>;
        declare layers: StubLayer[];
        declare options: StubOptions;
        declare removed: boolean;
        declare sources: Map<string, StubSource>;
        constructor(options: StubOptions) {
            this.options = options;
            this.sources = new Map();
            this.layers = [];
            this.handlers = new Map();
            this.canvas = { style: {}, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
            maps.push(this as unknown as StubMap);
        }
        addControl() {}
        once(type: string, callback: Handler) {
            if (type !== 'load') return;
            if (deferLoad) fireLoad = callback;
            else window.queueMicrotask(callback);
        }
        on(type: string, callback: Handler) { this.handlers.set(type, callback); }
        addSource(id: string, source: StubSource) { this.sources.set(id, { ...source, setData(data) { this.data = data; } }); }
        addLayer(layer: StubLayer) { this.layers.push(layer); }
        getLayer(id: string) { return this.layers.find(layer => layer.id === id); }
        removeLayer(id: string) { this.layers = this.layers.filter(layer => layer.id !== id); }
        getSource(id: string) { return this.sources.get(id); }
        removeSource(id: string) { this.sources.delete(id); }
        setPaintProperty() {}
        setSourceTileLodParams() {}
        queryRenderedFeatures() { return []; }
        project() { return { x: -10000, y: -10000 }; }
        getCanvas() { return this.canvas; }
        getZoom() { return 13; }
        getCenter() { return { lng: -121.805, lat: 48.73 }; }
        getBounds() {
            return {
                getWest: () => -121.9, getEast: () => -121.7,
                getSouth: () => 48.6, getNorth: () => 48.8
            };
        }
        isMoving() { return false; }
        isZooming() { return false; }
        isRotating() { return false; }
        fitBounds() {}
        jumpTo() {}
        resize() {}
        remove() { this.removed = true; }
    }

    const fetch = async (url: string) => {
        requested.push(String(url));
        const status = tileStatus!(String(url));
        if (status === 200) {
            return new Response(makeWebp(), {
                status: 200, headers: { 'content-type': 'image/webp' }
            });
        }
        return new Response('Tile not found', { status });
    };
    bootTerrainFrame(window, MapStub, {
        messages, fetch,
        maplibre: {
            Popup: class { setLngLat() { return this; } setDOMContent() { return this; } addTo() { return this; } remove() {} },
            addProtocol(name: string, handler: StubProtocol) { if (name === 'bpb-dem') protocol = handler; },
            removeProtocol() { protocol = null; }
        }
    });

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrainFrame: true,
            dir: 'toFrame',
            type: 'init',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
            theme: 'light',
            // No CacheStorage in jsdom, so the loader is network-only: every
            // tile the renderer asks for reaches the stubbed host.
            cacheLimitMb: 0
        }
    }));

    // Each tile MapLibre would fetch, driven through the frame's own protocol
    // registration so the outcome is counted exactly as it is in the browser.
    const loadTiles = async (...urls: string[]) => Promise.all(urls.map(url =>
        protocol!({ url }, new AbortController()).then(() => 'data', (error: { status?: number }) => error) as Promise<{ status?: number } | string>));

    return { dom, window, messages, maps, requested, loadTiles, dispatch: (payload: TestMessage) => window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: window.location.origin, data: { __bpbTerrainFrame: true, dir: 'toFrame', ...payload } })), fireLoad: () => fireLoad!() };
};

test('a region the elevation provider does not cover returns to 2D instead of paving the mountain', async () => {
    // MapLibre renders elevation 0 where it has no DEM, so a view over ground
    // Mapterhorn's archives do not cover paints as a convincing flat plane —
    // a working-looking 3D map of a mountain that has been bulldozed. Nothing
    // errors, so nothing else can catch this: the protocol is the only place
    // that sees a tile come back absent.
    const host = bootFrameWithTileHost({ tileStatus: () => 404 });
    await new Promise<void>(resolve => host.window.queueMicrotask(resolve));
    const map = host.maps[0];
    assert.equal(host.messages.at(-1)!.type, 'loaded', 'a coverage gap must not block the boot handshake');

    const outcomes = await host.loadTiles(
        'bpb-dem://12/662/1411.webp', 'bpb-dem://11/331/705.webp', 'bpb-dem://10/165/352.webp');
    assert.ok(outcomes.every(outcome => (outcome as { status?: number }).status === 404), 'every tile was absent');

    map.handlers.get('idle')!();
    assert.deepEqual(
        { type: host.messages.at(-1)!.type, reason: host.messages.at(-1)!.reason },
        { type: 'error', reason: 'coverage' });
    host.dom.window.close();
});

test('an elevation gap above the provider level keeps the 3D view on the coarser tiles that do exist', async () => {
    // The common shape by far: Mapterhorn serves most of the world to about
    // zoom 11-13 and only a few regions deeper, so a summit view routinely
    // asks for levels the local archive does not have. MapLibre answers those
    // from the parent level it does have, which is a slightly softer mesh —
    // not a failure, and not something to tear the view down for.
    const host = bootFrameWithTileHost({
        tileStatus: (url: string) => (Number(url.match(/(\d+)\/\d+\/\d+\.webp$/)![1]) > 13 ? 404 : 200)
    });
    await new Promise<void>(resolve => host.window.queueMicrotask(resolve));
    const map = host.maps[0];

    const outcomes = await host.loadTiles(
        'bpb-dem://14/2650/5644.webp', 'bpb-dem://13/1325/2822.webp', 'bpb-dem://12/662/1411.webp');
    assert.deepEqual(outcomes.map(outcome => (outcome as { status?: number }).status ?? outcome), [404, 'data', 'data']);

    map.handlers.get('idle')!();
    assert.ok(!host.messages.some(message => message.type === 'error'),
        `a partial coverage gap must not fail: ${JSON.stringify(host.messages.map(m => m.type))}`);
    assert.equal(host.messages.at(-1)!.type, 'loaded');
    host.dom.window.close();
});

test('an elevation source that cannot be reached during boot does not blame the browser', async () => {
    // Before load the elevation source is the only one in the style, so its
    // failures land here — and telling the user their browser cannot render 3D
    // sends them to check a GPU that is working fine.
    const host = bootFrameWithTileHost({ tileStatus: () => 500, deferLoad: true });
    const map = host.maps[0];
    map.handlers.get('error')!({ sourceId: 'terrain', error: new Error('DEM tile request failed (500)') });
    assert.deepEqual(
        { type: host.messages.at(-1)!.type, reason: host.messages.at(-1)!.reason },
        { type: 'error', reason: 'elevation' });
    host.dom.window.close();
});

test('a style or renderer failure during boot still reports the browser', async () => {
    const host = bootFrameWithTileHost({ tileStatus: () => 200, deferLoad: true });
    const map = host.maps[0];
    map.handlers.get('error')!({ error: new Error('WebGL context could not be created') });
    assert.deepEqual(
        { type: host.messages.at(-1)!.type, reason: host.messages.at(-1)!.reason },
        { type: 'error', reason: 'maplibre' });
    host.dom.window.close();
});

test('every failure reason the frame can report survives the bridge relay intact', async () => {
    // The bridge checks the reason because it crosses a trust boundary, and it
    // used to check against its own hand-written copy of the list. A reason the
    // copy had not heard of was silently rewritten to 'renderer' — so the frame
    // correctly reported a provider coverage gap and the user was told "Your
    // browser could not render 3D terrain", in a build where every test passed.
    // Pin the relay against the module that owns the reasons, not a second list.
    for (const reason of terrainFailure.REASONS) {
        const harness = await bootLoadedFrame();
        harness.dispatchFrame({ type: 'error', reason });
        const relayed = harness.pageMessages.at(-1);
        assert.equal(relayed!.type, 'error');
        assert.equal(relayed!.reason, reason, `the bridge rewrote '${reason}'`);
        // Whatever survives must also have something to say for itself.
        assert.match(terrainFailure.message(reason), /2D map is unchanged/);
        harness.dom.window.close();
    }

    const unknown = await bootLoadedFrame();
    unknown.dispatchFrame({ type: 'error', reason: 'something-a-page-made-up' });
    assert.equal(unknown.pageMessages.at(-1)!.reason, 'renderer',
        'an unrecognised reason must still fail closed to a known one');
    unknown.dom.window.close();
});

test('a DEM rate limit during boot reports the provider rather than a renderer failure', async () => {
    const host = bootFrameWithTileHost({ tileStatus: () => 429, deferLoad: true });
    try {
        host.maps[0].handlers.get('error')!({ sourceId: 'terrain', error: Object.assign(new Error('limit'), { status: 429 }) });
        assert.equal(host.messages.at(-1)!.reason, 'elevation-rate-limit');
        assert.match(terrainFailure.message('elevation-rate-limit'), /Mapterhorn request limit reached/);
    } finally { host.dom.window.close(); }
});

test('a loaded DEM limit keeps the working terrain and shows one contextual notice', async () => {
    const host = bootFrameWithTileHost({ tileStatus: () => 200 });
    try {
        await new Promise(resolve => setImmediate(resolve));
        const map = host.maps[0];
        map.handlers.get('error')!({ sourceId: 'terrain', error: Object.assign(new Error('limit'), { status: 429 }) });
        assert.match(host.window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.textContent, /Mapterhorn request limit reached/);
        assert.equal(map.removed, undefined);
        assert.equal(host.messages.some(message => message.type === 'error'), false);
    } finally { host.dom.window.close(); }
});

test('resumed coverage cannot borrow successful DEM tiles from the previous region', async () => {
    const host = bootFrameWithTileHost({ tileStatus: (url: string) => url.includes('/662/') ? 200 : 404 });
    try {
        await new Promise<void>(resolve => host.window.queueMicrotask(resolve));
        const map = host.maps[0];
        await host.loadTiles('bpb-dem://12/662/1411.webp'); map.handlers.get('idle')!();
        host.dispatch({ type: 'suspend' });
        map.getBounds = () => ({ getWest: () => 10, getEast: () => 11, getSouth: () => 45, getNorth: () => 46 });
        host.dispatch({ type: 'resume', focus: [45.5, 10.5], focusZoom: 12, theme: 'light' });
        await new Promise<void>(resolve => host.window.queueMicrotask(resolve));
        await host.loadTiles('bpb-dem://12/2167/1465.webp'); map.handlers.get('idle')!();
        assert.equal(host.messages.at(-1)!.reason, 'coverage');
    } finally { host.window.close(); }
});

test('parking the terrain renderer clears transient provider notices', async () => {
    const host = bootFrameWithTileHost({ tileStatus: () => 200 });
    try {
        await new Promise<void>(resolve => host.window.queueMicrotask(resolve));
        host.maps[0].handlers.get('error')!({ sourceId: 'terrain', error: { status: 429, retryAt: Date.now() + 60000 } });
        assert.equal(host.window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.hidden, false);
        host.dispatch({ type: 'suspend' });
        assert.equal(host.window.document.querySelector<HTMLElement>('.bpb-terrain-notice')!.hidden, true);
    } finally { host.window.close(); }
});
