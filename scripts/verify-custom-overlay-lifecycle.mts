// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import type { BrowserContext } from 'playwright';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createFixtureCertificate } from './browser-verification-fixtures.mts';
import { snowMapDocument } from './verify-snow-map-fixture.mts';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mts';
import { createVerificationRoot, launchVerificationChrome, launchVerificationFirefox, PEAKBAGGER_HOST_RULE } from './verification-launch.mts';

// Page-world fixture objects; callbacks cast in place so the shared program keeps Window unchanged.
interface FixtureLeafletMap { _layers: Record<string, { options?: { bpbOverlay?: unknown } }>; _events: { moveend: unknown[] };
    getPane(name: string): unknown; setView(center: number[], zoom: number, options?: object): void }
interface CustomStatus { pending?: boolean; message?: string; error?: unknown }
interface CustomRenderer { update(sources: object[], ...rest: object[]): void; dispose(): void; client: { evict(key: string): void } }
interface PixelSummary { hash: number; painted: number; red: number; blue: number }
interface LifecycleWindow {
    mapsPlaceholder: FixtureLeafletMap;
    L: { layerGroup: (...args: unknown[]) => { addTo: (...values: unknown[]) => unknown } };
    lifecycleRenderer(options: object): CustomRenderer; lifecycleParse(job: unknown): unknown; lifecycleDispose?: () => void;
    cacheStatuses: CustomStatus[]; cacheSource: { id: string; revision: number; [field: string]: unknown }; cacheRenderer: CustomRenderer; cachePixels(): PixelSummary[];
}
interface CacheState { version: number; png: Buffer[]; requests: { kind: string; metadata: boolean; unchanged: boolean }[] }

const [browserName, selection = 'startup'] = process.argv.slice(2);
assert.ok(process.argv.length <= 4 && ['chrome', 'firefox'].includes(browserName) && ['startup', 'lifetime', 'cache'].includes(selection),
    'Usage: node scripts/verify-custom-overlay-lifecycle.mts chrome|firefox [startup|lifetime|cache]');
