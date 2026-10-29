// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global window, document, location, innerWidth */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
import { build } from 'esbuild';
import { chromium, firefox } from 'playwright';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createFixtureCertificate } from './browser-verification-fixtures.mjs';
import { snowMapDocument } from './verify-snow-map-fixture.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';

const [browserName, selection = 'startup'] = process.argv.slice(2);
assert.ok(process.argv.length <= 4 && ['chrome', 'firefox'].includes(browserName) && ['startup', 'lifetime', 'cache'].includes(selection),
    'Usage: node scripts/verify-custom-overlay-lifecycle.mjs chrome|firefox [startup|lifetime|cache]');
const resources = createResourceStack();
try {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-custom-lifecycle-'));
    resources.defer('lifecycle fixture directory', () => rm(temporaryRoot, { recursive: true, force: true }));
    const bundle = await build({ stdin: { contents: "import {createCustomRenderer} from './src/maps/custom-overlay-render.js'; import {parseCustomData} from './src/maps/custom-overlay-data.js'; window.lifecycleRenderer=createCustomRenderer; window.lifecycleParse=parseCustomData;", resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false });
    const certificate = await createFixtureCertificate({ directory: temporaryRoot });
    resources.defer('lifecycle certificate', () => certificate.remove());
    const html = (await snowMapDocument()).replace('</body>', '<script src="/lifecycle.js"></script></body>');
    const cacheState = { version: 1, png: [], requests: [] };
    const server = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
        if (request.url.startsWith('/cache/')) return cacheResponse(request, response, cacheState);
        response.setHeader('content-type', request.url === '/lifecycle.js' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/lifecycle.js' ? bundle.outputFiles[0].contents : html);
    });
    resources.defer('lifecycle HTTPS server', () => closeServer(server)); await listenServer(server, 0, '127.0.0.1');
    const engine = browserName === 'chrome' ? chromium : firefox;
    assertChromeLaunchAllowed();
    const context = await engine.launchPersistentContext(path.join(temporaryRoot, 'profile'), {
        headless: true, viewport: { width: 1000, height: 760 },
        ...(browserName === 'chrome' ? { channel: 'chromium', args: [...certificate.chromeTrustArgs, '--no-proxy-server', '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
            : { ignoreHTTPSErrors: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }),
    });
    resources.defer('lifecycle browser', () => context.close());
    const mvt = Buffer.from(fromGeojsonVt({ trails: { features: [{ type: 1, geometry: [[2048, 2048]], tags: {} }] } }, { version: 2, extent: 4096 })).toString('base64');
    let cases = 0;
    if (selection === 'cache') {
        cases = await verifyCache(context, cacheState, `https://www.peakbagger.com:${server.address().port}`);
        assert.equal(cases, 6);
    } else {
        for (const width of [1000, 390]) for (const theme of ['light', 'dark']) for (const kind of (selection === 'lifetime' ? ['geojson'] : ['geojson', 'raster', 'mvt'])) {
            const page = await context.newPage(); await page.setViewportSize({ width, height: 760 });
            await page.goto(`https://www.peakbagger.com:${server.address().port}/map/MasterMap.aspx`);
            const result = await page.evaluate(async ({ kind, theme, mvt, selection }) => {
                document.documentElement.dataset.bpbTheme = theme;
                const map = window.mapsPlaceholder, statuses = [];
                let release, fail = false, empty = false;
                const held = new Promise(resolve => { release = resolve; });
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
                const ctx = canvas.getContext('2d'); ctx.fillStyle = '#26734d'; ctx.fillRect(0, 0, 256, 256);
                const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                window.fetch = async url => {
                    await held;
                    if (fail) throw new TypeError('Controlled provider failure');
                    if (url.endsWith('meta.json')) return Response.json({ tilejson: '3.0.0', minzoom: 0, maxzoom: 18, tiles: [`https://tiles.example.com/{z}/{x}/{y}.${kind === 'mvt' ? 'pbf' : 'png'}`] });
                    if (url.endsWith('.geojson')) return Response.json({ type: 'FeatureCollection', features: empty ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-121.8, 46.85] } }, { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-121.83, 46.84], [-121.81, 46.86]] } }, { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-121.87,46.84],[-121.85,46.84],[-121.85,46.86],[-121.87,46.84]]] } }] });
                    return kind === 'mvt' ? new Response(Uint8Array.from(atob(mvt), char => char.charCodeAt(0))) : new Response(png, { headers: { 'content-type': 'image/png' } });
                };
                const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind,
                    source: kind === 'geojson' ? { dataUrl: 'https://tiles.example.com/data.geojson' } : { tiles: [], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
                    approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: kind === 'raster' ? [] : (kind === 'geojson' ? ['point', 'line', 'polygon'] : ['point']).map(geometry => ({ sourceLayer: 'trails', geometry, color: '#26734d', radius: 5, width: 2, fillOpacity: .3 })) } };
                const ownership = () => ({ layers: Object.keys(map._layers).length, listeners: map._events.moveend.length, canvases: document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas').length });
                const baseline = ownership();
                const wait = async condition => { const cutoff = performance.now() + 10000; while (!condition()) { if (performance.now() > cutoff) throw new Error('State timeout: ' + JSON.stringify(statuses.at(-1))); await new Promise(resolve => window.requestAnimationFrame(resolve)); } };
                const renderer = window.lifecycleRenderer({ win: window, map, parse: async job => window.lifecycleParse(job), onStatus: (_id, status) => statuses.push(status) });
                try {
                    if (map.getPane('bpb-custom-overlays')) throw new Error('Fixture already has custom pane.');
                    renderer.update([source]); renderer.update([source]);
                    release();
                    const end = performance.now() + 10000;
                    while (statuses.at(-1)?.pending || !statuses.at(-1)?.message) {
                        if (performance.now() > end) throw new Error('Paint timeout: ' + JSON.stringify(statuses.at(-1)));
                        await new Promise(resolve => window.requestAnimationFrame(resolve));
                    }
                    if (statuses.at(-1).error) throw new Error(JSON.stringify(statuses.at(-1)));
                    if (selection === 'lifetime') {
                        const active = JSON.stringify(ownership());
                        for (let count = 1; count <= 3; count++) {
                            renderer.update([source], {}, { [source.id]: count });
                            await wait(() => !statuses.at(-1).pending);
                            if (JSON.stringify(ownership()) !== active) throw new Error('Reload retained extra renderers: ' + JSON.stringify(ownership()));
                        }
                        fail = true; const canvases = [...document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas')];
                        renderer.update([source], {}, { [source.id]: 4 }); await wait(() => !statuses.at(-1).pending);
                        if (!statuses.at(-1).error || canvases.some(node => !node.isConnected)) throw new Error('Failed refresh discarded usable geometry.');
                        fail = false;
                        const layerGroup = window.L.layerGroup;
                        window.L.layerGroup = (...args) => { const layer = layerGroup(...args), add = layer.addTo;
                            layer.addTo = function (...values) { add.apply(this, values); throw new Error('Controlled partial setup failure'); }; return layer; };
                        renderer.update([source], {}, { [source.id]: 5 }); await wait(() => !statuses.at(-1).pending);
                        window.L.layerGroup = layerGroup;
                        if (!statuses.at(-1).error || JSON.stringify(ownership()) !== active || canvases.some(node => !node.isConnected)) throw new Error('Partial setup leaked owners or discarded usable geometry.');
                        empty = true; renderer.update([source], {}, { [source.id]: 6 }); await wait(() => !statuses.at(-1).pending);
                        if (statuses.at(-1).error || ownership().canvases !== 0) throw new Error('Empty GeoJSON retained old canvases.');
                        renderer.update([]);
                        if (JSON.stringify(ownership()) !== JSON.stringify(baseline)) throw new Error('Off retained map owners: ' + JSON.stringify(ownership()));
                        empty = false; renderer.update([source]); await wait(() => !statuses.at(-1).pending);
                        renderer.dispose();
                        if (JSON.stringify(ownership()) !== JSON.stringify(baseline)) throw new Error('Disposal retained map owners: ' + JSON.stringify(ownership()));
                        return { loaded: true, canvases: 1 };
                    }
                    window.lifecycleDispose = () => renderer.dispose();
                    return { loaded: true, canvases: document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas').length };
                } catch (error) { renderer.dispose(); throw error; }
            }, { kind, theme, mvt, selection });
            assert.ok(result.loaded && result.canvases > 0, `${theme}/${width}/${kind} paints on a fresh map`);
            if (process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS) {
                await mkdir(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, `${browserName}-${selection}-${kind}-${theme}-${width}.png`) });
            }
            await page.evaluate(() => window.lifecycleDispose?.());
            cases++; await page.close();
        }
        assert.equal(cases, selection === 'lifetime' ? 4 : 12);
    }
    console.log(JSON.stringify({ verification: 'custom-overlay-lifecycle', selection, cases, browser: context.browser().version(), hidden: true, widths: [1000, 390], height: 760, renderer: 'Leaflet canvas 2D' }));
} finally { await resources.dispose(); }

