// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { darkCss } from '../src/theme/site-dark-css.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--firefox')) throw new Error('Usage: node scripts/verify-map-layer-control.mjs [--firefox]');
const firefoxMode = args.includes('--firefox');
const resources = createResourceStack(), screenshots = process.env.BPB_LAYER_SCREENSHOT_DIR;
let primaryError, summary;
try {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-layer-control-'));
    resources.defer('layer control temporary files', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('layer control HTTPS fixture', () => fixture.close());
    if (!firefoxMode) assertChromeLaunchAllowed();
    const context = await (firefoxMode ? firefox : chromium).launchPersistentContext(temporaryRoot, firefoxMode ? {
        headless: true, ignoreHTTPSErrors: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' },
    } : {
        channel: 'chromium', headless: true, args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('layer control browser', () => context.close());
    const bundle = await build({ stdin: { contents: `
        import {createMapLayerControl} from './src/maps/map-layer-control.js';
        import {settingsSchema as schema} from './src/settings/settings-schema.js';
        import {publicLandInfo} from './src/maps/map-overlay-providers.js';
        import {snotelPopup,updateSnotelPopupAction} from './src/snow/snotel-map-marker.js';
        const state=schema.mapOverlayState({slope:{enabled:true,opacity:60}});
        const statuses={sentinel:{capture:'latest',message:'Coverage 100% · Clouds 3%',captures:[
            {id:'latest',label:'Latest · 10-07 18:27 · ☁ 3%',title:'Latest · 2026-10-07 18:27 PDT · Clouds 3%'},
            {id:'older',label:'2026-10-06 18:27 · ☁ 100%',title:'2026-10-06 18:27 PDT · Clouds 100%'},
            {id:'unknown',label:'2026-10-05 18:27 · ☁ ?',title:'2026-10-05 18:27 PDT · Clouds unknown'}]},
            land:publicLandInfo(null),snotel:{legend:'NRCS active stations in the visible map. Station observations may differ from route conditions.'}};
        const toggles=[];let landTypes=schema.mapLandTypes();
        const control=createMapLayerControl({document,
            onToggle:(id,enabled)=>{toggles.push([id,enabled]);state[id].enabled=enabled;paint()},
            onOpacity:(id,opacity)=>{state[id].opacity=opacity;paint()},
            onLandTypes:value=>{landTypes=schema.mapLandTypes(value);paint()},
            onCapture:value=>{const status=statuses.sentinel;status.capture=value;status.message='Coverage 100% · Clouds '+status.captures.find(choice=>choice.id===value).title.split(' · Clouds ')[1];paint()},
            onRetry:id=>{window.fixture.retryRequests=(window.fixture.retryRequests||0)+1;statuses[id]={...statuses[id],pending:true,error:false,retry:true,message:id==='snotel'?'Loading stations':'Loading map tiles'};paint()}});
        document.body.append(control.element);
        function paint(){control.render({state,landTypes,statuses,coverage:window.fixture?.coverage,zoom:window.fixture?.zoom??17,theme:window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'});control.element.dataset.theme=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';control.position(document.querySelector('#map').getBoundingClientRect())}
        window.fixture={control,state,statuses,paint,toggles,landInfo:publicLandInfo,showPopup:scale=>{
            control.dispose();
            const station={id:'679:WA:SNTL',name:'Paradise SNOTEL station',latitude:46.78,longitude:-121.74,elevation:1570};
            const popup=snotelPopup(document,station);popup.id='station-popup';popup.style.fontSize=13*scale+'px';document.body.append(popup);
            window.fixture.membership=allowed=>updateSnotelPopupAction(popup,station,allowed?()=>{window.fixture.selections=(window.fixture.selections||0)+1}:undefined);
        }};paint();`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
    const css = await readFile(path.join(root, 'src/maps/map-layers.css'), 'utf8');
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    // Match the live native selector's white, black-bordered surround. The
    // full site sheet belongs only to the parent; its scoped map sheet must
    // reach this iframe without recoloring the map underneath the control.
    await page.route(`${origin}/map/MasterMap.aspx?themeFixture=1`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <style>html,body{height:100%;margin:0}#map{position:absolute;inset:0;background:#dce6d7}</style><div id="map"></div>
        <div id="selboxdiv" style="font-size:11px;font-family:Tahoma,Verdana,Arial Narrow;padding:5px;top:10px;right:10px;width:170px;position:absolute;z-index:99;background-color:white;border:2px solid black">
        <select id="selmap" aria-label="Base map"><option value="L_OT">Open Topo Map</option><option value="L_MT">MyTopo USA/Canada</option><option value="L_AG">ArcGIS - World Topo</option></select></div>` }));
    await page.route(`${origin}/native-map-theme.aspx`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <style>body{margin:16px;font:14px Arial}iframe{width:100%;height:300px;border:0}</style>
        <h1>Dynamic Map</h1><a id="before-map" href="#">Before map</a><iframe src="/map/MasterMap.aspx?themeFixture=1"></iframe><a id="after-map" href="#">Full screen map</a><h2>Following native content</h2>
        <script>let settings={theme:'light'};const listeners=[];
        window.chrome={storage:{sync:{get:async()=>({bpbSettings:settings})},onChanged:{addListener:listener=>listeners.push(listener),removeListener:()=>{}}}};
        window.setFixtureTheme=theme=>{settings={theme};listeners.forEach(listener=>listener({bpbSettings:{newValue:settings}},'sync'))};</script>` }));
    const themeBundle = await readFile(path.join(root, 'dist/content/theme.js'), 'utf8');
    let nativeThemeCases = 0;
    for (const [width, scale] of [[1280, 1], [375, 1], [1280, 2]]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${origin}/native-map-theme.aspx`);
        await page.addScriptTag({ content: themeBundle });
        await page.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'light');
        await page.locator('body').evaluate((body, scale) => { body.style.zoom = scale; }, scale);
        const native = page.frameLocator('iframe'), picker = native.locator('#selmap');
        await picker.waitFor();
        await page.locator('#before-map').focus();
        for (let step = 0; step < 3; step++) {
            await page.keyboard.press('Tab');
            if (await picker.evaluate(element => document.activeElement === element && document.hasFocus())) break;
        }
        assert.equal(await picker.evaluate(element => document.activeElement === element && document.hasFocus() && element.matches(':focus-visible')), true,
            'Tab reaches the native basemap picker with visible keyboard focus');
        const geometry = () => page.evaluate(() => {
            const frame = document.querySelector('iframe'), doc = frame.contentDocument;
            const rect = element => { const r = element.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; };
            return { page: [...document.querySelectorAll('h1,iframe,h2')].map(rect),
                map: ['#map','#selboxdiv','#selmap'].map(selector => rect(doc.querySelector(selector))),
                scroll: [window.scrollX,window.scrollY,doc.defaultView.scrollX,doc.defaultView.scrollY] };
        });
        const before = await geometry();
        for (const theme of ['dark', 'light', 'dark']) {
            await page.evaluate(theme => window.setFixtureTheme(theme), theme);
            await native.locator(`html[data-bpb-theme="${theme}"]`).waitFor({ state: 'attached' });
            assert.equal(await native.locator('html').getAttribute('data-bpb-theme'), theme);
            const appearance = await picker.evaluate(element => {
                const style = getComputedStyle(element), surround = getComputedStyle(element.parentElement);
                return { background: style.backgroundColor, color: style.color, scheme: style.colorScheme,
                    surround: surround.backgroundColor, border: surround.borderTopWidth, borderColor: surround.borderTopColor,
                    focused: document.activeElement === element && document.hasFocus(), focusVisible: element.matches(':focus-visible'),
                    outline: style.outlineStyle, outlineWidth: style.outlineWidth,
                    option: getComputedStyle(element.options[0]).backgroundColor,
                    map: getComputedStyle(document.getElementById('map')).backgroundColor };
            });
            if (theme === 'dark') {
                assert.equal(appearance.background, 'rgb(38, 54, 44)', 'native picker must use BPB dark inputs');
                assert.equal(appearance.surround, 'rgb(30, 43, 35)', 'the white surround must use BPB dark surfaces');
                assert.equal(appearance.option, appearance.background, 'the option list has a dark fallback');
                assert.equal(appearance.borderColor, 'rgb(56, 74, 62)', 'the inline black border follows the dark control palette');
                assert.equal(appearance.color, 'rgb(238, 234, 222)'); assert.equal(appearance.scheme, 'dark');
                assert.equal(appearance.outline, 'solid'); assert.equal(appearance.outlineWidth, '2px');
            } else assert.equal(appearance.surround, 'rgb(255, 255, 255)', 'light mode restores native styling');
            assert.equal(appearance.focused && appearance.focusVisible, true, 'keyboard focus survives theme updates');
            assert.equal(appearance.border, '2px'); assert.equal(appearance.map, 'rgb(220, 230, 215)');
            assert.deepEqual(await geometry(), before, 'theme changes keep the picker, map, headings and scroll anchored');
            if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `native-${width}-${theme}-${scale}x.png`) }); }
        }
        nativeThemeCases++;
    }
    assert.equal(nativeThemeCases, 3, 'all native map theme selections executed');
    await page.route('**/layer-scroll.aspx', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <style>body{margin:16px;font:14px system-ui}.before-map{height:480px}#map{height:320px;background:#c4cdc3}.after-map{height:1600px}</style>
        <h1>Ascent map</h1><div class="before-map"></div><div id="map"></div><h2>Following native content</h2><div class="after-map"></div>` }));
    const scrollCases = [];
    for (const width of [736, 320]) for (const theme of ['light', 'dark']) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 800 }); await page.emulateMedia({ colorScheme: theme });
        await page.goto(`${origin}/layer-scroll.aspx`);
        await page.addStyleTag({ content: css + darkCss });
        await page.evaluate(theme => {
            document.documentElement.dataset.bpbTheme = theme;
            window.scrollTo(0, document.querySelector('#map').getBoundingClientRect().top - 220);
        }, theme);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.locator('.bpb-map-layers').evaluate((element, scale) => { element.style.fontSize = `${13 * scale}px`; }, scale);
        for (const open of [false, true]) {
            if (open) await page.getByRole('button', { name: /^Overlays/ }).press('Enter');
            await page.evaluate(() => {
                // Intentionally leave the owner's position callback pending:
                // compositor scrolling must carry the button with the map.
                window.scrollFrames = [];
                window.traceScroll = true;
                const sample = () => {
                    if (!window.traceScroll) return;
                    const map = document.querySelector('#map').getBoundingClientRect();
                    const trigger = document.querySelector('.bpb-layers-trigger').getBoundingClientRect();
                    const heading = document.querySelector('h2').getBoundingClientRect();
                    window.scrollFrames.push({ x: trigger.x - map.x, y: trigger.y - map.y,
                        width: trigger.width, height: trigger.height, following: heading.y - map.bottom,
                        mapDocumentY: map.y + window.scrollY, headingDocumentY: heading.y + window.scrollY, scrollY: window.scrollY });
                    window.requestAnimationFrame(sample);
                };
                sample();
            });
            await page.mouse.move(width - 2, 300);
            for (const [delta, status] of [[80, { pending: true }], [-50, { error: true, retry: true, message: 'Could not load slope shading.' }], [60, {}]]) {
                const before = await page.evaluate(() => window.scrollY);
                await page.mouse.wheel(0, delta);
                await page.waitForFunction(before => window.scrollY !== before && window.scrollFrames.at(-1)?.scrollY === window.scrollY, before);
                await page.evaluate(async status => {
                    const { control, state, statuses } = window.fixture;
                    // Provider replies can paint before the delayed scroll
                    // handler; they must not combine stale viewport geometry
                    // with the new scroll offset and snap the button back.
                    statuses.slope = status;
                    control.render({ state, statuses, theme: document.documentElement.dataset.bpbTheme });
                    await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
                }, status);
            }
            const frames = await page.evaluate(() => { window.traceScroll = false; return window.scrollFrames; });
            assert.ok(new Set(frames.map(frame => frame.scrollY)).size >= 3, 'real wheel scrolling produced intermediate frames');
            assert.ok(Math.abs(frames[0].x - 10) <= 1 && Math.abs(frames[0].y - 10) <= 1, 'both themes keep the button ten pixels inside the map');
            for (const frame of frames) for (const key of ['x', 'y', 'width', 'height', 'following', 'mapDocumentY', 'headingDocumentY']) {
                assert.ok(Math.abs(frame[key] - frames[0][key]) <= 1,
                    `overlay follows the map during scrolling (${width}/${theme}/${scale}x/${open ? 'open' : 'closed'} ${key}): ${JSON.stringify(frames)}`);
            }
            // Once the owner catches up, updating its geometry must also be
            // invisible; the dropdown can still recalculate viewport limits.
            const before = await page.locator('.bpb-layers-trigger').boundingBox();
            await page.evaluate(() => window.fixture.paint());
            assert.deepEqual(await page.locator('.bpb-layers-trigger').boundingBox(), before, 'the scroll callback cannot move the anchored button');
            if (screenshots) {
                await mkdir(screenshots, { recursive: true });
                await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-scroll-${open ? 'open' : 'closed'}.png`) });
            }
            scrollCases.push({ width, theme, textScale: scale, open, frames: frames.length });
        }
    }
    assert.equal(scrollCases.length, 16, 'all scrolling selections executed');
    await page.route('**/layer-control.aspx', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:16px;font:14px system-ui}#map{height:240px;margin-top:36px;background:#c4cdc3}</style><div id="map"></div><h2>Following native content</h2>' }));
    const cases = [];
    for (const width of [736, 320]) for (const theme of ['light', 'dark']) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 800 }); await page.emulateMedia({ colorScheme: theme });
        await page.goto(`https://www.peakbagger.com:${fixture.port}/layer-control.aspx`);
        await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.locator('.bpb-map-layers').evaluate((element, scale) => { element.style.fontSize = `${13 * scale}px`; }, scale);
        const trigger = page.getByRole('button', { name: /^Overlays/ });
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        const collapsedTrigger = await trigger.boundingBox();
        const caret = trigger.locator('.bpb-layers-caret');
        assert.equal(await caret.isVisible(), true);
        assert.equal(await caret.evaluate(element => getComputedStyle(element).transform), 'none');
        await trigger.click();
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(await caret.evaluate(element => getComputedStyle(element).transform), 'matrix(-1, 0, 0, -1, 0, 0)');
        assert.deepEqual(await trigger.boundingBox(), collapsedTrigger, 'caret rotation does not move or resize the trigger');
        const box = await page.locator('.bpb-layers-panel').boundingBox();
        assert.ok(box.width <= 233 && box.height <= (scale === 1 ? 170 : 340), `compact readable overview ${JSON.stringify(box)}`);
        const mapBox = await page.locator('#map').boundingBox(), triggerBox = await trigger.boundingBox();
        assert.ok(Math.abs(triggerBox.x - mapBox.x - 10) <= 1 && Math.abs(box.x - triggerBox.x) <= 1, 'trigger and menu share the map left inset');
        assert.equal(await page.locator('.bpb-layers-panel [aria-label="Base map"]').count(), 0);
        const geometry = () => page.evaluate(() => ['.bpb-layers-trigger', ...Array.from(document.querySelectorAll('.bpb-layers-row')).map(row => `[data-layer="${row.dataset.layer}"]`), '#map', 'h2'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
        const before = await geometry();
        const stable = async () => { const after = await geometry(); before.forEach((rect, i) => rect.forEach((value, j) => assert.ok(Math.abs(value - after[i][j]) <= 1, `stable control ${i}/${j}`))); };
        if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-overview.png`) }); }
        for (const id of ['sentinel', 'slope', 'land']) {
            const caption = page.locator(`[data-layer="${id}"] .bpb-layers-value-label`);
            assert.equal(await caption.textContent(), 'Opacity');
            assert.equal(await caption.evaluate(element => {
                const caption = element.getBoundingClientRect(), label = element.closest('label').getBoundingClientRect();
                return caption.left >= label.left && caption.right <= label.right && caption.top >= label.top && caption.bottom <= label.bottom;
            }), true, 'opacity caption fits its primary toggle label');
        }
        const landToggle = page.locator('[data-layer="land"] input'), landName = page.locator('[data-layer="land"] .bpb-layers-row-name');
        const choiceBox = await page.locator('[data-layer="land"] label').boundingBox(), rowBox = await page.locator('[data-layer="land"]').boundingBox();
        assert.ok(choiceBox.width >= rowBox.width * .7, 'the primary visibility toggle gets most of the row');
        await landName.click(); assert.equal(await landToggle.isChecked(), true); await stable();
        const toggles = await page.evaluate(() => window.fixture.toggles.length);
        await page.locator('[data-layer="land"] button').click();
        assert.equal(await landToggle.isChecked(), true, 'settings never toggle visibility');
        assert.equal(await page.evaluate(() => window.fixture.toggles.length), toggles, 'settings do not duplicate toggle events');
        await landName.click(); assert.equal(await landToggle.isChecked(), false); await stable();
        await landToggle.focus(); await landToggle.press('Space'); assert.equal(await landToggle.isChecked(), true); await stable();
        await landToggle.press('Space'); assert.equal(await landToggle.isChecked(), false); await stable();
        for (const id of ['sentinel', 'slope', 'land', 'snotel', 'slope']) {
            await page.locator(`[data-layer="${id}"] button`).click(); await stable();
            assert.equal(await page.locator('.bpb-layers-detail:not([hidden])').count(), 1);
            if (id === 'land') {
                const guidance = page.getByRole('link', { name: 'BLM camping rules', exact: true });
                assert.equal(await guidance.isVisible(), true);
                await guidance.focus(); assert.equal(await guidance.evaluate(element => document.activeElement === element), true);
                assert.equal(await guidance.getAttribute('href'), 'https://www.blm.gov/programs/recreation/camping');
                assert.deepEqual(await page.locator('.bpb-layers-detail:not([hidden]) [data-land-type] label').allTextContents(), ['BLM', 'USFS', 'Other federal', 'State', 'Local / district', 'Tribal']);
                const detailBox = await page.locator('.bpb-layers-detail:not([hidden])').boundingBox();
                assert.ok(detailBox.x >= box.x && detailBox.x + detailBox.width <= box.x + box.width, 'land detail stays within compact width');
                if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-land.png`) });
                await page.locator('[data-layer="land"] input').check();
                const all = page.getByRole('checkbox', { name: 'All land types', exact: true });
                const only = page.getByRole('button', { name: 'Show only BLM land', exact: true });
                await only.scrollIntoViewIfNeeded(); await only.focus();
                const typeGeometry = () => page.evaluate(() => ({
                    boxes: ['.bpb-layers-panel', '[data-overlay="land"]', '[data-land-type="BLM"]', '[data-land-type="USFS"]', '#map', 'h2'].map(selector => {
                        const r = document.querySelector(selector).getBoundingClientRect(); return [r.x,r.y,r.width,r.height];
                    }), scroll: [window.scrollY, document.querySelector('.bpb-layers-panel').scrollTop]
                }));
                const typeBefore = await typeGeometry();
                await only.press('Enter');
                assert.equal(await all.evaluate(input => input.indeterminate), true);
                assert.equal(await page.getByRole('checkbox', { name: 'BLM land', exact: true }).isChecked(), true);
                assert.equal(await page.getByRole('checkbox', { name: 'USFS land', exact: true }).isChecked(), false);
                for (const status of [{pending:true,message:'Loading public lands'}, {error:true,retry:true,message:'Land coverage couldn’t load. Try again.'}, {message:''}]) {
                    await page.evaluate(status => { window.fixture.statuses.land = {...window.fixture.landInfo(null),...status}; window.fixture.paint(); }, status);
                    assert.deepEqual(await typeGeometry(), typeBefore, 'filter rows, panel and reading position stay anchored through provider feedback');
                    assert.equal(await only.evaluate(element => document.activeElement === element), true);
                }
                if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-land-filter.png`) });
                await all.focus(); await all.press('Space'); assert.equal(await all.isChecked(), true);
                await all.press('Space'); assert.equal(await all.isChecked(), false);
                await page.getByText('Select a land type.', {exact:true}).waitFor();
                assert.deepEqual(await typeGeometry(), typeBefore, 'empty selection retains the compact panel geometry');
                await all.press('Space');
                await page.evaluate(() => {
                    window.fixture.state.land.enabled = true;
                    window.fixture.statuses.land = { ...window.fixture.landInfo([-125, 53, -124, 54]), permission: true, retry: true, message: 'Allow BC parcel maps.' };
                    window.fixture.paint();
                });
                const allow = page.getByRole('button', { name: 'Allow BC land maps', exact: true });
                await allow.scrollIntoViewIfNeeded(); const allowBox = await allow.boundingBox();
                const scroll = await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop);
                await allow.focus();
                for (const status of [{ pending: true, message: 'Allow BC parcel maps.' }, { pending: false, error: true, message: 'BC access not granted.' }]) {
                    await page.evaluate(status => { Object.assign(window.fixture.statuses.land, status); window.fixture.paint(); }, status);
                    assert.deepEqual(await allow.boundingBox(), allowBox, 'permission pending/denial keep the action anchored');
                    assert.equal(await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop), scroll, 'permission feedback preserves menu reading position');
                    assert.equal(await allow.evaluate(element => document.activeElement === element), true);
                }
                assert.equal(await page.getByRole('link', { name: 'BC Crown land rules', exact: true }).isVisible(), true);
                await page.evaluate(() => { Object.assign(window.fixture.statuses.land, { partial: true, pending: false, message: 'BC maps need access. Other land coverage is shown.' }); window.fixture.paint(); });
                assert.equal(await page.locator('[data-layer="land"] .bpb-layers-row-status').textContent(), 'Partly loaded');
                assert.deepEqual(await allow.boundingBox(), allowBox, 'partial coverage keeps the permission action anchored');
                if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-canada.png`) });
                await page.evaluate(() => { window.fixture.state.land.enabled = false; window.fixture.statuses.land = window.fixture.landInfo(null); window.fixture.paint(); });
                await page.locator('.bpb-layers-panel').evaluate(element => { element.scrollTop = 0; });
            }
        }
        const opacitySlider = page.getByRole('slider', { name: 'Slope angle opacity' });
        await opacitySlider.focus();
        const dragGeometry = await geometry();
        const drag = await opacitySlider.evaluate(element => {
            const legends = [...document.querySelectorAll('.bpb-layers-legend')];
            const originals = legends.map(legend => [...legend.childNodes]);
            for (const opacity of [0, 25, 50, 75, 100, 60]) {
                element.value = String(opacity); element.dispatchEvent(new window.Event('input', { bubbles: true }));
                if (document.querySelector('[data-layer="slope"] .bpb-layers-value-number').textContent !== `${opacity}%`) return { immediate: false };
            }
            return { immediate: true, focused: document.activeElement === element,
                reused: legends.every((legend, i) => [...legend.childNodes].every((node, j) => node === originals[i][j])) };
        });
        assert.deepEqual(drag, { immediate: true, focused: true, reused: true }, 'opacity stays immediate and reuses unchanged legends');
        assert.deepEqual(await geometry(), dragGeometry, 'opacity dragging preserves rows, map and following content');
        await page.evaluate(() => { window.fixture.statuses.slope = { error: true, retry: true, message: 'Some tiles could not load.' }; window.fixture.paint(); });
        const recovery = page.getByRole('button', { name: /^(Retry|Reload)$/ });
        await recovery.scrollIntoViewIfNeeded(); await recovery.focus();
        const recoveryBox = await recovery.boundingBox(), scrollBeforeRecovery = await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop);
        const recoveryGeometry = await geometry();
        const stableRecovery = async () => {
            assert.deepEqual(await geometry(), recoveryGeometry, 'feedback keeps rows, map and following content anchored');
            assert.deepEqual(await recovery.boundingBox(), recoveryBox, 'Retry/Reload keeps the same pointer target');
            assert.equal(await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop), scrollBeforeRecovery);
            assert.equal(await recovery.evaluate(element => document.activeElement === element), true);
        };
        assert.equal(await page.locator('[data-layer="slope"] .bpb-layers-row-status').textContent(), 'Couldn’t load');
        await page.evaluate(() => { window.fixture.state.sentinel.enabled = true; Object.assign(window.fixture.statuses.sentinel, { pending: false, error: true, captureError: true, message: 'Capture search failed. Previous imagery shown.' }); window.fixture.paint(); });
        assert.equal(await page.locator('[data-layer="sentinel"] .bpb-layers-row-status').textContent(), 'Search failed'); await stableRecovery();
        await page.evaluate(() => { window.fixture.state.sentinel.enabled = false; Object.assign(window.fixture.statuses.sentinel, { error: false, captureError: false, message: '' }); window.fixture.paint(); });
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-failure.png`) });
        await page.evaluate(() => { window.fixture.statuses.slope = { error: true, partial: true, retry: true, message: 'Some slope tiles couldn’t load. Available shading is still shown.' }; window.fixture.paint(); });
        await stableRecovery();
        assert.equal(await page.locator('[data-layer="slope"] .bpb-layers-row-status').textContent(), 'Partly loaded');
        assert.equal(await page.getByText('Some slope tiles couldn’t load. Available shading is still shown.', { exact: true }).isVisible(), true);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-partial.png`) });
        await recovery.click(); await stableRecovery();
        assert.equal(await page.locator('[data-layer="slope"] .bpb-layers-row-status').textContent(), 'Loading');
        assert.equal(await recovery.getAttribute('aria-disabled'), 'true');
        const requests = await page.evaluate(() => window.fixture.retryRequests);
        await recovery.press('Enter'); assert.equal(await page.evaluate(() => window.fixture.retryRequests), requests, 'busy retry rejects duplicate keyboard activation');
        const spinner = page.locator('[data-layer="slope"] .bpb-layers-spinner'); assert.equal(await spinner.isVisible(), true);
        assert.equal(await spinner.evaluate(element => getComputedStyle(element).animationName), 'bpb-layer-spin');
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        assert.equal(await spinner.evaluate(element => getComputedStyle(element).animationName), 'none');
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-loading.png`) });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
        await page.evaluate(() => { window.fixture.statuses.slope = { error: true, retry: true, message: 'Some tiles could not load.' }; window.fixture.paint(); }); await stableRecovery();
        await recovery.click();
        await page.evaluate(() => { window.fixture.statuses.slope = {}; window.fixture.paint(); }); await stableRecovery();
        assert.equal(await recovery.textContent(), 'Reload', 'success retains a real action until the user leaves it');
        assert.equal(await page.getByText('Overlay refreshed.', { exact: true }).isVisible(), true);
        assert.equal(await recovery.getAttribute('aria-disabled'), 'false');
        assert.equal(await page.locator('[data-layer="slope"] .bpb-layers-row-status').isVisible(), false);
        assert.equal(await page.locator('[data-layer="slope"] .bpb-layers-value').isVisible(), true);
        await page.locator('[data-layer="slope"] input').focus();
        assert.equal(await recovery.isVisible(), false);
        await page.locator('.bpb-layers-panel').evaluate(element => { element.scrollTop = 0; });
        for (const id of ['land', 'sentinel', 'snotel', 'slope']) {
            const checkbox = page.locator(`[data-layer="${id}"] input`);
            await checkbox.focus(); await checkbox.press('Space'); await stable();
            assert.equal(await page.locator(`[data-layer="${id}"] button`).getAttribute('aria-expanded'), 'true', 'keyboard toggles select their matching detail');
            assert.equal(await page.locator(`[data-layer="${id}"]`).getAttribute('data-selected'), 'true');
            assert.equal(await page.locator('.bpb-layers-row[data-selected="true"]').count(), 1);
            assert.equal(await page.locator('.bpb-layers-detail:not([hidden])').getAttribute('aria-label'), `${await checkbox.getAttribute('aria-label')} settings`);
            await page.evaluate(() => { window.fixture.statuses.sentinel.pending = true; window.fixture.paint(); });
            assert.equal(await checkbox.evaluate(element => element === document.activeElement), true, 'async feedback preserves the toggle focus');
            assert.equal(await page.locator(`[data-layer="${id}"] button`).getAttribute('aria-expanded'), 'true'); await stable();
        }
        await page.evaluate(() => { window.fixture.state.slope.enabled = true; window.fixture.statuses.sentinel.pending = false; window.fixture.paint(); });
        const slider = page.getByRole('slider', { name: 'Slope angle opacity' });
        await slider.focus(); await slider.press('Home'); assert.equal(await slider.inputValue(), '0');
        await slider.press('End'); assert.equal(await slider.inputValue(), '100');
        for (const status of [{ pending: true, message: 'Loading slope…', retry: true }, { error: true, message: 'Slope is unavailable. Try again.', retry: true }, { message: 'Loaded' }]) {
            await page.evaluate(status => { window.fixture.statuses.slope = status; window.fixture.paint(); }, status); await stable();
        }
        const zoomGeometry = await geometry(), zoomPanel = await page.locator('.bpb-layers-panel').boundingBox();
        for (const zoom of [7, 8, 7, 8]) {
            await page.evaluate(zoom => { window.fixture.zoom = zoom; window.fixture.statuses.slope = { pending: true, retry: true, message: 'Loading slope shading' }; window.fixture.paint(); }, zoom);
            assert.equal(await page.locator('[data-layer="slope"] .bpb-layers-row-status').textContent(), zoom < 8 ? 'Zoom in' : 'Loading');
            assert.equal(await page.locator('[data-layer="sentinel"] .bpb-layers-row-status').textContent(), 'Zoom in', 'Sentinel requires catalog zoom 9, even when other rasters reach their zoom limit');
            assert.equal(await page.locator('.bpb-layers-detail:not([hidden]) .bpb-layers-retry').isVisible(), zoom >= 8);
            assert.deepEqual(await geometry(), zoomGeometry, 'zoom feedback keeps the overview, map and following content anchored');
            assert.deepEqual(await page.locator('.bpb-layers-panel').boundingBox(), zoomPanel, 'zoom feedback preserves the panel dimensions');
            assert.equal(await slider.evaluate(element => document.activeElement === element), true);
            if (screenshots && zoom === 7) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-zoom.png`) });
        }
        await page.evaluate(() => { window.fixture.statuses.slope = { message: 'Loaded' }; window.fixture.paint(); });
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-detail.png`) });
        await slider.press('Escape'); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true);
        assert.equal(await slider.evaluate(element => document.activeElement === element), true, 'Escape keeps focus with the current control');
        assert.equal(await page.evaluate(() => window.fixture.state.slope.enabled), true);
        await page.mouse.click(width - 15, 320); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true);
        await page.locator('#map').click({ position: { x: mapBox.width - 10, y: 10 } });
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true); await stable();
        await trigger.click(); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        assert.equal(await caret.evaluate(element => getComputedStyle(element).transform), 'none');
        assert.deepEqual(await trigger.boundingBox(), collapsedTrigger, 'collapse leaves the trigger anchored');
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-collapsed.png`) });
        await trigger.press('Enter'); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true);
        assert.equal(await page.locator('.bpb-layers-details').isVisible(), false, 'reopen starts with the compact overview');
        await trigger.press('Space'); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        await trigger.click(); await page.locator('[data-layer="sentinel"] input').check();
        if (await page.locator('[data-layer="sentinel"] button').getAttribute('aria-expanded') !== 'true') await page.locator('[data-layer="sentinel"] button').click();
        const capture = page.getByRole('combobox', { name: 'Sentinel-2 capture' });
        for (const id of ['latest', 'older', 'unknown']) {
            await capture.selectOption(id);
            const metadata = await capture.evaluate(element => ({ title: element.title, label: element.selectedOptions[0].textContent,
                accessible: element.selectedOptions[0].getAttribute('aria-label') }));
            assert.match(metadata.label, /☁ (?:3%|100%|\?)/); assert.match(metadata.title, /2026-10-0[567] 18:27 PDT · Clouds (?:3%|100%|unknown)$/);
            assert.equal(metadata.title, metadata.accessible); await stable();
        }
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-sentinel.png`) });
        await page.locator('[data-layer="snotel"] button').click();
        await page.evaluate(() => { window.fixture.state.snotel.enabled = true; window.fixture.statuses.snotel = { ...window.fixture.statuses.snotel, error: true, saved: true, retry: true, count: 3, message: 'Showing loaded locations.' }; window.fixture.paint(); });
        const stationRetry = page.getByRole('button', { name: /^(Retry|Reload)$/ }); await stationRetry.scrollIntoViewIfNeeded(); await stationRetry.focus();
        const stationBox = await stationRetry.boundingBox(), stationPanel = await page.locator('.bpb-layers-panel').boundingBox();
        const stationScroll = await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop);
        assert.equal(await page.locator('[data-layer="snotel"] .bpb-layers-row-status').textContent(), 'Refresh failed');
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-snotel-refresh.png`) });
        await stationRetry.click(); await stable();
        assert.deepEqual(await stationRetry.boundingBox(), stationBox);
        assert.deepEqual(await page.locator('.bpb-layers-panel').boundingBox(), stationPanel, 'station recovery preserves the compact panel dimensions');
        const stationRequests = await page.evaluate(() => window.fixture.retryRequests);
        await stationRetry.press('Enter'); assert.equal(await page.evaluate(() => window.fixture.retryRequests), stationRequests);
        await page.evaluate(() => { window.fixture.statuses.snotel = { ...window.fixture.statuses.snotel, pending: false, error: false, saved: false, retry: false, count: 3, message: '3 stations in view.' }; window.fixture.paint(); }); await stable();
        assert.equal(await stationRetry.textContent(), 'Reload');
        assert.deepEqual(await stationRetry.boundingBox(), stationBox);
        assert.deepEqual(await page.locator('.bpb-layers-panel').boundingBox(), stationPanel);
        assert.equal(await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop), stationScroll);
        assert.equal(await stationRetry.evaluate(element => document.activeElement === element), true);
        await page.locator('[data-layer="snotel"] input').focus();
        await page.evaluate(() => { window.fixture.statuses.snotel = { ...window.fixture.statuses.snotel, count: 0, overflow: true, message: 'More than 50 stations. Zoom in.' }; window.fixture.paint(); }); await stable();
        assert.equal(await page.locator('[data-layer="snotel"] .bpb-layers-row-status').textContent(), 'Zoom in');
        await page.evaluate(() => {
            window.fixture.statuses.snotel = { ...window.fixture.statuses.snotel, overflow: false, message: 'No coverage here.' };
            window.fixture.paint();
        });
        const stationToggle = page.getByRole('checkbox', { name: 'SNOTEL stations', exact: true }); await stationToggle.focus();
        const regionGeometry = await geometry(), regionPanel = await page.locator('.bpb-layers-panel').boundingBox();
        const regionScroll = await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop);
        for (const supported of [false, true, false, true]) {
            await page.evaluate(supported => {
                const fixture = window.fixture; fixture.coverage = { sentinel: true, slope: supported, land: supported, snotel: supported };
                for (const id of ['slope', 'land', 'snotel']) fixture.state[id].enabled = false;
                fixture.paint();
            }, supported);
            for (const id of ['slope', 'land', 'snotel']) {
                assert.equal(await page.locator(`[data-layer="${id}"] input`).isDisabled(), !supported);
                assert.equal(await page.locator(`[data-layer="${id}"] input`).isChecked(), false, 'returning to coverage never auto-enables an overlay');
                if (!supported) assert.equal(await page.locator(`[data-layer="${id}"] .bpb-layers-row-status`).textContent(), 'No coverage');
            }
            assert.deepEqual(await geometry(), regionGeometry, 'coverage changes preserve rows, map and following content');
            assert.deepEqual(await page.locator('.bpb-layers-panel').boundingBox(), regionPanel, 'coverage feedback preserves the panel dimensions');
            assert.equal(await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop), regionScroll);
            assert.equal(await page.locator('[data-layer="snotel"] button').evaluate(element => document.activeElement === element), true, 'disabling the focused toggle preserves focus on its row disclosure');
            if (!supported && screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-regional.png`) });
        }
        await page.evaluate(scale => window.fixture.showPopup(scale), scale);
        const official = page.getByRole('link', { name: 'View NRCS snow data', exact: true }); await official.focus();
        await page.evaluate(() => window.fixture.membership(true));
        const conditions = page.getByRole('button', { name: 'Show conditions at Paradise SNOTEL station', exact: true });
        assert.equal(await conditions.isVisible(), true);
        assert.equal(await official.evaluate(element => document.activeElement === element), true, 'new membership keeps the official link focused');
        await conditions.focus(); await conditions.press('Enter');
        assert.equal(await page.evaluate(() => window.fixture.selections), 1);
        await page.evaluate(() => window.fixture.membership(false));
        assert.equal(await conditions.count(), 0, 'an unavailable condition action is removed');
        assert.equal(await official.evaluate(element => document.activeElement === element), true, 'revocation returns focus to the same official link');
        cases.push({ width, theme, textScale: scale, overview: { width: box.width, height: box.height }, anchored: true, regionalCoverage: true, popupFocus: true });
    }
    const setupAssets = new Set(['bc-land/access.html', 'bc-land/access-head.js', 'bc-land/access.js', 'css/panel.css', 'css/gaia-access.css', 'css/bc-land-access.css', 'icons/icon-48.png']);
    await page.route(`https://www.peakbagger.com:${fixture.port}/dist/**`, async route => {
        const relative = new URL(route.request().url()).pathname.slice('/dist/'.length);
        assert.ok(setupAssets.has(relative), `unexpected setup asset ${relative}`);
        const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(relative)];
        return route.fulfill({ contentType, body: await readFile(path.join(root, 'dist', relative)) });
    });
    await page.addInitScript(() => {
        if (!window.location.pathname.endsWith('/bc-land/access.html')) return;
        window.__bcSetup = { requests: 0, notified: 0 };
        window.chrome = { runtime: {}, storage: { sync: { get: async () => ({ bpbSettings: { theme: 'system' } }) }, onChanged: { addListener() {}, removeListener() {} } },
            permissions: { request: () => { window.__bcSetup.requests++; return new Promise(resolve => { window.__bcSetup.finish = resolve; }); } },
            tabs: { sendMessage: async () => { window.__bcSetup.notified++; } } };
        window.close = () => { window.__bcSetup.closed = true; };
    });
    for (const entry of cases) {
        await page.setViewportSize({ width: entry.width, height: 800 }); await page.emulateMedia({ colorScheme: entry.theme });
        await page.goto(`https://www.peakbagger.com:${fixture.port}/dist/bc-land/access.html?tab=7`);
        const allow = page.getByRole('button', { name: 'Allow access', exact: true }); await allow.waitFor();
        await page.evaluate(scale => { document.querySelectorAll('h1,p,button').forEach(element => { element.style.fontSize = `${parseFloat(getComputedStyle(element).fontSize) * scale}px`; }); }, entry.textScale);
        const geometry = () => page.evaluate(() => ['h1', '.access-card', 'button'].map(selector => { const box = document.querySelector(selector).getBoundingClientRect(); return [box.x,box.y,box.width,box.height]; }));
        // Establish the user's focus/reading position before measuring async
        // feedback; keyboard focus can reveal a partly offscreen action.
        await allow.scrollIntoViewIfNeeded(); await allow.focus();
        const before = await geometry(), scroll = await page.evaluate(() => window.scrollY);
        const stable = async () => { assert.deepEqual(await geometry(), before, 'setup heading, card and action stay anchored through permission decisions'); assert.equal(await page.evaluate(() => window.scrollY), scroll); };
        await allow.press('Enter'); await page.waitForFunction(() => window.__bcSetup.requests === 1);
        await allow.press('Enter'); assert.equal(await page.evaluate(() => window.__bcSetup.requests), 1); await stable();
        assert.equal(await allow.evaluate(element => document.activeElement === element), true);
        await page.evaluate(() => window.__bcSetup.finish(false)); await page.getByText('Access not granted. Try again.', { exact: true }).waitFor(); await stable();
        await allow.press('Space'); await page.waitForFunction(() => window.__bcSetup.requests === 2);
        await page.evaluate(() => window.__bcSetup.finish(true));
        const back = page.getByRole('button', { name: 'Return to map', exact: true }); await back.waitFor(); await stable();
        assert.equal(await back.evaluate(element => document.activeElement === element), true);
        assert.equal(await page.evaluate(() => window.__bcSetup.notified), 1);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${entry.width}-${entry.theme}-${entry.textScale}x-bc-setup.png`), fullPage: true });
        await back.click(); assert.equal(await page.evaluate(() => window.__bcSetup.closed), true);
        entry.setupAnchored = true;
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(cases.length, 8, 'all component selections executed');
    summary = { check: 'map layer control', browser: firefoxMode ? 'firefox' : 'chromium', version: context.browser().version(), hidden: true, nativeThemeCases, scrollCases, cases };
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({ ...summary, teardown: 'passed' }));