const resources = createResourceStack();
try {
    const temporaryRoot = await createVerificationRoot(resources, 'bpb-custom-lifecycle-', 'lifecycle fixture directory');
    const bundle = await build({ stdin: { contents: "import {createCustomRenderer} from './src/maps/custom-overlay-render.js'; import {parseCustomData} from './src/maps/custom-overlay-data.ts'; window.lifecycleRenderer=createCustomRenderer; window.lifecycleParse=parseCustomData;", resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false });
    const certificate = await createFixtureCertificate({ directory: temporaryRoot as never });
    assert.ok(certificate);
    resources.defer('lifecycle certificate', () => certificate.remove());
    const html = (await snowMapDocument()).replace('</body>', '<script src="/lifecycle.js"></script></body>');
    const cacheState: CacheState = { version: 1, png: [], requests: [] };
    const server = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
        if (request.url!.startsWith('/cache/')) return cacheResponse(request, response, cacheState);
        response.setHeader('content-type', request.url === '/lifecycle.js' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/lifecycle.js' ? bundle.outputFiles[0].contents : html);
    });
    resources.defer('lifecycle HTTPS server', () => closeServer(server)); await listenServer(server, 0, '127.0.0.1');
    const profile = path.join(temporaryRoot, 'profile'), viewport = { width: 1000, height: 760 };
    const context = browserName === 'chrome'
        ? await launchVerificationChrome(resources, 'lifecycle browser', profile, { viewport,
            trustArgs: certificate.chromeTrustArgs, args: ['--no-proxy-server'], hosts: [PEAKBAGGER_HOST_RULE] })
        : await launchVerificationFirefox(resources, 'lifecycle browser', profile, { viewport });
    const port = (server.address() as AddressInfo).port;
    const mvt = Buffer.from(fromGeojsonVt({ trails: { features: [{ type: 1, geometry: [[2048, 2048]], tags: {} }] } }, { version: 2, extent: 4096 })).toString('base64');
    let cases = 0;
    if (selection === 'cache') {
        cases = await verifyCache(context, cacheState, `https://www.peakbagger.com:${port}`);
        assert.equal(cases, 6);
    } else {
        for (const width of [1000, 390]) for (const theme of ['light', 'dark']) for (const kind of (selection === 'lifetime' ? ['geojson'] : ['geojson', 'raster', 'mvt'])) {
            const page = await context.newPage(); await page.setViewportSize({ width, height: 760 });
            await page.goto(`https://www.peakbagger.com:${port}/map/MasterMap.aspx`);
            const result = await page.evaluate(async ({ kind: sourceKind, theme: pageTheme, mvt: mvtBase64, selection: mode }) => {
                const fixtureWindow = window as unknown as LifecycleWindow;
                document.documentElement.dataset.bpbTheme = pageTheme;
                const map = fixtureWindow.mapsPlaceholder, statuses: CustomStatus[] = [];
                let release!: (value?: unknown) => void, fail = false, empty = false;
                const held = new Promise(resolve => { release = resolve; });
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
                const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#26734d'; ctx.fillRect(0, 0, 256, 256);
                const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
                window.fetch = (async (url: string) => {
                    await held;
                    if (fail) throw new TypeError('Controlled provider failure');
                    if (url.endsWith('meta.json')) return Response.json({ tilejson: '3.0.0', minzoom: 0, maxzoom: 18, tiles: [`https://tiles.example.com/{z}/{x}/{y}.${sourceKind === 'mvt' ? 'pbf' : 'png'}`] });
                    if (url.endsWith('.geojson')) return Response.json({ type: 'FeatureCollection', features: empty ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-121.8, 46.85] } }, { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-121.83, 46.84], [-121.81, 46.86]] } }, { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-121.87,46.84],[-121.85,46.84],[-121.85,46.86],[-121.87,46.84]]] } }] });
                    return sourceKind === 'mvt' ? new Response(Uint8Array.from(atob(mvtBase64), char => char.charCodeAt(0))) : new Response(png, { headers: { 'content-type': 'image/png' } });
                }) as typeof window.fetch;
                const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind: sourceKind,
                    source: sourceKind === 'geojson' ? { dataUrl: 'https://tiles.example.com/data.geojson' } : { tiles: [], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
                    approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: sourceKind === 'raster' ? [] : (sourceKind === 'geojson' ? ['point', 'line', 'polygon'] : ['point']).map(geometry => ({ sourceLayer: 'trails', geometry, color: '#26734d', radius: 5, width: 2, fillOpacity: .3 })) } };
                const ownership = () => ({ layers: Object.keys(map._layers).length, listeners: map._events.moveend.length, canvases: document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas').length });
                const baseline = ownership();
                const wait = async (condition: () => boolean) => { const cutoff = performance.now() + 10000; while (!condition()) { if (performance.now() > cutoff) throw new Error('State timeout: ' + JSON.stringify(statuses.at(-1))); await new Promise(resolve => window.requestAnimationFrame(resolve)); } };
                const renderer = fixtureWindow.lifecycleRenderer({ win: window, map, parse: async (job: unknown) => fixtureWindow.lifecycleParse(job), onStatus: (_id: string, status: CustomStatus) => statuses.push(status) });
                try {
                    if (map.getPane('bpb-custom-overlays')) throw new Error('Fixture already has custom pane.');
                    renderer.update([source]); renderer.update([source]);
                    release();
                    const end = performance.now() + 10000;
                    while (statuses.at(-1)?.pending || !statuses.at(-1)?.message) {
                        if (performance.now() > end) throw new Error('Paint timeout: ' + JSON.stringify(statuses.at(-1)));
                        await new Promise(resolve => window.requestAnimationFrame(resolve));
                    }
                    if (statuses.at(-1)!.error) throw new Error(JSON.stringify(statuses.at(-1)));
                    if (mode === 'lifetime') {
                        const active = JSON.stringify(ownership());
                        for (let count = 1; count <= 3; count++) {
                            renderer.update([source], {}, { [source.id]: count });
                            await wait(() => !statuses.at(-1)!.pending);
                            if (JSON.stringify(ownership()) !== active) throw new Error('Reload retained extra renderers: ' + JSON.stringify(ownership()));
                        }
                        fail = true; const canvases = [...document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas')];
                        renderer.update([source], {}, { [source.id]: 4 }); await wait(() => !statuses.at(-1)!.pending);
                        if (!statuses.at(-1)!.error || canvases.some(node => !node.isConnected)) throw new Error('Failed refresh discarded usable geometry.');
                        fail = false;
                        const layerGroup = fixtureWindow.L.layerGroup;
                        fixtureWindow.L.layerGroup = (...args: unknown[]) => { const layer = layerGroup(...args), add = layer.addTo;
                            layer.addTo = function (this: unknown, ...values: unknown[]) { add.apply(this, values); throw new Error('Controlled partial setup failure'); }; return layer; };
                        renderer.update([source], {}, { [source.id]: 5 }); await wait(() => !statuses.at(-1)!.pending);
                        fixtureWindow.L.layerGroup = layerGroup;
                        if (!statuses.at(-1)!.error || JSON.stringify(ownership()) !== active || canvases.some(node => !node.isConnected)) throw new Error('Partial setup leaked owners or discarded usable geometry.');
                        empty = true; renderer.update([source], {}, { [source.id]: 6 }); await wait(() => !statuses.at(-1)!.pending);
                        if (statuses.at(-1)!.error || ownership().canvases !== 0) throw new Error('Empty GeoJSON retained old canvases.');
                        renderer.update([]);
                        if (JSON.stringify(ownership()) !== JSON.stringify(baseline)) throw new Error('Off retained map owners: ' + JSON.stringify(ownership()));
                        empty = false; renderer.update([source]); await wait(() => !statuses.at(-1)!.pending);
                        renderer.dispose();
                        if (JSON.stringify(ownership()) !== JSON.stringify(baseline)) throw new Error('Disposal retained map owners: ' + JSON.stringify(ownership()));
                        return { loaded: true, canvases: 1 };
                    }
                    fixtureWindow.lifecycleDispose = () => renderer.dispose();
                    return { loaded: true, canvases: document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas').length };
                } catch (error) { renderer.dispose(); throw error; }
            }, { kind, theme, mvt, selection });
            assert.ok(result.loaded && result.canvases > 0, `${theme}/${width}/${kind} paints on a fresh map`);
            if (process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS) {
                await mkdir(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, `${browserName}-${selection}-${kind}-${theme}-${width}.png`) });
            }
            await page.evaluate(() => (window as unknown as LifecycleWindow).lifecycleDispose?.());
            cases++; await page.close();
        }
        assert.equal(cases, selection === 'lifetime' ? 4 : 12);
    }
    console.log(JSON.stringify({ verification: 'custom-overlay-lifecycle', selection, cases, browser: context.browser()!.version(), hidden: true, widths: [1000, 390], height: 760, renderer: 'Leaflet canvas 2D' }));
} finally { await resources.dispose(); }

