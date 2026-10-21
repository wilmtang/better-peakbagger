// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document, Image, requestAnimationFrame, mapsPlaceholder, nativeTiles, nativeRoute */
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
    const holdCatalog = false, failedCatalog = false, failedTiles = false;
    const capture = id => ({ id, collection: 'sentinel-2-l2a',
        properties: { datetime: new Date(Date.now() - (id === 'scene_new' ? 2 : 3) * 86400000).toISOString(),
            platform: 'Sentinel-2B', 'sat:relative_orbit': 13, 'eo:cloud_cover': 4 },
        geometry: { type: 'Polygon', coordinates: [[[-122, 46], [-121, 46], [-121, 47], [-122, 47], [-122, 46]]] } });
    const catalog = [capture('scene_new'), capture('scene_old')];
    await context.route(`${origin}/leaflet.*`, route => route.fulfill({ body: assets[route.request().url().endsWith('.js') ? 0 : 1],
        contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/css' }));
    await context.route(`${origin}/map/MasterMap.aspx*`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
        <link rel="stylesheet" href="/leaflet.css"><style>html,body,#map{height:100%;margin:0}#selmap{position:absolute;top:10px;left:60px;z-index:1000}</style>
        </head><body><div id="map"></div><select id="selmap"><option value="L_FIX">Base map</option></select><script src="/leaflet.js"></script><script>
        window.mapsPlaceholder=L.map('map',{inertia:false}).setView([46.78,-121.74],13);
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
            await route.fulfill({ status: failedTiles ? 503 : 200, contentType: 'image/png', headers: cors,
                body: failedTiles ? '' : tile(route.request().url().includes('scene_old') ? '#315bb0' : '#347d61') });
        }
    });
    await context.route('https://elevation.nationalmap.gov/**', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: tile('#315bb0') }));
    await context.route('https://edits.nationalmap.gov/**', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: tile('#347d61') }));
    await context.route('https://wcc.sc.egov.usda.gov/**', route => {
        const url = new URL(route.request().url());
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(url.pathname.endsWith('/stations') ? snotelStations() : snotelFixture(url.searchParams.get('stationTriplets'), url.searchParams.get('duration'), Date.now())) });
    });
    const wait = (fn, description) => waitForCondition(() => page.evaluate(fn), { description, timeoutMs: 20000 });
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
        await wait(() => document.querySelector('.bpb-layers-trigger') && !document.querySelector('.bpb-map-layers').hidden, 'real extension Layers control');
        const native = pathname.includes('MasterMap') ? page : page.frames().find(frame => frame.url().includes('MasterMap.aspx'));
        assert.equal(await native.locator('.bpb-map-layers').count(), pathname.includes('MasterMap') ? 1 : 0, 'one outer owner');
        assert.equal(await native.locator('#selmap').isVisible(), false, 'native picker replaced');
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false, 'starts collapsed');
        await page.getByRole('button', { name: /^Layers/ }).click();
        await page.getByRole('checkbox', { name: 'Sentinel-2 (experimental)', exact: true }).check();
        await page.getByRole('button', { name: /^Adjust Sentinel/ }).click();
        await page.locator('.bpb-layers-detail:not([hidden])').filter({ hasText: 'Coverage' }).waitFor();
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
        await page.getByRole('checkbox', { name: 'SNOTEL stations', exact: true }).check();
        await page.getByRole('button', { name: /^Adjust SNOTEL/ }).click();
        await page.locator('.bpb-layers-detail:not([hidden])').filter({ hasText: /stations? in view/ }).waitFor();
        assert.ok(await native.locator('.bpb-snotel-marker').count() > 0, 'viewport stations rendered');
        assert.equal(await native.evaluate(() => mapsPlaceholder.hasLayer(nativeTiles) && mapsPlaceholder.hasLayer(nativeRoute)), true, 'native layers preserved');
        const before = searches;
        await slider.count();
        await native.evaluate(() => mapsPlaceholder.panBy([10,0], {animate:false}));
        await waitForCondition(() => searches > before, {description:'one active catalog owner refreshes'});
        if(output){await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,`detail-${cases.length}.png`)});await page.locator('[data-layer="snotel"] button').click();await page.screenshot({path:path.join(output,`overview-${cases.length}.png`)});if(cases.length===1){for(const id of ['slope','land']){await page.locator(`[data-layer="${id}"] button`).click();await page.screenshot({path:path.join(output,`${id}-detail.png`)});await page.locator(`[data-layer="${id}"] button`).click();}}}
        await page.getByRole('button', {name:/^Layers/}).click();
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        if (output) { await mkdir(output,{recursive:true}); await page.screenshot({path:path.join(output,`map-${cases.length}.png`)}); }
        if(pathname.startsWith('/Peak.aspx')){
            await page.getByRole('button',{name:/^Layers/}).click();await page.getByRole('button',{name:/^Adjust Sentinel/}).click();
            const picker=page.locator('[aria-label="Sentinel-2 capture"]');const chosen=await picker.locator('option').nth(1).getAttribute('value');await picker.selectOption(chosen);
            await page.getByRole('button',{name:/^Layers/}).click();
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
    const dem = Buffer.from('UklGRoIAAABXRUJQVlA4THYAAAAv/8F/AD8gFkzyR94dhICgyHPTY/6zQwZFtW1TKqigggoqqKCC/rM/wx3R/wkI/M//A+P38h+YpefnP1DLz8t/4Fauz38gV4/Pf2DXtuc/0OvT+Y//+I/41uc/wDsv/wHdffkP4N6T/4DtvfkP0P6T/4CM/8Ef', 'base64');
    await context.route('https://tiles.mapterhorn.com/**', route => route.fulfill({contentType:'image/webp',headers:{'access-control-allow-origin':'*'},body:dem}));
    await page.goto(`${origin}/map/BigMap.aspx?t=A&d=1&c=900001`);
    await page.getByRole('button',{name:/^Layers/}).click();
    await page.getByRole('checkbox',{name:'Sentinel-2 (experimental)',exact:true}).check();
    await page.getByRole('button',{name:/^Adjust Sentinel/}).click();
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
    await page.getByRole('button',{name:/^Layers/}).click();
    await page.getByRole('button',{name:/^Adjust Sentinel/}).click();
    await wait(() => document.querySelector('.bpb-layers-detail:not([hidden])')?.textContent.includes('Coverage'),'3D catalog metadata');
    const renderer = await terrain.locator('canvas.maplibregl-canvas').evaluate(canvas => {const gl=canvas.getContext('webgl2');const info=gl.getExtension('WEBGL_debug_renderer_info');return info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
    assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
    const coloredPixels = async color => {
        const png = await terrain.locator('canvas.maplibregl-canvas').screenshot();
        return page.evaluate(async ({data,color}) => {const image = new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<pixels.length;i+=4)if(color==='blue'?pixels[i+2]>pixels[i+1]*1.3&&pixels[i+2]>pixels[i]*1.5:pixels[i+1]>pixels[i+2]*1.15&&pixels[i+1]>pixels[i]*1.4)count++;return count;},{data:png.toString('base64'),color});
    };
    const bluePixels=()=>coloredPixels('blue');
    await waitForCondition(bluePixels,{description:'painted pinned capture in hardware 3D',timeoutMs:30000,isReady:count=>count>1000});
    assert.equal(await capturePicker.inputValue(),older,'pinned pass survives engine handoff');
    await capturePicker.selectOption('latest');
    await waitForCondition(()=>coloredPixels('green'),{description:'explicit latest capture painted in 3D',timeoutMs:30000,isReady:count=>count>1000});
    await page.locator('[data-layer="sentinel"] button').click();await page.locator('[data-layer="sentinel"] button').click();
    assert.equal(await capturePicker.inputValue(),'latest','frame acknowledgement preserves its matching capture status');
    await capturePicker.selectOption(older);await waitForCondition(bluePixels,{description:'explicit pinned capture repainted in 3D',timeoutMs:30000,isReady:count=>count>1000});
    await page.getByRole('combobox',{name:'Base map',exact:true}).selectOption('terrain');
    await waitForCondition(bluePixels,{description:'Sentinel remains painted over terrain-only base',timeoutMs:30000,isReady:count=>count>1000});
    assert.equal(await page.getByRole('checkbox',{name:'Sentinel-2 (experimental)',exact:true}).isChecked(),true);
    await toggle.click();
    await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'false');
    assert.equal(await page.locator('[aria-label="Sentinel-2 capture"]').inputValue(),older);
    await toggle.click();
    await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'true');
    await waitForCondition(bluePixels,{description:'parked renderer resumes selected overlay',timeoutMs:30000,isReady:count=>count>1000});
    assert.equal(await terrain.locator('.bpb-terrain-picker,.bpb-sentinel').count(),0,'one outer menu replaces floating controls');
    assert.equal(await page.locator('[aria-label="Base map"]').inputValue(),'terrain','resuming a user-selected base republishes its selector');
    assert.ok(await page.locator('[aria-label="Base map"] option').count()>=2);
    if(output){await page.locator('.bpb-layers-trigger').click();await page.locator('[data-layer="sentinel"] button').click();await wait(()=>document.querySelector('.bpb-layers-detail:not([hidden])')?.textContent.includes('Coverage'),'settled capture detail for visual inspection');await page.screenshot({path:path.join(output,'3d.png')});}
    await toggle.click();await page.waitForFunction(()=>document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed')==='false');
    await page.locator('.bpb-layers-trigger').click();await page.locator('[data-layer="sentinel"] input').uncheck();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));forbidCatalog=true;
    await toggle.click();await page.waitForFunction(()=>document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('[data-layer="sentinel"] input').isChecked(),false,'2D off wins over the parked renderer snapshot');
    await terrain.locator('canvas.maplibregl-canvas').screenshot();
    cases.push('0/50/100 percent mosaic pixels with negative control','one-use Full Screen state and pinned pass','3D capture choices, independent base, suspend/resume','off while parked prevents catalog replay');
    assert.deepEqual(errors, []);
    summary = {browser:'chromium', version:context.browser().version(), hidden:true, leaflet:'1.9.4', cases, viewports:[[1000,700]], renderer, tileRequests, profile:temporaryRoot};
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({...summary, teardown:'passed'}));
