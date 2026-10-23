// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document, window, Image, requestAnimationFrame, mapsPlaceholder, nativeTiles, nativeRoute */
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

import { snotelStations, snotelFixture } from '../test/helpers/snotel-fixture.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.BPB_VERIFY_LAYERS_SCREENSHOT_DIR;
assert.equal(process.argv.length, 2, 'Usage: node scripts/verify-map-layers.mjs');
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
    let searches = 0, tileRequests = 0, forbidCatalog = false;
    const holdCatalog = false, failedCatalog = false;
    let imageryMode = 'ready', missingImageryUrl = null; const heldImagery = [];
    resources.defer('held imagery tiles', () => { imageryMode = 'ready'; heldImagery.splice(0).forEach(resolve => resolve()); });
    const capture = id => ({ id, collection: 'sentinel-2-l2a',
        properties: { datetime: new Date(Date.now() - (id === 'scene_new' ? 2 : 3) * 86400000).toISOString(),
            platform: 'Sentinel-2B', 'sat:relative_orbit': 13, 'eo:cloud_cover': 4 },
        geometry: { type: 'Polygon', coordinates: [[[-122, 46], [-121, 46], [-121, 47], [-122, 47], [-122, 46]]] } });
    const catalog = [capture('scene_new'), capture('scene_old')];
    await context.route(`${origin}/leaflet.*`, route => route.fulfill({ body: assets[route.request().url().endsWith('.js') ? 0 : 1],
        contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/css' }));
    await context.route(`${origin}/map/MasterMap.aspx*`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
        <link rel="stylesheet" href="/leaflet.css"><style>html,body,#map{height:100%;margin:0}#selmap{position:absolute;top:10px;right:10px;z-index:1000}</style>
        </head><body><div id="map"></div><select id="selmap" aria-label="Base map"><option value="L_FIX">Base map</option></select><script src="/leaflet.js"></script><script>
        window.mapsPlaceholder=L.map('map',{inertia:false,zoomControl:false}).setView([46.78,-121.74],13);
        L.control.zoom({position:'bottomright'}).addTo(mapsPlaceholder);
        window.nativeTiles=L.tileLayer('/native/{z}/{x}/{y}.png').addTo(mapsPlaceholder);
        window.nativeRoute=L.polyline([[46.48,-121.51],[46.52,-121.49]],{color:'#e55',weight:5}).addTo(mapsPlaceholder);
        </script></body></html>` }));
    // Solid, decoded PNG tiles distinguish loaded satellite imagery from the
    // grey native fallback without using the live imagery service.
    const tiles = await page.evaluate(() => Object.fromEntries(['#a8b1ba', '#315bb0', '#347d61'].map(color => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 256, 256);
        return [color, canvas.toDataURL().split(',')[1]];
    })));
    const tile = color => Buffer.from(tiles[color], 'base64');
    // One composed service tile contains BLM, USFS and other federal parcels.
    const landTile = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d');
        for (const [color, x, width] of [['#e69f00', 0, 96], ['#0072b2', 96, 96], ['#919191', 192, 64]]) {
            context.fillStyle = color; context.fillRect(x, 0, width, 256);
        }
        return canvas.toDataURL().split(',')[1];
    }), 'base64');
    const countImageColors = (png, colors) => page.evaluate(async ({ data, colors }) => {
        const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        return colors.map(color => {
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4) if (color.every((value, channel) => Math.abs(value - pixels[i + channel]) <= 2)) count++;
            return count;
        });
    }, { data: png.toString('base64'), colors });
    await context.route(`${origin}/native/**`, route => route.fulfill({ contentType: 'image/png', body: tile('#a8b1ba') }));
    await context.route('https://planetarycomputer.microsoft.com/**', async route => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
        if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
        if (route.request().url().includes('/api/stac/')) {
            searches++;if(forbidCatalog)errors.push('A disabled overlay requested a catalog while the parked renderer resumed.');
            if (holdCatalog) await new Promise(resolve => held.push(resolve));
            await route.fulfill({ status: failedCatalog ? 503 : 200, contentType: 'application/json',
                headers: cors, body: JSON.stringify({ features: catalog }) });
        } else {
            tileRequests++;
            const url = route.request().url();
            // Failure belongs to the selected older pass. An outgoing Latest
            // request can still reach the interceptor after the picker changes.
            if (imageryMode === 'partial' && url.includes('item=scene_old')) missingImageryUrl ??= url;
            if (imageryMode === 'hold' && url === missingImageryUrl || imageryMode === 'pan-hold' && url.includes('item=scene_pan'))
                await new Promise(resolve => heldImagery.push(resolve));
            await route.fulfill({ status: imageryMode === 'partial' && url === missingImageryUrl ? 404 : 200, contentType: 'image/png', headers: cors,
                body: tile(url.includes('scene_old') || url.includes('scene_pan_old') ? '#315bb0' : '#347d61') });
        }
    });
    let slopeMode = 'ready', missingSlopeUrl = null; const slopeRequests = new Map(), heldSlope = [];
    resources.defer('held slope tiles', () => { slopeMode = 'ready'; heldSlope.splice(0).forEach(resolve => resolve()); });
    await context.route('https://elevation.nationalmap.gov/**', async route => {
        const url = route.request().url(), count = (slopeRequests.get(url) || 0) + 1; slopeRequests.set(url, count);
        if (slopeMode === 'partial') missingSlopeUrl ??= url;
        if (slopeMode === 'hold' && url === missingSlopeUrl) await new Promise(resolve => heldSlope.push(resolve));
        if (slopeMode === 'partial' && url === missingSlopeUrl || slopeMode === 'recover' && count === 1)
            return route.fulfill({ status: slopeMode === 'partial' ? 404 : 503, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'Unavailable' });
        return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: tile('#315bb0') });
    });
    let landMode = 'ready'; const heldLand = [];
    resources.defer('held public-land tiles', () => { landMode = 'ready'; heldLand.splice(0).forEach(resolve => resolve()); });
    await context.route('https://edits.nationalmap.gov/**', async route => {
        const layers = JSON.parse(new URL(route.request().url()).searchParams.get('dynamicLayers'));
        assert.equal(layers[0].definitionExpression, "Own_Type = 'FED' AND Mang_Name = 'BLM'");
        assert.deepEqual(layers[0].drawingInfo.renderer.symbol.color, [230, 159, 0, 255]);
        assert.equal(layers[1].definitionExpression, "Own_Type = 'FED' AND Mang_Name = 'USFS'");
        assert.deepEqual(layers[1].drawingInfo.renderer.symbol.color, [0, 114, 178, 255]);
        assert.equal(layers[2].drawingInfo.renderer.defaultSymbol.style, 'esriSFSNull');
        if (landMode === 'hold') await new Promise(resolve => heldLand.push(resolve));
        if (landMode === 'error') return route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'Unavailable' });
        return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: landTile });
    });
    let bcRequests = 0, albertaRequests = 0;
    const canadianTile = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d'); context.fillStyle = '#e69f00'; context.fillRect(0, 0, 112, 256);
        context.fillStyle = '#ae8596'; context.fillRect(112, 0, 64, 256);
        return canvas.toDataURL().split(',')[1];
    }), 'base64');
    await context.route('https://maps.gov.bc.ca/**', route => {
        bcRequests++;
        const url = new URL(route.request().url());
        assert.equal(url.pathname, '/arcgis/rest/services/whse/bcgw_pub_whse_cadastre/MapServer/export');
        assert.equal(JSON.parse(url.searchParams.get('dynamicLayers'))[0].drawingInfo.renderer.defaultSymbol.style, 'esriSFSNull');
        return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: canadianTile });
    });
    await context.route('https://geospatial.alberta.ca/**', route => {
        albertaRequests++;
        const params = new URL(route.request().url()).searchParams;
        assert.equal(params.get('outFields'), 'objectid,crownclass');
        assert.equal(params.get('resultOffset'), '0');
        const [left, bottom, right, top] = params.get('geometry').split(',').map(Number);
        const ring = (x1, y1, x2, y2) => [[left + (right-left)*x1, bottom + (top-bottom)*y1], [left + (right-left)*x2, bottom + (top-bottom)*y1], [left + (right-left)*x2, bottom + (top-bottom)*y2], [left + (right-left)*x1, bottom + (top-bottom)*y2], [left + (right-left)*x1, bottom + (top-bottom)*y1]];
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ spatialReference: { wkid: 3857 }, features: [
            { attributes: { objectid: 1, crownclass: 'Provincial' }, geometry: { rings: [ring(0,0,.65,1), ring(.2,.2,.4,.4)] } },
            { attributes: { objectid: 2, crownclass: 'Municipal' }, geometry: { rings: [ring(.65,0,.85,1)] } },
            { attributes: { objectid: 3, crownclass: 'Private' }, geometry: { rings: [ring(.85,0,1,1)] } },
        ] }) });
    });
    let snotelCatalogAttempts = 0;
    await context.route('https://wcc.sc.egov.usda.gov/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/stations') && ++snotelCatalogAttempts === 1)
            return route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'Temporarily unavailable' });
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(url.pathname.endsWith('/stations') ? snotelStations() : snotelFixture(url.searchParams.get('stationTriplets'), url.searchParams.get('duration'), Date.now())) });
    });
    const wait = (fn, description) => waitForCondition(() => page.evaluate(fn), { description, timeoutMs: 20000 });
    const verifyCaptureMetadata = async () => {
        const metadata = await waitForCondition(() => page.getByRole('combobox', { name: 'Sentinel-2 capture' }).evaluate(element => ({
            title: element.title, selected: element.selectedOptions[0]?.title,
            options: Array.from(element.options, option => ({ label: option.textContent, title: option.title, accessible: option.getAttribute('aria-label') })) })),
        { description: 'dated Sentinel capture choices have loaded', timeoutMs: 20000, isReady: value => value.options.length > 1 });
        assert.ok(metadata.options.length > 1, 'the capture dropdown lists dated alternatives');
        for (const option of metadata.options) {
            assert.match(option.label, /☁ (?:\d+%|\?)/, 'every capture has cloud coverage in its list item');
            assert.match(option.title, /Clouds (?:\d+%|unknown)$/);
            assert.equal(option.accessible, option.title);
        }
        assert.equal(metadata.title, metadata.selected, 'the compact picker retains its full date, timezone and cloud tooltip');
    };
    const registry = await context.newPage();
    await registry.goto('chrome://extensions-internals/');
    const extension = await registry.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
    await registry.goto(`chrome-extension://${extension.id}/options/options.html`);
    await registry.evaluate(async () => chrome.storage.sync.set({ bpbSettings: { enable3dMap: true, showSnotel: true, terrainCacheLimitMb: 0, theme: 'light' } }));
    await registry.close();
    await context.route(`${origin}/map/BigMap.aspx?t=OTHER&handoff=1`, route => route.fulfill({contentType:'text/html',body:'<!doctype html><iframe id="if" style="width:100%;height:500px" src="/map/MasterMap.aspx?t=P"></iframe>'}));
    const cases = [];
    for (const pathname of ['/map/MasterMap.aspx?t=P', '/Peak.aspx?pid=2296&layersFixture=1', '/climber/ascent.aspx?aid=1&layersFixture=1', '/map/BigMap.aspx?t=OTHER&layersFixture=1']) {
        if (pathname.includes('layersFixture')) await context.route(`${origin}${pathname}`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:16px;font:14px system-ui}iframe{width:100%;height:360px;border:0}</style><h1>Native map fixture</h1><iframe id="if" src="/map/MasterMap.aspx?t=P"></iframe><h2>Following native content</h2><a id="fullscreen" target="_blank" href="/map/BigMap.aspx?t=OTHER&amp;handoff=1">Full Screen</a>' }));
        await page.goto(origin + pathname);
        await wait(() => document.querySelector('.bpb-layers-trigger') && !document.querySelector('.bpb-map-layers').hidden, 'real extension Overlays control');
        const native = pathname.includes('MasterMap') ? page : page.frames().find(frame => frame.url().includes('MasterMap.aspx'));
        assert.equal(await native.locator('.bpb-map-layers').count(), pathname.includes('MasterMap') ? 1 : 0, 'one outer owner');
        assert.equal(await native.locator('#selmap').isVisible(), true, 'native basemap picker stays visible in its original corner');
        const mapBox = await (pathname.includes('MasterMap') ? page.locator('#map') : page.locator('iframe#if')).boundingBox();
        const overlayBox = await page.locator('.bpb-layers-trigger').boundingBox(), baseBox = await native.locator('#selmap').boundingBox();
        assert.ok(Math.abs(overlayBox.x - mapBox.x - 10) <= 1, 'overlay trigger is 10px from the actual map left edge');
        assert.ok(Math.abs(mapBox.x + mapBox.width - baseBox.x - baseBox.width - 10) <= 1, 'native basemap stays 10px from the map right edge');
        assert.equal(await page.locator('.bpb-layers-panel [aria-label="Base map"]').count(), 0, 'overlay menu contains no basemap selector');
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false, 'starts collapsed');
        await page.getByRole('button', { name: /^Overlays/ }).click();
        await native.locator('#map').click({ position: { x: mapBox.width - 50, y: 80 } });
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true, 'native map clicks preserve the open overlay menu');
        await native.locator('#selmap').click(); await page.keyboard.press('Escape');
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true, 'native basemap and Escape preserve the open overlay menu');
        if (pathname.includes('layersFixture')) {
            await page.getByRole('heading', { name: 'Following native content', exact: true }).click();
            assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true, 'clicking other page content preserves the open overlay menu');
        }
        await page.getByRole('checkbox', { name: 'Sentinel-2 (experimental)', exact: true }).check();
        assert.equal(await page.getByRole('slider', { name: 'Sentinel-2 (experimental) opacity' }).isVisible(), true, 'enabling Sentinel selects its opacity detail');
        await page.locator('.bpb-layers-detail:not([hidden])').filter({ hasText: 'Coverage' }).waitFor();
        await verifyCaptureMetadata();
        await waitForCondition(() => native.evaluate(() => Object.values(mapsPlaceholder._layers).some(layer => layer.options?.bpbOverlay && Object.values(layer._tiles || {}).some(({el}) => el.width && el.getContext?.('2d').getImageData(128,128,1,1).data[3] === 255))), { description: 'decoded opaque Sentinel mosaic tile' });
        const slider = page.getByRole('slider', { name: 'Sentinel-2 (experimental) opacity' });
        await slider.fill('50'); await slider.dispatchEvent('input'); await slider.dispatchEvent('change');
        assert.ok(await native.evaluate(() => Object.values(mapsPlaceholder._layers).some(layer => layer.options?.bpbOverlay && layer.options.opacity === 0.5)));
        const pixel = async () => {
            const png = await (pathname.includes('MasterMap') ? page.locator('#map') : page.locator('iframe#if')).screenshot();
            return page.evaluate(async data => {const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(Math.floor(canvas.width*.7),Math.floor(canvas.height*.7),1,1).data];},png.toString('base64'));
        };
        const expected=[110,151,142];
        await waitForCondition(pixel,{description:'50 percent opacity applied once to overlapping scenes',isReady:rgba=>expected.every((value,i)=>Math.abs(value-rgba[i])<=2)});
        if(cases.length===0){
            const naive=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle='#a8b1ba';ctx.fillRect(0,0,1,1);ctx.globalAlpha=.5;ctx.fillStyle='#347d61';ctx.fillRect(0,0,1,1);ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];});
            assert.throws(()=>assert.ok(expected.every((value,i)=>Math.abs(value-naive[i])<=2)),'the pixel assertion rejects per-scene alpha');
            await slider.fill('0');await slider.dispatchEvent('input');
            await waitForCondition(pixel,{description:'zero opacity exposes the unchanged native map',isReady:rgba=>[168,177,186].every((value,i)=>Math.abs(value-rgba[i])<=2)});
            await slider.fill('100');await slider.dispatchEvent('input');
            await waitForCondition(pixel,{description:'full opacity paints the composed imagery',isReady:rgba=>[52,125,97].every((value,i)=>Math.abs(value-rgba[i])<=2)});
        }
        for (const label of ['Slope angle', 'Public lands']) await page.getByRole('checkbox', { name: label, exact: true }).check();
        await waitForCondition(() => native.evaluate(() => Object.values(mapsPlaceholder._layers).filter(layer => layer.options?.bpbOverlay && layer._tiles).length === 3), { description: 'three independently layered rasters' });
        // A different scene set from the same pass is normal near a footprint
        // boundary. Hold replacement imagery after a same-zoom pan: removing
        // the layer here would visibly expose the native basemap again.
        await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).uncheck();
        await page.getByRole('checkbox', { name: 'Public lands', exact: true }).uncheck();
        const sentinelOpacity = page.getByRole('slider', { name: 'Sentinel-2 (experimental) opacity' });
        await page.getByRole('button', { name: /^Adjust Sentinel-2/ }).click();
        await sentinelOpacity.fill('100'); await sentinelOpacity.dispatchEvent('input');
        const painted = await waitForCondition(async () => countImageColors(await (pathname.includes('MasterMap') ? page.locator('#map') : page.locator('iframe#if')).screenshot(), [[52, 125, 97]]),
            { description: `loaded imagery before panning ${pathname}`, isReady: counts => counts[0] > 10000 });
        if (output && cases.length === 0) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'sentinel-before-pan.png') }); }
        const originalCapture = catalog[0];
        catalog[0] = { ...originalCapture, id: 'scene_pan' }; imageryMode = 'pan-hold';
        await native.evaluate(() => { window.__panBasemap = nativeTiles; mapsPlaceholder.panBy([32, 0], { animate: false }); });
        await waitForCondition(() => heldImagery.length, { description: 'replacement scene tiles are held after the pan', isReady: count => count > 0 });
        const during = await countImageColors(await (pathname.includes('MasterMap') ? page.locator('#map') : page.locator('iframe#if')).screenshot(), [[52, 125, 97]]);
        assert.ok(during[0] >= painted[0] * .8, `panning retains painted imagery while replacements load: ${during[0]} of ${painted[0]} pixels`);
        if (output && cases.length === 0) await page.screenshot({ path: path.join(output, 'sentinel-pan-pending.png') });
        assert.equal(await native.evaluate(() => nativeTiles === window.__panBasemap && mapsPlaceholder.hasLayer(nativeTiles)), true, 'pan preserves the native basemap');
        imageryMode = 'ready'; heldImagery.splice(0).forEach(resolve => resolve());
        await wait(() => document.querySelector('[data-layer="sentinel"] .bpb-layers-value')?.hidden === false, 'replacement scene tiles finish');
        catalog[0] = originalCapture;
        for (const label of ['Slope angle', 'Public lands']) await page.getByRole('checkbox', { name: label, exact: true }).check();
        await waitForCondition(() => native.evaluate(() => Object.values(mapsPlaceholder._layers).filter(layer => layer._tiles)
            .every(layer => !layer._loading && Object.values(layer._tiles).every(({ el, loaded }) => loaded && Number(window.getComputedStyle(el).opacity) >= .99))),
        { description: 'all native rasters finish loading and fading before the pan' });
        await native.evaluate(() => {
            const bounds = document.getElementById('map').getBoundingClientRect(), cx = (bounds.left + bounds.right) / 2, cy = (bounds.top + bounds.bottom) / 2;
            window.__panLayers = Object.values(mapsPlaceholder._layers).filter(layer => layer._tiles).map(layer => ({ layer,
                tile: Object.values(layer._tiles).map(({ el }) => el).sort((a, b) => {
                    const distance = el => { const r = el.getBoundingClientRect(); return Math.hypot((r.left + r.right) / 2 - cx, (r.top + r.bottom) / 2 - cy); };
                    return distance(a) - distance(b);
                })[0] }));
            window.__panFades = [];
            window.__panRoute = nativeRoute.getElement();
            window.__panObserver = new window.MutationObserver(() => {
                for (const { layer, tile } of window.__panLayers) if (tile.isConnected && Number(window.getComputedStyle(tile).opacity) < .99) window.__panFades.push(layer.options.pane);
            });
            for (const { tile } of window.__panLayers) window.__panObserver.observe(tile, { attributes: true, attributeFilter: ['style'] });
            mapsPlaceholder.panBy([-16, 16], { animate: false });
        });
        await wait(() => ['sentinel', 'slope', 'land'].every(id => document.querySelector(`[data-layer="${id}"] .bpb-layers-value`)?.hidden === false),
            'all rasters settle after panning');
        await native.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await native.evaluate(() => window.__panLayers.every(({ layer, tile }) => mapsPlaceholder.hasLayer(layer) && tile.isConnected)), true,
            'basemap, Sentinel, slope and land retain their painted center tiles');
        assert.deepEqual(await native.evaluate(() => { window.__panObserver.disconnect(); return window.__panFades; }), [],
            'already visible native tiles do not fade out when their pixels refresh');
        assert.equal(await native.evaluate(() => mapsPlaceholder.hasLayer(nativeRoute) && nativeRoute.getElement() === window.__panRoute && window.__panRoute.isConnected), true,
            'the native route remains attached through raster refreshes');
        await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).uncheck();
        await page.getByRole('button', { name: /^Adjust Public lands/ }).click();
        assert.deepEqual(await page.locator('.bpb-layers-detail:not([hidden]) .bpb-layers-legend-item').allTextContents(), ['BLM', 'USFS', 'Other federal', 'State', 'Local', 'Tribal']);
        assert.equal(await page.getByRole('link', { name: 'BLM camping rules', exact: true }).isVisible(), true);
        const landOpacity = page.getByRole('slider', { name: 'Public lands opacity' });
        const setLandOpacity = async value => { await landOpacity.fill(String(value)); await landOpacity.dispatchEvent('input'); };
        const palette = [[230, 159, 0], [0, 114, 178], [145, 145, 145]];
        const landPixels = async colors => countImageColors(await (pathname.includes('MasterMap') ? page.locator('#map') : page.locator('iframe#if')).screenshot(), colors);
        await setLandOpacity(100);
        await waitForCondition(() => landPixels(palette), { description: `BLM, USFS and other federal colors on ${pathname}`, isReady: counts => counts.every(count => count > 1000) });
        await setLandOpacity(0);
        await waitForCondition(() => landPixels(palette), { description: 'zero land opacity exposes lower layers', isReady: counts => counts.every(count => count < 1000) });
        const under = await pixel();
        await setLandOpacity(50);
        const blended = palette.map(color => color.map((value, i) => Math.round((value + under[i]) / 2)));
        await waitForCondition(() => landPixels(blended), { description: 'BLM/USFS opacity applies once to the composed export', isReady: counts => counts.every(count => count > 1000) });
        await setLandOpacity(25);
        const defaultBlend = palette.map(color => color.map((value, i) => Math.round(value * 0.25 + under[i] * 0.75)));
        await waitForCondition(() => landPixels(defaultBlend), { description: 'BLM/USFS default opacity preserves distinct tints', isReady: counts => counts.every(count => count > 1000) });
        if (output && cases.length === 0) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'native-land-25.png') }); }
        await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).check();
        await native.evaluate(() => mapsPlaceholder.setZoom(7, { animate: false }));
        await wait(() => document.querySelector('[data-layer="sentinel"] .bpb-layers-row-status')?.textContent === 'Zoom in', 'zoomed-out Sentinel explains its catalog limit');
        if (output && cases.length === 0) await page.screenshot({ path: path.join(output, 'native-zoom.png') });
        for (const id of ['slope', 'land']) {
            await wait(() => ['slope', 'land'].every(id => document.querySelector(`[data-layer="${id}"] .bpb-layers-row-status`)?.textContent === 'Zoom in'), 'zoomed-out native rasters request a closer view');
            assert.equal(await page.locator(`[data-layer="${id}"] .bpb-layers-spinner`).isVisible(), false);
        }
        await native.evaluate(() => {
            mapsPlaceholder.setView([46.851731, -121.760395], 17, { animate: false });
            window.__snotelRevealMoves = 0; mapsPlaceholder.on('moveend', () => window.__snotelRevealMoves++);
        });
        if (cases.length === 0) await page.evaluate(() => {
            window.addEventListener('message', event => {
                const data = event.data;
                if (event.source !== window || event.origin !== window.location.origin) return;
                if (data?.__bpbMapLayers && data.dir === 'toPage' && data.type === 'stations' && !data.error) window.__membershipStations = data.stations;
                if (data?.__bpbPeakSnow && data.dir === 'toCS' && data.type === 'get') window.__membershipRequest = data.requestId;
            });
        });
        await page.getByRole('checkbox', { name: 'SNOTEL stations', exact: true }).check();
        await waitForCondition(() => native.evaluate(() => window.__snotelRevealMoves > 0 && mapsPlaceholder.getZoom() < 17
            && mapsPlaceholder.getBounds().contains([46.78266, -121.74767])), { description: `SNOTEL activation auto-zoom on ${pathname}` });
        assert.equal(await page.locator('[data-layer="snotel"]').getAttribute('data-selected'), 'true', 'SNOTEL activation selects its own details');
        await page.locator('.bpb-layers-detail:not([hidden])').filter({ hasText: /stations? in view/ }).waitFor();
        assert.ok(await native.locator('.bpb-snotel-marker').count() > 0, 'viewport stations rendered');
        await page.evaluate(() => {
            window.__stationPanSettled = false;
            const settled = event => {
                const data = event.data;
                if (event.source === window && event.origin === window.location.origin && data?.__bpbMapLayers && data.dir === 'toPage' && data.type === 'stations') {
                    window.__stationPanSettled = true; window.removeEventListener('message', settled);
                }
            };
            window.addEventListener('message', settled);
        });
        await native.evaluate(() => { window.__panStationMarkers = [...document.querySelectorAll('.bpb-snotel-marker')]; mapsPlaceholder.panBy([2, 0], { animate: false }); });
        await wait(() => window.__stationPanSettled && document.querySelector('[data-layer="snotel"] .bpb-layers-value')?.hidden === false,
            'station membership refresh completes after a same-zoom pan');
        assert.equal(await native.evaluate(() => window.__panStationMarkers.every(marker => marker.isConnected)), true,
            'unchanged SNOTEL markers remain attached while panning');
        if (cases.length === 0) {
            await native.locator('.bpb-snotel-marker').first().click();
            const link = native.getByRole('link', { name: 'View NRCS snow data', exact: true }); await link.focus();
            await link.evaluate(element => { window.__membershipLink = element; });
            await page.evaluate(() => window.postMessage({ __bpbPeakSnow: true, dir: 'toPage', type: 'availability', enabled: true }, window.location.origin));
            await page.waitForFunction(() => Number.isInteger(window.__membershipRequest));
            await page.evaluate(() => window.postMessage({ __bpbPeakSnow: true, dir: 'toPage', type: 'stations', requestId: window.__membershipRequest, stations: window.__membershipStations }, window.location.origin));
            await native.getByRole('button', { name: /^Show conditions at/ }).waitFor();
            assert.equal(await link.evaluate(element => element === window.__membershipLink && document.activeElement === element), true, 'late membership keeps the real Leaflet popup and focused link');
            if (output) await page.screenshot({ path: path.join(output, 'native-popup-membership.png') });
            await native.getByRole('button', { name: /^Show conditions at/ }).focus();
            await page.evaluate(() => window.postMessage({ __bpbPeakSnow: true, dir: 'toPage', type: 'availability', enabled: false }, window.location.origin));
            await native.getByRole('button', { name: /^Show conditions at/ }).waitFor({ state: 'detached' });
            assert.equal(await link.evaluate(element => document.activeElement === element), true, 'revoked action returns focus to its NRCS link');
            await native.locator('.leaflet-popup-close-button').click();
        }
        assert.equal(snotelCatalogAttempts, 2, 'station metadata recovered once, then reused the device-local catalog');
        assert.equal(await native.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles) && mapsPlaceholder.hasLayer(nativeRoute)), true, 'native layers preserved');
        const before = searches;
        await slider.count();
        await native.evaluate(() => mapsPlaceholder.panBy([10,0], {animate:false}));
        await waitForCondition(() => searches > before, {description:'one active catalog owner refreshes'});
        if(output){await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,`detail-${cases.length}.png`)});await page.locator('[data-layer="snotel"] button').click();await page.screenshot({path:path.join(output,`overview-${cases.length}.png`)});if(cases.length===1){for(const id of ['slope','land']){await page.locator(`[data-layer="${id}"] button`).click();await page.screenshot({path:path.join(output,`${id}-detail.png`)});await page.locator(`[data-layer="${id}"] button`).click();}}}
        await page.getByRole('button', {name:/^Overlays/}).click();
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        if (output) { await mkdir(output,{recursive:true}); await page.screenshot({path:path.join(output,`map-${cases.length}.png`)}); }
        if(pathname.startsWith('/Peak.aspx')){
            await page.getByRole('button',{name:/^Overlays/}).click();await page.getByRole('button',{name:/^Adjust Sentinel/}).click();
            const picker=page.locator('[aria-label="Sentinel-2 capture"]');const chosen=await picker.locator('option').nth(1).getAttribute('value');await picker.selectOption(chosen);
            await page.getByRole('button',{name:/^Overlays/}).click();
            const [destination]=await Promise.all([context.waitForEvent('page'),page.locator('#fullscreen').click()]);await destination.waitForLoadState();
            await destination.waitForFunction(()=>document.querySelector('[data-layer="slope"] input')?.checked===true);
            assert.equal(await destination.locator('.bpb-layers-panel').isVisible(),false,'full-screen handoff starts compact');
            assert.equal(await destination.locator('[data-layer="sentinel"] input').isChecked(),true);
            await destination.locator('.bpb-layers-trigger').click();await destination.locator('[data-layer="sentinel"] button').click();
            await destination.waitForFunction(expected=>document.querySelector('[aria-label="Sentinel-2 capture"]')?.value===expected,chosen);
            await destination.reload();await destination.waitForFunction(()=>!!document.querySelector('[data-layer="slope"] input'));
            assert.equal(await destination.locator('[data-layer="slope"] input').isChecked(),false,'consumed handoff is not replayed on reload');await destination.close();
        }
        cases.push(pathname);
    }
    await page.goto(`${origin}/Peak.aspx?pid=2296&layersFixture=1`);
    await page.getByRole('button', { name: /^Overlays/ }).click();
    const regionalMap = page.frames().find(frame => frame.url().includes('MasterMap.aspx'));
    for (const label of ['Slope angle', 'Public lands', 'SNOTEL stations']) await page.getByRole('checkbox', { name: label, exact: true }).check();
    await page.locator('.bpb-layers-detail:not([hidden])').filter({ hasText: /stations? in view/ }).waitFor();
    const regionGeometry = () => page.evaluate(() => ['h1', 'iframe#if', 'h2', '.bpb-layers-trigger', ...['sentinel','slope','land','snotel'].map(id => `[data-layer="${id}"]`)]
        .map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
    const regionalBefore = await regionGeometry();
    await regionalMap.evaluate(() => mapsPlaceholder.setView([45.98, 7.65], 13, { animate: false }));
    await wait(() => ['slope','land','snotel'].every(id => {
        const checkbox = document.querySelector(`[data-layer="${id}"] input`); return checkbox?.disabled && !checkbox.checked;
    }), 'unsupported native overlays turn off and become unavailable');
    assert.deepEqual(await regionGeometry(), regionalBefore, 'regional availability keeps native headings, map, following content and overview anchored');
    assert.equal(await regionalMap.evaluate(() => Object.values(mapsPlaceholder._layers).some(layer => layer.options?.bpbOverlay)), false, 'unsupported native overlays and stations are removed');
    assert.equal(await page.getByRole('checkbox', { name: 'Sentinel-2 (experimental)', exact: true }).isEnabled(), true, 'global imagery remains offered');
    if (output) await page.screenshot({ path: path.join(output, 'regional-alps-native.png') });
    await regionalMap.evaluate(() => mapsPlaceholder.setView([46.78, -121.74], 13, { animate: false }));
    await wait(() => ['slope','land','snotel'].every(id => !document.querySelector(`[data-layer="${id}"] input`)?.disabled), 'returning to coverage restores available controls');
    for (const id of ['slope','land','snotel']) assert.equal(await page.locator(`[data-layer="${id}"] input`).isChecked(), false, 'returning never silently re-enables overlays');
    cases.push('native regional availability cancels overlays and preserves layout without auto-reactivation');
    await page.goto(`${origin}/Peak.aspx?pid=2296&layersFixture=1`);
    await page.getByRole('button', { name: /^Overlays/ }).click();
    const slopeMap = page.frames().find(frame => frame.url().includes('MasterMap.aspx'));
    slopeMode = 'recover'; slopeRequests.clear();
    await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).check();
    await wait(() => document.querySelector('[data-layer="slope"] .bpb-layers-value')?.hidden === false, 'temporary slope failures recover automatically');
    assert.ok([...slopeRequests.values()].some(count => count === 2), 'real transient requests were retried');
    assert.ok([...slopeRequests.values()].every(count => count <= 2), 'slope recovery stays bounded');
    await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).uncheck();
    slopeMode = 'partial'; slopeRequests.clear(); missingSlopeUrl = null;
    await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).check();
    await wait(() => document.querySelector('[data-layer="slope"] .bpb-layers-row-status')?.textContent === 'Partly loaded', 'partial slope shading is explained');
    await slopeMap.evaluate(() => {
        const layer = Object.values(mapsPlaceholder._layers).find(item => item.options?.pane === 'bpb-overlay-slope');
        window.__slopeGoodTiles = Object.values(layer._tiles).map(item => item.el).filter(el => el.getContext('2d').getImageData(128, 128, 1, 1).data[3] === 255);
    });
    assert.ok(await slopeMap.evaluate(() => window.__slopeGoodTiles.length > 0), 'available shading is painted');
    if (output) await page.screenshot({ path: path.join(output, 'slope-partial.png') });
    const slopeRecovery = page.getByRole('button', { name: /^(Retry|Reload)$/ }); await slopeRecovery.focus();
    const slopeRecoveryBox = await slopeRecovery.boundingBox(), beforeSlopeRequests = [...slopeRequests.values()].reduce((sum, count) => sum + count, 0);
    slopeMode = 'hold'; await slopeRecovery.click();
    await waitForCondition(() => heldSlope.length, { description: 'native slope retry waits only for the missing tile', isReady: count => count === 1 });
    assert.equal([...slopeRequests.values()].reduce((sum, count) => sum + count, 0), beforeSlopeRequests + 1);
    assert.deepEqual(await slopeRecovery.boundingBox(), slopeRecoveryBox);
    assert.equal(await slopeMap.evaluate(() => window.__slopeGoodTiles.every(el => el.isConnected && el.getContext('2d').getImageData(128, 128, 1, 1).data[3] === 255)), true, 'retry leaves successful native canvases painted');
    slopeMode = 'ready'; heldSlope.splice(0).forEach(resolve => resolve());
    await wait(() => document.querySelector('[data-layer="slope"] .bpb-layers-value')?.hidden === false, 'native slope recovery clears the partial warning');
    assert.deepEqual(await slopeRecovery.boundingBox(), slopeRecoveryBox);
    cases.push('native slope automatic recovery, partial coverage and retry only missing tiles without clearing good shading');
    await page.goto(`${origin}/Peak.aspx?pid=2296&layersFixture=1`);
    await page.getByRole('button', { name: /^Overlays/ }).click(); landMode = 'error';
    await page.getByRole('checkbox', { name: 'Public lands', exact: true }).check();
    await wait(() => document.querySelector('[data-layer="land"] .bpb-layers-row-status')?.textContent === 'Couldn’t load', 'native public-land failure is explained in its row');
    await wait(() => document.querySelector('.bpb-layers-detail:not([hidden]) .bpb-layers-retry')?.getAttribute('aria-disabled') === 'false', 'native land retries have settled before user recovery');
    const recovery = page.getByRole('button', { name: /^(Retry|Reload)$/ }); await recovery.focus();
    const recoveryBox = await recovery.boundingBox(); landMode = 'hold'; await recovery.click();
    await waitForCondition(() => heldLand.length, { description: 'retry is waiting on actual public-land tile work', isReady: count => count >= 4 });
    assert.equal(await page.locator('[data-layer="land"] .bpb-layers-row-status').textContent(), 'Loading');
    assert.equal(await recovery.getAttribute('aria-disabled'), 'true'); assert.deepEqual(await recovery.boundingBox(), recoveryBox);
    const heldCount = heldLand.length; await recovery.press('Enter'); assert.equal(heldLand.length, heldCount, 'repeated activation does not duplicate tile work');
    if (output) await page.screenshot({ path: path.join(output, 'native-loading.png') });
    landMode = 'ready'; heldLand.splice(0).forEach(resolve => resolve());
    await wait(() => document.querySelector('[data-layer="land"] .bpb-layers-value')?.hidden === false, 'successful native retry clears the failure');
    assert.equal(await recovery.textContent(), 'Reload'); assert.equal(await recovery.evaluate(element => document.activeElement === element), true);
    assert.deepEqual(await recovery.boundingBox(), recoveryBox);
    if (output) await page.screenshot({ path: path.join(output, 'native-recovered.png') });
    cases.push('native readable loading/failure, body wait, guarded retry and focused recovery');
    await page.getByRole('checkbox', { name: 'Sentinel-2 (experimental)', exact: true }).check();
    await verifyCaptureMetadata();
    const nativePicker = page.getByRole('combobox', { name: 'Sentinel-2 capture' });
    const nativePinned = await nativePicker.locator('option').nth(1).getAttribute('value');
    await wait(() => document.querySelector('[data-layer="sentinel"] .bpb-layers-value')?.hidden === false, 'Latest imagery settles before the user selects a different capture');
    imageryMode = 'partial'; missingImageryUrl = null; await nativePicker.selectOption(nativePinned);
    await waitForCondition(() => page.locator('[data-layer="sentinel"] .bpb-layers-row-status').textContent(),
        { description: 'native imagery explains partial coverage', isReady: value => value === 'Partly loaded' });
    const searchesBeforeRecovery = searches, imageryRetry = page.getByRole('button', { name: /^(Retry|Reload)$/ });
    imageryMode = 'hold'; await imageryRetry.click();
    await waitForCondition(() => heldImagery.length, { description: 'native imagery retries its missing tile', isReady: count => count === 1 });
    assert.equal(searches, searchesBeforeRecovery, 'image recovery does not repeat the capture search');
    assert.equal(await nativePicker.inputValue(), nativePinned);
    imageryMode = 'ready'; heldImagery.splice(0).forEach(resolve => resolve());
    await wait(() => document.querySelector('[data-layer="sentinel"] .bpb-layers-value')?.hidden === false, 'native imagery recovery clears its partial warning');
    await verifyCaptureMetadata();
    await page.getByRole('checkbox', { name: 'Sentinel-2 (experimental)', exact: true }).uncheck();
    await page.getByRole('button', { name: /^Adjust Public lands/ }).click();
    cases.push('native imagery recovers the pinned pass without a new catalog or full redraw');
    // Exercise real MAIN -> isolated -> worker tile messages. Native permission
    // prompts are deliberately stubbed so this hidden check cannot steal focus.
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
        globalThis.__bpbBCPermission = { allowed: false, requests: 0 };
        const contains = chrome.permissions.contains.bind(chrome.permissions);
        chrome.permissions.contains = permission => permission.origins?.includes('https://maps.gov.bc.ca/*') ? Promise.resolve(globalThis.__bpbBCPermission.allowed) : contains(permission);
        chrome.permissions.request = () => {
            globalThis.__bpbBCPermission.requests++;
            if (globalThis.__bpbBCPermission.setup) throw new Error('permissions.request requires an extension user action');
            return new Promise(resolve => { globalThis.__bpbBCPermission.finish = allowed => { globalThis.__bpbBCPermission.allowed = allowed; resolve(allowed); }; });
        };
    });
    for (const [index, pathname] of cases.slice(0, 4).entries()) {
        await page.goto(origin + pathname);
        const native = pathname.includes('MasterMap') ? page : page.frames().find(frame => frame.url().includes('/map/MasterMap.aspx'));
        await waitForCondition(() => native.evaluate(() => !!window.mapsPlaceholder), { description: 'Canadian native map ready' });
        await native.evaluate(() => { mapsPlaceholder.setView([54,-124],12,{animate:false}); });
        await page.getByRole('button', { name: /^Overlays/ }).click();
        await page.getByRole('checkbox', { name: 'Public lands', exact: true }).check();
        assert.equal(await page.getByRole('slider', { name: 'Public lands opacity' }).isVisible(), true, 'enabling Canadian public lands selects its matching opacity detail');
        const opacity = page.getByRole('slider', { name: 'Public lands opacity' });
        await opacity.fill('100'); await opacity.dispatchEvent('input');
        await page.getByRole('link', { name: 'BC Crown land rules', exact: true }).waitFor();
        if (index === 0) {
            const allow = page.getByRole('button', { name: 'Allow BC land maps', exact: true });
            await allow.waitFor(); assert.equal(bcRequests, 0, 'no BC provider traffic before consent');
            const geometry = await allow.boundingBox();
            await allow.click();
            await waitForCondition(() => worker.evaluate(() => globalThis.__bpbBCPermission.requests), { description: 'trusted Allow reaches the worker synchronously', isReady: value => value === 1 });
            assert.deepEqual(await allow.boundingBox(), geometry, 'Allow remains anchored while permission is pending');
            assert.equal(await allow.evaluate(element => element === document.activeElement), true, 'permission pending retains action focus');
            await worker.evaluate(() => globalThis.__bpbBCPermission.finish(false));
            await wait(() => document.querySelector('.bpb-layers-detail:not([hidden])')?.textContent.includes('BC access not granted.'), 'permission denial feedback');
            assert.deepEqual(await allow.boundingBox(), geometry, 'denial keeps the action anchored');
            await worker.evaluate(() => { globalThis.__bpbBCPermission.setup = true; });
            const [setup] = await Promise.all([context.waitForEvent('page'), allow.click()]); await setup.waitForLoadState();
            assert.ok(new URL(setup.url()).pathname === '/bc-land/access.html', 'Firefox-style gesture failure opens only the packaged setup');
            await setup.evaluate(() => { chrome.permissions.request = () => new Promise(resolve => { globalThis.__bcSetupFinish = resolve; }); });
            await setup.getByRole('button', { name: 'Allow access', exact: true }).click();
            await setup.waitForFunction(() => typeof globalThis.__bcSetupFinish === 'function');
            await worker.evaluate(() => { globalThis.__bpbBCPermission.allowed = true; });
            await setup.evaluate(() => globalThis.__bcSetupFinish(true));
            await setup.getByRole('button', { name: 'Return to map', exact: true }).waitFor();
            if (output) await setup.screenshot({ path: path.join(output, 'bc-setup.png') });
            await Promise.all([setup.waitForEvent('close'), setup.getByRole('button', { name: 'Return to map', exact: true }).click()]);
        }
        const screenshot = () => (pathname.includes('MasterMap') ? page.locator('#map') : page.locator('iframe#if')).screenshot();
        const counts = () => screenshot().then(png => countImageColors(png, [[230,159,0],[174,133,150]]));
        await waitForCondition(counts, { description: `Crown and municipal BC pixels on ${pathname}`, isReady: values => values.every(value => value > 1000) });
        if (output) await page.screenshot({ path: path.join(output, `canada-bc-${index}.png`) });
        await opacity.fill('0'); await opacity.dispatchEvent('input');
        await waitForCondition(counts, { description: 'zero Canadian land opacity', isReady: values => values.every(value => value < 1000) });
        const beforeBC = bcRequests;
        await native.evaluate(() => { mapsPlaceholder.setView([51.18,-115.57],13,{animate:false}); });
        await page.getByRole('link', { name: 'Alberta camping rules', exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'BC Crown land rules', exact: true }).count(), 0, 'Banff does not request BC access');
        await opacity.fill('100'); await opacity.dispatchEvent('input');
        await waitForCondition(counts, { description: `Alberta classified polygons on ${pathname}`, isReady: values => values.every(value => value > 1000) });
        assert.equal(bcRequests, beforeBC, 'Alberta camera uses no BC provider');
        assert.equal(await native.evaluate(() => Object.values(mapsPlaceholder._layers).filter(layer => layer.options?.bpbOverlay).every(layer => Object.values(layer._tiles || {}).filter(tile => tile.loaded).every(({el}) => {
            const context = el.getContext('2d');
            return context.getImageData(76,179,1,1).data[3] === 0 && context.getImageData(240,128,1,1).data[3] === 0;
        }))), true, 'Alberta polygon holes and private parcels remain clear');
        if (output) await page.screenshot({ path: path.join(output, `canada-ab-${index}.png`) });
        await native.evaluate(() => { mapsPlaceholder.setView([55,-112],13,{animate:false}); });
        await wait(() => {
            const input = document.querySelector('[data-layer="land"] input'); return input?.disabled && !input.checked;
        }, 'unsupported Alberta area disables public lands');
        assert.equal(await native.evaluate(() => Object.values(mapsPlaceholder._layers).some(layer => layer.options?.pane === 'bpb-overlay-land')), false,
            'unsupported Alberta removes the overlay instead of keeping empty tile resources');
    }
    const boundaryMap = page.frames().find(frame => frame.url().includes('MasterMap.aspx'));
    await worker.evaluate(() => { globalThis.__bpbBCPermission.allowed = false; globalThis.__bpbBCPermission.setup = false; delete globalThis.__bpbBCPermission.finish; });
    await boundaryMap.evaluate(() => mapsPlaceholder.setView([49,-122],10,{animate:false}));
    await page.getByRole('checkbox', { name: 'Public lands', exact: true }).check();
    await page.getByRole('slider', { name: 'Public lands opacity' }).fill('100');
    await page.getByRole('slider', { name: 'Public lands opacity' }).dispatchEvent('input');
    await wait(() => document.querySelector('[data-layer="land"] .bpb-layers-row-status')?.textContent === 'Partly loaded', 'BC permission does not hide US land coverage');
    if (output) await page.screenshot({ path: path.join(output, 'land-boundary-partial.png') });
    await waitForCondition(() => page.locator('iframe#if').screenshot().then(png => countImageColors(png, [[230,159,0]])),
        { description: 'US land remains painted at the provider boundary', isReady: values => values[0] > 1000 });
    await page.getByRole('button', { name: 'Allow BC land maps', exact: true }).click();
    await waitForCondition(() => worker.evaluate(() => typeof globalThis.__bpbBCPermission.finish === 'function'), { description: 'explicit boundary access action' });
    await worker.evaluate(() => globalThis.__bpbBCPermission.finish(true));
    await wait(() => document.querySelector('[data-layer="land"] .bpb-layers-value')?.hidden === false, 'boundary provider access recovers missing coverage');
    cases.push('partial land at the US/BC boundary preserves US coverage and explicit BC access');
    const dem = Buffer.from('UklGRoIAAABXRUJQVlA4THYAAAAv/8F/AD8gFkzyR94dhICgyHPTY/6zQwZFtW1TKqigggoqqKCC/rM/wx3R/wkI/M//A+P38h+YpefnP1DLz8t/4Fauz38gV4/Pf2DXtuc/0OvT+Y//+I/41uc/wDsv/wHdffkP4N6T/4DtvfkP0P6T/4CM/8Ef', 'base64');
    await context.route('https://tiles.mapterhorn.com/**', route => route.fulfill({contentType:'image/webp',headers:{'access-control-allow-origin':'*'},body:dem}));
    // Full Screen uses the viewport, rather than an unstyled iframe's 300x150
    // HTML default, so corner and navigation measurements match the live shell.
    await context.route(`${origin}/map/BigMap.aspx?t=A&d=1&c=900001`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style><iframe id="if" src="/map/MasterMap.aspx?t=A&d=2296&c=900001"></iframe>' }));
    await page.goto(`${origin}/map/BigMap.aspx?t=A&d=1&c=900001`);
    await page.getByRole('button',{name:/^Overlays/}).click();
    await page.getByRole('checkbox',{name:'Sentinel-2 (experimental)',exact:true}).check();
    assert.equal(await page.getByRole('slider',{name:'Sentinel-2 (experimental) opacity'}).isVisible(),true);
    const capturePicker = page.getByRole('combobox',{name:'Sentinel-2 capture'});
    await wait(() => document.querySelector('[aria-label="Sentinel-2 capture"]')?.options.length > 1,'native capture choices');
    const older = await capturePicker.locator('option').nth(1).getAttribute('value');
    await capturePicker.selectOption(older);
    await page.getByRole('slider',{name:'Sentinel-2 (experimental) opacity'}).fill('100');
    await page.getByRole('slider',{name:'Sentinel-2 (experimental) opacity'}).dispatchEvent('input');
    const toggle = page.locator('#bpb-terrain-toggle');
    await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.disabled === false);
    await toggle.click();
    const terrain = page.frameLocator('#bpb-terrain-frame');
    await terrain.locator('canvas.maplibregl-canvas').waitFor();
    await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('.bpb-layers-panel').isVisible(),true,'switching to 3D preserves the expanded menu');
    await wait(() => document.querySelector('.bpb-layers-detail:not([hidden])')?.textContent.includes('Coverage'),'preserved Sentinel detail in 3D');
    await verifyCaptureMetadata();
    const renderer = await terrain.locator('canvas.maplibregl-canvas').evaluate(canvas => {const gl=canvas.getContext('webgl2');const info=gl.getExtension('WEBGL_debug_renderer_info');return info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
    assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
    const coloredPixels = async color => {
        const png = await terrain.locator('canvas.maplibregl-canvas').screenshot();
        return page.evaluate(async ({data,color}) => {const image = new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<pixels.length;i+=4)if(color==='blue'?pixels[i+2]>pixels[i+1]*1.3&&pixels[i+2]>pixels[i]*1.5:color==='usfs'?pixels[i+2]>pixels[i]*1.3&&pixels[i+2]>pixels[i+1]*.9:color==='gold'?pixels[i]>pixels[i+1]*1.1&&pixels[i+1]>pixels[i+2]*1.7:pixels[i+1]>pixels[i+2]*1.15&&pixels[i+1]>pixels[i]*1.4)count++;return count;},{data:png.toString('base64'),color});
    };
    const bluePixels=()=>coloredPixels('blue');
    await waitForCondition(bluePixels,{description:'painted pinned capture in hardware 3D',timeoutMs:30000,isReady:count=>count>1000});
    assert.equal(await capturePicker.inputValue(),older,'pinned pass survives engine handoff');
    const beforeTerrainPan = await bluePixels(), originalOldCapture = catalog[1];
    catalog[1] = { ...originalOldCapture, id: 'scene_pan_old' }; imageryMode = 'pan-hold';
    const drag = await terrain.locator('canvas.maplibregl-canvas').boundingBox();
    assert.equal(await terrain.locator('canvas.maplibregl-canvas').evaluate(canvas => {
        const r = canvas.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width * .75, r.top + r.height * .72) === canvas;
    }), true, 'terrain pan begins on exposed canvas');
    await page.mouse.move(drag.x + drag.width * .75, drag.y + drag.height * .72);
    await page.mouse.down(); await page.mouse.move(drag.x + drag.width * .75 - 24, drag.y + drag.height * .72, { steps: 6 }); await page.mouse.up();
    await waitForCondition(() => heldImagery.length, { description: 'terrain replacement imagery held after dragging', timeoutMs: 30000, isReady: count => count > 0 });
    const duringTerrainPan = await bluePixels();
    assert.ok(duringTerrainPan >= beforeTerrainPan * .75, `hardware terrain retains imagery while a new mosaic loads: ${duringTerrainPan} of ${beforeTerrainPan} pixels`);
    if (output) await page.screenshot({ path: path.join(output, 'sentinel-terrain-pan-pending.png') });
    imageryMode = 'ready'; heldImagery.splice(0).forEach(resolve => resolve()); catalog[1] = originalOldCapture;
    await wait(() => document.querySelector('[data-layer="sentinel"] .bpb-layers-value')?.hidden === false, 'terrain replacement imagery finishes');
    cases.push('native basemap/all raster center tiles and fades remain stable through same-zoom pans on four surfaces; hardware Sentinel retains textures during scene refresh');
    await page.getByRole('checkbox', { name: 'Sentinel-2 (experimental)', exact: true }).uncheck();
    imageryMode = 'partial'; missingImageryUrl = null;
    await page.getByRole('checkbox', { name: 'Sentinel-2 (experimental)', exact: true }).check();
    await wait(() => document.querySelector('[data-layer="sentinel"] .bpb-layers-row-status')?.textContent === 'Partly loaded', 'terrain imagery explains partial coverage');
    const availableImagery = await waitForCondition(bluePixels, { description: 'available pinned imagery is visible', isReady: count => count > 1000 });
    const terrainImagerySearches = searches; imageryMode = 'hold';
    await page.getByRole('button', { name: /^(Retry|Reload)$/ }).click();
    await waitForCondition(() => heldImagery.length, { description: 'terrain imagery retries its missing tile', isReady: count => count === 1 });
    assert.ok(await bluePixels() >= availableImagery * .9, 'terrain imagery recovery preserves painted tiles');
    assert.equal(searches, terrainImagerySearches); assert.equal(await capturePicker.inputValue(), older);
    imageryMode = 'ready'; heldImagery.splice(0).forEach(resolve => resolve());
    await wait(() => document.querySelector('[data-layer="sentinel"] .bpb-layers-value')?.hidden === false, 'terrain imagery clears recovered failure');
    cases.push('hardware imagery recovers the same capture while retaining good textures');
    await capturePicker.selectOption('latest');
    await waitForCondition(()=>coloredPixels('green'),{description:'explicit latest capture painted in 3D',timeoutMs:30000,isReady:count=>count>1000});
    await page.locator('[data-layer="sentinel"] button').click();await page.locator('[data-layer="sentinel"] button').click();
    assert.equal(await capturePicker.inputValue(),'latest','frame acknowledgement preserves its matching capture status');
    await capturePicker.selectOption(older);await waitForCondition(bluePixels,{description:'explicit pinned capture repainted in 3D',timeoutMs:30000,isReady:count=>count>1000});
    await terrain.getByRole('combobox',{name:'Base map',exact:true}).selectOption('terrain');
    await waitForCondition(bluePixels,{description:'Sentinel remains painted over terrain-only base',timeoutMs:30000,isReady:count=>count>1000});
    assert.equal(await page.getByRole('checkbox',{name:'Sentinel-2 (experimental)',exact:true}).isChecked(),true);
    await terrain.getByRole('combobox',{name:'Base map',exact:true}).click(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.bpb-layers-panel').isVisible(),true,'3D basemap interaction preserves the expanded menu');
    const canvas = terrain.locator('canvas.maplibregl-canvas');
    const canvasBox = await canvas.boundingBox();
    await canvas.click({position:{x:canvasBox.width*.7,y:canvasBox.height*.7}});
    assert.equal(await page.locator('.bpb-layers-panel').isVisible(),true,'3D map click preserves the expanded menu');
    await canvas.press('Escape');
    await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'false');
    assert.equal(await page.locator('.bpb-layers-panel').isVisible(),true,'Escape leaves 3D without collapsing Overlays');
    assert.equal(await page.locator('[aria-label="Sentinel-2 capture"]').inputValue(),older);
    await toggle.click();
    await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'true');
    await waitForCondition(bluePixels,{description:'parked renderer resumes selected overlay',timeoutMs:30000,isReady:count=>count>1000});
    assert.equal(await terrain.locator('.bpb-sentinel').count(),0,'overlay settings remain in the outer menu');
    assert.equal(await terrain.getByRole('combobox',{name:'Base map',exact:true}).inputValue(),'terrain','resuming preserves the independent basemap selector');
    assert.ok(await terrain.locator('[aria-label="Base map"] option').count()>=2);
    if(output){await wait(()=>document.querySelector('.bpb-layers-detail:not([hidden])')?.textContent.includes('Coverage'),'settled capture detail for visual inspection');await page.screenshot({path:path.join(output,'3d.png')});}
    await toggle.click();await page.waitForFunction(()=>document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed')==='false');
    await page.locator('[data-layer="sentinel"] input').uncheck();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));forbidCatalog=true;
    await toggle.click();await page.waitForFunction(()=>document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('[data-layer="sentinel"] input').isChecked(),false,'2D off wins over the parked renderer snapshot');
    await terrain.locator('canvas.maplibregl-canvas').screenshot();
    await page.getByRole('checkbox', { name: 'Public lands', exact: true }).check();
    assert.equal(await page.getByRole('slider', { name: 'Public lands opacity' }).isVisible(), true, 'terrain layer activation selects its own opacity detail');
    assert.equal(await page.getByRole('link', { name: 'BLM camping rules', exact: true }).isVisible(), true);
    const landOpacity = page.getByRole('slider', { name: 'Public lands opacity' });
    await landOpacity.fill('100'); await landOpacity.dispatchEvent('input');
    const gold = await waitForCondition(() => coloredPixels('gold'), { description: 'gold BLM pixels over hardware terrain', timeoutMs: 30000, isReady: count => count > 1000 });
    if (output) await page.screenshot({ path: path.join(output, '3d-land.png') });
    // Terrain lighting shifts blue toward cyan. Require its cool tint here,
    // then prove the colored surface disappears when opacity reaches zero.
    const blue = await waitForCondition(() => coloredPixels('usfs'), { description: 'blue USFS pixels over hardware terrain', timeoutMs: 30000, isReady: count => count > 1000 });
    landMode = 'error'; await page.getByRole('checkbox', { name: 'Public lands', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Public lands', exact: true }).check();
    await wait(() => document.querySelector('[data-layer="land"] .bpb-layers-row-status')?.textContent === 'Couldn’t load', 'terrain public-land failure is explained');
    await wait(() => document.querySelector('.bpb-layers-detail:not([hidden]) .bpb-layers-retry')?.getAttribute('aria-disabled') === 'false', 'terrain land retries have settled before user recovery');
    const terrainRetry = page.getByRole('button', { name: /^(Retry|Reload)$/ }); landMode = 'hold'; await terrainRetry.click();
    await waitForCondition(() => heldLand.length, { description: 'terrain retry waits on actual tile work', isReady: count => count >= 4 });
    assert.equal(await page.locator('[data-layer="land"] .bpb-layers-row-status').textContent(), 'Loading');
    assert.equal(await terrainRetry.getAttribute('aria-disabled'), 'true');
    landMode = 'ready'; heldLand.splice(0).forEach(resolve => resolve());
    await wait(() => document.querySelector('[data-layer="land"] .bpb-layers-value')?.hidden === false, 'terrain retry clears stale failure and loading');
    await waitForCondition(() => coloredPixels('gold'), { description: 'terrain repaints after its recovery', timeoutMs: 30000, isReady: count => count > 1000 });
    cases.push('terrain readable failure and real retry loading/success');
    await landOpacity.fill('0'); await landOpacity.dispatchEvent('input');
    await waitForCondition(() => coloredPixels('gold'), { description: 'zero opacity exposes the terrain below BLM', timeoutMs: 30000, isReady: count => count < gold / 5 });
    await waitForCondition(() => coloredPixels('usfs'), { description: 'zero opacity exposes the terrain below USFS', timeoutMs: 30000, isReady: count => count < blue / 5 });
    await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).uncheck();
    slopeMode = 'partial'; missingSlopeUrl = null; slopeRequests.clear();
    await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).check();
    await wait(() => document.querySelector('[data-layer="slope"] .bpb-layers-row-status')?.textContent === 'Partly loaded', 'hardware terrain reports partial slope shading');
    const paintedSlope = await waitForCondition(bluePixels, { description: 'successful slope tiles painted over hardware terrain', timeoutMs: 30000, isReady: count => count > 1000 });
    const terrainSlopeRetry = page.getByRole('button', { name: /^(Retry|Reload)$/ }); slopeMode = 'hold'; await terrainSlopeRetry.click();
    await waitForCondition(() => heldSlope.length, { description: 'terrain slope retry holds its missing tile', isReady: count => count === 1 });
    assert.ok(await bluePixels() >= paintedSlope * .9, 'reloading the existing terrain source keeps successful slope shading visible');
    if (output) await page.screenshot({ path: path.join(output, 'terrain-slope-loading.png') });
    slopeMode = 'ready'; heldSlope.splice(0).forEach(resolve => resolve());
    await wait(() => document.querySelector('[data-layer="slope"] .bpb-layers-value')?.hidden === false, 'terrain slope recovery clears the partial warning');
    cases.push('hardware terrain keeps available slope shading through partial-tile recovery');
    await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).uncheck();
    await page.getByRole('button', { name: /^Adjust Public lands/ }).click();
    await toggle.click(); await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'false');
    const canadianNative = page.frames().find(frame => frame.url().includes('/map/MasterMap.aspx'));
    await canadianNative.evaluate(() => { mapsPlaceholder.setView([54,-124],12,{animate:false}); });
    await landOpacity.fill('100'); await landOpacity.dispatchEvent('input');
    await page.getByRole('link', { name: 'BC Crown land rules', exact: true }).waitFor();
    const before3DBC = bcRequests;
    await toggle.click(); await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true');
    await waitForCondition(() => coloredPixels('gold'), { description: 'BC Crown parcels through the packaged terrain sender', timeoutMs: 30000, isReady: count => count > 1000 });
    assert.ok(bcRequests > before3DBC, 'embedded terrain frame received BC tiles from the worker');
    if (output) await page.screenshot({ path: path.join(output, 'canada-bc-3d.png') });
    await landOpacity.fill('0'); await landOpacity.dispatchEvent('input');
    await waitForCondition(() => coloredPixels('gold'), { description: 'zero Crown opacity in hardware terrain', timeoutMs: 30000, isReady: count => count < 1000 });
    await toggle.click(); await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'false');
    await canadianNative.evaluate(() => { mapsPlaceholder.setView([51.18,-115.57],13,{animate:false}); });
    await page.getByRole('link', { name: 'Alberta camping rules', exact: true }).waitFor();
    const before3DAB = albertaRequests;
    await landOpacity.fill('100'); await landOpacity.dispatchEvent('input');
    await toggle.click(); await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true');
    await waitForCondition(() => coloredPixels('gold'), { description: 'Alberta polygons over hardware terrain', timeoutMs: 30000, isReady: count => count > 1000 });
    assert.ok(albertaRequests > before3DAB, 'terrain queried Alberta class-only geometry');
    if (output) await page.screenshot({ path: path.join(output, 'canada-ab-3d.png') });
    await page.getByRole('checkbox', { name: 'Slope angle', exact: true }).check();
    // Each activation must finish its camera change before the next one. With
    // reduced motion the native navigation buttons complete synchronously.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (let step = 0; step < 8; step++) await terrain.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await wait(() => ['slope', 'land'].every(id => document.querySelector(`[data-layer="${id}"] .bpb-layers-row-status`)?.textContent === 'Zoom in'), 'zoomed-out hardware rasters request a closer view');
    if (output) await page.screenshot({ path: path.join(output, 'terrain-zoom.png') });
    cases.push('native and hardware 3D zoom limits show Zoom in instead of stale loading');
    await toggle.click(); await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'false');
    await canadianNative.evaluate(() => mapsPlaceholder.setView([45.98, 7.65], 13, { animate: false }));
    await wait(() => ['slope','land','snotel'].every(id => document.querySelector(`[data-layer="${id}"] input`)?.disabled), 'unsupported-region state before terrain handoff');
    await toggle.click(); await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true');
    await wait(() => ['slope','land','snotel'].every(id => {
        const input = document.querySelector(`[data-layer="${id}"] input`); return input?.disabled && !input.checked;
    }), 'hardware terrain preserves regional availability');
    if (output) await page.screenshot({ path: path.join(output, 'regional-alps-terrain.png') });
    cases.push('unsupported regional state survives native-to-hardware-terrain handoff');
    cases.push('BC Allow pending/denial/retry without layout shift (native prompt stubbed)', 'BC/Alberta native ownership and opacity on all four surfaces', 'Alberta holes/private/unsupported coverage stay clear', 'BC embedded worker sender and Alberta polygons in hardware 3D');
    cases.push('0/50/100 percent mosaic and BLM/USFS pixels with negative control','one-use Full Screen state and pinned pass','3D capture choices, independent base, suspend/resume','off while parked prevents catalog replay', 'BLM/USFS legend, guidance and native/terrain alpha');
    assert.deepEqual(errors, []);
    summary = {browser:'chromium', version:context.browser().version(), hidden:true, leaflet:'1.9.4', cases, viewports:[[1000,700]], renderer, tileRequests, profile:temporaryRoot};
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({...summary, teardown:'passed'}));
