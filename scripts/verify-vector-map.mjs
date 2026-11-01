// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, mapsPlaceholder, nativeTiles, nativePeak, scrollY, Image */

import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createBrowserFixtureServer, waitForCondition, resolveFixtureFile } from './browser-verification-fixtures.mjs';
import { snowMapDocument } from './verify-snow-map-fixture.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

const args = process.argv.slice(2);
assert.ok(new Set(args).size === args.length && args.every(arg => ['--firefox', '--preflight', '--live', '--camera-only', '--recovery-only', '--cooldown-only'].includes(arg))
    && args.filter(arg => ['--preflight', '--live', '--camera-only', '--recovery-only', '--cooldown-only'].includes(arg)).length <= 1,
'Usage: node scripts/verify-vector-map.mjs [--firefox] [--preflight | --live | --camera-only | --recovery-only | --cooldown-only]');
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
        .replace('<body><div id="map"></div>', '<body><h1>Native map heading</h1><div id="map">')
        .replace('</select>', '<option value="L_SECOND">Other native map</option></select></div><p id="following">Following native content</p>')
        .replace('</script></body>', `window.nativeChanges=0;
        window.nativeSelections=[];
        document.getElementById('selmap').onchange=event=>{window.nativeChanges++;window.nativeSelections.push(event.target.value);};
        window.nativeTiles=L.tileLayer('/vector-native/{z}/{x}/{y}.png').addTo(mapsPlaceholder);
        </script></body>`);
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile, masterMapDocument: html, peakMapDocument: html });
    resources.defer('vector HTTPS fixture', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    if (!firefoxMode) assertChromeLaunchAllowed();
    const context = await (firefoxMode ? firefox : chromium).launchPersistentContext(profile, firefoxMode ? {
        headless: true, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 },
        firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com', 'webgl.sanitize-unmasked-renderer': false },
    } : { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1',
            `--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`],
    });
    resources.defer('vector browser', () => context.close());
    const page = await context.newPage(), errors = [], requests = [];
    failurePage = page;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().startsWith('Better Peakbagger vector map:')) console.error(message.text()); });
    let mode = 'hold', tileFailures = 0, partialUrl = null; const held = new Set();
    let retrySeconds = '2';
    failureContext = () => ({ mode, partialUrl, lastRequests: requests.slice(-12) });
    const release = () => { for (const done of held) done(); held.clear(); };
    resources.defer('held vector styles', release);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWPYvHnzfwAHNwL9GPw68wAAAABJRU5ErkJggg==', 'base64');
    await context.route('**/vector-native/**', route => route.fulfill({ contentType: 'image/png', body: png }));
    const geographicPoints = [[5, 90], [75, 5], [-75, 5], [5, 5], [46.851731, -121.760395]];
    const tile = url => {
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
    const style = { version: 8, sources: { fixture: { type: 'vector', url: 'https://tiles.openfreemap.org/vector.json' } }, layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#d5dec9' } },
        { id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'land', paint: { 'fill-color': '#c4ddac' } },
        { id: 'probes', type: 'circle', source: 'fixture', 'source-layer': 'probes', paint: { 'circle-radius': 12, 'circle-color': '#1e64d2' } },
    ] };
    await context.route('https://tiles.openfreemap.org/**', async route => {
        const url = route.request().url(); requests.push(url);
        assert.equal(route.request().headers().cookie, undefined); assert.equal(route.request().headers().referer, undefined);
        if (liveMode) return route.continue();
        if (url.endsWith('/styles/liberty') && mode === 'hold') await new Promise(resolve => held.add(resolve));
        const metadata = url.endsWith('/vector.json');
        if (mode === 'partial' && url.endsWith('.pbf')) partialUrl ??= url;
        const tileFailed = url.endsWith('.pbf') && (mode === 'tile-error' || mode === 'partial' && url === partialUrl);
        const limited = mode === 'style-limit' && url.endsWith('/styles/liberty') || mode === 'tile-limit' && url.endsWith('.pbf');
        if (tileFailed) tileFailures++;
        try {
            await route.fulfill({ status: limited ? 429 : tileFailed || mode === 'error' && url.endsWith('/styles/liberty') || mode === 'metadata-error' && metadata ? 503 : 200,
                headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...(limited ? { 'retry-after': retrySeconds, 'access-control-expose-headers': 'Retry-After' } : {}) },
                contentType: url.endsWith('.pbf') ? 'application/x-protobuf' : 'application/json',
                body: url.endsWith('.pbf') ? mode === 'empty' ? emptyTile : tile(url) : JSON.stringify(metadata
                    ? { tilejson: '3.0.0', tiles: ['https://tiles.openfreemap.org/fixture/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 } : style),
            });
        } catch { /* A deliberately cancelled frame no longer owns its request. */ }
    });
    if (firefoxMode) {
        await context.route(`${origin}/dist/**`, async route => {
            const file = await resolveFixtureFile(new URL(route.request().url()).pathname);
            assert.ok(file, `Packaged Firefox fixture asset exists: ${route.request().url()}`);
            await route.fulfill({ path: file, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript' });
        });
        // Firefox exercises real Leaflet and hardware MapLibre; only extension
        // runtime/capability transport is stubbed. Chrome loads the real addon.
        await context.addInitScript(({ origin }) => { window.chrome = { runtime: {
            getURL: value => `${origin}/dist/${value}`, sendMessage: async () => ({ ok: true, token: 'fixture-activation' }),
        } }; }, { origin });
    }
    const open = async () => {
        await page.goto(`${origin}/map/MasterMap.aspx?t=A`);
        if (firefoxMode) {
            await page.addStyleTag({ path: path.join(root, 'dist/css/vector-map.css') });
            await page.addScriptTag({ path: path.join(root, 'dist/content/vector-map-bridge.js') });
            await page.addScriptTag({ path: path.join(root, 'dist/content/vector-map.js') });
        }
        await page.waitForFunction(() => !!window.mapsPlaceholder?.getSize);
        if (!preflight) await page.locator('#selmap option[value="BPB_VECTOR"]').waitFor({ state: 'attached' });
        // The extension's first-run tab can become the active tab in this
        // disposable headless browser. Native picker defaults need page focus.
        await page.bringToFront();
        await page.evaluate(() => {
            window.vectorSettledViews = [];
            window.addEventListener('message', event => {
                if (event.source === document.querySelector('.bpb-vector-slot iframe')?.contentWindow
                    && event.data?.__bpbVectorMap === true && event.data.type === 'loaded' && event.data.view) window.vectorSettledViews.push(event.data.view);
            });
        });
    };
    await open();
    await page.evaluate(() => {
        window.vectorEvents = [];
        for (const type of ['keydown', 'change', 'input']) document.addEventListener(type, event => {
            if (event.target.id === 'selmap') window.vectorEvents.push({ type, key: event.key, trusted: event.isTrusted, value: event.target.value });
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
    const verifyCameraAlignment = async () => {
        mode = 'ready'; await open();
        await page.locator('#selmap').focus(); await page.keyboard.type('OSM');
        await page.waitForFunction(() => document.querySelector('.bpb-vector-slot')?.style.opacity === '1');
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
                    const context2d = canvas.getContext('2d'); context2d.drawImage(image, 0, 0);
                    const target = mapsPlaceholder.latLngToContainerPoint(point), bounds = document.getElementById('map').getBoundingClientRect();
                    const pixels = [[10, 0], [-10, 0], [0, 10], [0, -10]].map(([dx, dy]) => [...context2d.getImageData(
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
    const verifyProviderRecovery = async () => {
        const geometry = () => page.evaluate(() => ({ scroll: scrollY, boxes: ['h1', '#map', '#selmap', '#following', '.leaflet-control-zoom'].map(selector => {
            const rect = document.querySelector(selector).getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
        }) }));
        const stable = async baseline => {
            const actual = await geometry(); assert.equal(actual.scroll, baseline.scroll);
            actual.boxes.forEach((rect, index) => rect.forEach((value, dimension) => assert.ok(Math.abs(value - baseline.boxes[index][dimension]) <= 1, `Recovery shifted box ${index}/${dimension}`)));
        };
        const activate = async () => { await page.locator('#selmap').focus(); await page.keyboard.type('OSM'); await page.waitForFunction(() => document.querySelector('.bpb-vector-slot')?.style.opacity === '1'); };
        const screenshot = async name => { if (process.env.BPB_VECTOR_SCREENSHOTS) { await mkdir(process.env.BPB_VECTOR_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `${firefoxMode ? 'firefox' : 'chrome'}-recovery-${name}.png`) }); } };
        let cases = 0;
        for (const [width, theme, zoom] of [[1280, 'light', 1], [375, 'dark', 1], [1280, 'light', 2]]) {
            await page.setViewportSize({ width, height: 800 }); mode = 'ready'; await open();
            await page.evaluate(value => { document.documentElement.dataset.bpbTheme = value.theme; document.body.style.zoom = value.zoom; mapsPlaceholder.invalidateSize(); }, { theme, zoom });
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
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - during[key]) <= 1, `Outage Retry moved: ${key}`);
            assert.equal(await retry.evaluate(element => document.activeElement === element), true); await stable(retryBaseline);
            mode = 'ready'; release(); await page.waitForFunction(() => document.querySelector('.bpb-vector-slot')?.style.opacity === '1');
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), false); await stable(retryBaseline); await screenshot(`${width}-${zoom}-recovered`); cases++;
        }
        await page.setViewportSize({ width: 1280, height: 800 }); mode = 'empty'; await open(); await activate();
        assert.equal(await page.locator('.bpb-vector-status').evaluate(element => element.hidden), true, 'Valid empty tiles stay healthy');
        const failuresBefore = tileFailures; mode = 'tile-error';
        await page.evaluate(() => mapsPlaceholder.panBy([512, 0], { animate: false }));
        await waitForCondition(() => tileFailures > failuresBefore, { description: 'mixed cached-empty/new failed tiles' });
        await page.waitForFunction(() => window.vectorSettledViews.some(view => {
            const center = mapsPlaceholder.getCenter().wrap(); return Math.abs(view.center[0] - center.lat) < 1e-7 && Math.abs(view.center[1] - center.lng) < 1e-7;
        }));
        assert.equal(await page.locator('.bpb-vector-slot').evaluate(element => element.style.opacity), '1', 'Cached empty tiles remain usable beside failures'); cases++;
        partialUrl = null; mode = 'partial'; await open(); await activate();
        assert.ok(partialUrl); assert.equal(await page.locator('.bpb-vector-status').evaluate(element => element.hidden), true, 'Partial tile loss preserves usable output'); cases++;
        mode = 'metadata-error'; await open(); await page.locator('#selmap').focus(); await page.keyboard.type('OSM');
        await page.locator('.bpb-vector-status button[data-bpb-vector-map]').waitFor({ state: 'visible', timeout: 6000 });
        assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true, 'Failed TileJSON is unavailable, not a valid empty viewport'); cases++;
        return cases;
    };
    const verifyProviderCooldown = async () => {
        let cases = 0;
        for (const [width, theme, zoom, limit] of [[1280, 'light', 1, 'style-limit'], [375, 'dark', 1, 'tile-limit'], [1280, 'light', 2, 'style-limit']]) {
            await page.setViewportSize({ width, height: 800 }); mode = limit; retrySeconds = cases === 0 ? '120' : '3'; await open();
            await page.evaluate(value => { document.documentElement.dataset.bpbTheme = value.theme; document.body.style.zoom = value.zoom; mapsPlaceholder.invalidateSize(); }, { theme, zoom });
            await page.locator('#selmap').focus(); await page.keyboard.type('OSM');
            const retry = page.locator('.bpb-vector-status button[data-bpb-vector-map]'); await retry.waitFor({ state: 'visible' });
            await page.waitForFunction(() => !document.querySelector('.bpb-vector-slot iframe'));
            assert.equal(await retry.getAttribute('aria-disabled'), 'true', 'Retry-After must survive renderer disposal');
            assert.match(await page.locator('.bpb-vector-status').innerText(), /OpenFreeMap is busy\. Retry after/);
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true);
            await retry.focus(); const bounds = await retry.boundingBox();
            const geometry = () => page.evaluate(() => ({ scroll: scrollY, boxes: ['h1', '#map', '#selmap', '#following', '.leaflet-control-zoom'].map(selector => {
                const rect = document.querySelector(selector).getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
            }) }));
            const baseline = await geometry(), count = requests.length;
            const stable = async () => {
                const actual = await geometry(); assert.equal(actual.scroll, baseline.scroll);
                actual.boxes.forEach((rect, index) => rect.forEach((value, dimension) => assert.ok(Math.abs(value - baseline.boxes[index][dimension]) <= 1, `Cooldown shifted box ${index}/${dimension}`)));
            };
            await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await retry.click({ force: true });
            assert.equal(await retry.evaluate(element => document.activeElement === element), true);
            await page.evaluate(() => document.querySelector('.bpb-vector-status button[data-bpb-vector-map]').click());
            // The deadline also guards activation if the disabled hint changes.
            await retry.evaluate(element => element.setAttribute('aria-disabled', 'false')); await retry.click({ force: true });
            await retry.evaluate(element => element.setAttribute('aria-disabled', 'true'));
            assert.equal(requests.length, count, 'Retry cannot bypass the cooldown');
            const actual = await retry.boundingBox();
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(bounds[key] - actual[key]) <= 1, `Cooldown moved Retry: ${key}`);
            await stable();
            if (process.env.BPB_VECTOR_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, `${firefoxMode ? 'firefox' : 'chrome'}-cooldown-${width}-${zoom}.png`) });
            if (cases === 0) {
                // Prove the full 120-second header is retained without sleeping
                // through it. Short cases below exercise real timer expiry.
                cases++; continue;
            }
            mode = 'ready';
            await page.waitForFunction(() => document.querySelector('.bpb-vector-status button[data-bpb-vector-map]')?.getAttribute('aria-disabled') === 'false', null, { timeout: 6000 });
            assert.equal(requests.length, count, 'Expiry does not automatically replay requests');
            const expired = await retry.boundingBox();
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(bounds[key] - expired[key]) <= 1, `Expiry moved Retry: ${key}`);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector('.bpb-vector-slot')?.style.opacity === '1');
            await stable(); assert.ok(requests.length > count); cases++;
        }
        return cases;
    };
    if (preflight) summary = { preflight: true, cases: 1, renderer, browser: context.browser().version() };
    else if (cameraOnly) summary = { verification: 'vector-camera', cases: await verifyCameraAlignment(), renderer, browser: context.browser().version(), hidden: true, realExtension: !firefoxMode };
    else if (recoveryOnly) summary = { verification: 'vector-recovery', cases: await verifyProviderRecovery(), renderer, browser: context.browser().version(), hidden: true, realExtension: !firefoxMode };
    else if (cooldownOnly) summary = { verification: 'vector-cooldown', cases: await verifyProviderCooldown(), renderer, browser: context.browser().version(), hidden: true, realExtension: !firefoxMode };
    else if (liveMode) {
        await page.locator('#selmap').focus(); await page.keyboard.type('OSM');
        await page.waitForFunction(() => document.querySelector('.bpb-vector-slot')?.style.opacity === '1');
        if (process.env.BPB_VECTOR_SCREENSHOTS) {
            await mkdir(process.env.BPB_VECTOR_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.BPB_VECTOR_SCREENSHOTS, 'vector-live.png') });
        }
        summary = { verification: '2d-vector-map-live', cases: 1, renderer, hidden: true, realExtension: !firefoxMode, requests: requests.length, browser: context.browser().version() };
    }
    else {
        const geometry = () => page.evaluate(() => ({ scroll: scrollY,
            boxes: ['h1', '#map', '#selmap', '#following', '.leaflet-control-zoom'].map(selector => {
                const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
            }),
        }));
        const stable = async baseline => {
            const actual = await geometry(); assert.equal(actual.scroll, baseline.scroll);
            actual.boxes.forEach((rect, index) => rect.forEach((value, dimension) => assert.ok(Math.abs(value - baseline.boxes[index][dimension]) <= 1, `Layout changed at box ${index}, dimension ${dimension}: ${JSON.stringify({ actual, baseline })}`)));
        };
        const chooseVector = async () => { await page.locator('#selmap').focus(); await page.keyboard.type('OSM'); };
        const chooseNative = async () => { await page.locator('#selmap').selectOption('L_FIX'); };
        const ready = () => page.waitForFunction(() => document.querySelector('.bpb-vector-slot')?.style.opacity === '1');
        const shots = process.env.BPB_VECTOR_SCREENSHOTS;
        const screenshot = async name => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${firefoxMode ? 'firefox' : 'chrome'}-${name}.png`) }); } };
        let cases = 0;
        for (const [width, theme, zoom] of [[1280, 'light', 1], [375, 'dark', 1], [1280, 'light', 2]]) {
            // Each viewport is a separate document. This also resets the native
            // picker's type-ahead buffer instead of typing impossible strings
            // such as "FixtureOSM" through several instantaneous transitions.
            if (cases) await open();
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(({ theme, zoom }) => { document.documentElement.dataset.bpbTheme = theme; document.body.style.zoom = zoom; mapsPlaceholder.invalidateSize(); }, { theme, zoom });
            const baseline = await geometry(); assert.equal(requests.length, 0, 'No vector traffic before selection');
            await page.evaluate(() => { const select = document.getElementById('selmap'); select.value = 'BPB_VECTOR'; select.dispatchEvent(new Event('change', { bubbles: true })); });
            assert.equal(requests.length, 0, 'Forged selection cannot authorize provider requests');
            await chooseVector();
            await page.waitForFunction(() => document.getElementById('selmap').getAttribute('aria-busy') === 'true', null, { timeout: 10000 });
            await waitForCondition(() => held.size, { description: 'held vector style' });
            await stable(baseline); await screenshot(`${width}-${zoom}-pending`);
            mode = 'ready'; release(); await ready(); await stable(baseline);
            assert.equal(await page.locator('#selmap').evaluate(element => document.activeElement === element), true, 'Selection retains keyboard focus');
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativePeak)), true, 'Native marker survives');
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), false, 'Hidden native raster stops requesting tiles');
            assert.equal(await page.evaluate(() => window.nativeSelections.includes('BPB_VECTOR')), false, 'Vector choice bypasses native MapChange');
            await page.locator('.leaflet-interactive').first().click(); await page.locator('.leaflet-popup').waitFor();
            await page.evaluate(() => mapsPlaceholder.closePopup());
            await screenshot(`${width}-${zoom}-ready`);
            const frame = page.frames().find(item => /\/terrain\/vector.html/.test(item.url()));
            assert.ok(frame, 'Vector renderer iframe exists');
            const canvas = frame.locator('canvas'); assert.ok((await canvas.boundingBox()).width > 0);
            if (cases === 0) {
                const rect = await page.locator('#map').boundingBox();
                await page.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .45);
                await page.mouse.down();
                try {
                    await page.mouse.move(rect.x + rect.width * .8, rect.y + rect.height * .45, { steps: 10 });
                    await waitForCondition(async () => {
                        const pngData = (await page.locator('#map').screenshot()).toString('base64');
                        return page.evaluate(async data => {
                            const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
                            const target = document.createElement('canvas'); target.width = image.width; target.height = image.height;
                            const context2d = target.getContext('2d'); context2d.drawImage(image, 0, 0);
                            const pixels = context2d.getImageData(0, 0, image.width, image.height).data;
                            let painted = 0;
                            for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - 196) < 3 && Math.abs(pixels[i + 1] - 221) < 3 && Math.abs(pixels[i + 2] - 172) < 3) painted++;
                            return painted / (image.width * image.height);
                        }, pngData);
                    }, { isReady: fraction => fraction > .9, description: 'vector tiles cover the map during a long held drag', timeoutMs: 3000 });
                    await screenshot('drag-held');
                } finally { await page.mouse.up(); }
            }
            await page.evaluate(() => mapsPlaceholder.panBy([60, 20], { animate: false })); await ready();
            await chooseNative(); await page.waitForFunction(() => !document.querySelector('.bpb-vector-slot'));
            assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true, 'Native raster restored');
            requests.length = 0; mode = 'hold'; cases++;
        }
        await open();
        const baseline = await geometry(); mode = 'error'; await chooseVector();
        await page.locator('.bpb-vector-status button[data-bpb-vector-map]').waitFor({ state: 'visible' }); await stable(baseline); await screenshot('error');
        assert.notEqual(await page.locator('#selmap').inputValue(), 'BPB_VECTOR');
        assert.equal(await page.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles)), true);
        const retryBounds = await page.locator('.bpb-vector-status button[data-bpb-vector-map]').boundingBox();
        mode = 'hold'; await page.locator('.bpb-vector-status button[data-bpb-vector-map]').focus(); await page.keyboard.press('Enter');
        await waitForCondition(() => held.size, { description: 'retry style is pending' }); await stable(baseline);
        assert.equal(await page.locator('.bpb-vector-status button[data-bpb-vector-map]').evaluate(element => document.activeElement === element), true, 'Retry retains keyboard focus while busy');
        const busyBounds = await page.locator('.bpb-vector-status button[data-bpb-vector-map]').boundingBox();
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(retryBounds[key] - busyBounds[key]) <= 1, `Retry moved during loading: ${key}`);
        const pendingRequests = held.size; await page.keyboard.press('Enter'); assert.equal(held.size, pendingRequests, 'Busy Retry does not duplicate work');
        mode = 'ready'; release(); await ready(); await stable(baseline);
        assert.equal(await page.locator('#selmap').evaluate(element => document.activeElement === element), true, 'Successful retry returns focus to the basemap choice');
        await open(); mode = 'hold'; await chooseVector(); await waitForCondition(() => held.size, { description: 'cancelled style is pending' });
        await chooseNative(); mode = 'ready'; release();
        await page.waitForFunction(() => !document.querySelector('.bpb-vector-slot iframe'));
        assert.equal(await page.locator('#selmap').inputValue(), 'L_FIX', 'Late completion cannot reactivate a cancelled layer');
        await open(); await chooseVector(); await ready();
        await page.evaluate(() => mapsPlaceholder.remove());
        await page.waitForFunction(() => !document.querySelector('.bpb-vector-slot iframe'));
        assert.equal(await page.locator('#selmap').evaluate(element => element.style.minWidth), '', 'Map teardown restores the native picker sizing');
        const cameraCases = await verifyCameraAlignment();
        const recoveryCases = await verifyProviderRecovery();
        const cooldownCases = await verifyProviderCooldown();
        assert.deepEqual(errors, []);
        summary = { verification: '2d-vector-map', hidden: true, browser: context.browser().version(), renderer,
            cases: cases + 3 + cameraCases + recoveryCases + cooldownCases, viewports: '1280/375 × 800, light/dark, 200% CSS zoom', realExtension: !firefoxMode,
            syntheticProvider: true, loadingSuccessErrorRetryCancellation: true, stableGeometry: true, nativeMarkerInteraction: true };
    }
} catch (error) {
    failure = error;
    console.error(failureContext?.());
    if (failurePage && !failurePage.isClosed()) console.error(await failurePage.evaluate(() => ({
        selected: document.getElementById('selmap')?.value, busy: document.getElementById('selmap')?.getAttribute('aria-busy'),
        events: window.vectorEvents, focused: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(),
        camera: window.mapsPlaceholder && { center: window.mapsPlaceholder.getCenter(), zoom: window.mapsPlaceholder.getZoom() },
        status: document.querySelector('.bpb-vector-status')?.outerHTML, slot: document.querySelector('.bpb-vector-slot')?.outerHTML,
    })).catch(() => null));
}
await resources.dispose(failure);
assert.ok(summary?.cases > 0, 'No vector-map verification cases executed');
console.log(JSON.stringify(summary));