function cacheResponse(request: IncomingMessage, response: ServerResponse, state: CacheState) {
    const url = request.url!;
    const [, , kind, ...parts] = url.split('/'), metadata = parts.at(-1) === 'metadata.json';
    const etag = `"${url}-${state.version}"`, unchanged = request.headers['if-none-match'] === etag;
    state.requests.push({ kind, metadata, unchanged });
    response.setHeader('cache-control', 'public, max-age=3600'); response.setHeader('etag', etag);
    if (unchanged) { response.writeHead(304); response.end(); return; }
    response.setHeader('content-type', metadata || kind === 'geojson' ? 'application/json' : kind === 'raster' ? 'image/png' : 'application/vnd.mapbox-vector-tile');
    const origin = `https://${request.headers.host}`;
    if (metadata) response.end(JSON.stringify({ tilejson: '3.0.0', minzoom: 0, maxzoom: state.version === 1 ? 18 : 17,
        ...(state.version === 3 && { bounds: [0, 0, 1, 1] }),
        tiles: [`${origin}${url.slice(0, url.lastIndexOf('/'))}/{z}/{x}/{y}.${kind === 'raster' ? 'png' : 'pbf'}`] }));
    else if (kind === 'raster') response.end(state.png[Math.min(state.version - 1, state.png.length - 1)]);
    else if (kind === 'geojson') response.end(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: {
        type: 'Polygon', coordinates: [[[state.version === 1 ? -121.86 : -121.78, 46.82], [-121.74, 46.82], [-121.74, 46.88], [state.version === 1 ? -121.86 : -121.78, 46.82]]],
    } }] }));
    else {
        const left = state.version === 1 ? 0 : 2048;
        response.end(Buffer.from(fromGeojsonVt({ trails: { features: [{ type: 3, geometry: [[[left, 0], [4096, 0], [4096, 4096], [left, 0]]], tags: {} }] } }, { version: 2, extent: 4096 })));
    }
}

