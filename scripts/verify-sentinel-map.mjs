// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createBrowserFixtureServer, waitForCondition } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.BPB_VERIFY_SENTINEL_SCREENSHOT_DIR;
const resources = createResourceStack();
let primaryError, summary;
try {
    // Real Leaflet, pinned independently of Peakbagger's live CDN. These files
    // are used only in this disposable test and never shipped by the extension.
    const assets = await Promise.all([
        ['js', '20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='],
        ['css', 'p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='],
    ].map(async ([extension, hash]) => {
        const response = await fetch(`https://unpkg.com/leaflet@1.9.4/dist/leaflet.${extension}`, { signal: AbortSignal.timeout(30_000) });
        assert.equal(response.ok, true, `Leaflet ${extension} download`);
        const body = Buffer.from(await response.arrayBuffer());
        assert.equal(createHash('sha256').update(body).digest('base64'), hash, `pinned Leaflet ${extension}`);
        return body;
    }));
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-sentinel-verify-'));
    resources.defer('Sentinel temporary profile', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('Sentinel HTTPS fixture', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const dist = path.join(root, 'dist');
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(temporaryRoot, {
        channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
        args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('Sentinel Chrome context', () => context.close());
    const page = await context.newPage(), errors = [], held = [];
    page.on('pageerror', error => errors.push(error.message));
    resources.defer('Sentinel held catalogs', () => held.splice(0).forEach(resolve => resolve()));
    let searches = 0, holdCatalog = false, failedCatalog = false, failedTiles = false, tileRequests = 0;
    const capture = id => ({ id, collection: 'sentinel-2-l2a',
        properties: { datetime: new Date(Date.now() - (id === 'scene_new' ? 2 : 3) * 86400000).toISOString(),
            platform: 'Sentinel-2B', 'sat:relative_orbit': 13, 'eo:cloud_cover': 4 },
        geometry: { type: 'Polygon', coordinates: [[[-122, 46], [-121, 46], [-121, 47], [-122, 47], [-122, 46]]] } });
    let catalog = [capture('scene_new'), capture('scene_old')];
    await context.route(`${origin}/leaflet.*`, route => route.fulfill({ body: assets[route.request().url().endsWith('.js') ? 0 : 1],
        contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/css' }));
    await context.route(`${origin}/map/MasterMap.aspx*`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
        <link rel="stylesheet" href="/leaflet.css"><style>html,body,#map{height:100%;margin:0}#selmap{position:absolute;top:10px;left:60px;z-index:1000}</style>
        </head><body><div id="map"></div><select id="selmap"><option value="L_FIX">Base map</option></select><script src="/leaflet.js"></script><script>
        window.mapsPlaceholder=L.map('map',{inertia:false}).setView([46.5,-121.5],13);
        window.nativeTiles=L.tileLayer('/native/{z}/{x}/{y}.png').addTo(mapsPlaceholder);
        window.nativeRoute=L.polyline([[46.48,-121.51],[46.52,-121.49]],{color:'#e55',weight:5}).addTo(mapsPlaceholder);
        window.sentinelEvents=[]; window.moveEnds=0;
        window.imageryOpacity=()=>{
            const center=mapsPlaceholder.getSize().divideBy(2);
            return Math.max(0,...Object.values(mapsPlaceholder._layers).filter(layer=>layer._url?.includes('planetarycomputer'))
                .flatMap(layer=>Object.values(layer._tiles).map(({el})=>{
                    const b=el.getBoundingClientRect();
                    return el.complete&&el.naturalWidth>0&&b.left<=center.x&&b.right>center.x&&b.top<=center.y&&b.bottom>center.y
                        ? Number(getComputedStyle(el).opacity) : 0;
                })));
        };
        window.fadedFrames=0; window.probing=false;
        requestAnimationFrame(function probe(){if(window.probing&&imageryOpacity()<.99) fadedFrames++;requestAnimationFrame(probe)});
        mapsPlaceholder.on('layeradd layerremove',event=>{if(event.layer._url?.includes('planetarycomputer')) sentinelEvents.push(event.type)});
        mapsPlaceholder.on('moveend',()=>moveEnds++);
        </script></body></html>` }));
    // Solid, decoded SVG tiles distinguish loaded satellite imagery from the
    // grey native fallback without using the live imagery service.
    const tile = color => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${color}"/></svg>`;
    await context.route(`${origin}/native/**`, route => route.fulfill({ contentType: 'image/svg+xml', body: tile('#a8b1ba') }));
    await context.route('https://planetarycomputer.microsoft.com/**', async route => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
        if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
        if (route.request().url().includes('/api/stac/')) {
            searches++;
            if (holdCatalog) await new Promise(resolve => held.push(resolve));
            await route.fulfill({ status: failedCatalog ? 503 : 200, contentType: 'application/json',
                headers: cors, body: JSON.stringify({ features: catalog }) });
        } else {
            tileRequests++;
            await route.fulfill({ status: failedTiles ? 503 : 200, contentType: 'image/svg+xml', headers: cors,
                body: failedTiles ? '' : tile('#347d61') });
        }
    });
    const wait = (fn, description) => waitForCondition(() => page.evaluate(fn), { description, timeoutMs: 20_000 });
    await page.goto(`${origin}/map/MasterMap.aspx?t=P`, { waitUntil: 'load' });
    await wait(() => document.querySelector('#selmap option[value="BPB_SENTINEL"]'), 'real unpacked Sentinel bundle in the Leaflet page');
    await page.selectOption('#selmap', 'BPB_SENTINEL');
    const snapshot = () => {
        const layers = Object.values(window.mapsPlaceholder._layers).filter(layer => layer._url?.includes('planetarycomputer'));
        const center = window.mapsPlaceholder.getSize().divideBy(2);
        return { ids: layers.map(layer => layer._leaflet_id), events: [...window.sentinelEvents],
            imageAtCenter: layers.some(layer => Object.values(layer._tiles).some(({ el }) => {
                const bounds = el.getBoundingClientRect();
                return el.complete && el.naturalWidth > 0 && bounds.left <= center.x && bounds.right > center.x && bounds.top <= center.y && bounds.bottom > center.y;
            })), native: window.mapsPlaceholder.hasLayer(window.nativeTiles), route: window.mapsPlaceholder.hasLayer(window.nativeRoute) };
    };
    await wait(() => document.querySelector('.bpb-sentinel-stats').textContent.includes('Coverage 100%'), 'dated capture catalog');
    await wait(() => window.imageryOpacity() >= .99, 'fully painted Sentinel tile at the map center');
    await page.evaluate(() => { window.probing = true; });
    const initial = await page.evaluate(snapshot);
    if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'loaded.png') }); }
    for (const [index, fail] of [false, false, true].entries()) {
        holdCatalog = true; failedCatalog = fail;
        const beforeSearch = searches, beforeMove = await page.evaluate(() => window.moveEnds);
        await page.mouse.move(500, 250); await page.mouse.down(); await page.mouse.move(530, 260, { steps: 8 }); await page.mouse.up();
        await waitForCondition(() => searches > beforeSearch, { description: 'catalog refresh after physical map drag' });
        assert.ok(await page.evaluate(count => window.moveEnds > count, beforeMove), 'a real Leaflet drag completed');
        assert.equal((await page.evaluate(snapshot)).imageAtCenter, true, 'keep the loaded image during the held catalog request');
        holdCatalog = false; held.splice(0).forEach(resolve => resolve());
        await wait(() => document.querySelector('.bpb-sentinel-summary').hidden
            || document.querySelector('.bpb-sentinel-summary').textContent.includes('unavailable'), 'catalog settles after dragging');
        const after = await page.evaluate(snapshot);
        if (output) await page.screenshot({ path: path.join(output, `drag-${index + 1}${fail ? '-failed-catalog' : ''}.png`) });
        assert.deepEqual(after.ids, initial.ids, 'dragging reuses the existing satellite layer and decoded tile cache');
        assert.deepEqual(after.events, initial.events, 'unchanged catalogs and temporary failures do not remove/re-add imagery');
        assert.equal(after.imageAtCenter, true, 'Sentinel covers the center instead of exposing the base map');
        assert.equal(after.native, true); assert.equal(after.route, true);
    }
    assert.equal(await page.evaluate(() => window.fadedFrames), 0, 'unchanged capture dragging does not fade to the native map between frames');
    await page.evaluate(() => { window.probing = false; });
    failedCatalog = false;
    await page.locator('.bpb-sentinel button').click();
    await wait(() => document.querySelector('.bpb-sentinel-summary').hidden, 'catalog retry recovers');
    failedTiles = true;
    await page.locator('.bpb-sentinel select').selectOption({ index: 2 });
    await wait(() => document.querySelector('.bpb-sentinel-summary').textContent.includes('tiles are unavailable'), 'failed imagery exposes retry');
    const failed = await page.evaluate(snapshot), beforeRetry = tileRequests;
    assert.equal(failed.imageAtCenter, false);
    for (const [width, theme] of [[1000, 'light'], [1000, 'dark'], [375, 'light'], [375, 'dark']]) {
        await page.setViewportSize({ width, height: 700 });
        await page.locator('html').evaluate((element, value) => { element.dataset.bpbTheme = value; }, theme);
        await wait(() => !document.querySelector('.bpb-sentinel-summary').hidden
            && document.querySelector('.bpb-sentinel-stats').textContent.includes('Coverage'), 'failed capture metadata settles');
        const geometry = await page.locator('.bpb-sentinel').evaluate(element => {
            const warning = element.querySelector('.bpb-sentinel-summary').getBoundingClientRect();
            const stats = element.querySelector('.bpb-sentinel-stats').getBoundingClientRect();
            return { warningBottom: warning.bottom, statsTop: stats.top };
        });
        assert.ok(geometry.warningBottom <= geometry.statsTop, `warning and coverage overlap: ${JSON.stringify(geometry)}`);
        if (output) await page.locator('.bpb-sentinel').screenshot({ path: path.join(output, `failed-tiles-${width}-${theme}.png`) });
    }
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.locator('html').evaluate(element => { element.dataset.bpbTheme = 'light'; });
    failedTiles = false;
    await page.locator('.bpb-sentinel button').click();
    await wait(() => window.imageryOpacity() >= .99, 'retry actually repaints the failed capture');
    assert.ok(tileRequests > beforeRetry, 'retry sends new tile requests');
    assert.notDeepEqual((await page.evaluate(snapshot)).ids, failed.ids, 'retry remounts the failed imagery resources');
    await waitForCondition(async () => (await page.evaluate(snapshot)).imageAtCenter, { description: 'the explicitly chosen capture loads' });
    assert.notDeepEqual((await page.evaluate(snapshot)).ids, initial.ids, 'a different dated capture replaces imagery');
    await page.setViewportSize({ width: 375, height: 700 });
    await wait(() => window.mapsPlaceholder.getSize().x === 375 && window.imageryOpacity() >= .99, 'narrow Leaflet map paints the selected capture');
    if (output) await page.screenshot({ path: path.join(output, 'narrow.png') });
    catalog = [];
    await page.evaluate(() => window.mapsPlaceholder.panBy([20, 0], { animate: false }));
    await wait(() => document.querySelector('.bpb-sentinel-summary').textContent.includes('does not cover'), 'absent capture has honest coverage feedback');
    assert.equal((await page.evaluate(snapshot)).ids.length, 0, 'confirmed missing imagery clears the previous capture');
    assert.deepEqual(errors, []);
    summary = { browser: 'chromium', version: context.browser().version(), hidden: true, leaflet: '1.9.4', viewports: [[1000, 700], [375, 700]], fadedFrames: 0,
        gestures: 3, tests: ['same-scenes', 'catalog-delay', 'catalog-failure', 'retry', 'tile-retry', 'capture-switch', 'missing-capture', 'native-layers'], profile: temporaryRoot };
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({ ...summary, teardown: 'passed' }));
