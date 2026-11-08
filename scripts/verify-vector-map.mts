// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import type { Frame } from 'playwright';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createBrowserFixtureServer, waitForCondition as waitForValue, resolveFixtureFile } from './browser-verification-fixtures.mjs';
import { snowMapDocument } from './verify-snow-map-fixture.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { decodePng } from './browser-verification-png.mts';
import { MAPTOOLKIT_BASEMAP } from '../src/maps/vector-basemap.ts';


// Browser-side fixture globals these evaluated callbacks read; node strips the
// annotations in place, so each callback's page-world source is unchanged.
interface FixtureLatLng { lat: number; lng: number; wrap(): FixtureLatLng; }
interface FixtureLayer { options?: { bpbVector?: boolean }; surface: Element; painted?: { view: { zoom: number; center: number[] }; width: number; height: number }; element: Element; [field: string]: unknown; }
interface FixtureMap {
    invalidateSize(): void; setView(center: number[], zoom: number, options?: object): void; panBy(offset: number[], options?: object): void; panTo(center: number[], options?: object): void;
    getCenter(): FixtureLatLng; getZoom(): number; hasLayer(layer: unknown): boolean; eachLayer(callback: (layer: FixtureLayer) => void): void;
    zoomIn(delta?: number, options?: object): void; zoomOut(delta?: number, options?: object): void; setZoom(zoom: number, options?: object): void;
    latLngToContainerPoint(point: number[]): { x: number; y: number }; getContainer(): HTMLElement; _animatingZoom?: boolean; once(type: string, callback: () => void): void; on(type: string, callback: () => void): void;
    [field: string]: unknown;
}
interface TraceEntry { delta: number; [field: string]: unknown; }
interface TerrainTestMap {
    getStyle(): { layers: { id: string; source?: string; [field: string]: unknown }[]; sources: Record<string, { type?: string }>; [field: string]: unknown };
    getSource(id: string): { type?: string; tileSize?: number; [field: string]: unknown } | undefined; getLayer(id: string): unknown; getTerrain(): { source?: string } | null;
    getSprite(): { id: string; url: string }[]; project(point: unknown): { x: number; y: number }; queryRenderedFeatures(...args: unknown[]): unknown[]; queryTerrainElevation(point: unknown): number | null;
    jumpTo(options: object): void; loaded(): boolean; areTilesLoaded(): boolean; resize(): void; once(type: string, callback: () => void): void; getCanvas(): HTMLCanvasElement; fire(type: string, event?: object): void; [field: string]: unknown;
}
type FixtureElement = HTMLElement & { value: string; disabled: boolean; href: string; contentWindow: Window };
declare const mapsPlaceholder: FixtureMap, nativeTiles: unknown;
declare const nativePeak: { getElement(): SVGPathElement; setLatLng(point: unknown): void; setStyle(style: object): void; getLatLng(): { lat: number; lng: number } };
declare global {
    interface Window {
        __bpbTerrainTestMap: TerrainTestMap; zoomTrace: TraceEntry[]; vectorFirstPaintLatency: number | null; vectorEvents: unknown[]; vectorFixtureCode: string;
        vectorSettledViews: { center: number[] }[]; vectorChosenAt: number; staleSceneRejected: unknown; holdZoomView: boolean; holdSnapshotCenter: number[] | null;
        heldZoomViews: { data: unknown; origin: string }[]; heldSnapshots: (() => void)[]; nativeSelections: string[];
    }
}
// The legacy helper's default isReady hides its generic read result.
const waitForCondition = waitForValue as unknown as <T>(read: () => T | Promise<T>, options?: { description?: string; intervalMs?: number; timeoutMs?: number; isReady?: (value: T) => unknown }) => Promise<NonNullable<T>>;

