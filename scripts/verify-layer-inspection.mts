/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { snowMapDocument, snowMapDem } from './verify-snow-map-fixture.mjs';
import { createResourceStack } from './resource-stack.mjs';

declare global {
    interface Window { inspectionFixture: {open(): void; finishElevation(): void; toggle(): void; dispose(): void}; }
}
const [kind, ...args] = process.argv.slice(2);
assert.ok(['chrome', 'firefox'].includes(kind) && !args.length, 'Usage: node scripts/verify-layer-inspection.mts chrome|firefox');
const resources = createResourceStack(), output = process.env.BPB_INSPECTION_SCREENSHOT_DIR;
let failure: unknown;
try {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-layer-inspection-'));
    console.log(`Layer inspection disposable root: ${temporaryRoot}`);
    resources.defer('inspection temporary files', () => rm(temporaryRoot, {recursive: true, force: true}));
    // Preserve the required helper option despite its incomplete JS-inferred signature.
    const fixtureOptions = {temporaryRoot, inlineBuddies: false, masterMapDocument: await snowMapDocument()};
    const fixture = await createBrowserFixtureServer(fixtureOptions);
    resources.defer('inspection HTTPS fixture', () => fixture.close());
    if (kind === 'chrome') assertChromeLaunchAllowed();
    const context = await (kind === 'chrome' ? chromium : firefox).launchPersistentContext(path.join(temporaryRoot, 'profile'), kind === 'chrome' ? {
        channel: 'chromium', headless: true, args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    } : {headless: true, ignoreHTTPSErrors: true, firefoxUserPrefs: {'network.dns.localDomains': 'www.peakbagger.com'}});
    resources.defer('inspection browser', () => context.close());
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const legend = JSON.parse(await readFile('test/fixtures/maps/snow-depth-legend.json', 'utf8'));
    const bundle = await build({stdin: {resolveDir: process.cwd(), contents: `
        import {createMapLocationMenu} from './src/maps/map-location-menu.ts';
        import {createMapLayerControl} from './src/maps/map-layer-control.ts';
        import {settingsSchema as Schema} from './src/settings/settings-schema.js';
        import {readSnowDepthLegend,SNOW_DEPTH_LEGEND} from './src/maps/snow-depth.js';
        const state=Schema.mapOverlayState({snow:{enabled:true},land:{enabled:true},slope:{enabled:true}});
        const model={state,landTypes:Schema.mapLandTypes(),theme:document.documentElement.dataset.bpbTheme,statuses:{snow:{legend:SNOW_DEPTH_LEGEND,analysisTime:Date.UTC(2026,10,1),legendEntries:readSnowDepthLegend(${JSON.stringify(legend)})}},zoom:12};
        const target=document.getElementById('map'),control=createMapLayerControl({document});document.body.append(control.element);
        const paint=()=>{control.render(model);control.position(target.getBoundingClientRect())};paint();
        let finish=()=>{};
        const menu=createMapLocationMenu({window,client:{lookup:()=>new Promise(resolve=>{finish=()=>resolve(1610)}),clear(){}}});
        const open=()=>{const r=target.getBoundingClientRect();menu.show({latitude:46.85,longitude:-121.76,x:r.left+r.width-16,y:r.top+r.height-16},target)};
        target.addEventListener('contextmenu',event=>{event.preventDefault();open()});
        target.addEventListener('keydown',event=>{if(event.key==='F10'&&event.shiftKey){event.preventDefault();open()}});
        window.inspectionFixture={open,finishElevation:()=>finish(),toggle:()=>{state.snow.enabled=!state.snow.enabled;paint()},dispose:()=>{menu.dispose();control.dispose()}};
    `}, bundle: true, write: false, format: 'iife'});
    const css = await readFile(process.env.BPB_INSPECTION_CSS || 'src/maps/map-layers.css', 'utf8');
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    await page.route(`${origin}/inspection.aspx`, route => route.fulfill({contentType: 'text/html', body: `<!doctype html>
        <meta name="viewport" content="width=device-width"><style>
        body{margin:12px;font:14px Arial}h1,h2{margin:8px 0}#map{height:460px;background:linear-gradient(125deg,#cdd8ba,#b9d5e0);position:relative}
        html[data-bpb-theme=dark]{background:#202522;color:#eee}button{font:inherit}
        </style><h1>Dynamic Map</h1><div id="map" tabindex="0" aria-label="Map"></div><h2>Following native content</h2>
        <section id="bpb-peak-weather" data-bpb-map-weather="ready" hidden></section>`}));
    let release: () => void = () => {}, pending = Promise.resolve(), mode = 'ready', requests = 0;
    const hold = () => { pending = new Promise<void>(resolve => { release = resolve; }); };
    resources.defer('inspection pending requests', () => release());
    await page.route(/https:\/\/(mapservices\.weather\.noaa\.gov|edits\.nationalmap\.gov|elevation\.nationalmap\.gov)\//, async route => {
        requests++; await pending;
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/legend')) {await route.fulfill({contentType:'application/json', body: JSON.stringify(legend)}); return;}
        if (url.searchParams.get('outFields') === 'idp_validtime') {await route.fulfill({contentType:'application/json', body: JSON.stringify({features:[{attributes:{idp_validtime:Date.UTC(2026,10,1)}}]})}); return;}
        if (/export(?:Image)?$/.test(url.pathname)) {await route.fulfill({contentType:'image/png', body:Buffer.from(legend.layers.find((layer: {layerId: number}) => layer.layerId === 3).legend[1].imageData,'base64')}); return;}
        if (mode === 'error') { await route.fulfill({status: 503, body: ''}); return; }
        const host = new URL(route.request().url()).hostname;
        const data = host.startsWith('mapservices') ? {results: [{layerId: 3, attributes: {'Classify.Class value': '4'}}]}
            : host.startsWith('edits') ? {features: [{attributes: {Own_Type: 'FED', Mang_Name: 'USFS', Unit_Nm: 'National forest'}}]} : {value: '32.4'};
        await route.fulfill({contentType: 'application/json', body: JSON.stringify(data)});
    });
    const geometry = () => page.evaluate(() => {
        const rect = (element: Element) => {const r = element.getBoundingClientRect(); return [r.x,r.y,r.width,r.height];};
        const menu = document.getElementById('bpb-peak-weather-menu')!;
        return {menu: rect(menu), rows: [...menu.querySelectorAll('.bpb-map-location-layer')].map(rect),
            action: rect(menu.querySelector('button')!), surroundings: [...document.querySelectorAll('h1,#map,h2')].map(rect), scroll: [scrollX,scrollY]};
    });
    let cases = 0;
    for (const width of [1280, 375]) for (const theme of ['light', 'dark']) for (const scale of [1, 2]) {
        await page.setViewportSize({width, height: 900});
        await page.goto(`${origin}/inspection.aspx`); await page.addStyleTag({content: css});
        await page.evaluate(config => {document.documentElement.dataset.bpbTheme = config.theme;}, {theme});
        await page.addScriptTag({content: bundle.outputFiles[0].text});
        await page.addStyleTag({content: `#bpb-peak-weather-menu,.bpb-map-layers{font-size:${13 * scale}px}
            #bpb-peak-weather-menu :is(.bpb-map-location-label,.bpb-map-location-alternative,.bpb-weather-menu-coordinates,.bpb-map-location-weather,.bpb-map-location-layer){font-size:${12 * scale}px}
            #bpb-peak-weather-menu .bpb-map-location-value{font-size:${18 * scale}px}
            #bpb-peak-weather-menu .bpb-map-location-source{font-size:${11 * scale}px}`});
        mode = 'ready'; hold();
        await page.locator('#bpb-peak-weather').evaluate(element => {(element as HTMLElement).hidden = false;});
        await page.locator('#map').click({button: 'right', position: {x: 150,y: 150}});
        await page.waitForFunction(() => document.querySelectorAll('.bpb-map-location-layer').length === 3);
        const before = await geometry();
        const readable = await page.locator('#bpb-peak-weather-menu').evaluate(element => {
            const alternative = element.querySelector('.bpb-map-location-alternative')!.getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            return {alternativeWidth: alternative.width, height: rect.height, contentHeight: element.scrollHeight, viewport: innerHeight};
        });
        assert.ok(readable.alternativeWidth >= 60, 'secondary elevation must not wrap one digit per line');
        assert.ok(readable.height < readable.viewport - 32, 'popup must stay compact enough to reveal the forecast action');
        await page.evaluate(() => window.inspectionFixture.finishElevation()); release();
        await page.waitForFunction(() => document.querySelector('[data-layer="snow"] dd')?.textContent === '9.8–20 in');
        await page.waitForFunction(() => document.querySelector('[data-layer="land"] dd')?.textContent === 'USFS');
        assert.deepEqual(await geometry(), before, 'provider responses must not move popup, action, following content or scroll');
        await page.locator('#bpb-peak-weather-menu').evaluate(element => {element.style.top = `${parseFloat(element.style.top) + 5}px`;});
        assert.notDeepEqual(await geometry(), before, 'geometry assertion must detect a popup shift');
        await page.locator('#bpb-peak-weather-menu').evaluate(element => {element.style.top = `${parseFloat(element.style.top) - 5}px`;});
        assert.equal(await page.locator('#bpb-peak-weather-menu').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'no horizontal clipping');
        if (output) {await mkdir(output, {recursive: true}); await page.screenshot({path: path.join(output, `${kind}-${width}-${theme}-${scale}.png`)});}
        // Keyboard dismissal and retry/error preserve the same reserved rows.
        await page.keyboard.press('Escape'); await page.locator('#map').focus();
        mode = 'error'; hold(); await page.keyboard.press('Shift+F10');
        const errorBefore = await geometry(); release();
        await page.waitForFunction(() => [...document.querySelectorAll('.bpb-map-location-layer dd')].every(element => element.textContent === 'Unavailable'));
        assert.deepEqual(await geometry(), errorBefore, 'error responses must preserve geometry');
        await page.keyboard.press('Escape'); mode = 'ready'; await page.keyboard.press('Shift+F10');
        await page.waitForFunction(() => document.querySelector('[data-layer="land"] dd')?.textContent === 'USFS');
        await page.evaluate(() => window.inspectionFixture.toggle());
        assert.equal(await page.locator('#bpb-peak-weather-menu').evaluate(element => (element as HTMLElement).hidden), true, 'changing layers cancels the open point');
        await page.evaluate(() => window.inspectionFixture.toggle());
        // Readable full-width legend samples independently of the menu readings.
        await page.locator('.bpb-layers-trigger').click(); await page.locator('[data-layer="snow"] .bpb-layers-disclosure').click();
        const samples = await page.locator('[data-overlay="snow"] .bpb-layers-legend-item i').evaluateAll(elements => elements.map(element => {
            const r = element.getBoundingClientRect(), item = element.parentElement!.getBoundingClientRect();
            return {width: r.width, height: r.height, item: item.width};
        }));
        assert.equal(samples.length, 12); assert.ok(samples.every(sample => sample.width > 50 && sample.height >= 18 && Math.abs(sample.width - sample.item) <= 1));
        if (output) await page.screenshot({path: path.join(output, `${kind}-${width}-${theme}-${scale}-legend.png`)});
        await page.evaluate(() => window.inspectionFixture.dispose()); cases++;
    }
    assert.ok(requests >= cases * 9);
    // Exercise the actual coordinator bundle and trusted Leaflet binding too,
    // so passing isolated components cannot hide a broken state registration.
    await page.setViewportSize({width: 1280, height: 900});
    await page.route('https://tiles.mapterhorn.com/**', route => route.fulfill({contentType:'image/webp', body:snowMapDem}));
    await page.goto(`${origin}/map/MasterMap.aspx?t=A&d=2296`);
    await page.addStyleTag({content: css});
    await page.addScriptTag({content: `window.addEventListener('message',event=>{
        const data=event.data;if(event.source!==window||data?.__bpbMapLayers!==true||data.dir!=='toCS'||data.type!=='preferences')return;
        window.postMessage({__bpbMapLayers:true,dir:'toPage',type:'preferences',settings:{},snotelAllowed:false},location.origin);
    });`});
    await page.addScriptTag({content: await readFile('dist/content/map-layers.js','utf8')});
    await page.locator('.bpb-layers-trigger').waitFor();
    await page.locator('.bpb-layers-trigger').click();
    for (const id of ['snow','slope','land']) await page.locator(`[data-layer="${id}"] input`).check();
    await page.waitForFunction(() => document.querySelector('.bpb-snow-depth-time')?.textContent?.includes('2026'));
    await page.locator('.bpb-layers-trigger').click();
    await page.locator('#map').click({button:'right', position:{x:600,y:350}});
    await page.waitForFunction(() => document.querySelector('#bpb-peak-weather-menu [data-layer="snow"] dd')?.textContent === '9.8–20 in');
    await page.waitForFunction(() => document.querySelector('#bpb-peak-weather-menu [data-layer="land"] dd')?.textContent === 'USFS');
    assert.equal(await page.locator('#bpb-peak-weather-menu [data-layer="slope"] dd').textContent(), '≈ 32.4°');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({browser: kind, version: context.browser()?.version(), hidden: true, viewports: ['1280×900','375×900'], themes: ['light','dark'], textScale: [1,2], cases, bundledLeafletPointCase: true,
        proof: 'controlled public provider replies; pending/success/error/retry, keyboard, geometry and legend samples; native focus and live providers not established'}));
} catch (error) {failure = error;} finally {await resources.dispose().catch((error: unknown) => { if (!failure) failure = error; else console.error(error); }); }
if (failure) throw failure;
