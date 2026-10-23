// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifySnowMapCases({ origin, evaluate, evaluateTerrain, navigate, click: originalClick, clickPoint, press, resize, screenshotPage,
    setSettings, setZoom, wait, writeLocal, setMode, release, snowEvidence, networkErrors, firefoxMode }) {
    const output = process.env.BPB_VERIFY_SNOW_MAP_SCREENSHOT_DIR, cases = [];
    if (output) await mkdir(output, { recursive: true });
    const browser = firefoxMode ? 'firefox' : 'chrome', selection = process.env.BPB_VERIFY_SNOW_MAP_CASE || 'all';
    if (!['all', 'terrain', 'camera'].includes(selection)) throw new Error(`Unknown snow map case: ${selection}`);
    const key = name => firefoxMode ? { Enter: '\uE007', Space: '\uE00D', Escape: '\uE00C' }[name] : name;
    const image = async name => { if (output) await screenshotPage(path.join(output, `${browser}-${name}.png`)); };
    const open = async detail => {
        if (!await evaluate(() => document.querySelector('.bpb-layers-trigger')?.getAttribute('aria-expanded') === 'true')) await originalClick('.bpb-layers-trigger');
        if (detail && !await evaluate(() => document.querySelector('[data-layer="snotel"] button').getAttribute('aria-expanded') === 'true')) await originalClick('[data-layer="snotel"] button');
    };
    const click = async selector => {
        if (selector === '#bpb-snow-map-toggle') { await open(false); return originalClick('[data-layer="snotel"] input'); }
        if (selector === '.bpb-snow-map-notice button') { await open(true); return originalClick('[aria-label="SNOTEL stations settings"] .bpb-layers-retry'); }
        return originalClick(selector);
    };
    const geometry = () => evaluate(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
        const mount = document.querySelector('.bpb-terrain-mount-peak');
        return { trigger:rect(document.querySelector('.bpb-layers-trigger')), mode:rect(document.getElementById('bpb-terrain-toggle')), map:rect(mount),
            heading:rect(document.querySelector('h1')), following:rect(mount.closest('td').querySelector('a[href*="BigMap"]')),scroll:{x:window.scrollX,y:window.scrollY} };
    });
    const stable = (before,after,label) => {for(const part of Object.keys(before))for(const dim of Object.keys(before[part]))assert.ok(Math.abs(before[part][dim]-after[part][dim])<=1,`${label}: ${part}.${dim} moved: ${JSON.stringify({before,after})}`);};
    const markerCount = () => evaluate(() => document.getElementById('Gmap').contentDocument.querySelectorAll('.bpb-snotel-marker').length);
    const waitMarkers = count => waitForCondition(markerCount,{description:`${count} native snow markers`,timeoutMs:15000,isReady:value=>value===count});
    const unobscuredStation = () => evaluate(() => {
        const frame = document.getElementById('Gmap');
        const doc = frame?.contentDocument, offset = frame?.getBoundingClientRect();
        if (!doc || !offset) return false;
        const blockers = [...document.querySelectorAll('.bpb-layers-panel, .bpb-layers-trigger, #bpb-terrain-toggle, .bpb-map-compass')].map(node => node.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
        const marker = doc.querySelector('.bpb-snotel-marker[title="Paradise · SNOTEL"]');
        if (!marker) return false;
        const box = marker.getBoundingClientRect();
        const r = {left:box.left+offset.left,top:box.top+offset.top,right:box.right+offset.left,bottom:box.bottom+offset.top};
        return box.width > 0 && box.left >= 0 && box.top >= 0 && box.right <= offset.width && box.bottom <= offset.height
            && blockers.every(panel => r.right <= panel.left || r.left >= panel.right || r.bottom <= panel.top || r.top >= panel.bottom);
    });
    const ready = () => wait(() => document.querySelector('[data-layer="snotel"]')?.dataset.status === '', 'settled viewport station layer');
    const frameWait = (fn,description) => waitForCondition(()=>evaluateTerrain(fn),{description,timeoutMs:20000});
    const prepare = async (width,theme,mode='loading') => {
        await resize(width,1100);await setSettings({theme,units:'imperial',enable3dMap:true,showSunMoon:false,showWeather:true,showSnotel:true});
        await writeLocal({bpbSnotelCatalogV1:null});setMode(mode);
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map-first`);
        await wait(()=>!!document.querySelector('.bpb-layers-trigger')&&!document.querySelector('[data-layer="snotel"] input').disabled,'available shared layer menu');
        await evaluate(()=>document.getElementById('bpb-peak-weather').scrollIntoView({block:'start'}));
        await wait(()=>document.querySelectorAll('.bpb-week-day').length===16&&document.getElementById('bpb-peak-weather').getAttribute('aria-busy')==='false','neighboring forecast settled');
        await evaluate(()=>document.querySelector('.bpb-terrain-mount-peak').scrollIntoView({block:'center'}));
        await wait(()=>document.querySelector('.bpb-layers-trigger')?.getBoundingClientRect().width>0,'layer control positioned in the visible map');
        await wait(()=>document.getElementById('bpb-terrain-toggle')?.disabled===false,'terrain settings ready');
        // An already-visible station should preserve the user's camera.
        // The separate activation cases below start with stations offscreen.
        await evaluate(()=>{ document.getElementById('Gmap').contentWindow.mapsPlaceholder.setView([46.81,-121.54],9,{animate:false}); });
        assert.equal(await markerCount(),0);
    };
    const nativeCamera = () => evaluate(() => {
        const map = document.getElementById('Gmap').contentWindow.mapsPlaceholder, center = map.getCenter();
        return [center.lat, center.lng, map.getZoom()];
    });
    const trackActivation = () => evaluate(() => {
        window.__snowReplies = 0; window.__snowViews = []; window.__snowMoveStarts = 0;
        window.addEventListener('message', event => {
            const data = event.data;
            if (event.source !== window || event.origin !== window.location.origin || data?.dir !== 'toPage') return;
            if (data.__bpbMapLayers === true && data.type === 'stations') window.__snowReplies++;
            if (data.__bpbTerrain === true && data.type === 'layerView') window.__snowViews.push(data.bounds);
            if (data.__bpbTerrain === true && data.type === 'layerMoveStart') window.__snowMoveStarts++;
        });
    });
    if (selection !== 'terrain') {
        await prepare(1440, 'light', 'complete'); await trackActivation();
        await evaluate(() => {
            const map = document.getElementById('Gmap').contentWindow.mapsPlaceholder;
            map.setView([46.851731, -121.760395], 16, { animate: false });
            window.__snowMoves = 0; map.on('moveend', () => window.__snowMoves++);
        });
        const before = await nativeCamera(), layout = await geometry();
        await click('#bpb-snow-map-toggle');
        await wait(() => window.__snowMoves > 0 && document.getElementById('Gmap').contentWindow.mapsPlaceholder.getBounds().contains([46.78266, -121.74767]), 'activation zoom reveals an offscreen SNOTEL station');
        await ready();
        await waitForCondition(unobscuredStation, { description: 'nearest native station is visible beside the open overlay menu' });
        await wait(() => document.querySelector('[aria-label="SNOTEL stations settings"]')?.textContent.includes('stations in view.'),
            'the settled camera refresh replaces discovery candidates with visible stations');
        const revealedMarkers = await markerCount();
        const revealed = await nativeCamera(); assert.ok(revealed[2] < before[2], 'activation zooms out to nearby stations');
        assert.ok(revealed[2] >= 12, `a distant alternative must not force a regional zoom: ${JSON.stringify(revealed)}`);
        stable(layout, await geometry(), 'SNOTEL activation zoom'); await image('native-auto-zoom');
        await click('#bpb-snow-map-toggle'); const moves = await evaluate(() => window.__snowMoves);
        await click('#bpb-snow-map-toggle'); await ready(); await waitMarkers(revealedMarkers);
        assert.deepEqual(await nativeCamera(), revealed, 'enabling already-visible stations preserves the camera');
        assert.equal(await evaluate(() => window.__snowMoves), moves, 'visible stations do not start another camera animation');
        const replies = await evaluate(() => window.__snowReplies);
        await evaluate(() => { document.getElementById('Gmap').contentWindow.mapsPlaceholder.panBy([50, 0], { animate: false }); });
        const panned = await nativeCamera();
        await wait(() => window.__snowReplies > 0, 'station replies observed');
        await waitForCondition(() => evaluate(() => window.__snowReplies), { description: 'passive viewport refresh after user pan', isReady: value => value > replies });
        await ready(); assert.deepEqual(await nativeCamera(), panned, 'a later pan is not pulled back to the stations');
        cases.push({ states: ['native-offscreen-activation-zoom', 'visible-station-keeps-camera', 'passive-pan-keeps-camera'] });
        await prepare(1440, 'light', 'loading');
        await evaluate(() => { document.getElementById('Gmap').contentWindow.mapsPlaceholder.setView([46.851731, -121.760395], 17, { animate: false }); });
        await click('#bpb-snow-map-toggle');
        await wait(() => document.querySelector('[data-layer="snotel"]').dataset.status === 'loading', 'activation waiting for the station catalog');
        await evaluate(() => { document.getElementById('Gmap').contentWindow.mapsPlaceholder.fire('movestart'); });
        setMode('complete'); release();
        await evaluate(() => { document.getElementById('Gmap').contentWindow.mapsPlaceholder.panBy([100, 0], { animate: false }); });
        const userCamera = await nativeCamera(); await ready();
        assert.deepEqual(await nativeCamera(), userCamera, 'movement start cancels discovery before a late catalog arrives');
        cases.push({ states: ['pending-pan-cancels-reveal'] });
    }
    await prepare(375, 'dark', 'complete'); await trackActivation();
    await evaluate(() => { document.getElementById('Gmap').contentWindow.mapsPlaceholder.setView([46.851731, -121.760395], 17, { animate: false }); });
    await click('#bpb-terrain-toggle');
    await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true' && window.__snowViews.length > 0, 'tight 3D camera ready for station activation');
    const initialBounds = await evaluate(() => window.__snowViews.at(-1));
    assert.equal(46.78266 >= initialBounds[1] && 46.78266 <= initialBounds[3]
        && -121.74767 >= initialBounds[0] && -121.74767 <= initialBounds[2], false, 'the station starts outside the 3D view');
    await click('#bpb-snow-map-toggle');
    await frameWait(() => Array.from(document.querySelectorAll('.bpb-snotel-marker')).some(marker => {
        const r = marker.getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    }), '3D activation zoom reveals a fully visible SNOTEL marker');
    await waitForCondition(() => evaluate(() => window.__snowViews.at(-1)), { description: 'settled 3D station reveal camera',
        isReady: bounds => bounds && bounds.some((value, i) => Math.abs(value - initialBounds[i]) > 1e-7) });
    await ready();
    const terrainChrome = await evaluate(() => {
        const frame = document.getElementById('bpb-terrain-frame').getBoundingClientRect();
        return [...document.querySelectorAll('.bpb-layers-panel, .bpb-layers-trigger, #bpb-terrain-toggle, .bpb-map-compass')]
            .map(node => node.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
            .map(box => ({left:box.left-frame.left,top:box.top-frame.top,right:box.right-frame.left,bottom:box.bottom-frame.top}));
    });
    await waitForCondition(() => evaluateTerrain(blockers => {
        const marker = document.querySelector('.bpb-snotel-marker[title="Paradise · SNOTEL"]');
        if (!marker) return false;
        const r = marker.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
            && blockers.every(box => r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom);
    }, terrainChrome), {description:'nearest 3D marker clears the outer menu, mode button and compass',timeoutMs:20000});
    await image('terrain-auto-zoom');
    assert.equal(await evaluate(() => document.querySelector('.bpb-layers-trigger').getAttribute('aria-expanded')), 'true', 'auto-zoom preserves the expanded overlay menu');
    cases.push({ states: ['3D-offscreen-activation-zoom', 'sticky-overlay-menu'] });
    if (selection === 'camera') {
        const renderer = await evaluateTerrain(() => {
            const gl = document.querySelector('canvas.maplibregl-canvas').getContext('webgl2'), info = gl.getExtension('WEBGL_debug_renderer_info');
            return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        });
        assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
        // Cover the inverse viewport/theme pairing too, with an unchanged map
        // shell and one useful station beside the expanded controls.
        for (const [width, theme, terrain] of [[375, 'dark', false], [1440, 'light', true]]) {
            await prepare(width, theme, 'complete'); await trackActivation();
            await evaluate(() => { document.getElementById('Gmap').contentWindow.mapsPlaceholder.setView([46.851731, -121.760395], 17, { animate: false }); });
            if (terrain) {
                await click('#bpb-terrain-toggle');
                await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true' && window.__snowViews.length > 0, 'camera matrix terrain ready');
            }
            const layout = await geometry(); await click('#bpb-snow-map-toggle');
            if (terrain) await frameWait(() => [...document.querySelectorAll('.bpb-snotel-marker')].some(marker => {
                const r = marker.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
            }), 'wide terrain discovery marker');
            else await waitForCondition(unobscuredStation, {description:'narrow native discovery clears the menu'});
            stable(layout, await geometry(), 'camera matrix shell'); await image(`camera-${width}-${theme}`);
            cases.push({width, theme, terrain, states:['nearest-station', 'stable-map-shell']});
        }
        await prepare(1440, 'light', 'loading'); await trackActivation();
        await evaluate(() => { document.getElementById('Gmap').contentWindow.mapsPlaceholder.setView([46.851731, -121.760395], 17, {animate:false}); });
        await click('#bpb-terrain-toggle');
        await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true' && window.__snowViews.length > 0, 'pending camera terrain ready');
        await evaluate(() => { window.__snowMoveStarts = 0; });
        await click('#bpb-snow-map-toggle');
        await wait(() => document.querySelector('[data-layer="snotel"]').dataset.status === 'loading', '3D station catalog is held');
        await evaluateTerrain(() => document.querySelector('canvas.maplibregl-canvas').focus({preventScroll:true}));
        await press(firefoxMode ? '\uE014' : 'ArrowRight');
        await wait(() => window.__snowMoveStarts > 0, '3D navigation start reaches the outer owner before discovery completes');
        setMode('complete'); release(); await ready();
        const afterGesture = await evaluate(() => window.__snowViews.at(-1));
        assert.equal(46.78266 >= afterGesture[1] && 46.78266 <= afterGesture[3]
            && -121.74767 >= afterGesture[0] && -121.74767 <= afterGesture[2], false, 'late station data cannot pull the 3D camera away from keyboard navigation');
        cases.push({states:['3D-pending-navigation-cancels-reveal']});
        await prepare(375, 'dark', 'no-stations'); const emptyCamera = await nativeCamera(), emptyLayout = await geometry();
        await click('#bpb-snow-map-toggle');
        await wait(() => document.querySelector('[aria-label="SNOTEL stations settings"]')?.textContent.includes('No SNOTEL stations'), 'empty camera coverage');
        assert.deepEqual(await nativeCamera(), emptyCamera, 'empty coverage must not move the camera');
        stable(emptyLayout, await geometry(), 'empty camera coverage');
        cases.push({states:['empty-coverage-keeps-camera']});
        assert.equal(cases.length, 7, 'every selected camera case executed'); assert.deepEqual(networkErrors, []);
        return {renderer, cases, snowRequests:snowEvidence.length};
    }
    const popupPalette = () => evaluate(() => {
        const win = document.getElementById('Gmap').contentWindow, popup = win.document.querySelector('.leaflet-popup');
        const style = selector => win.getComputedStyle(popup.querySelector(selector));
        return { background: style('.leaflet-popup-content-wrapper').backgroundColor, tip: style('.leaflet-popup-tip').backgroundColor,
            text: style('.leaflet-popup-content-wrapper').color, link: style('.leaflet-popup-content a').color,
            close: style('.leaflet-popup-close-button').color,
            button: popup.querySelector('button') ? style('button').backgroundColor : null };
    });
    const themedPopup = (palette, theme) => {
        assert.equal(palette.background, theme === 'dark' ? 'rgb(39, 44, 41)' : 'rgb(255, 255, 255)', `${theme}: native popup surface follows the site theme`);
        assert.equal(palette.tip, palette.background, 'the geographic arrow matches its popup');
        if (theme === 'dark') {
            assert.equal(palette.text, 'rgb(226, 222, 213)');
            assert.equal(palette.link, 'rgb(170, 208, 255)');
            assert.equal(palette.close, palette.text);
            if (palette.button) assert.equal(palette.button, 'rgb(52, 59, 55)');
        }
    };
    const popupSettled = () => wait(() => {
        const win = document.getElementById('Gmap').contentWindow, popup = win.document.querySelector('.leaflet-popup');
        return popup && win.getComputedStyle(popup).opacity === '1' && !win.mapsPlaceholder._panAnim?._inProgress;
    }, 'fully painted native popup and settled pan');
    const popupGeometry = () => evaluate(() => {
        const win = document.getElementById('Gmap').contentWindow, doc = win.document;
        const rect = selector => {
            const r = doc.querySelector(selector).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return { surface: rect('.leaflet-popup'), close: rect('.leaflet-popup-close-button'), action: rect('.bpb-snotel-show-conditions'),
            link: rect('.bpb-snotel-popup a'), canvas: win.getComputedStyle(doc.getElementById('map')).backgroundColor,
            focus: doc.activeElement.className, scroll: [win.scrollX, win.scrollY] };
    });
    const popupAnchor = () => evaluateTerrain(() => {
        const marker = [...document.querySelectorAll('.bpb-snotel-marker')].find(node => node.title.startsWith('Paradise'));
        const popup = document.querySelector('.bpb-snotel-map-popup'), tip = popup.querySelector('.maplibregl-popup-tip');
        const r = marker.getBoundingClientRect(), t = tip.getBoundingClientRect();
        return { tipVisible: getComputedStyle(tip).display !== 'none',
            dx: Math.abs(t.x + t.width / 2 - r.x - r.width / 2), dy: Math.abs(t.bottom - r.y - r.height / 2),
            marker: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, viewport: { width: window.innerWidth, height: window.innerHeight } };
    });
    const anchored = state => {
        assert.equal(state.tipVisible, true, 'the popup has a visible geographic arrow');
        assert.ok(state.dx <= 2 && state.dy <= 20, `popup arrow stays beside its station: ${JSON.stringify(state)}`);
        assert.ok(state.marker.top >= 0 && state.marker.bottom <= state.viewport.height
            && state.marker.left >= 0 && state.marker.right <= state.viewport.width, `the popup's station stays visible: ${JSON.stringify(state)}`);
    };
    for(const width of selection==='all'?[1440,375]:[])for(const theme of ['light','dark']){
        await prepare(width,theme);const initial=await geometry();await open(true);
        await evaluate(()=>document.querySelector('[data-layer="snotel"] input').focus({preventScroll:true}));await press(key('Space'));
        await wait(()=>document.querySelector('[data-layer="snotel"]').dataset.status==='loading','pending viewport catalog');stable(initial,await geometry(),'pending');
        await press(key('Space'));await waitMarkers(0);await press(key('Space'));setMode('complete');release();await ready();await waitMarkers(2);
        stable(initial,await geometry(),'ready');
        assert.equal(await evaluate(()=>document.getElementById('Gmap').contentWindow.nativeLayers.every(layer=>document.getElementById('Gmap').contentWindow.mapsPlaceholder.hasLayer(layer))),true);
        await image(`${width}-${theme}-ready`);
        await evaluate(()=>document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-marker').focus());await press(key('Enter'));await popupSettled();
        themedPopup(await popupPalette(),theme);
        await wait(()=>!!document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-show-conditions'),'authorized nearby card action');
        await evaluate(()=>document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-show-conditions').focus({preventScroll:true}));
        const popupBefore=await popupGeometry();
        for(const next of [theme==='dark'?'light':'dark',theme]){
            await setSettings({theme:next,units:'imperial',enable3dMap:true,showSunMoon:false,showWeather:true,showSnotel:true});
            await waitForCondition(popupPalette,{description:`popup theme ${next}`,isReady:palette=>palette.background===(next==='dark'?'rgb(39, 44, 41)':'rgb(255, 255, 255)')});
            themedPopup(await popupPalette(),next);assert.deepEqual(await popupGeometry(),popupBefore,'theme preserves station popup and focus');
        }
        await click('#bpb-snow-map-toggle');await waitMarkers(0);const requests=snowEvidence.length;await click('#bpb-snow-map-toggle');await ready();await waitMarkers(2);
        assert.equal(snowEvidence.length,requests,'cached toggles make no observation requests');
        await evaluate(()=>{const frame=document.getElementById('Gmap');window.__oldSnowDocument=frame.contentDocument;frame.src=frame.src;});
        await wait(()=>document.getElementById('Gmap').contentDocument!==window.__oldSnowDocument,'new native frame identity');await waitMarkers(2);stable(initial,await geometry(),'frame replacement');
        cases.push({width,theme,states:['pending','off','ready','keyboard-popup','live-theme','cached','frame-replacement']});
    }
    await prepare(1440,'light','service-error');await click('#bpb-snow-map-toggle');await open(true);
    await wait(()=>document.querySelector('[data-layer="snotel"]').dataset.status==='error','station service failure');const failed=await geometry();
    setMode('loading');await click('.bpb-snow-map-notice button');await wait(()=>document.querySelector('[data-layer="snotel"]').dataset.status==='loading','retry pending');stable(failed,await geometry(),'retry');
    setMode('complete');release();await ready();await waitMarkers(2);stable(failed,await geometry(),'retry success');
    await click('#bpb-terrain-toggle');await frameWait(()=>document.querySelectorAll('.bpb-snotel-marker').length===2,'3D viewport stations');
    const renderer=await evaluateTerrain(()=>{const gl=document.querySelector('canvas.maplibregl-canvas').getContext('webgl2'),info=gl.getExtension('WEBGL_debug_renderer_info');return info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
    assert.ok(renderer&&!/swiftshader|software|llvmpipe/i.test(renderer),`hardware renderer required: ${renderer}`);
    await evaluateTerrain(()=>document.querySelector('.bpb-snotel-marker').focus());await press(key('Enter'));await frameWait(()=>!!document.querySelector('.bpb-snotel-popup'),'3D keyboard popup');anchored(await popupAnchor());
    await evaluateTerrain(()=>{const style=document.createElement('style');style.id='snow-anchor-negative';style.textContent='.bpb-snotel-map-popup{left:12px!important;top:92px!important;transform:none!important}.bpb-snotel-map-popup .maplibregl-popup-tip{display:none!important}';document.head.append(style);});
    const detached=await popupAnchor();assert.throws(()=>anchored(detached));await evaluateTerrain(()=>document.getElementById('snow-anchor-negative').remove());anchored(await popupAnchor());
    await press(key('Escape'));await frameWait(()=>!document.querySelector('.bpb-snotel-popup'),'Escape closes popup before exiting 3D');
    await click('#bpb-snow-map-toggle');await frameWait(()=>!document.querySelector('.bpb-snotel-marker'),'3D stations off');await click('#bpb-snow-map-toggle');await frameWait(()=>document.querySelectorAll('.bpb-snotel-marker').length===2,'3D stations restored');
    await click('#bpb-terrain-toggle');await waitMarkers(2);await click('#bpb-terrain-toggle');await frameWait(()=>document.querySelectorAll('.bpb-snotel-marker').length===2,'parked 3D resume');
    await setSettings({theme:'dark',enable3dMap:true,showSnotel:false});await frameWait(()=>!document.querySelector('.bpb-snotel-marker'),'master opt-out clears stations');
    cases.push({states:['error','retry','3D','popup','escape','off','on','2D','resume','opt-out']});
    await prepare(375,'dark','no-stations');await click('#bpb-snow-map-toggle');await open(true);await wait(()=>document.querySelector('[aria-label="SNOTEL stations settings"]').textContent.includes('No SNOTEL stations'),'empty viewport');await waitMarkers(0);
    await prepare(375,'dark','error');await click('#bpb-snow-map-toggle');await open(true);await wait(()=>document.querySelector('[aria-label="SNOTEL stations settings"] .bpb-layers-retry').getAttribute('aria-disabled')==='true','NRCS cooldown');
    const count=snowEvidence.length;const point=await evaluate(()=>{const r=document.querySelector('[aria-label="SNOTEL stations settings"] .bpb-layers-retry').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
    await clickPoint(point.x,point.y);await evaluate(()=>document.querySelector('[aria-label="SNOTEL stations settings"] .bpb-layers-retry').focus());await press(key('Enter'));assert.equal(snowEvidence.length,count,'cooldown blocks pointer and keyboard retry');
    await prepare(375,'dark','complete');await setZoom(2);await click('#bpb-snow-map-toggle');await ready();await image('zoom-200');await setZoom(1);
    cases.push({states:['empty','rate-limit','blocked-retry','zoom-200']});
    const cardGeometry = () => evaluate(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const card = document.getElementById('bpb-peak-snow');
        return { card: rect(card), heading: rect(card.querySelector('h2')), action: rect(card.querySelector('.bpb-snow-refresh')),
            picker: rect(card.querySelector('select')), context: rect(card.querySelector('.bpb-snow-context')),
            metrics: rect(card.querySelector('.bpb-snow-metrics')),
            scroll: { x: window.scrollX, y: window.scrollY } };
    });
    const stableCard = (before, after) => {
        for (const part of Object.keys(before)) for (const dim of Object.keys(before[part])) {
            assert.ok(Math.abs(before[part][dim] - after[part][dim]) <= 1, `station card ${part}.${dim} moved during load/recovery`);
        }
    };
    const cardReady = stationId => waitForCondition(() => evaluate(() => ({
        busy: document.getElementById('bpb-peak-snow').getAttribute('aria-busy'),
        station: document.getElementById('bpb-peak-snow-station').value,
        status: document.querySelector('.bpb-snow-status').textContent,
        focus: document.activeElement.id,
    })), { description: `card conditions at ${stationId}`, timeoutMs: 15_000,
        isReady: state => state.busy === 'false' && state.station === stationId && state.status.includes('Hourly readings') });
    for (const [width, theme] of [[1440, 'light'], [375, 'dark']]) {
        await prepare(width, theme, 'map-selection'); await click('#bpb-snow-map-toggle'); await ready(); await waitMarkers(4);
        await evaluate(() => document.getElementById('bpb-peak-snow').scrollIntoView({ block: 'start' }));
        await cardReady('994:WA:SNTL');
        assert.equal(await evaluate(() => document.getElementById('bpb-peak-snow-station').options.length), 3);
        await click('#bpb-peak-snow .bpb-peak-card-toggle');
        await wait(() => document.querySelector('#bpb-peak-snow .bpb-peak-card-body').hidden, 'collapsed snow card before map selection');
        await evaluate(() => {
            document.querySelector('.bpb-terrain-mount-peak').scrollIntoView({ block: 'center' });
            document.getElementById('Gmap').contentDocument.querySelector('[title="Station 1 · SNOTEL"]').focus();
        });
        await press(key('Enter'));
        await wait(() => !!document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-show-conditions'), 'native conditions action');
        setMode('loading');
        await evaluate(() => document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-show-conditions').focus());
        await press(key('Enter'));
        await wait(() => document.getElementById('bpb-peak-snow').getAttribute('aria-busy') === 'true'
            && document.getElementById('bpb-peak-snow-station').value === '991:WA:SNTL', 'map-selected station pending in card');
        assert.equal(await evaluate(() => document.activeElement.id), 'bpb-peak-snow-station');
        assert.equal(await evaluate(() => document.querySelector('#bpb-peak-snow .bpb-peak-card-body').hidden), false,
            'Show conditions reveals the collapsed card before focusing the station');
        assert.equal(await evaluate(() => document.querySelector('.bpb-snow-metric strong').textContent), '—');
        const pendingCard = await cardGeometry(); await image(`${width}-${theme}-map-conditions-pending`);
        setMode('service-error'); release();
        await wait(() => document.querySelector('.bpb-snow-status').textContent.includes('Could not load'), 'map-selected station error');
        assert.equal(await evaluate(() => document.getElementById('bpb-peak-snow-station').value), '994:WA:SNTL', 'failed replacement retains the previous station identity');
        stableCard(pendingCard, await cardGeometry());
        // Failure restores the displayed station. Refresh intentionally refreshes
        // that station; retrying a replacement requires selecting it explicitly.
        setMode('map-selection'); await evaluate(() => {
            const select = document.getElementById('bpb-peak-snow-station'); select.value = '991:WA:SNTL'; select.dispatchEvent(new Event('change'));
        }); await cardReady('991:WA:SNTL');
        stableCard(pendingCard, await cardGeometry());
        assert.equal(await evaluate(() => document.querySelector('.bpb-snow-metric strong').textContent), '41.0 in');
        assert.equal(await evaluate(() => document.getElementById('bpb-peak-snow-station').options.length), 4);
        await image(`${width}-${theme}-map-conditions-ready`);

        await evaluate(() => document.querySelector('.bpb-terrain-mount-peak').scrollIntoView({ block: 'center' }));
        await click('#bpb-terrain-toggle'); await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 4, '3D stations with conditions actions');
        await evaluateTerrain(() => document.querySelector('[title="Station 2 · SNOTEL"]').focus()); await press(key('Enter'));
        await frameWait(() => !!document.querySelector('.bpb-snotel-show-conditions'), '3D conditions action');
        await evaluateTerrain(() => document.querySelector('.bpb-snotel-show-conditions').focus()); await press(key('Enter'));
        await cardReady('992:WA:SNTL');
        assert.equal(await evaluate(() => document.activeElement.id), 'bpb-peak-snow-station');
        assert.equal(await evaluate(() => document.querySelector('.bpb-snow-metric strong').textContent), '21.0 in');
        await image(`${width}-${theme}-3d-conditions-ready`);
        cases.push({ width, theme, states: ['2D-card-selection', 'pending', 'error', 'retry', 'fourth-nearest', '3D-card-selection'] });
    }
    setMode('complete');
    await setSettings({ theme: 'dark', units: 'imperial', showWeather: true, showSnotel: false });
    await writeLocal({ bpbSnotelCatalogV1: null }); const beforeOptOut = snowEvidence.length;
    await navigate(`${origin}/peak.aspx?pid=2296&snotel=disabled`);
    await wait(() => document.getElementById('bpb-peak-snow-row')?.hidden === true
        && document.querySelector('[data-layer="snotel"] input')?.disabled === true
        && document.getElementById('bpb-peak-weather')?.hidden === false, 'SNOTEL disabled on a fresh peak page');
    await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start' }));
    await wait(() => document.querySelectorAll('.bpb-week-day').length === 16
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'forecast remains usable without SNOTEL');
    assert.equal(snowEvidence.length, beforeOptOut, 'disabled SNOTEL makes no catalog or observation requests');
    await setSettings({ theme: 'dark', units: 'imperial', showWeather: false, showSnotel: true });
    await wait(() => document.getElementById('bpb-peak-weather').hidden
        && !document.getElementById('bpb-peak-snow-row').hidden, 'SNOTEL enabled independently of weather');
    await evaluate(() => document.getElementById('bpb-peak-snow').scrollIntoView({ block: 'start' }));
    await cardReady('679:WA:SNTL');
    cases.push({ states: ['SNOTEL-off-forecast-on', 'no-NRCS-requests', 'SNOTEL-on-forecast-off'] });

    assert.deepEqual(networkErrors,[]);assert.ok(cases.length>0);return{renderer,cases,snowRequests:snowEvidence.length};
}