function cacheResponse(request, response, state) {
    const [, , kind, ...parts] = request.url.split('/'), metadata = parts.at(-1) === 'metadata.json';
    const etag = `"${request.url}-${state.version}"`, unchanged = request.headers['if-none-match'] === etag;
    state.requests.push({ kind, metadata, unchanged });
    response.setHeader('cache-control', 'public, max-age=3600'); response.setHeader('etag', etag);
    if (unchanged) { response.writeHead(304); response.end(); return; }
    response.setHeader('content-type', metadata || kind === 'geojson' ? 'application/json' : kind === 'raster' ? 'image/png' : 'application/vnd.mapbox-vector-tile');
    const origin = `https://${request.headers.host}`;
    if (metadata) response.end(JSON.stringify({ tilejson: '3.0.0', minzoom: 0, maxzoom: 18, tiles: [`${origin}${request.url.slice(0, request.url.lastIndexOf('/'))}/{z}/{x}/{y}.${kind === 'raster' ? 'png' : 'pbf'}`] }));
    else if (kind === 'raster') response.end(state.png[state.version - 1]);
    else if (kind === 'geojson') response.end(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: {
        type: 'Polygon', coordinates: [[[state.version === 1 ? -121.86 : -121.78, 46.82], [-121.74, 46.82], [-121.74, 46.88], [state.version === 1 ? -121.86 : -121.78, 46.82]]],
    } }] }));
    else {
        const left = state.version === 1 ? 0 : 2048;
        response.end(Buffer.from(fromGeojsonVt({ trails: { features: [{ type: 3, geometry: [[[left, 0], [4096, 0], [4096, 4096], [left, 0]]], tags: {} }] } }, { version: 2, extent: 4096 })));
    }
}