async function verifyCache(context: BrowserContext, state: CacheState, origin: string) {
    let cases = 0;
    for (const width of [1000, 390]) for (const kind of ['geojson', 'raster', 'mvt']) {
        state.version = 1;
        const page = await context.newPage(); await page.setViewportSize({ width, height: 760 });
        try {
            await page.goto(`${origin}/map/MasterMap.aspx`);
            state.png = (await page.evaluate(() => ['#f02010', '#1020f0'].map(color => {
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
                const drawing = canvas.getContext('2d')!; drawing.fillStyle = color; drawing.fillRect(0, 0, 256, 256);
                return [...Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0))];
            }))).map(bytes => Buffer.from(bytes));
            await page.evaluate(sourceKind => {
                const fixtureWindow = window as unknown as LifecycleWindow, pageOrigin = location.origin;
                fixtureWindow.cacheStatuses = [];
                fixtureWindow.cacheSource = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Cache fixture', kind: sourceKind,
                    source: sourceKind === 'geojson' ? { dataUrl: `${pageOrigin}/cache/${sourceKind}/${innerWidth}/data.geojson` }
                        : { tiles: [], metadataUrl: `${pageOrigin}/cache/${sourceKind}/${innerWidth}/metadata.json`, minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
                    approvedOrigins: [pageOrigin], attribution: { text: '' }, appearance: { opacity: 60,
                        rules: sourceKind === 'raster' ? [] : [{ sourceLayer: 'trails', geometry: 'polygon', color: '#26734d', radius: 5, width: 2, fillOpacity: .8 }] } };
                fixtureWindow.cacheRenderer = fixtureWindow.lifecycleRenderer({ win: window, map: fixtureWindow.mapsPlaceholder, parse: async (job: unknown) => fixtureWindow.lifecycleParse(job),
                    onStatus: (_id: string, status: CustomStatus) => fixtureWindow.cacheStatuses.push(status) });
                fixtureWindow.cachePixels = () => [...document.querySelectorAll<HTMLCanvasElement>('.leaflet-bpb-custom-overlays-pane canvas')].map(canvas => {
                    const bytes = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
                    let hash = 2166136261, painted = 0, red = 0, blue = 0;
                    for (let i = 0; i < bytes.length; i++) {
                        hash = Math.imul(hash ^ bytes[i], 16777619);
                        if (i % 4 === 3 && bytes[i]) { painted++; red += bytes[i - 3]; blue += bytes[i - 1]; }
                    }
                    return { hash, painted, red, blue };
                });
                fixtureWindow.cacheRenderer.update([fixtureWindow.cacheSource]);
            }, kind);
            await page.waitForFunction(() => (window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.message === 'Loaded' && !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.pending && (window as unknown as LifecycleWindow).cachePixels().some(value => value.painted));
            const settledPixels = () => page.evaluate(async () => {
                let previous = '', stable = 0;
                const cutoff = performance.now() + 10000;
                while (performance.now() < cutoff) {
                    await new Promise(resolve => window.requestAnimationFrame(resolve));
                    const pixels = (window as unknown as LifecycleWindow).cachePixels(), next = JSON.stringify(pixels);
                    stable = next === previous && !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.pending ? stable + 1 : 0;
                    if (stable >= 3) return pixels;
                    previous = next;
                }
                throw new Error('Custom pixels did not settle: ' + previous);
            });
            const before = await settledPixels();
            state.version = 2;
            const start = state.requests.length;
            await page.evaluate(() => (window as unknown as LifecycleWindow).cacheRenderer.update([(window as unknown as LifecycleWindow).cacheSource], {}, { [(window as unknown as LifecycleWindow).cacheSource.id]: 1 }));
            await page.waitForFunction(expected => !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.pending && !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.error
                && JSON.stringify((window as unknown as LifecycleWindow).cachePixels()) !== JSON.stringify(expected), before);
            assert.ok(state.requests.length > start, `${kind} Reload reaches the real cacheable provider`);
            const after = await settledPixels(), unchangedStart = state.requests.length;
            const count = (pixels: PixelSummary[]) => pixels.reduce((sum, value) => sum + value.painted, 0);
            if (kind === 'raster') assert.ok(before.every(value => value.red > value.blue) && after.every(value => value.blue > value.red), 'Reload paints the new blue raster');
            else assert.ok(Math.abs(count(after) - count(before)) > count(before) * .05, `${kind}/${width} Reload changes the fixture geometry`);
            if (kind !== 'geojson') assert.equal(await page.evaluate(() => Object.values((window as unknown as LifecycleWindow).mapsPlaceholder._layers).filter(layer => layer.options?.bpbOverlay).length), 1,
                `${kind}/${width} changed metadata releases the old native rendering owner after paint`);
            await page.evaluate(() => (window as unknown as LifecycleWindow).cacheRenderer.update([(window as unknown as LifecycleWindow).cacheSource], {}, { [(window as unknown as LifecycleWindow).cacheSource.id]: 2 }));
            await page.waitForFunction(() => !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.pending && (window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.message === 'Loaded');
            assert.ok(state.requests.slice(unchangedStart).some(request => request.unchanged), `${kind} unchanged data is conditionally revalidated`);
            const unchanged = await settledPixels();
            // Canvas may switch between hardware and software rasterization
            // after readback. Compare geometry coverage with a 1% edge-AA
            // tolerance, rather than requiring identical antialiasing bytes.
            assert.ok(Math.abs(count(unchanged) - count(after)) <= count(after) * .01, `${kind}/${width} conditional responses preserve painted coverage`);
            if (kind === 'raster') assert.ok(unchanged.every(value => value.blue > value.red));
            if (process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS) {
                await mkdir(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, `${context.browser()!.browserType().name()}-cache-${kind}-${width}.png`) });
            }
            const cachedStart = state.requests.length;
            await page.evaluate(() => {
                (window as unknown as LifecycleWindow).cacheRenderer.client.evict(`${(window as unknown as LifecycleWindow).cacheSource.id}:${(window as unknown as LifecycleWindow).cacheSource.revision}`);
                (window as unknown as LifecycleWindow).cacheRenderer.update([]); (window as unknown as LifecycleWindow).cacheRenderer.update([(window as unknown as LifecycleWindow).cacheSource]);
            });
            await page.waitForFunction(() => !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.pending && (window as unknown as LifecycleWindow).cachePixels().some(value => value.painted));
            assert.equal(state.requests.length, cachedStart, `${kind} ordinary re-enable keeps browser-cache reuse`);
            if (kind !== 'geojson') {
                state.version = 3;
                await page.evaluate(() => (window as unknown as LifecycleWindow).cacheRenderer.update([(window as unknown as LifecycleWindow).cacheSource], {}, { [(window as unknown as LifecycleWindow).cacheSource.id]: 3 }));
                await page.waitForFunction(() => !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.pending && (window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.message === 'No tiles in this area.');
                assert.deepEqual(await page.evaluate(() => (window as unknown as LifecycleWindow).cachePixels()), [], 'an explicitly empty replacement releases old native canvases');
                await page.evaluate(() => (window as unknown as LifecycleWindow).mapsPlaceholder.setView([.5, .5], 8, { animate: false }));
                await page.waitForFunction(() => !(window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.pending && (window as unknown as LifecycleWindow).cachePixels().some(value => value.painted));
                assert.equal(await page.evaluate(() => (window as unknown as LifecycleWindow).cacheStatuses.at(-1)?.message), 'Loaded', 'panning back into coverage clears empty feedback without Reload');
            }
            cases++;
        } finally { await page.evaluate(() => (window as unknown as LifecycleWindow).cacheRenderer?.dispose()).catch(() => {}); await page.close(); }
    }
    return cases;
}
