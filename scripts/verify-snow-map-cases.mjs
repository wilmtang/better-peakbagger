// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle, requestAnimationFrame */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifySnowMapCases({ origin, evaluate, evaluateTerrain, navigate, click, clickPoint, press, resize, screenshotPage,
    setSettings, setZoom, wait, writeLocal, setMode, release, snowEvidence, networkErrors, firefoxMode }) {
    const output = process.env.BPB_VERIFY_SNOW_MAP_SCREENSHOT_DIR, cases = [];
    if (output) await mkdir(output, { recursive: true });
    const browser = firefoxMode ? 'firefox' : 'chrome';
    const selection = process.env.BPB_VERIFY_SNOW_MAP_CASE || 'all';
    if (!['all', 'terrain'].includes(selection)) throw new Error(`Unknown snow map case: ${selection}`);
    const key = name => firefoxMode ? { Enter: '\uE007', Space: '\uE00D', Escape: '\uE00C' }[name] : name;
    const image = async name => { if (output) await screenshotPage(path.join(output, `${browser}-${name}.png`)); };
    const geometry = () => evaluate(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const mount = document.querySelector('.bpb-terrain-mount-peak');
        return { toggle: rect(document.getElementById('bpb-snow-map-toggle')), mode: rect(document.getElementById('bpb-terrain-toggle')), map: rect(mount),
            heading: rect(document.querySelector('h1')), following: rect(mount.closest('td').querySelector('a[href*="BigMap"]')),
            scroll: { x: window.scrollX, y: window.scrollY }, focus: document.activeElement.id };
    });
    const stable = (before, after, label) => {
        for (const part of ['toggle', 'mode', 'map', 'heading', 'following', 'scroll']) for (const dim of Object.keys(before[part])) {
            assert.ok(Math.abs(before[part][dim] - after[part][dim]) <= 1, `${label}: ${part}.${dim} moved; ${JSON.stringify({ before, after })}`);
        }
    };
    const markerCount = () => evaluate(() => document.getElementById('Gmap').contentDocument.querySelectorAll('.bpb-snotel-marker').length);
    const waitMarkers = count => waitForCondition(markerCount, { description: `${count} native snow markers`, timeoutMs: 10_000, isReady: value => value === count });
    const ready = () => wait(() => document.getElementById('bpb-snow-map-toggle')?.getAttribute('aria-busy') === 'false'
        && document.querySelector('.bpb-snow-map-notice')?.hidden === true, 'settled snow layer');
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
    const nativeHeaderThemeShift = () => evaluate(() => {
        // Measure the existing page-wide theme layout without the new popup
        // rules. Narrow native header controls can wrap differently between
        // themes; the popup change must add no movement to that baseline.
        const root = document.documentElement, sheet = document.getElementById('bpb-site-dark');
        const css = sheet.textContent, theme = root.getAttribute('data-bpb-theme');
        const start = css.indexOf('html[data-bpb-theme="dark"] .leaflet-popup');
        if (start < 0) throw new Error('Native popup CSS is missing from the site sheet');
        try {
            sheet.textContent = css.slice(0, start);
            const before = document.querySelector('h1').getBoundingClientRect().y;
            root.setAttribute('data-bpb-theme', theme === 'dark' ? 'light' : 'dark');
            return document.querySelector('h1').getBoundingClientRect().y - before;
        } finally { root.setAttribute('data-bpb-theme', theme); sheet.textContent = css; }
    });
    const aligned = state => assert.ok(Math.abs(state.map.x + state.map.width - state.toggle.x - state.toggle.width - 10) <= 1,
        'SNOTEL shares the right inset of the map controls');
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
    const prepare = async (width, theme, mode = 'loading') => {
        await resize(width, 1100); await setSettings({ theme, units: 'imperial', enable3dMap: true, showSunMoon: false, showWeather: true, showSnotel: true });
        await writeLocal({ bpbSnotelCatalogV1: null }); setMode(mode);
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map-first`);
        await wait(() => document.getElementById('bpb-snow-map-toggle')?.hidden === false, 'available snow toggle');
        await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start' }));
        await wait(() => document.querySelectorAll('.bpb-week-day').length === 16
            && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'settled neighboring forecast');
        // Weather and terrain have independent settings readers. Wait for the
        // terrain coordinator's actual input before its trusted activation.
        await evaluate(() => {
            window.__snotelTerrainEnabled = false;
            window.addEventListener('message', event => {
                if (event.source === window && event.origin === window.location.origin && event.data?.__bpbPeakMap === true
                    && event.data.dir === 'toPage') window.__snotelTerrainEnabled = event.data.enable3dMap === true;
            });
            window.postMessage({ __bpbPeakMap: true, dir: 'toCS', type: 'get' }, window.location.origin);
        });
        await wait(() => window.__snotelTerrainEnabled === true, 'terrain settings available to the coordinator');
        await evaluate(() => {
            document.querySelector('.bpb-terrain-mount-peak').scrollIntoView({ block: 'center' });
            document.getElementById('bpb-snow-map-toggle').focus({ preventScroll: true });
        });
        assert.equal(await markerCount(), 0, 'the layer starts off');
    };
    for (const width of selection === 'all' ? [1440, 375] : []) for (const theme of ['light', 'dark']) {
        await prepare(width, theme); const initial = await geometry();
        assert.equal(await evaluate(() => document.getElementById('bpb-snow-map-toggle').textContent), 'SNOTEL');
        assert.ok(initial.toggle.width <= 100 && initial.toggle.height <= 34, 'compact control');
        aligned(initial);
        assert.ok(initial.toggle.x >= initial.map.x && initial.toggle.x + initial.toggle.width <= initial.map.x + initial.map.width, 'toggle inside map');
        if (width === 1440 && theme === 'light') await evaluate(() => {
            const win = document.getElementById('Gmap').contentWindow, map = win.mapsPlaceholder;
            map.setView([46.851731, -121.760395], 14, { animate: false });
            win.__snowRevealZooms = []; win.__snowRevealEnds = 0;
            map.on('move', () => win.__snowRevealZooms.push(map.getZoom()));
            map.on('moveend', () => win.__snowRevealEnds++);
        });
        await press(key('Enter'));
        await wait(() => document.getElementById('bpb-snow-map-toggle').getAttribute('aria-busy') === 'true', 'pending snow layer');
        stable(initial, await geometry(), 'pending layer'); await image(`${width}-${theme}-pending`);
        await press(key('Space')); await waitMarkers(0);
        assert.equal(await evaluate(() => document.getElementById('bpb-snow-map-toggle').getAttribute('aria-pressed')), 'false');
        await press(key('Enter')); setMode('complete'); release(); await ready(); await waitMarkers(2);
        if (width === 1440 && theme === 'light') await waitForCondition(() => evaluate(() => {
            const win = document.getElementById('Gmap').contentWindow;
            return { zoom: win.mapsPlaceholder.getZoom(), ended: win.__snowRevealEnds > 0, visible: [...win.document.querySelectorAll('.bpb-snotel-marker')].slice(0, 3).every(pin => {
                const r = pin.getBoundingClientRect();
                return r.left >= 0 && r.right <= win.innerWidth && r.top >= 0 && r.bottom <= win.innerHeight;
            }) };
        }), { description: 'enabling SNOTEL reveals an offscreen station', timeoutMs: 5000,
            isReady: state => state.zoom < 14 && state.visible && state.ended });
        if (width === 1440 && theme === 'light') assert.ok(await evaluate(() =>
            new Set(document.getElementById('Gmap').contentWindow.__snowRevealZooms.map(zoom => zoom.toFixed(2))).size > 2),
        '2D reveal paints intermediate zoom levels');
        stable(initial, await geometry(), 'ready layer'); assert.equal((await geometry()).focus, 'bpb-snow-map-toggle');
        if (theme === 'dark') {
            const activeColor = () => evaluate(() => getComputedStyle(document.getElementById('bpb-snow-map-toggle')).backgroundColor);
            assert.equal(await activeColor(), 'rgb(25, 73, 101)', 'dark selected state remains visible');
            if (width === 1440) {
                // Recreate the site's former generic !important button rule.
                // The assertion must fail on the real user-visible color loss.
                await evaluate(() => {
                    const style = document.createElement('style'); style.id = 'snow-color-regression';
                    style.textContent = 'html[data-bpb-theme="dark"] button.bpb-snow-map-toggle{background:#2b2f34!important}'; document.head.append(style);
                });
                const regressed = await activeColor(); assert.throws(() => assert.equal(regressed, 'rgb(25, 73, 101)'));
                await evaluate(() => document.getElementById('snow-color-regression').remove());
                assert.equal(await activeColor(), 'rgb(25, 73, 101)');
            }
        }
        assert.equal(await evaluate(() => {
            const win = document.getElementById('Gmap').contentWindow;
            return win.nativeLayers.every(layer => win.mapsPlaceholder.hasLayer(layer));
        }), true, 'native summit and route remain present');
        await image(`${width}-${theme}-ready`);
        await evaluate(() => document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-marker').focus());
        await press(key('Enter'));
        await wait(() => !!document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-popup'), 'keyboard native station popup');
        await popupSettled();
        assert.match(await evaluate(() => document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-popup').textContent), /Paradise.*SNOTEL.*View NRCS snow data/);
        themedPopup(await popupPalette(), theme);
        assert.equal(await evaluate(() => {
            const win = document.getElementById('Gmap').contentWindow, bounds = win.document.querySelector('.leaflet-popup').getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= win.innerWidth && bounds.top >= 0 && bounds.bottom <= win.innerHeight;
        }), true, 'native station popup fits the map');
        await image(`${width}-${theme}-popup`);
        await evaluate(() => document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-show-conditions').focus({ preventScroll: true }));
        const popupBefore = await popupGeometry(), pageBefore = await geometry(), headerShift = await nativeHeaderThemeShift();
        for (const next of [theme === 'dark' ? 'light' : 'dark', theme]) {
            await setSettings({ theme: next, units: 'imperial', enable3dMap: true, showSunMoon: false, showWeather: true, showSnotel: true });
            await waitForCondition(popupPalette, { description: `native popup changes to ${next}`, timeoutMs: 5000,
                isReady: palette => palette.background === (next === 'dark' ? 'rgb(39, 44, 41)' : 'rgb(255, 255, 255)') });
            themedPopup(await popupPalette(), next);
            assert.deepEqual(await popupGeometry(), popupBefore, 'live theme changes preserve popup geometry, map paint, scroll and keyboard focus');
            const after = await geometry();
            if (next !== theme) for (const part of ['toggle', 'mode', 'map', 'heading', 'following']) after[part].y -= headerShift;
            stable(pageBefore, after, 'live popup theme adds no shift beyond the native header baseline');
        }
        await image(`${width}-${theme}-popup-focus`);
        await click('#bpb-snow-map-toggle'); await waitMarkers(0);
        const requests = snowEvidence.length; await click('#bpb-snow-map-toggle'); await ready(); await waitMarkers(2);
        assert.equal(snowEvidence.length, requests, 'toggling cached metadata does not fetch observations');
        stable(initial, await geometry(), 'cached toggle');
        // A native iframe reload must restore the overlay without touching the
        // parent toggle, camera, or surrounding document.
        await evaluate(() => {
            const frame = document.getElementById('Gmap'); window.__snowOldMapDocument = frame.contentDocument; frame.src = frame.src;
        });
        await wait(() => document.getElementById('Gmap').contentDocument !== window.__snowOldMapDocument,
            'native iframe navigation installs a new document');
        await waitMarkers(2); stable(initial, await geometry(), 'frame reload');
        await evaluate(() => { document.getElementById('Gmap').contentWindow.nativePeak.openPopup(); });
        await popupSettled(); themedPopup(await popupPalette(), theme);
        await image(`${width}-${theme}-summit-popup`);
        cases.push({ width, theme, nativeHeaderThemeShift: headerShift,
            states: ['off', 'pending', 'cancel', 'ready', 'popup', 'live-theme', 'cached', 'frame-reload', 'summit-popup'] });
        console.log(`${browser} ${width}/${theme}: stable snow layer and keyboard popup`);
    }
    await prepare(1440, 'light', 'service-error'); await click('#bpb-snow-map-toggle');
    await wait(() => document.querySelector('.bpb-snow-map-notice button')?.hidden === false, 'retryable snow failure');
    const error = await geometry(); await image('error');
    setMode('loading'); await click('.bpb-snow-map-notice button');
    await wait(() => document.getElementById('bpb-snow-map-toggle').getAttribute('aria-busy') === 'true', 'retry pending');
    stable(error, await geometry(), 'error retry');
    setMode('complete'); release(); await ready(); await waitMarkers(2); stable(error, await geometry(), 'retry success');
    cases.push({ states: ['error', 'retry', 'success'] });

    // The same outer toggle controls the real authorized extension renderer.
    await evaluate(() => {
        window.__snotelTerrainEvents = [];
        window.addEventListener('click', event => {
            if (event.target.closest?.('#bpb-terrain-toggle')) window.__snotelTerrainEvents.push({ click: event.isTrusted });
        }, true);
        window.addEventListener('message', event => {
            if (event.data?.__bpbTerrain || event.data?.__bpbPeakMap) window.__snotelTerrainEvents.push(event.data);
        });
    });
    const nativeControls = await geometry();
    await click('#bpb-terrain-toggle');
    await waitForCondition(() => evaluate(() => ({ pressed: document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed'),
        frame: !!document.getElementById('bpb-terrain-frame'), failure: document.querySelector('.bpb-terrain-failure')?.textContent,
        events: window.__snotelTerrainEvents?.slice(-8) })), {
        description: 'real 3D extension renderer', timeoutMs: 40_000, isReady: value => value.pressed === 'true' && value.frame,
    });
    const frameWait = (fn, description) => waitForCondition(() => evaluateTerrain(fn), { description, timeoutMs: 15_000 });
    await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 2, '3D snow markers');
    stable(nativeControls, await geometry(), '2D to 3D controls');
    const renderer = await evaluateTerrain(() => {
        const canvas = document.querySelector('canvas.maplibregl-canvas'), gl = canvas?.getContext('webgl2');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    });
    assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
    await image('3d-stations');
    await evaluateTerrain(() => document.querySelector('.bpb-snotel-marker').focus()); await press(key('Enter'));
    await waitForCondition(() => evaluateTerrain(() => ({ popup: !!document.querySelector('.bpb-snotel-popup'),
        focus: document.activeElement?.outerHTML?.slice(0, 300), markers: document.querySelectorAll('.bpb-snotel-marker').length })), {
        description: '3D keyboard popup', timeoutMs: 10_000, isReady: state => state.popup,
    });
    await frameWait(() => {
        const hint = document.querySelector('.bpb-terrain-hint');
        return !hint || getComputedStyle(hint).opacity === '0';
    }, 'gesture hint finishes hiding for station details'); await image('3d-popup');
    anchored(await popupAnchor());
    // Challenge the assertions with the previous, detached corner popover
    // and inset control in disposable fixture DOM, without changing sources.
    await evaluateTerrain(() => {
        const style = document.createElement('style'); style.id = 'snotel-anchor-regression';
        style.textContent = '.bpb-snotel-map-popup{left:12px!important;top:92px!important;transform:none!important}.bpb-snotel-map-popup .maplibregl-popup-tip{display:none!important}';
        document.head.append(style);
    });
    const detached = await popupAnchor(); assert.throws(() => anchored(detached));
    await evaluateTerrain(() => document.getElementById('snotel-anchor-regression').remove());
    anchored(await popupAnchor());
    const controlBefore = await geometry(); aligned(controlBefore);
    await evaluate(() => document.getElementById('bpb-snow-map-toggle').style.right = '58px');
    const inset = await geometry(); assert.throws(() => aligned(inset));
    await evaluate(() => document.getElementById('bpb-snow-map-toggle').style.removeProperty('right'));
    aligned(await geometry());
    await press(key('Escape')); await frameWait(() => !document.querySelector('.bpb-snotel-popup'), 'Escape closes station popup');
    assert.equal(await evaluate(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed')), 'true', 'popup Escape keeps 3D open');
    await click('#bpb-snow-map-toggle'); await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 0, '3D layer off');
    await click('#bpb-snow-map-toggle'); await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 2, '3D layer on');
    await click('#bpb-terrain-toggle'); await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'false', 'return to native map');
    stable(nativeControls, await geometry(), '3D to 2D controls');
    await waitMarkers(2);
    await click('#bpb-terrain-toggle'); await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 2, 'parked 3D resume');
    await setSettings({ theme: 'dark', units: 'imperial', enable3dMap: true, showSunMoon: false, showWeather: true, showSnotel: false });
    await wait(() => document.getElementById('bpb-snow-map-toggle').hidden, 'settings disable layer');
    await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 0, 'settings clear 3D layer');
    assert.equal(await markerCount(), 0);
    assert.equal(await evaluate(() => document.getElementById('bpb-peak-snow-row').hidden), true);
    assert.equal(await evaluate(() => document.getElementById('bpb-peak-weather').hidden), false, 'SNOTEL opt-out preserves forecast');
    await setSettings({ theme: 'dark', units: 'imperial', enable3dMap: true, showSunMoon: false, showWeather: true, showSnotel: true });
    await wait(() => !document.getElementById('bpb-snow-map-toggle').hidden, 'settings restore control');
    assert.equal(await evaluate(() => document.getElementById('bpb-snow-map-toggle').getAttribute('aria-pressed')), 'false');
    cases.push({ renderer, states: ['3D', 'popup', 'Escape', 'off', 'on', '2D', 'resume', 'settings'] });

    await evaluate(() => window.localStorage.setItem('pbPeakMapViewport.v1', JSON.stringify({ width: 320, height: 240 })));
    await prepare(375, 'dark', 'long-station'); await click('#bpb-snow-map-toggle'); await ready(); await waitMarkers(2);
    const minimumControls = await geometry();
    await click('#bpb-terrain-toggle');
    await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true', 'narrow 3D view');
    await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 2, 'narrow 3D snow markers');
    stable(minimumControls, await geometry(), 'minimum-size mode switch');
    assert.equal(await evaluate(() => {
        const snow = document.getElementById('bpb-snow-map-toggle').getBoundingClientRect();
        return [...document.querySelectorAll('#bpb-terrain-toggle, .bpb-map-compass')].every(node => {
            const r = node.getBoundingClientRect();
            return snow.right <= r.left || snow.left >= r.right || snow.bottom <= r.top || snow.top >= r.bottom;
        });
    }), true, 'SNOTEL never covers the 3D navigation controls at the minimum map height');
    await evaluateTerrain(() => document.querySelector('.bpb-snotel-marker').focus()); await press(key('Space'));
    await frameWait(() => !!document.querySelector('.bpb-snotel-popup'), 'long-name 3D popup');
    anchored(await popupAnchor()); aligned(await geometry());
    assert.equal(await evaluateTerrain(() => getComputedStyle(document.querySelector('.bpb-snotel-popup a')).color),
        'rgb(170, 208, 255)', 'NRCS link uses the readable dark popup palette');
    assert.equal(await evaluateTerrain(() => {
        const r = document.querySelector('.maplibregl-popup').getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    }), true, 'long-name popup fits the narrow 3D map');
    const popup = await evaluateTerrain(() => {
        const r = document.querySelector('.maplibregl-popup').getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    assert.ok(popup.right - popup.left > 100 && popup.bottom - popup.top > 40, 'station details have a painted content area');
    const controls = await evaluate(() => {
        const frame = document.getElementById('bpb-terrain-frame').getBoundingClientRect();
        return ['bpb-snow-map-toggle', 'bpb-terrain-toggle', 'bpb-terrain-compass'].map(id => {
            const r = document.getElementById(id).getBoundingClientRect();
            return { id, left: r.left - frame.left, right: r.right - frame.left, top: r.top - frame.top, bottom: r.bottom - frame.top };
        });
    });
    for (const control of controls) assert.ok(popup.right <= control.left || popup.left >= control.right || popup.bottom <= control.top || popup.top >= control.bottom,
        `station popup stays clear of ${control.id} at minimum size`);
    await frameWait(() => {
        const hint = document.querySelector('.bpb-terrain-hint');
        return !hint || getComputedStyle(hint).opacity === '0';
    }, 'minimum-map gesture hint finishes hiding');
    await evaluateTerrain(() => document.querySelector('.bpb-snotel-show-conditions').focus());
    assert.equal(await evaluateTerrain(() => {
        const action = document.querySelector('.bpb-snotel-show-conditions'), r = action.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight
            && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === action;
    }), true, 'conditions action stays visible and usable in the minimum-size popup');
    await image('375-dark-3d-conditions-action');
    await evaluateTerrain(() => document.querySelector('.bpb-snotel-popup a').focus());
    assert.equal(await evaluateTerrain(() => {
        const link = document.querySelector('.bpb-snotel-popup a'), r = link.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('a') === link;
    }), true, 'source link remains visible and usable in the minimum-size popover');
    await image('375-dark-3d-long-name'); cases.push({ width: 375, theme: 'dark', states: ['3D', 'long-name-popup'] });
    await setSettings({ theme: 'dark', units: 'imperial', enable3dMap: true, showSunMoon: false, showWeather: true, showSnotel: false });
    await wait(() => document.getElementById('bpb-snow-map-toggle').hidden, 'minimum map SNOTEL disabled');
    await setSettings({ theme: 'dark', units: 'imperial', enable3dMap: true, showSunMoon: false, showWeather: true, showSnotel: true });
    await wait(() => !document.getElementById('bpb-snow-map-toggle').hidden, 'minimum map SNOTEL restored');
    assert.equal(await evaluate(() => {
        const snow = document.getElementById('bpb-snow-map-toggle').getBoundingClientRect();
        const compass = document.getElementById('bpb-terrain-compass').getBoundingClientRect();
        return snow.right <= compass.left || snow.left >= compass.right || snow.bottom <= compass.top || snow.top >= compass.bottom;
    }), true, 'restoring SNOTEL on the minimum map keeps the compass clear');
    await evaluate(() => window.localStorage.removeItem('pbPeakMapViewport.v1'));

    await prepare(1440, 'dark'); await setZoom(2);
    await evaluate(() => document.querySelector('.bpb-terrain-mount-peak').scrollIntoView({ block: 'center' }));
    const zoom = await geometry(); await click('#bpb-snow-map-toggle');
    await wait(() => document.getElementById('bpb-snow-map-toggle').getAttribute('aria-busy') === 'true', '200% pending');
    stable(zoom, await geometry(), '200% pending'); setMode('complete'); release(); await ready(); await waitMarkers(2);
    stable(zoom, await geometry(), '200% ready');
    await click('#bpb-terrain-toggle');
    await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true', '200% 3D view');
    stable(zoom, await geometry(), '200% 2D to 3D');
    await click('#bpb-terrain-toggle');
    await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'false', '200% return to 2D');
    stable(zoom, await geometry(), '200% 3D to 2D');
    await evaluate(() => document.getElementById('Gmap').contentDocument.querySelector('.bpb-snotel-marker').focus());
    await press(key('Enter')); await popupSettled(); themedPopup(await popupPalette(), 'dark');
    await image('zoom-200'); await setZoom(1);
    cases.push({ zoom: 2, states: ['pending', 'ready', '3D', '2D'] });
    await prepare(375, 'light', 'no-stations'); await click('#bpb-snow-map-toggle');
    await wait(() => document.querySelector('.bpb-snow-map-notice')?.textContent.includes('No SNOTEL stations'), 'no coverage');
    await image('no-stations'); await waitMarkers(0); cases.push({ states: ['no-stations'] });

    await prepare(375, 'dark', 'error'); await click('#bpb-snow-map-toggle');
    await wait(() => document.querySelector('.bpb-snow-map-notice button')?.getAttribute('aria-disabled') === 'true', 'NRCS retry cooldown');
    const limited = await geometry(), requests = snowEvidence.length;
    await click('#bpb-snow-map-toggle'); await click('#bpb-snow-map-toggle');
    await wait(() => document.querySelector('.bpb-snow-map-notice')?.hidden === false
        && document.querySelector('.bpb-snow-map-notice')?.textContent.includes('NRCS is busy'), 'cooldown remains visible after toggling');
    const retryPoint = await evaluate(() => {
        const r = document.querySelector('.bpb-snow-map-notice button').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    // Locator.click intentionally refuses aria-disabled controls. Send a real
    // pointer click to prove the product's event guard, then real key input.
    await clickPoint(retryPoint.x, retryPoint.y);
    await evaluate(() => document.querySelector('.bpb-snow-map-notice button').focus({ preventScroll: true }));
    await press(key('Enter')); await press(key('Space'));
    assert.equal(snowEvidence.length, requests, 'pointer and keyboard cannot bypass NRCS cooldown');
    stable(limited, await geometry(), 'rate-limit off/on and unavailable Retry'); await image('375-dark-rate-limit');
    cases.push({ width: 375, theme: 'dark', states: ['rate-limit', 'off', 'on', 'retry-blocked'] });

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
        setMode('map-selection'); await click('.bpb-snow-refresh'); await cardReady('991:WA:SNTL');
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
        && document.getElementById('bpb-snow-map-toggle')?.hidden === true
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

    for (const [width, theme, reduced] of [[1440, 'light', false], [375, 'dark', false], [375, 'dark', true]]) {
        await prepare(width, theme, 'complete');
        await evaluate(() => {
            document.getElementById('Gmap').contentWindow.mapsPlaceholder
                .setView([46.851731, -121.760395], 14, { animate: false });
        });
        await click('#bpb-terrain-toggle');
        await wait(() => document.getElementById('bpb-terrain-frame')?.style.opacity === '1'
            && document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true', 'close 3D view ready');
        await evaluate(() => {
            window.__snowRevealCameras = [];
            window.addEventListener('message', event => {
                if (event.source === window && event.data?.__bpbTerrain === true && event.data.dir === 'toPage'
                    && event.data.type === 'camera') window.__snowRevealCameras.push(event.data.camera);
            });
        });
        await evaluateTerrain(() => {
            window.__snowRevealFrames = []; window.__snowRevealSampling = true;
            const sample = () => {
                const pin = document.querySelector('.bpb-snotel-marker');
                if (pin) {
                    const r = pin.getBoundingClientRect();
                    window.__snowRevealFrames.push({ x: r.x, y: r.y, width: r.width });
                }
                if (window.__snowRevealSampling) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        if (reduced) await evaluateTerrain(() => {
            const original = window.matchMedia.bind(window);
            window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? { matches: true } : original(query);
        });
        const before = await geometry();
        const nativeCamera = await evaluate(() => {
            const map = document.getElementById('Gmap').contentWindow.mapsPlaceholder;
            const center = map.getCenter(); return { lat: center.lat, lon: center.lng, zoom: map.getZoom() };
        });
        await click('#bpb-snow-map-toggle'); await ready();
        await waitForCondition(() => evaluate(() => window.__snowRevealCameras), {
            description: `${width}/${theme}: 3D SNOTEL reveal finishes`, timeoutMs: 20_000,
            isReady: cameras => cameras.some(camera => camera.zoom < 13),
        });
        await frameWait(() => {
            const pins = [...document.querySelectorAll('.bpb-snotel-marker')];
            return pins.length > 0 && pins.slice(0, 3).every(pin => {
                const r = pin.getBoundingClientRect();
                return r.width > 0 && r.left >= 12 && r.right <= window.innerWidth - 12 && r.top >= 12 && r.bottom <= window.innerHeight - 12;
            });
        }, '3D reveal fully exposes the framed stations inside the viewport');
        const samples = await evaluateTerrain(() => { window.__snowRevealSampling = false; return window.__snowRevealFrames; });
        if (!reduced) assert.ok(new Set(samples.filter(frame => frame.width > 0).map(frame => `${Math.round(frame.x)},${Math.round(frame.y)}`)).size > 2,
            `3D reveal paints intermediate camera positions: ${JSON.stringify(samples)}`);
        stable(before, await geometry(), '3D reveal keeps controls and reading position anchored');
        assert.equal((await geometry()).focus, 'bpb-snow-map-toggle');
        const afterNative = await evaluate(() => {
            const map = document.getElementById('Gmap').contentWindow.mapsPlaceholder;
            const center = map.getCenter(); return { lat: center.lat, lon: center.lng, zoom: map.getZoom() };
        });
        // The renderer owns its reveal. The hidden 2D camera changes only on
        // the ordinary mode handoff, never as a side effect of adding markers.
        assert.deepEqual(afterNative, nativeCamera, 'revealing 3D stations does not animate the hidden native map');
        await image(`${width}-${theme}-3d-reveal${reduced ? '-reduced-motion' : ''}`);
        await click('#bpb-snow-map-toggle'); await frameWait(() => !document.querySelector('.bpb-snotel-marker'), 'revealed layer off');
        const cameraCount = await evaluate(() => window.__snowRevealCameras.length);
        await click('#bpb-snow-map-toggle'); await frameWait(() => document.querySelectorAll('.bpb-snotel-marker').length === 2, 'visible stations restored');
        await evaluateTerrain(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await evaluate(() => window.__snowRevealCameras.length), cameraCount, 'an already visible station does not recenter');
        cases.push({ width, theme, reducedMotion: reduced, states: ['3D-offscreen', 'reveal', 'visible-no-recenter', 'stable-controls'] });
    }
    assert.deepEqual(networkErrors, []); assert.ok(cases.length > 0); return { renderer, cases, snowRequests: snowEvidence.length };
}