async function verifyCache(context, state, origin) {
    let cases = 0;
    for (const width of [1000, 390]) for (const kind of ['geojson', 'raster', 'mvt']) {
        state.version = 1;
        const page = await context.newPage(); await page.setViewportSize({ width, height: 760 });
        try {
            await page.goto(`${origin}/map/MasterMap.aspx`);
            state.png = (await page.evaluate(() => ['#f02010', '#1020f0'].map(color => {
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
                const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 256, 256);
                return [...Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0))];
            }))).map(bytes => Buffer.from(bytes));
            await page.evaluate(kind => {
                const origin = location.origin;
                window.cacheStatuses = [];
                window.cacheSource = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Cache fixture', kind,
                    source: kind === 'geojson' ? { dataUrl: `${origin}/cache/${kind}/${innerWidth}/data.geojson` }
                        : { tiles: [], metadataUrl: `${origin}/cache/${kind}/${innerWidth}/metadata.json`, minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
                    approvedOrigins: [origin], attribution: { text: '' }, appearance: { opacity: 60,
                        rules: kind === 'raster' ? [] : [{ sourceLayer: 'trails', geometry: 'polygon', color: '#26734d', radius: 5, width: 2, fillOpacity: .8 }] } };
                window.cacheRenderer = window.lifecycleRenderer({ win: window, map: window.mapsPlaceholder, parse: async job => window.lifecycleParse(job),
                    onStatus: (_id, status) => window.cacheStatuses.push(status) });
                window.cachePixels = () => [...document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas')].map(canvas => {
                    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                    let hash = 2166136261, painted = 0;
                    for (let i = 0; i < bytes.length; i++) { hash = Math.imul(hash ^ bytes[i], 16777619); if (i % 4 === 3 && bytes[i]) painted++; }
                    return { hash, painted };
                });
                window.cacheRenderer.update([window.cacheSource]);
            }, kind);
            await page.waitForFunction(() => window.cacheStatuses.at(-1)?.message === 'Loaded' && !window.cacheStatuses.at(-1)?.pending && window.cachePixels().some(value => value.painted));
            const settledPixels = () => page.evaluate(async () => {
                let previous = '', stable = 0;
                const cutoff = performance.now() + 10000;
                while (performance.now() < cutoff) {
                    await new Promise(resolve => window.requestAnimationFrame(resolve));
                    const pixels = window.cachePixels(), next = JSON.stringify(pixels);
                    stable = next === previous && !window.cacheStatuses.at(-1)?.pending ? stable + 1 : 0;
                    if (stable >= 3) return pixels;
                    previous = next;
                }
                throw new Error('Custom pixels did not settle: ' + previous);
            });
            const before = await settledPixels();
            state.version = 2;
            const start = state.requests.length;
            await page.evaluate(() => window.cacheRenderer.update([window.cacheSource], {}, { [window.cacheSource.id]: 1 }));
            await page.waitForFunction(before => !window.cacheStatuses.at(-1)?.pending && !window.cacheStatuses.at(-1)?.error
                && JSON.stringify(window.cachePixels()) !== JSON.stringify(before), before);
            assert.ok(state.requests.length > start, `${kind} Reload reaches the real cacheable provider`);
            const after = await settledPixels(), unchangedStart = state.requests.length;
            assert.notDeepEqual(after, before, `${kind}/${width} Reload changes settled painted pixels`);
            await page.evaluate(() => window.cacheRenderer.update([window.cacheSource], {}, { [window.cacheSource.id]: 2 }));
            await page.waitForFunction(() => !window.cacheStatuses.at(-1)?.pending && window.cacheStatuses.at(-1)?.message === 'Loaded');
            assert.ok(state.requests.slice(unchangedStart).some(request => request.unchanged), `${kind} unchanged data is conditionally revalidated`);
            assert.deepEqual(await settledPixels(), after, `${kind}/${width} conditional responses preserve painted pixels`);
            if (process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS) {
                await mkdir(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, `${context.browser().browserType().name()}-cache-${kind}-${width}.png`) });
            }
            const cachedStart = state.requests.length;
            await page.evaluate(() => {
                window.cacheRenderer.client.evict(`${window.cacheSource.id}:${window.cacheSource.revision}`);
                window.cacheRenderer.update([]); window.cacheRenderer.update([window.cacheSource]);
            });
            await page.waitForFunction(() => !window.cacheStatuses.at(-1)?.pending && window.cachePixels().some(value => value.painted));
            assert.equal(state.requests.length, cachedStart, `${kind} ordinary re-enable keeps browser-cache reuse`);
            cases++;
        } finally { await page.evaluate(() => window.cacheRenderer?.dispose()).catch(() => {}); await page.close(); }
    }
    return cases;
}