const args = process.argv.slice(2);
assert.ok(new Set(args).size === args.length && args.every(arg => ['--firefox', '--terrain', '--preflight', '--live', '--camera-only', '--recovery-only', '--cooldown-only', '--layout-only', '--performance-only', '--zoom-only'].includes(arg))
    && args.filter(arg => ['--preflight', '--live', '--camera-only', '--recovery-only', '--cooldown-only', '--layout-only', '--performance-only', '--zoom-only'].includes(arg)).length <= 1,
'Usage: node scripts/verify-vector-map.mts [--firefox] [--terrain] [--preflight | --live | --camera-only | --recovery-only | --cooldown-only | --layout-only | --performance-only | --zoom-only]');
const terrainMode = args.includes('--terrain');
const zoomMode = args.includes('--zoom-only');
assert.ok(!terrainMode || !args.some(arg => ['--camera-only', '--recovery-only', '--cooldown-only', '--layout-only', '--performance-only', '--zoom-only'].includes(arg)), 'Terrain selection requires the full, live or preflight mode');
const instrumentMap = (source: string) => {
    assert.ok(source.includes('startTerrainFrame(maplibre);'), 'Packaged frame exposes its expected startup call');
    return source.replace('startTerrainFrame(maplibre);', `startTerrainFrame({ ...maplibre, Map: new Proxy(maplibre.Map, {
        construct(Target, args, newTarget) { const map = Reflect.construct(Target, args, newTarget); window.__bpbTerrainTestMap = map; return map; }
    }) });`);
};
const instrumentVectorMap = (source: string) => {
    assert.ok(source.includes('map = new maplibre.Map({'), 'Packaged 2D frame exposes its expected constructor');
    return `window.heldZoomViews = []; window.holdZoomView = false;
    window.heldSnapshots = []; window.holdSnapshotCenter = null;
    const originalSnapshot = window.createImageBitmap.bind(window);
    window.createImageBitmap = (...args) => {
        const snapshot = originalSnapshot(...args), center = window.__bpbVectorTestMap?.getCenter();
        if (!window.holdSnapshotCenter || !center || Math.abs(center.lat - window.holdSnapshotCenter[0]) > .00001 || Math.abs(center.lng - window.holdSnapshotCenter[1]) > .00001) return snapshot;
        return snapshot.then(bitmap => new Promise(resolve => window.heldSnapshots.push(() => resolve(bitmap))));
    };
    window.addEventListener('message', event => {
        if (!window.holdZoomView || event.data?.__bpbVectorMap !== true || event.data.type !== 'view') return;
        event.stopImmediatePropagation(); window.heldZoomViews.push({ data: event.data, origin: event.origin });
    });\n` + source.replace('map = new maplibre.Map({', 'map = window.__bpbVectorTestMap = new maplibre.Map({');
};
const basemap = MAPTOOLKIT_BASEMAP;
const providerOrigin = 'https://tiles.maptoolkit.org';
const chooseKeys = 'Maptoolkit';
const firefoxMode = args.includes('--firefox'), preflight = args.includes('--preflight'), liveMode = args.includes('--live'), cameraOnly = args.includes('--camera-only');
const recoveryOnly = args.includes('--recovery-only');
const cooldownOnly = args.includes('--cooldown-only');
const root = path.resolve(import.meta.dirname, '..'), resources = createResourceStack();
let failure, summary, failurePage, failureContext;
try {
    const profile = await mkdtemp(path.join(tmpdir(), 'bpb-vector-map-'));
    resources.defer('vector profile', () => rm(profile, { recursive: true, force: true }));
    let html = await snowMapDocument();
    html = html.replace('html,body,#map{height:100%;margin:0}', 'html,body{margin:0}#map{height:440px}h1,p{margin:12px;font:16px Arial}')
        .replace('#selmap{position:absolute;top:10px;right:10px;z-index:1000}', '#map{position:relative}#selboxdiv{font:11px Tahoma,Verdana,Arial Narrow;padding:5px;top:10px;right:10px;width:170px;position:absolute;z-index:1000;background:white;border:2px solid black}')
        .replace('<body><div id="map"></div>', '<body><h1>Native map heading</h1><div id="map">')
        .replace('<select id="selmap">', '<div id="selboxdiv"><select id="selmap" aria-label="Base map">')
        .replace('</select>', '<option value="L_SECOND">Other native map</option></select></div></div><p id="following">Following native content</p>')
        .replace('</script></body>', `window.nativeChanges=0;
        window.nativeSelections=[];
        document.getElementById('selmap').onchange=event=>{window.nativeChanges++;window.nativeSelections.push(event.target.value);};
        window.nativeTiles=L.tileLayer('/vector-native/{z}/{x}/{y}.png').addTo(mapsPlaceholder);
        </script></body>`);
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile, masterMapDocument: html, peakMapDocument: html, bigMapDocument: html } as Parameters<typeof createBrowserFixtureServer>[0]);
    resources.defer('vector HTTPS fixture', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const extensionRoot = path.join(profile, 'extension');
    await cp(path.join(root, 'dist'), extensionRoot, { recursive: true });
    if ((terrainMode || zoomMode) && !firefoxMode) {
        const module = path.join(extensionRoot, terrainMode ? 'terrain/terrain-frame.js' : 'terrain/vector-map-frame.js');
        await writeFile(module, (terrainMode ? instrumentMap : instrumentVectorMap)(await readFile(module, 'utf8')));
    }
    if (!firefoxMode) assertChromeLaunchAllowed();
    const context = await (firefoxMode ? firefox : chromium).launchPersistentContext(profile, firefoxMode ? {
        headless: true, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 },
        firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com', 'webgl.sanitize-unmasked-renderer': false },
    } : { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1',
            `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
    });
    resources.defer('vector browser', () => context.close());
    if (terrainMode && !firefoxMode) {
        const worker = await waitForCondition(() => context.serviceWorkers()[0], { description: 'real extension worker startup' });
        await worker.evaluate(async () => {
            await globalThis.chrome.storage.sync.set({ bpbSettings: { enable3dMap: true } });
            await globalThis.chrome.storage.local.set({ bpbDeviceSettings: { schemaVersion: 1, settings: { terrainCacheLimitMb: 0 } } });
        });
    }
    await context.addInitScript(code => { window.vectorFixtureCode = code; }, basemap.code);
    const page = await context.newPage(), errors: string[] = [], requests: string[] = [];
    failurePage = page;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().startsWith('Better Peakbagger vector map:')) console.error(message.text()); });
    let mode = 'hold', tileFailures = 0, partialUrl: string | null = null; const held = new Set<(value?: unknown) => void>();
    let retrySeconds = '2';
    failureContext = () => ({ mode, partialUrl, lastRequests: requests.slice(-12) });
    const release = () => { for (const done of held) done(); held.clear(); };
    resources.defer('held vector styles', release);
    const dem = Buffer.from('UklGRoIAAABXRUJQVlA4THYAAAAv/8F/AD8gFkzyR94dhICgyHPTY/6zQwZFtW1TKqigggoqqKCC/rM/wx3R/wkI/M//A+P38h+YpefnP1DLz8t/4Fauz38gV4/Pf2DXtuc/0OvT+Y//+I/41uc/wDsv/wHdffkP4N6T/4DtvfkP0P6T/4CM/8Ef', 'base64');
    const pngTile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPYcWDLfwAHjAMsIXX3PwAAAABJRU5ErkJggg==', 'base64');
    await context.route('**/vector-native/**', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'image/png', body: pngTile }));
    const geographicPoints = [[5, 90], [75, 5], [-75, 5], [5, 5], [46.851731, -121.760395]];
    const tile = (url: string) => {
        const match = /\/fixture\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url); assert.ok(match, `Unexpected vector tile ${url}`);
        const [, z, x, y] = match.map(Number), scale = 2 ** z;
        const features = geographicPoints.flatMap(([lat, lon]) => {
            const worldX = (lon + 180) / 360 * scale, worldY = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * scale;
            return Math.floor(worldX) === x && Math.floor(worldY) === y
                ? [{ type: 1, geometry: [[Math.round((worldX - x) * 4096), Math.round((worldY - y) * 4096)]], tags: {} }] : [];
        });
        return Buffer.from(fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] }, probes: { features } }, { version: 2, extent: 4096 }));
    };
    const emptyTile = Buffer.from(fromGeojsonVt({ land: { features: [] }, probes: { features: [] } }, { version: 2, extent: 4096 }));
    const style: { version: number; sprite?: unknown; sources: Record<string, object>; layers: { id: string; type: string; source?: string; 'source-layer'?: string; paint?: Record<string, unknown> }[] } = { version: 8, sources: { fixture: { type: 'vector', url: `${providerOrigin}/vector.json` } }, layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#d5dec9' } },
        { id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'land', paint: { 'fill-color': '#c4ddac' } },
        { id: 'probes', type: 'circle', source: 'fixture', 'source-layer': 'probes', paint: { 'circle-radius': 12, 'circle-color': '#1e64d2' } },
    ] };
    if (zoomMode) style.layers.find(layer => layer.id === 'probes')!.paint!['circle-radius'] = 20;
    if (basemap === MAPTOOLKIT_BASEMAP) {
        // The real Hiking style shades from Mapterhorn. A healthy DEM must not hide a cartography outage.
        style.sources.dem = { type: 'raster-dem', tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'], tileSize: 512, encoding: 'terrarium' };
        style.layers.splice(1, 0, { id: 'relief', type: 'hillshade', source: 'dem' });
    }
    if (basemap === MAPTOOLKIT_BASEMAP) style.sprite = [{ id: 'sdf', url: 'https://icons.maptoolkit.org/sprite' }, { id: 'nature', url: 'https://icons.maptoolkit.org/nature' }];
    await context.route(url => basemap.origins.some(candidate => url.origin === candidate) || terrainMode && url.origin === 'https://tiles.mapterhorn.com', async route => {
        const url = route.request().url(); requests.push(url);
        assert.equal(route.request().headers().cookie, undefined); assert.equal(route.request().headers().referer, undefined);
        if (liveMode) return route.continue();
        if (url.startsWith('https://tiles.mapterhorn.com/')) return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'image/webp', body: dem });
        const isStyle = url === basemap.styleUrl;
        if (isStyle && mode === 'hold') await new Promise(resolve => held.add(resolve));
        if (mode === 'tile-hold' && url.endsWith('.pbf')) {
            const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url)!.map(Number), scale = 2 ** z;
            const centerX = Math.floor((-121.760395 + 180) / 360 * scale);
            const centerY = Math.floor((1 - Math.asinh(Math.tan(46.851731 * Math.PI / 180)) / Math.PI) / 2 * scale);
            if (x !== centerX || y !== centerY) partialUrl ??= url;
            if (url === partialUrl) await new Promise(resolve => held.add(resolve));
        }
        if (url.startsWith('https://icons.maptoolkit.org/')) return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: url.endsWith('.png') ? 'image/png' : 'application/json', body: url.endsWith('.png') ? pngTile : '{}' });
        const metadata = url.endsWith('/vector.json');
        if (mode === 'partial' && url.endsWith('.pbf')) partialUrl ??= url;
        const atCenter = url.endsWith('.pbf') && (() => {
            const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url)!.map(Number), scale = 2 ** z;
            return x === Math.floor((-121.760395 + 180) / 360 * scale) && y === Math.floor((1 - Math.asinh(Math.tan(46.851731 * Math.PI / 180)) / Math.PI) / 2 * scale);
        })();
        const tileFailed = url.endsWith('.pbf') && (mode === 'tile-error' || mode === 'partial' && url === partialUrl || mode === 'center-error' && atCenter);
        const limited = mode === 'style-limit' && isStyle || mode === 'tile-limit' && url.endsWith('.pbf');
        if (tileFailed) tileFailures++;
        try {
            await route.fulfill({ status: limited ? 429 : tileFailed || mode === 'error' && isStyle || mode === 'metadata-error' && metadata ? 503 : 200,
                headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...(limited ? { 'retry-after': retrySeconds, 'access-control-expose-headers': 'Retry-After' } : {}) },
                contentType: url.endsWith('.pbf') ? 'application/x-protobuf' : 'application/json',
                body: url.endsWith('.pbf') ? mode === 'empty' ? emptyTile : tile(url) : JSON.stringify(metadata
                    ? { tilejson: '3.0.0', tiles: [`${providerOrigin}/fixture/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14,
                        ...(basemap === MAPTOOLKIT_BASEMAP ? { attribution: "<a href='https://www.maptoolkit.com/copyright/' target='_blank' rel='noopener noreferrer'>&copy; Maptoolkit</a> <a href='https://www.openstreetmap.org/copyright' target='_blank' rel='noopener noreferrer'>&copy; Openstreetmap</a>" } : {}) } : style),
            });
        } catch { /* A deliberately cancelled frame no longer owns its request. */ }
    });
    if (firefoxMode) {
        await context.route(`${origin}/dist/**`, async route => {
            const shipped = await resolveFixtureFile(new URL(route.request().url()).pathname);
            assert.ok(shipped, `Packaged Firefox fixture asset exists: ${route.request().url()}`);
            const file = path.join(extensionRoot, path.relative(path.join(root, 'dist'), shipped));
            if (terrainMode && file.endsWith('/terrain-frame.js')) return route.fulfill({ body: instrumentMap(await readFile(file, 'utf8')), contentType: 'text/javascript' });
            if (zoomMode && file.endsWith('/vector-map-frame.js')) return route.fulfill({ body: instrumentVectorMap(await readFile(file, 'utf8')), contentType: 'text/javascript' });
            await route.fulfill({ path: file, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript' });
        });
        // Firefox exercises real Leaflet and hardware MapLibre; only extension
        // runtime/capability transport is stubbed. Chrome loads the real addon.
        await context.addInitScript(({ origin: pageOrigin, terrainMode: enableTerrain }) => { const read = (_keys: unknown, callback: ((result?: unknown) => void) | undefined) => {
            const result = { bpbSettings: { enable3dMap: enableTerrain }, bpbDeviceSettings: { schemaVersion: 1, settings: { terrainCacheLimitMb: 0 } } }; callback?.(result); return Promise.resolve(result);
        }; const event = { addListener() {}, removeListener() {} };
        const write = (_data: unknown, callback: ((result?: unknown) => void) | undefined) => { callback?.(); return Promise.resolve(); };
        (window as unknown as { chrome: unknown }).chrome = { storage: { sync: { get: read, set: write }, local: { get: read, set: write }, session: { get: read, set: write }, onChanged: event }, runtime: {
            getURL: (value: string) => `${pageOrigin}/dist/${value}`, sendMessage: async () => ({ ok: true, token: 'fixture-activation', expiresAt: Date.now() + 5000 }),
            onMessage: event,
        } }; }, { origin, terrainMode });
    }
    const open = async () => {
        await page.goto(`${origin}/map/${terrainMode ? 'BigMap' : 'MasterMap'}.aspx?t=A`);
        if (firefoxMode) {
            await page.addStyleTag({ path: path.join(extensionRoot, 'css/vector-map.css') });
            await page.addScriptTag({ path: path.join(extensionRoot, 'content/vector-map-bridge.js') });
            await page.addScriptTag({ path: path.join(extensionRoot, 'content/vector-map.js') });
            if (terrainMode) {
                await page.addStyleTag({ path: path.join(extensionRoot, 'css/terrain-map.css') });
                for (const file of ['big-map-bridge', 'big-map', 'terrain-map']) await page.addScriptTag({ path: path.join(extensionRoot, `content/${file}.js`) });
            }
        }
        await page.waitForFunction(() => !!(window as unknown as { mapsPlaceholder?: FixtureMap }).mapsPlaceholder?.getSize);
        if (!preflight) await page.locator(`#selmap option[value="${basemap.code}"]`).waitFor({ state: 'attached' });
        // The extension's first-run tab can become the active tab in this
        // disposable headless browser. Native picker defaults need page focus.
        await page.bringToFront();
        await page.evaluate(() => {
            document.addEventListener('change', event => {
                if (event.isTrusted && (event.target as FixtureElement).id === 'selmap' && (event.target as FixtureElement).value === window.vectorFixtureCode) {
                    window.vectorChosenAt = performance.now(); window.vectorFirstPaintLatency = null;
                }
            }, true);
            window.addEventListener('message', event => {
                if (event.data?.__bpbVectorMap === true && event.data.dir === 'toPage' && event.data.type === 'painted'
                    && window.vectorFirstPaintLatency == null && window.vectorChosenAt != null
                    && document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1') window.vectorFirstPaintLatency = performance.now() - window.vectorChosenAt;
            });
            window.vectorEvents = [];
            for (const type of ['keydown', 'change', 'input']) document.addEventListener(type, event => {
                if ((event.target as FixtureElement).id === 'selmap') window.vectorEvents.push({ type, key: (event as KeyboardEvent).key, trusted: event.isTrusted, value: (event.target as FixtureElement).value });
            });
            // Optional hover/focus warming is covered by its own suite. Keep
            // this fixture's elevation requests in the visible frame so all
            // synthetic DEM replies are intercepted deterministically.
            for (const type of ['mouseenter', 'focus']) document.addEventListener(type, event => {
                if ((event.target as FixtureElement | null)?.id === 'bpb-terrain-toggle') event.stopImmediatePropagation();
            }, true);
            window.vectorSettledViews = [];
            window.addEventListener('message', event => {
                if (event.source === document.querySelector<FixtureElement>('.bpb-vector-slot iframe')?.contentWindow
                    && event.data?.__bpbVectorMap === true && event.data.type === 'loaded' && event.data.view) window.vectorSettledViews.push(event.data.view);
            });
        });
    };
    await open();
    await page.evaluate(() => {
        window.vectorEvents = [];
        for (const type of ['keydown', 'change', 'input']) document.addEventListener(type, event => {
            if ((event.target as FixtureElement).id === 'selmap') window.vectorEvents.push({ type, key: (event as KeyboardEvent).key, trusted: event.isTrusted, value: (event.target as FixtureElement).value });
        }, true);
    });
    const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return null;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const result = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        gl.getExtension('WEBGL_lose_context')?.loseContext(); return result;
    });
    assert.ok(renderer && !/swiftshader|llvmpipe|software/i.test(renderer), `Hardware renderer required; got ${renderer}`);
    const verifyPicker = async () => {
        const boxes = await page.evaluate(() => ['#map', '#selboxdiv', '#selmap'].map(selector => {
            const r = document.querySelector(selector)!.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }));
        const [map, surround, picker] = boxes;
        assert.ok(picker.left >= surround.left && picker.right <= surround.right && picker.top >= surround.top && picker.bottom <= surround.bottom,
            `Basemap picker must fit its native surround: ${JSON.stringify(boxes)}`);
        assert.ok(surround.left >= map.left && surround.right <= map.right, `Picker surround must fit the map: ${JSON.stringify(boxes)}`);
    };
    const verifyPickerLayouts = async () => {
        let cases = 0;
        for (const [width, zoom] of [[1280, 1], [375, 1], [1280, 2], [375, 2]] as [number, number][]) {
            await page.setViewportSize({ width, height: 800 }); await open();
            await page.evaluate(pageZoom => { document.body.style.zoom = pageZoom as unknown as string; mapsPlaceholder.invalidateSize(); }, zoom);
            for (const theme of ['light', 'dark']) {
                await page.evaluate(pageTheme => { document.documentElement.dataset.bpbTheme = pageTheme; }, theme);
                await verifyPicker(); cases++;
                if (process.env.BPB_VECTOR_SCREENSHOTS) {
                    await mkdir(process.env.BPB_VECTOR_SCREENSHOTS, { recursive: true });
                    await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `${firefoxMode ? 'firefox' : 'chrome'}-picker-${width}-${zoom}-${theme}.png`) });
                }
            }
        }
        return cases;
    };
    const verifyProgressive = async () => {
        mode = 'tile-hold'; partialUrl = null; await open();
        const started = performance.now();
        await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys);
        await waitForCondition(() => held.size, { description: 'a held secondary vector tile' });
        await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1', null, { timeout: 5000 });
        assert.ok(held.size > 0, 'Usable map appears before the delayed secondary tile finishes');
        assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), false, 'Visible progressive map replaces the fallback');
        const firstLatency = await page.evaluate(() => window.vectorFirstPaintLatency);
        assert.ok(Number.isFinite(firstLatency) && firstLatency! >= 0, 'Initial paint must be measured after the trusted choice');
        const firstPaintMs = Math.round(firstLatency!), firstDriverElapsedMs = Math.round(performance.now() - started);
        mode = 'ready'; release(); await verifyPicker();
        const frame = page.frames().find(item => /\/terrain\/vector.html/.test(item.url())); assert.ok(frame);
        const styles = requests.filter(url => url === basemap.styleUrl).length;
        await page.locator('#selmap').selectOption('L_FIX');
        await page.waitForFunction(() => !document.querySelector<FixtureElement>('.bpb-vector-slot'));
        await page.evaluate(() => { mapsPlaceholder.panBy([60, 20], { animate: false }); });
        assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true);
        const resumed = performance.now();
        if (firefoxMode) {
            await page.locator('#selmap').focus();
            if (basemap === MAPTOOLKIT_BASEMAP) await page.keyboard.press('End');
            else { await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); }
        } else { await page.locator('#selmap').click(); await page.keyboard.type(chooseKeys); await page.keyboard.press('Enter'); }
        await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
        const warmLatency = await page.evaluate(() => window.vectorFirstPaintLatency);
        assert.ok(Number.isFinite(warmLatency) && warmLatency! >= 0, 'Warm paint must be measured after the trusted choice');
        const warmPaintMs = Math.round(warmLatency!);
        const driverElapsedMs = Math.round(performance.now() - resumed);
        assert.equal(page.frames().find(item => /\/terrain\/vector.html/.test(item.url())), frame, 'Layer reselection reuses its initialized renderer');
        assert.equal(requests.filter(url => url === basemap.styleUrl).length, styles, 'Warm selection reuses its validated style');
        await verifyPicker(); await verifyCredits();
        return { cases: 2, firstPaintMs, warmPaintMs, driverElapsedMs, firstDriverElapsedMs };
    };
    const verifyCredits = async () => {
        if (basemap !== MAPTOOLKIT_BASEMAP) return;
        const result = await page.evaluate(async () => {
            const logo = document.querySelector<FixtureElement>('.bpb-vector-maptoolkit-logo'), credits = document.querySelector<FixtureElement>('.bpb-vector-credits');
            const image = new Image(); image.src = window.getComputedStyle(logo!).backgroundImage.slice(5, -2); await image.decode();
            const box = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
            return { logoHeight: logo!.offsetHeight, imageWidth: image.naturalWidth, links: [...credits!.querySelectorAll('a')].map(a => a.href),
                logo: box(logo!), credits: box(credits!), map: box(document.getElementById('map')!), zoom: box(document.querySelector<FixtureElement>('.leaflet-control-zoom')!),
                nativeVisibility: window.getComputedStyle(document.querySelector<FixtureElement>('.leaflet-control-attribution:not(.bpb-vector-credits)')!).visibility };
        });
        assert.ok(result.logoHeight >= 24 && result.imageWidth > 0, 'Official logo is loaded at its required minimum size');
        assert.deepEqual(result.links, ['https://www.maptoolkit.com/copyright/', 'https://www.openstreetmap.org/copyright']);
        for (const name of ['logo', 'credits'] as const) {
            const box = result[name]; assert.ok(box.left >= result.map.left - 1 && box.right <= result.map.right + 1 && box.top >= result.map.top - 1 && box.bottom <= result.map.bottom + 1, `${name} stays inside the map: ${JSON.stringify(result)}`);
            assert.ok(box.right <= result.zoom.left || box.bottom <= result.zoom.top || box.left >= result.zoom.right || box.top >= result.zoom.bottom, `${name} does not cover native zoom controls: ${JSON.stringify(result)}`);
        }
        assert.ok(result.logo.bottom <= result.credits.top, 'Logo and copyright do not overlap');
        assert.equal(result.nativeVisibility, 'hidden', 'Native credits reserve their layout without covering provider credits');
        const trigger = page.locator('.bpb-layers-trigger');
        if (await trigger.count()) {
            await trigger.click(); const menu = page.locator('.bpb-layers-panel'); await menu.waitFor({ state: 'visible' });
            const panel = await menu.boundingBox(), logo = await page.locator('.bpb-vector-maptoolkit-logo').boundingBox();
            assert.ok(panel!.y + panel!.height <= logo!.y - 4, 'Open overlays cannot cover the provider logo');
            await trigger.click(); await page.locator('#selmap').focus();
        }
    };
    const verifyCameraAlignment = async () => {
        mode = 'ready'; await open();
        await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys);
        await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
        const cameras = [
            { center: [0, 0], zoom: 0, point: [5, 90] },
            { center: [0, 0], zoom: 1, point: [5, 90] },
            { center: [80, 0], zoom: 3, point: [75, 5] },
            { center: [-80, 0], zoom: 3, point: [-75, 5] },
            { center: [0, 0], zoom: 3, point: [5, 5] },
        ];
        for (const camera of cameras) {
            await page.evaluate(value => { nativePeak.setLatLng(value.point); mapsPlaceholder.setView(value.center, value.zoom, { animate: false }); }, camera);
            await waitForCondition(async () => {
                const pngData = (await page.locator('#map').screenshot()).toString('base64');
                return page.evaluate(async ({ data, point }) => {
                    const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
                    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
                    const context2d = canvas.getContext('2d'); context2d!.drawImage(image, 0, 0);
                    const target = mapsPlaceholder.latLngToContainerPoint(point), bounds = document.getElementById('map')!.getBoundingClientRect();
                    const pixels = [[10, 0], [-10, 0], [0, 10], [0, -10]].map(([dx, dy]) => [...context2d!.getImageData(
                        Math.round((target.x + dx) * image.width / bounds.width), Math.round((target.y + dy) * image.height / bounds.height), 1, 1).data]);
                    return { pixels, point: target, nativeZoom: mapsPlaceholder.getZoom() };
                }, { data: pngData, point: camera.point });
            }, { description: `geographic vector/native alignment ${JSON.stringify(camera)}`, timeoutMs: 5000,
                isReady: result => result.pixels.every(pixel => [30, 100, 210].every((value, channel) => Math.abs(pixel[channel] - value) <= 8)) });
            if (process.env.BPB_VECTOR_SCREENSHOTS) {
                await mkdir(process.env.BPB_VECTOR_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `${firefoxMode ? 'firefox' : 'chrome'}-camera-${camera.center[0]}-${camera.zoom}.png`) });
            }
        }
        return cameras.length;
    };
    const verifyZoomContinuity = async () => {
        let cases = 0, samples = 0, animatedSamples = 0;
        const sample = async (label: string) => {
            const bounds = await page.locator('#map').boundingBox(), viewport = page.viewportSize();
            const clip = { x: Math.max(0, bounds!.x), y: Math.max(0, bounds!.y), width: 0, height: 0 };
            clip.width = Math.min(viewport!.width, bounds!.x + bounds!.width) - clip.x;
            clip.height = Math.min(viewport!.height, bounds!.y + bounds!.height) - clip.y;
            const png = decodePng(await page.screenshot({ clip }));
            const alignment: { points: { count: number; x: number; y: number; unclipped: boolean }[]; animated?: boolean; native?: boolean; zoom?: number } = (() => {
                const { pixels } = png;
                const colors = [[30, 100, 210], [208, 32, 208]].map(rgb => ({ rgb, count: 0, x: 0, y: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }));
                for (let row = 0; row < png.height; row++) for (let col = 0; col < png.width; col++) {
                    const i = (row * png.width + col) * png.bpp;
                    for (const color of colors) if (color.rgb.every((value, channel) => Math.abs(pixels[i + channel] - value) < 8)) {
                        color.count++; color.x += col; color.y += row; color.minX = Math.min(color.minX, col); color.maxX = Math.max(color.maxX, col); color.minY = Math.min(color.minY, row); color.maxY = Math.max(color.maxY, row);
                    }
                }
                return { points: colors.map(color => ({ count: color.count, x: (color.minX + color.maxX) / 2 * clip.width / png.width, y: (color.minY + color.maxY) / 2 * clip.width / png.width,
                    unclipped: color.minX > 0 && color.maxX < png.width - 1 && color.minY > 0 && color.maxY < png.height - 1 })) };
            })();
            Object.assign(alignment, await page.evaluate(() => ({ animated: !!mapsPlaceholder._animatingZoom, native: mapsPlaceholder.hasLayer(nativeTiles), zoom: mapsPlaceholder.getZoom() })));
            const [vector, native] = alignment.points;
            if (Math.hypot(vector.x - native.x, vector.y - native.y) > 4) console.log(JSON.stringify({ label, geometry: await page.evaluate(() => {
                const slot = document.querySelector<FixtureElement>('.bpb-vector-slot'), peakPath = nativePeak.getElement(), svg = peakPath.ownerSVGElement;
                let layer!: FixtureLayer; mapsPlaceholder.eachLayer(item => { if (item.options?.bpbVector) layer = item; });
                return { elements: ([slot, layer.surface, svg] as Element[]).map(element => ({ tag: element!.tagName, style: element!.getAttribute('style'), class: element!.getAttribute('class'), transform: window.getComputedStyle(element).transform, transition: window.getComputedStyle(element).transition })),
                    paint: layer.painted, path: peakPath.getAttribute('d'), trace: window.zoomTrace.filter(item => item.delta > 4).slice(-5) };
            }) }));
            assert.ok(vector.count > 20 && native.count > 20, `Zoom retains painted map and native marker: ${label} ${JSON.stringify(alignment)}`);
            assert.ok(vector.unclipped && native.unclipped, `Pixel probes must remain fully visible: ${label}`);
            assert.ok(Math.hypot(vector.x - native.x, vector.y - native.y) <= 4,
                `Vector map jumps away from the native peak during zoom: ${label} ${JSON.stringify(alignment)}`);
            assert.equal(alignment.native, false, 'Zoom must not flash the native raster');
            samples++; if (alignment.animated) animatedSamples++;
            return alignment;
        };
        const layouts = [[1280, 1, 'light'], [375, 1, 'dark'], [1280, 2, 'light'], [375, 2, 'dark']] as [number, number, string][];
        for (const [width, textZoom, theme] of Array.from({ length: 3 }, () => layouts).flat()) {
            await page.setViewportSize({ width, height: 800 }); mode = 'ready'; await open();
            await page.evaluate(({ textZoom: pageZoom, theme: pageTheme }) => {
                document.body.style.zoom = pageZoom as unknown as string; document.documentElement.dataset.bpbTheme = pageTheme; mapsPlaceholder.invalidateSize();
                nativePeak.setStyle({ color: '#d020d0', fillColor: '#d020d0' });
                mapsPlaceholder.setView([46.851731, -121.760395 - .04 / pageZoom], 10, { animate: false });
            }, { textZoom, theme });
            await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys);
            await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
            const frame = page.frames().find(item => /\/terrain\/vector.html/.test(item.url())); assert.ok(frame);
            await page.evaluate(() => {
                window.zoomTrace = [];
                const trace = () => {
                    let layer!: FixtureLayer; mapsPlaceholder.eachLayer(item => { if (item.options?.bpbVector) layer = item; });
                    if (layer?.painted) {
                        const paint = layer.painted, point = nativePeak.getLatLng(), surface = layer.surface.getBoundingClientRect(), marker = nativePeak.getElement().getBoundingClientRect();
                        const mercator = (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
                        const scale = 512 * 2 ** paint.view.zoom;
                        const x = surface.left + (paint.width / 2 + (point.lng - paint.view.center[1]) / 360 * scale) / paint.width * surface.width;
                        const y = surface.top + (paint.height / 2 + (mercator(point.lat) - mercator(paint.view.center[0])) * scale) / paint.height * surface.height;
                        window.zoomTrace.push({ delta: Math.hypot(x - marker.x - marker.width / 2, y - marker.y - marker.height / 2),
                            animated: !!mapsPlaceholder._animatingZoom, transform: window.getComputedStyle(layer.element).transform,
                            nativeTransform: window.getComputedStyle(nativePeak.getElement().ownerSVGElement!).transform });
                        if (window.zoomTrace.length > 512) window.zoomTrace.shift();
                    }
                    window.requestAnimationFrame(trace);
                }; window.requestAnimationFrame(trace);
            });
            for (const [direction, target] of [['in', 11], ['out', 10], ['wheel', 11]] as [string, number][]) {
                await frame.evaluate(() => { window.holdZoomView = true; });
                const button = page.locator(`.leaflet-control-zoom-${direction === 'wheel' ? 'in' : direction}`);
                await button.scrollIntoViewIfNeeded();
                await sample(`${width}/${textZoom} before ${direction}`);
                const click = direction === 'wheel' ? (async () => {
                    const marker = await page.locator('.leaflet-interactive').first().boundingBox();
                    await page.mouse.move(marker!.x + marker!.width / 2 + 10, marker!.y + marker!.height / 2);
                    await page.mouse.wheel(0, -1);
                })() : button.click();
                const deadline = Date.now() + 5000;
                let state;
                do { state = await sample(`${width}/${textZoom} ${direction}`); }
                while ((state.zoom !== target || state.animated) && Date.now() < deadline);
                await click;
                assert.equal(state.zoom, target); assert.equal(state.animated, false);
                await frame.waitForFunction(() => window.heldZoomViews.length > 0);
                await sample(`${width}/${textZoom} delayed ${direction}`);
                await frame.evaluate(() => {
                    window.holdZoomView = false;
                    for (const item of window.heldZoomViews.splice(0)) window.dispatchEvent(new MessageEvent('message', { data: item.data, origin: item.origin, source: parent }));
                });
                await page.waitForFunction(() => {
                    const surface = document.querySelector<FixtureElement>('.bpb-vector-surface'); return surface && Math.abs(new window.DOMMatrix(window.getComputedStyle(surface).transform).a - 1) < .001;
                });
                await sample(`${width}/${textZoom} handed off ${direction}`);
                const failures = await page.evaluate(() => window.zoomTrace.filter(item => item.delta > 4));
                assert.deepEqual(failures, [], `Every measured paint stays aligned through zoom: ${width}/${textZoom}`);
                cases++;
            }
        }
        assert.ok(animatedSamples > 0, 'Actual intermediate animation frames must be inspected');
        const frame = page.frames().find(item => /\/terrain\/vector.html/.test(item.url()));
        const original = await page.evaluate(() => ({ center: [mapsPlaceholder.getCenter().lat, mapsPlaceholder.getCenter().lng], zoom: mapsPlaceholder.getZoom() }));
        await page.evaluate(() => {
            window.staleSceneRejected = false;
            window.addEventListener('message', event => {
                if (event.data?.dir !== 'toPage' || event.data.type !== 'painted' || event.data.view?.center[0] !== 5) return;
                mapsPlaceholder.eachLayer(layer => { if (layer.options?.bpbVector) window.staleSceneRejected = layer.painted?.view.center[0] !== 5; });
            });
        });
        await frame!.evaluate(() => { window.holdSnapshotCenter = [5, 5]; });
        await page.evaluate(() => { mapsPlaceholder.setView([5, 5], mapsPlaceholder.getZoom(), { animate: false }); });
        await frame!.waitForFunction(() => window.heldSnapshots.length > 0);
        await page.evaluate(value => { mapsPlaceholder.setView(value.center, value.zoom, { animate: false }); }, original);
        await frame!.evaluate(() => { window.holdSnapshotCenter = null; for (const resolve of window.heldSnapshots.splice(0)) resolve(); });
        await page.waitForFunction(() => window.staleSceneRejected);
        await sample('late distant image after camera reversal'); cases++;
        const queuedProvider = await page.evaluate(otherProvider => {
            const select = (document.getElementById('selmap') as FixtureElement | null), chosen = select!.value;
            window.dispatchEvent(new MessageEvent('message', { source: window, origin: window.location.origin,
                data: { __bpbVectorMap: true, dir: 'toPage', type: 'error', id: select!.dataset.bpbVectorMap, basemap: otherProvider } }));
            return { chosen, selected: select!.value, visible: document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1',
                errorHidden: document.querySelector<FixtureElement>('.bpb-vector-status')!.hidden };
        }, 'retired-provider');
        assert.equal(queuedProvider.selected, queuedProvider.chosen, 'A queued error from a different provider cannot reset this choice');
        assert.ok(queuedProvider.visible && queuedProvider.errorHidden, 'The current cartography survives an outgoing provider error');
        return { cases, samples, animatedSamples };
    };
    const verifyProviderRecovery = async () => {
        const geometry = () => page.evaluate(() => ({ scroll: scrollY, boxes: ['h1', '#map', '#selmap', '#following', '.leaflet-control-zoom'].map(selector => {
            const rect = document.querySelector(selector)!.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
        }) }));
        const stable = async (baseline: { boxes: number[][]; [field: string]: unknown }) => {
            const actual = await geometry(); assert.equal(actual.scroll, baseline.scroll);
            actual.boxes.forEach((rect, index) => rect.forEach((value, dimension) => assert.ok(Math.abs(value - baseline.boxes[index][dimension]) <= 1, `Recovery shifted box ${index}/${dimension}`)));
        };
        const activate = async () => { await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys); await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1'); };
        const screenshot = async (name: string) => { if (process.env.BPB_VECTOR_SCREENSHOTS) { await mkdir(process.env.BPB_VECTOR_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `${firefoxMode ? 'firefox' : 'chrome'}-recovery-${name}.png`) }); } };
        let cases = 0;
        for (const [width, theme, zoom] of [[1280, 'light', 1], [375, 'dark', 1], [1280, 'light', 2]] as [number, string, number][]) {
            await page.setViewportSize({ width, height: 800 }); mode = 'ready'; await open();
            await page.evaluate(value => { document.documentElement.dataset.bpbTheme = value.theme; document.body.style.zoom = value.zoom as unknown as string; mapsPlaceholder.invalidateSize(); }, { theme, zoom });
            await activate(); const baseline = await geometry(); mode = 'tile-error';
            await page.evaluate(() => mapsPlaceholder.setView([-30, 100], 10, { animate: false }));
            await page.locator('.bpb-vector-status button[data-bpb-vector-map]').waitFor({ state: 'visible', timeout: 6000 });
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true, 'A wholly failed viewport restores native imagery');
            assert.equal(await page.locator('.bpb-vector-slot iframe').count(), 0); await stable(baseline); await screenshot(`${width}-${zoom}-error`);
            const retry = page.locator('.bpb-vector-status button[data-bpb-vector-map]');
            mode = 'hold'; await retry.focus();
            // At 200% zoom the user first scrolls/focuses the offscreen action.
            // Its active reading position is the baseline for the async change.
            const before = await retry.boundingBox(), retryBaseline = await geometry();
            await page.keyboard.press('Enter');
            await waitForCondition(() => held.size, { description: 'post-load outage retry is pending' });
            const during = await retry.boundingBox();
            for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(before![key] - during![key]) <= 1, `Outage Retry moved: ${key}`);
            assert.equal(await retry.evaluate(element => document.activeElement === element), true); await stable(retryBaseline);
            mode = 'ready'; release(); await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), false); await stable(retryBaseline); await screenshot(`${width}-${zoom}-recovered`); cases++;
        }
        await page.setViewportSize({ width: 1280, height: 800 }); mode = 'empty'; await open(); await activate();
        assert.equal(await page.locator('.bpb-vector-status').evaluate(element => (element as HTMLElement).hidden), true, 'Valid empty tiles stay healthy');
        const failuresBefore = tileFailures; mode = 'tile-error';
        await page.evaluate(() => mapsPlaceholder.panBy([512, 0], { animate: false }));
        await waitForCondition(() => tileFailures > failuresBefore, { description: 'mixed cached-empty/new failed tiles' });
        await page.waitForFunction(() => window.vectorSettledViews.some(view => {
            const center = mapsPlaceholder.getCenter().wrap(); return Math.abs(view.center[0] - center.lat) < 1e-7 && Math.abs(view.center[1] - center.lng) < 1e-7;
        }));
        assert.equal(await page.locator('.bpb-vector-slot').evaluate(element => element.style.opacity), '1', 'Cached empty tiles remain usable beside failures'); cases++;
        partialUrl = null; mode = 'partial'; await open(); await activate();
        assert.ok(partialUrl); assert.equal(await page.locator('.bpb-vector-status').evaluate(element => (element as HTMLElement).hidden), true, 'Partial tile loss preserves usable output'); cases++;
        const centerFailures = tileFailures; mode = 'center-error'; await open();
        const centerStart = Date.now(); await activate();
        assert.ok(tileFailures > centerFailures, 'The fixture failed the center tile');
        assert.ok(Date.now() - centerStart < 10000, `A failed center tile waited for the deadline: ${Date.now() - centerStart} ms`);
        assert.equal(await page.locator('.bpb-vector-status').evaluate(element => (element as HTMLElement).hidden), true, 'A failed center tile keeps its usable neighbors'); cases++;
        mode = 'metadata-error'; await open(); await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys);
        await page.locator('.bpb-vector-status button[data-bpb-vector-map]').waitFor({ state: 'visible', timeout: 6000 });
        assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true, 'Failed TileJSON is unavailable, not a valid empty viewport'); cases++;
        return cases;
    };
    const verifyProviderCooldown = async () => {
        let cases = 0;
        for (const [width, theme, zoom, limit] of [[1280, 'light', 1, 'style-limit'], [375, 'dark', 1, 'tile-limit'], [1280, 'light', 2, 'style-limit']] as [number, string, number, string][]) {
            await page.setViewportSize({ width, height: 800 }); mode = limit; retrySeconds = cases === 0 ? '120' : '3'; await open();
            await page.evaluate(value => { document.documentElement.dataset.bpbTheme = value.theme; document.body.style.zoom = value.zoom as unknown as string; mapsPlaceholder.invalidateSize(); }, { theme, zoom });
            await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys);
            const retry = page.locator('.bpb-vector-status button[data-bpb-vector-map]'); await retry.waitFor({ state: 'visible' });
            await page.waitForFunction(() => !document.querySelector<FixtureElement>('.bpb-vector-slot iframe'));
            assert.equal(await retry.getAttribute('aria-disabled'), 'true', 'Retry-After must survive renderer disposal');
            assert.match(await page.locator('.bpb-vector-status').innerText(), new RegExp(`${basemap.provider} is busy\\. Retry after`));
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true);
            await retry.focus(); const bounds = await retry.boundingBox();
            const geometry = () => page.evaluate(() => ({ scroll: scrollY, boxes: ['h1', '#map', '#selmap', '#following', '.leaflet-control-zoom'].map(selector => {
                const rect = document.querySelector(selector)!.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
            }) }));
            const baseline = await geometry(), count = requests.length;
            const stable = async () => {
                const actual = await geometry(); assert.equal(actual.scroll, baseline.scroll);
                actual.boxes.forEach((rect, index) => rect.forEach((value, dimension) => assert.ok(Math.abs(value - baseline.boxes[index][dimension]) <= 1, `Cooldown shifted box ${index}/${dimension}`)));
            };
            await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await retry.click({ force: true });
            assert.equal(await retry.evaluate(element => document.activeElement === element), true);
            await page.evaluate(() => document.querySelector<FixtureElement>('.bpb-vector-status button[data-bpb-vector-map]')!.click());
            // The deadline also guards activation if the disabled hint changes.
            await retry.evaluate(element => element.setAttribute('aria-disabled', 'false')); await retry.click({ force: true });
            await retry.evaluate(element => element.setAttribute('aria-disabled', 'true'));
            assert.equal(requests.length, count, 'Retry cannot bypass the cooldown');
            const actual = await retry.boundingBox();
            for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(bounds![key] - actual![key]) <= 1, `Cooldown moved Retry: ${key}`);
            await stable();
            if (process.env.BPB_VECTOR_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `${firefoxMode ? 'firefox' : 'chrome'}-cooldown-${width}-${zoom}.png`) });
            if (cases === 0) {
                // Prove the full 120-second header is retained without sleeping
                // through it. Short cases below exercise real timer expiry.
                cases++; continue;
            }
            mode = 'ready';
            await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-status button[data-bpb-vector-map]')?.getAttribute('aria-disabled') === 'false', null, { timeout: 6000 });
            assert.equal(requests.length, count, 'Expiry does not automatically replay requests');
            const expired = await retry.boundingBox();
            for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(bounds![key] - expired![key]) <= 1, `Expiry moved Retry: ${key}`);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
            await stable(); assert.ok(requests.length > count); cases++;
        }
        return cases;
    };
    const verifyTerrain = async () => {
        const toggle = page.locator('#bpb-terrain-toggle');
        const readyToggle = async () => { await toggle.waitFor({ state: 'visible' }); await page.waitForFunction(() => {
            const button = (document.getElementById('bpb-terrain-toggle') as FixtureElement | null); return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
        }); };
        const openTerrain = async (fromVector = true) => {
            mode = 'ready'; await open(); await readyToggle();
            if (fromVector) { await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys); await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1'); }
            await toggle.click();
            await page.waitForFunction(() => (document.getElementById('bpb-terrain-toggle') as FixtureElement | null)?.textContent.trim() === '2D');
            const frame = page.frames().find(item => /\/terrain\/terrain.html/.test(item.url())); assert.ok(frame);
            await frame.waitForFunction(() => !!window.__bpbTerrainTestMap?.getLayer('bpb-route'));
            return frame;
        };
        const readyVector = (frame: Frame) => frame.waitForFunction((id: string) => document.querySelector<FixtureElement>('.bpb-terrain-picker')?.value === id
            && window.__bpbTerrainTestMap?.getStyle().layers.some(layer => layer.id.startsWith('bpb-vector:')), basemap.id);
        const geometry = (frame: Frame) => frame.evaluate(() => ['.bpb-terrain-picker', '.maplibregl-ctrl-group'].map(selector => {
            const rect = document.querySelector(selector)!.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
        }));
        const stable = async (frame: Frame, before: number[][]) => {
            const after = await geometry(frame);
            after.forEach((box: number[], index: number) => box.forEach((value: number, dimension: number) => assert.ok(Math.abs(value - before[index][dimension]) <= 1, `3D control moved ${index}/${dimension}: ${JSON.stringify({ before, after })}`)));
        };
        const check = async (frame: Frame) => {
            await readyVector(frame);
            const result = await waitForCondition(() => frame.evaluate(async () => {
                const map = window.__bpbTerrainTestMap, bounds = (map.getBounds as () => { getWest(): number; getEast(): number; getSouth(): number; getNorth(): number })(), values: number[] = [];
                for (const x of [.25, .5, .75]) for (const y of [.25, .5, .75]) {
                    const value = map.queryTerrainElevation([bounds.getWest() + (bounds.getEast() - bounds.getWest()) * x, bounds.getSouth() + (bounds.getNorth() - bounds.getSouth()) * y]);
                    if (Number.isFinite(value)) values.push(value!);
                }
                const logo = document.querySelector<FixtureElement>('.bpb-terrain-maptoolkit-logo');
                if (logo && !logo.hidden) { const image = new Image(); image.src = window.getComputedStyle(logo!).backgroundImage.slice(5, -2); await image.decode(); }
                const vectorLayers = map.getStyle().layers.filter(layer => layer.id.startsWith('bpb-vector:') && layer.source && map.getSource(layer.source)?.type === 'vector').map(layer => layer.id);
                return { terrain: map.getTerrain()?.source, route: !!map.getLayer('bpb-route'), sprites: map.getSprite().map(item => item.id),
                    settled: map.areTilesLoaded(), vectorFeatures: vectorLayers.length ? map.queryRenderedFeatures({ layers: vectorLayers }).length : 0,
                    logoHeight: logo?.offsetHeight, logoHidden: logo?.hidden, credits: [...document.querySelectorAll<HTMLAnchorElement>('.maplibregl-ctrl-attrib a')].map(a => a.href),
                    relief: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0 };
            }), { description: '3D basemap on decoded non-flat elevation', isReady: state => state.terrain === 'terrain' && state.route && state.relief > 100 && state.settled && state.vectorFeatures > 0 });
            if (basemap === MAPTOOLKIT_BASEMAP) {
                assert.ok(!result.logoHidden && result.logoHeight! >= 24); assert.ok(result.sprites.includes('sdf') && result.sprites.includes('nature'));
                assert.ok(result.credits.includes('https://www.maptoolkit.com/copyright/') && result.credits.includes('https://www.openstreetmap.org/copyright'));
                assert.equal(result.credits.filter((href: string) => href === 'https://www.maptoolkit.com/copyright/').length, 1, 'Maptoolkit copyright is displayed once');
                const trigger = page.locator('.bpb-layers-trigger');
                if (await trigger.count()) {
                    await trigger.click(); const panel = await page.locator('.bpb-layers-panel').boundingBox();
                    const owner = await frame.frameElement(), box = await owner.boundingBox();
                    const inner = await frame.evaluate(() => ({ width: window.innerWidth, top: document.querySelector<FixtureElement>('.bpb-terrain-maptoolkit-logo')!.getBoundingClientRect().top }));
                    assert.ok(panel!.y + panel!.height <= box!.y + inner.top * box!.width / inner.width - 4, '3D overlay menu stays clear of the provider logo');
                    await trigger.click();
                }
            }
        };
        let cases = 0;
        for (const [width, theme, zoom] of [[1280, 'light', 1], [375, 'dark', 1], [1280, 'light', 2], [375, 'dark', 2]] as [number, string, number][]) {
            await page.setViewportSize({ width, height: 800 }); const frame = await openTerrain(!liveMode);
            if (liveMode) await frame.locator('.bpb-terrain-picker').selectOption(basemap.id);
            await frame.evaluate(value => { document.getElementById('bpb-terrain-map')!.dataset.theme = value.theme;
                if (value.zoom === 2) { const sheet = document.createElement('style'); sheet.textContent = '#bpb-terrain-map, #bpb-terrain-map .bpb-terrain-picker {font-size:24px} #bpb-terrain-map .maplibregl-ctrl-attrib {font-size:22px}'; document.head.append(sheet); }
                window.__bpbTerrainTestMap.resize(); }, { theme, zoom });
            await check(frame); const before = await geometry(frame);
            if (process.env.BPB_VECTOR_SCREENSHOTS) { await mkdir(process.env.BPB_VECTOR_SCREENSHOTS, { recursive: true }); await frame.locator('#bpb-terrain-map').screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `${firefoxMode ? 'firefox' : 'chrome'}-terrain-${width}-${zoom}.png`) }); }
            if (liveMode) { cases++; break; }
            const picker = frame.locator('.bpb-terrain-picker'); await picker.selectOption('terrain');
            await frame.waitForFunction(() => !window.__bpbTerrainTestMap.getLayer('bpb-vector:land'));
            await stable(frame, before); await picker.selectOption(basemap.id); await check(frame); await stable(frame, before);
            await toggle.click(); await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
            assert.equal(await page.locator('#selmap').inputValue(), basemap.code, 'Returning to 2D retains its chosen provider'); cases++;
            if (preflight || liveMode) break;
        }
        if (!preflight && !liveMode) {
            await page.setViewportSize({ width: 1280, height: 800 });
            let frame = await openTerrain(false), picker = frame.locator('.bpb-terrain-picker'), before = await geometry(frame);
            mode = 'hold'; await picker.focus(); await picker.selectOption(basemap.id);
            await waitForCondition(() => held.size, { description: '3D style pending' }); await stable(frame, before);
            await picker.selectOption('terrain'); mode = 'ready'; release();
            await frame.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-terrain-picker')!.value === 'terrain');
            await picker.selectOption(basemap.id); await check(frame); await stable(frame, before); cases++;

            frame = await openTerrain(false); picker = frame.locator('.bpb-terrain-picker'); before = await geometry(frame);
            mode = 'error'; await picker.selectOption(basemap.id);
            await frame.waitForFunction(() => /unavailable/.test(document.querySelector<FixtureElement>('.bpb-terrain-notice')!.textContent));
            await stable(frame, before); mode = 'ready'; await picker.focus(); await page.keyboard.type(chooseKeys); await check(frame); await stable(frame, before); cases++;

            frame = await openTerrain(false); picker = frame.locator('.bpb-terrain-picker'); before = await geometry(frame);
            retrySeconds = '3'; mode = 'style-limit'; await picker.selectOption(basemap.id);
            await frame.waitForFunction(id => document.querySelector<FixtureElement>(`.bpb-terrain-picker option[value="${id}"]`)!.disabled, basemap.id);
            const count = requests.filter(url => url === basemap.styleUrl).length;
            await picker.evaluate((element, id) => { (element as FixtureElement).value = id; element.dispatchEvent(new Event('change')); }, basemap.id);
            await frame.waitForFunction(() => /request limit/.test(document.querySelector<FixtureElement>('.bpb-terrain-notice')!.textContent));
            assert.equal(requests.filter(url => url === basemap.styleUrl).length, count); await stable(frame, before);
            mode = 'ready'; await frame.waitForFunction(id => !document.querySelector<FixtureElement>(`.bpb-terrain-picker option[value="${id}"]`)!.disabled, basemap.id);
            assert.equal(requests.filter(url => url === basemap.styleUrl).length, count, '3D expiry enables selection without fetching');
            await picker.selectOption(basemap.id); await check(frame); await stable(frame, before); cases++;

            mode = 'tile-limit'; await frame.evaluate(() => window.__bpbTerrainTestMap.jumpTo({ center: [100, -30], zoom: 9 }));
            await frame.waitForFunction(id => document.querySelector<FixtureElement>(`.bpb-terrain-picker option[value="${id}"]`)!.disabled
                && document.querySelector<FixtureElement>('.bpb-terrain-picker')!.value === 'terrain', basemap.id);
            assert.equal(await frame.evaluate(() => window.__bpbTerrainTestMap.getTerrain()!.source), 'terrain');
            await stable(frame, before); mode = 'ready';
            await frame.waitForFunction(id => !document.querySelector<FixtureElement>(`.bpb-terrain-picker option[value="${id}"]`)!.disabled, basemap.id);
            await picker.selectOption(basemap.id); await check(frame); await stable(frame, before); cases++;
            if (!firefoxMode) for (const [width, theme] of [[1280, 'light'], [375, 'dark']] as [number, string][]) {
                const worker = context.serviceWorkers()[0]; assert.ok(worker);
                await worker.evaluate(async pageTheme => {
                    const { bpbSettings = {} } = await globalThis.chrome.storage.sync.get('bpbSettings') as { bpbSettings?: object };
                    await globalThis.chrome.storage.sync.set({ bpbSettings: { ...bpbSettings, enable3dMap: false, theme: pageTheme } });
                }, theme);
                await page.setViewportSize({ width, height: 800 }); mode = 'ready'; await open(); await readyToggle(); await toggle.click();
                const dialog = page.locator('#bpb-terrain-consent [role="dialog"]'); await dialog.waitFor({ state: 'visible' });
                assert.match(await dialog.innerText(), /Maptoolkit/); assert.equal(await dialog.locator('a[href="https://www.maptoolkit.org/privacy"]').count(), 1);
                const box = await dialog.boundingBox(); assert.ok(box!.x >= 0 && box!.y >= 0 && box!.x + box!.width <= width + 1 && box!.y + box!.height <= 801, 'Consent remains readable inside the viewport');
                if (process.env.BPB_VECTOR_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `chrome-consent-${width}.png`) });
                await dialog.locator('.bpb-terrain-consent-primary').click();
                await page.waitForFunction(() => (document.getElementById('bpb-terrain-toggle') as FixtureElement | null)?.textContent.trim() === '2D');
                assert.equal(await worker.evaluate(async () => ((await globalThis.chrome.storage.sync.get('bpbSettings')).bpbSettings as { enable3dMap?: boolean }).enable3dMap), true);
                cases++;
            }
        }
        assert.deepEqual(errors, []);
        return { verification: liveMode ? 'terrain-vector-live' : 'terrain-vector', provider: basemap.provider, cases, renderer, browser: context.browser()!.version(), hidden: true, realExtension: !firefoxMode, instrumentedMapOnly: true };
    };
    if (terrainMode) summary = await verifyTerrain();
    else if (args.includes('--layout-only')) summary = { verification: 'vector-picker-layout', cases: await verifyPickerLayouts(), renderer, browser: context.browser()!.version(), hidden: true };
    else if (args.includes('--performance-only')) summary = { verification: 'vector-progressive', ...await verifyProgressive(), renderer, browser: context.browser()!.version(), hidden: true };
    else if (args.includes('--zoom-only')) summary = { verification: 'vector-zoom', ...await verifyZoomContinuity(), renderer, browser: context.browser()!.version(), hidden: true };
    else if (preflight) summary = { preflight: true, cases: 1, renderer, browser: context.browser()!.version() };
    else if (cameraOnly) summary = { verification: 'vector-camera', cases: await verifyCameraAlignment(), renderer, browser: context.browser()!.version(), hidden: true, realExtension: !firefoxMode };
    else if (recoveryOnly) summary = { verification: 'vector-recovery', cases: await verifyProviderRecovery(), renderer, browser: context.browser()!.version(), hidden: true, realExtension: !firefoxMode };
    else if (cooldownOnly) summary = { verification: 'vector-cooldown', cases: await verifyProviderCooldown(), renderer, browser: context.browser()!.version(), hidden: true, realExtension: !firefoxMode };
    else if (liveMode) {
        await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys);
        await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
        await verifyCredits();
        for (const direction of ['initial', 'in', 'out']) {
            const targetZoom = await page.evaluate(() => mapsPlaceholder.getZoom()) + (direction === 'in' ? 1 : direction === 'out' ? -1 : 0);
            if (direction !== 'initial') await page.locator(`.leaflet-control-zoom-${direction}`).click();
            await page.waitForFunction(target => {
                let current!: FixtureLayer; mapsPlaceholder.eachLayer(layer => { if (layer.options?.bpbVector) current = layer; });
                const center = mapsPlaceholder.getCenter(), painted = current?.painted;
                return mapsPlaceholder.getZoom() === target && !mapsPlaceholder._animatingZoom && painted && Math.abs(painted.view.zoom + 1 - target) < .001
                    && Math.abs(painted.view.center[0] - center.lat) < .00001 && Math.abs(painted.view.center[1] - center.lng) < .00001;
            }, targetZoom);
            if (process.env.BPB_VECTOR_SCREENSHOTS) {
                await mkdir(process.env.BPB_VECTOR_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `vector-live-${direction}.png`) });
            }
        }
        summary = { verification: '2d-vector-map-live', cases: 3, renderer, hidden: true, realExtension: !firefoxMode, requests: requests.length, browser: context.browser()!.version() };
    }
    else {
        const geometry = () => page.evaluate(() => ({ scroll: scrollY,
            boxes: ['h1', '#map', '#selmap', '#following', '.leaflet-control-zoom'].map(selector => {
                const r = document.querySelector(selector)!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
            }),
        }));
        const stable = async (baseline: { boxes: number[][]; [field: string]: unknown }) => {
            const actual = await geometry(); assert.equal(actual.scroll, baseline.scroll);
            actual.boxes.forEach((rect, index) => rect.forEach((value, dimension) => assert.ok(Math.abs(value - baseline.boxes[index][dimension]) <= 1, `Layout changed at box ${index}, dimension ${dimension}: ${JSON.stringify({ actual, baseline })}`)));
        };
        const chooseVector = async () => { await page.locator('#selmap').focus(); await page.keyboard.type(chooseKeys); };
        const chooseNative = async () => { await page.locator('#selmap').selectOption('L_FIX'); };
        const ready = () => page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-vector-slot')?.style.opacity === '1');
        const shots = process.env.BPB_VECTOR_SCREENSHOTS;
        const screenshot = async (name: string) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${firefoxMode ? 'firefox' : 'chrome'}-${name}.png`), fullPage: basemap === MAPTOOLKIT_BASEMAP }); } };
        let cases = 0;
        for (const [width, theme, zoom] of [[1280, 'light', 1], [375, 'dark', 1], [1280, 'light', 2]] as [number, string, number][]) {
            // Each viewport is a separate document. This also resets the native
            // picker's type-ahead buffer instead of typing impossible strings
            // such as "FixtureOSM" through several instantaneous transitions.
            if (cases) await open();
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(({ theme: pageTheme, zoom: pageZoom }) => { document.documentElement.dataset.bpbTheme = pageTheme; document.body.style.zoom = pageZoom as unknown as string; mapsPlaceholder.invalidateSize(); }, { theme, zoom });
            const baseline = await geometry(); assert.equal(requests.length, 0, 'No vector traffic before selection');
            await verifyPicker();
            await page.evaluate(() => { const select = (document.getElementById('selmap') as FixtureElement | null); select!.value = window.vectorFixtureCode; select!.dispatchEvent(new Event('change', { bubbles: true })); });
            assert.equal(requests.length, 0, 'Forged selection cannot authorize provider requests');
            await chooseVector();
            await page.waitForFunction(() => (document.getElementById('selmap') as FixtureElement | null)!.getAttribute('aria-busy') === 'true', null, { timeout: 10000 });
            await waitForCondition(() => held.size, { description: 'held vector style' });
            await stable(baseline); await screenshot(`${width}-${zoom}-pending`);
            mode = 'ready'; release(); await ready(); await stable(baseline);
            await verifyCredits();
            assert.equal(await page.locator('#selmap').evaluate(element => document.activeElement === element), true, 'Selection retains keyboard focus');
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativePeak)), true, 'Native marker survives');
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), false, 'Hidden native raster stops requesting tiles');
            assert.equal(await page.evaluate(() => window.nativeSelections.includes(window.vectorFixtureCode)), false, 'Vector choice bypasses native MapChange');
            await page.locator('.leaflet-interactive').first().click(); await page.locator('.leaflet-popup').waitFor();
            await page.evaluate(() => (mapsPlaceholder.closePopup as () => void)());
            await screenshot(`${width}-${zoom}-ready`);
            const frame = page.frames().find(item => /\/terrain\/vector.html/.test(item.url()));
            assert.ok(frame, 'Vector renderer iframe exists');
            const canvas = frame.locator('canvas'); assert.ok((await canvas.boundingBox())!.width > 0);
            if (cases === 0) {
                const rect = await page.locator('#map').boundingBox();
                await page.mouse.move(rect!.x + rect!.width * .3, rect!.y + rect!.height * .45);
                await page.mouse.down();
                try {
                    await page.mouse.move(rect!.x + rect!.width * .8, rect!.y + rect!.height * .45, { steps: 10 });
                    await waitForCondition(async () => {
                        const pngData = (await page.locator('#map').screenshot()).toString('base64');
                        return page.evaluate(async data => {
                            const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
                            const target = document.createElement('canvas'); target.width = image.width; target.height = image.height;
                            const context2d = target.getContext('2d'); context2d!.drawImage(image, 0, 0);
                            const pixels = context2d!.getImageData(0, 0, image.width, image.height).data;
                            let painted = 0;
                            for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - 196) < 3 && Math.abs(pixels[i + 1] - 221) < 3 && Math.abs(pixels[i + 2] - 172) < 3) painted++;
                            return painted / (image.width * image.height);
                        }, pngData);
                    }, { isReady: fraction => fraction > .9, description: 'vector tiles cover the map during a long held drag', timeoutMs: 3000 });
                    await screenshot('drag-held');
                } finally { await page.mouse.up(); }
            }
            await page.evaluate(() => mapsPlaceholder.panBy([60, 20], { animate: false })); await ready();
            await chooseNative(); await page.waitForFunction(() => !document.querySelector<FixtureElement>('.bpb-vector-slot'));
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true, 'Native raster restored');
            assert.equal(await page.locator('.leaflet-control-attribution:not(.bpb-vector-credits)').evaluate(element => element.style.visibility), '', 'Native attribution visibility is restored');
            requests.length = 0; mode = 'hold'; cases++;
        }
        await open();
        const baseline = await geometry(); mode = 'error'; await chooseVector();
        await page.locator('.bpb-vector-status button[data-bpb-vector-map]').waitFor({ state: 'visible' }); await stable(baseline); await screenshot('error');
        assert.notEqual(await page.locator('#selmap').inputValue(), basemap.code);
        assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true);
        const retryBounds = await page.locator('.bpb-vector-status button[data-bpb-vector-map]').boundingBox();
        mode = 'hold'; await page.locator('.bpb-vector-status button[data-bpb-vector-map]').focus(); await page.keyboard.press('Enter');
        await waitForCondition(() => held.size, { description: 'retry style is pending' }); await stable(baseline);
        assert.equal(await page.locator('.bpb-vector-status button[data-bpb-vector-map]').evaluate(element => document.activeElement === element), true, 'Retry retains keyboard focus while busy');
        const busyBounds = await page.locator('.bpb-vector-status button[data-bpb-vector-map]').boundingBox();
        for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(retryBounds![key] - busyBounds![key]) <= 1, `Retry moved during loading: ${key}`);
        const pendingRequests = held.size; await page.keyboard.press('Enter'); assert.equal(held.size, pendingRequests, 'Busy Retry does not duplicate work');
        mode = 'ready'; release(); await ready(); await stable(baseline);
        assert.equal(await page.locator('#selmap').evaluate(element => document.activeElement === element), true, 'Successful retry returns focus to the basemap choice');
        await open(); mode = 'hold'; await chooseVector(); await waitForCondition(() => held.size, { description: 'cancelled style is pending' });
        await chooseNative(); mode = 'ready'; release();
        await page.waitForFunction(() => !document.querySelector<FixtureElement>('.bpb-vector-slot iframe'));
        assert.equal(await page.locator('#selmap').inputValue(), 'L_FIX', 'Late completion cannot reactivate a cancelled layer');
        await open(); await chooseVector(); await ready();
        await page.evaluate(() => (mapsPlaceholder.remove as () => void)());
        await page.waitForFunction(() => !document.querySelector<FixtureElement>('.bpb-vector-slot iframe'));
        assert.equal(await page.locator('#selmap').evaluate(element => element.style.minWidth), '', 'Map teardown restores the native picker sizing');
        const cameraCases = await verifyCameraAlignment();
        const recoveryCases = await verifyProviderRecovery();
        const cooldownCases = await verifyProviderCooldown();
        assert.deepEqual(errors, []);
        summary = { verification: '2d-vector-map', hidden: true, browser: context.browser()!.version(), renderer, provider: basemap.provider,
            cases: cases + 3 + cameraCases + recoveryCases + cooldownCases, viewports: '1280/375 × 800, light/dark, 200% CSS zoom', realExtension: !firefoxMode,
            syntheticProvider: true, loadingSuccessErrorRetryCancellation: true, stableGeometry: true, nativeMarkerInteraction: true };
    }
} catch (error) {
    failure = error;
    console.error(failureContext?.());
    if (failurePage && !failurePage.isClosed()) console.error(await failurePage.evaluate(() => ({
        selected: (document.getElementById('selmap') as FixtureElement | null)?.value, busy: (document.getElementById('selmap') as FixtureElement | null)?.getAttribute('aria-busy'),
        events: window.vectorEvents, focused: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(),
        camera: (window as unknown as { mapsPlaceholder?: FixtureMap }).mapsPlaceholder && { center: mapsPlaceholder.getCenter(), zoom: mapsPlaceholder.getZoom() },
        status: document.querySelector<FixtureElement>('.bpb-vector-status')?.outerHTML, slot: document.querySelector<FixtureElement>('.bpb-vector-slot')?.outerHTML,
        terrain: document.getElementById('bpb-terrain-frame')?.outerHTML,
        terrainToggle: (document.getElementById('bpb-terrain-toggle') as FixtureElement | null)?.outerHTML,
        terrainNotice: document.querySelector<FixtureElement>('.bpb-terrain-failure')?.outerHTML,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => node.textContent),
    })).catch(() => null));
}
await resources.dispose(failure as Parameters<typeof resources.dispose>[0]);
assert.ok((summary?.cases ?? 0) > 0, 'No vector-map verification cases executed');
console.log(JSON.stringify(summary));
