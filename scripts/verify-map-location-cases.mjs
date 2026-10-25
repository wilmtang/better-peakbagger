// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, requestAnimationFrame, getComputedStyle */

import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifyMapLocationCases({ evaluate, evaluateTerrain, navigate, click, clickPoint, press, resize, wait,
    setSettings, setZoom, setMode, release, elevationEvidence, evidence, origin, screenshotPage, output, firefoxMode }) {
    const cases = [], measurements = [], menuId = 'bpb-peak-weather-menu';
    const urls = [
        '/Peak.aspx?pid=2296&week-weather=success',
        '/climber/ascent.aspx?aid=7654321',
        '/map/BigMap.aspx?t=L&d=1',
        '/map/MasterMap.aspx?t=L&d=1',
    ];
    const settings = { enable3dMap: false, showWeather: false, showSnotel: false, showSunMoon: false, units: 'imperial' };
    const geometry = () => {
        const menu = document.getElementById('bpb-peak-weather-menu');
        const rect = node => {
            if (!node || !node.getClientRects().length) return null;
            const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const frame = document.querySelector('iframe[src*="MasterMap" i]');
        return { menu: rect(menu), coordinates: rect(menu.querySelector('.bpb-weather-menu-coordinates')),
            action: rect(menu.querySelector('button')), heading: rect(document.querySelector('h1')), frame: rect(frame),
            following: rect(frame?.closest('tr')?.nextElementSibling), scroll: window.scrollY, pageWidth: document.documentElement.scrollWidth,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            overflow: [...menu.querySelectorAll('.bpb-map-location-value, .bpb-map-location-alternative, .bpb-weather-menu-coordinates, button:not([hidden])')]
                .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className) };
    };
    const stable = (before, after) => {
        for (const key of ['menu', 'coordinates', 'action', 'heading', 'frame', 'following']) {
            assert.equal(!!before[key], !!after[key], `visibility changed: ${key}`);
            if (before[key]) for (const dimension of ['x', 'y', 'width', 'height']) {
                assert.ok(Math.abs(before[key][dimension] - after[key][dimension]) <= 1, `${key}.${dimension}: ${JSON.stringify({ before, after })}`);
            }
        }
        assert.equal(after.scroll, before.scroll, 'reading position moved');
        assert.equal(after.pageWidth, before.pageWidth, 'document width changed');
        assert.deepEqual(after.overflow, [], 'menu text is clipped');
        assert.ok(after.menu.x >= 7 && after.menu.x + after.menu.width <= after.viewport.width - 7, JSON.stringify(after));
        assert.ok(after.menu.y >= 7 && after.menu.y + after.menu.height <= after.viewport.height - 7, JSON.stringify(after));
    };
    const nativePoint = () => evaluate(() => {
        const frame = document.querySelector('iframe[src*="MasterMap" i]'), owner = frame?.contentWindow || window;
        const target = frame || owner.mapsPlaceholder.getContainer(); target.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = target.getBoundingClientRect();
        const x = Math.round(Math.max(20, Math.min(window.innerWidth - 28, r.left + r.width * .4)));
        const y = Math.round(Math.max(30, Math.min(window.innerHeight - 30, r.top + r.height * .55)));
        const point = owner.mapsPlaceholder.mouseEventToLatLng({ clientX: x - (frame ? r.left + frame.clientLeft : 0), clientY: y - (frame ? r.top + frame.clientTop : 0) });
        return { x, y, coordinates: `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}` };
    });
    const settledPosition = async terrain => {
        let previous, matches = 0;
        await waitForCondition(async () => {
            const position = await evaluate(isTerrain => {
                const target = isTerrain ? document.getElementById('bpb-terrain-frame') : document.querySelector('iframe[src*="MasterMap" i]') || window.mapsPlaceholder.getContainer();
                const r = target.getBoundingClientRect();
                return [r.x, r.y, r.width, r.height, window.scrollY];
            }, terrain);
            const key = JSON.stringify(position); matches = key === previous ? matches + 1 : 0; previous = key;
            return { matches, position };
        }, { description: 'map settles after native content and viewport changes', isReady: value => value.matches >= 3 });
    };
    const open = async () => {
        await wait(() => {
            if (!/\/ascent\.aspx$/i.test(window.location.pathname)) return true;
            const canvas = document.querySelector('#bpb-gpx-analysis canvas');
            return canvas && window.Chart?.getChart(canvas)?.data.datasets.some(dataset => dataset.data.length > 2);
        }, 'native ascent analysis finished adding its content');
        await wait(() => {
            const frame = document.querySelector('iframe[src*="MasterMap" i]');
            return (frame?.contentWindow || window).mapsPlaceholder?.mouseEventToLatLng && document.getElementById('bpb-peak-weather-menu')
                && !!document.querySelector('.bpb-map-layers')?.style.left;
        }, 'native map and shared menu ready');
        await nativePoint();
        await wait(() => document.querySelector('.bpb-map-layers')?.hidden === false, 'native map in viewport');
        await settledPosition(false);
        const point = await nativePoint();
        await evaluate(() => {
            const frame = document.querySelector('iframe[src*="MasterMap" i]'), owner = frame?.contentWindow || window;
            window.__bpbExpectedPoint = null;
            owner.document.addEventListener('contextmenu', event => {
                const location = owner.mapsPlaceholder.mouseEventToLatLng(event);
                window.__bpbExpectedPoint = `${location.lat.toFixed(4)}, ${(((location.lng + 180) % 360 + 360) % 360 - 180).toFixed(4)}`;
            }, { capture: true, once: true });
        });
        await clickPoint(point.x, point.y, 'right');
        try { await wait(() => !document.getElementById('bpb-peak-weather-menu').hidden, 'location menu visible after native right-click'); }
        catch (error) {
            const diagnostic = await evaluate(() => ({ url: window.location.href,
                menu: document.getElementById('bpb-peak-weather-menu').outerHTML,
                controls: [...document.querySelectorAll('[class*="bpb-map-layer"]')].map(node => ({ class: node.className, hidden: node.hidden })),
                active: document.activeElement?.outerHTML.slice(0, 250), scroll: window.scrollY }));
            throw new Error(`${error.message}; point=${JSON.stringify(point)}; ${JSON.stringify(diagnostic)}`);
        }
        assert.equal(await evaluate(() => document.querySelector('.bpb-weather-menu-coordinates').textContent), await evaluate(() => window.__bpbExpectedPoint));
    };
    for (const url of urls) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
        await setSettings({ ...settings, theme }); setMode('elevation-loading');
        await resize(width, 1000); await navigate(origin + url);
        await wait(() => document.documentElement.dataset.bpbTheme, 'theme applied');
        const count = elevationEvidence.length;
        await open();
        await wait(() => document.getElementById('bpb-peak-weather-menu').dataset.state === 'loading', 'elevation pending');
        assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-menu button').hidden), true, 'weather opt-out preserves elevation only');
        const before = await evaluate(geometry);
        if (output && url.startsWith('/Peak') && theme === 'dark' && width === 375) {
            await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-location-pending.png`));
        }
        await evaluate(() => {
            window.__bpbLocationFrames = [];
            window.__bpbCollectLocation = true;
            const collect = () => {
                if (!window.__bpbCollectLocation) return;
                const r = document.getElementById('bpb-peak-weather-menu').getBoundingClientRect();
                window.__bpbLocationFrames.push({ x: r.x, y: r.y, width: r.width, height: r.height, scroll: window.scrollY });
                requestAnimationFrame(collect);
            }; requestAnimationFrame(collect);
        });
        await wait(() => window.__bpbLocationFrames.length >= 3, 'pending layout painted across frames');
        setMode('complete'); release();
        await wait(() => document.getElementById('bpb-peak-weather-menu').dataset.state === 'ready', 'decoded terrain elevation');
        stable(before, await evaluate(geometry));
        const frames = await evaluate(() => { window.__bpbCollectLocation = false; return window.__bpbLocationFrames; });
        for (const frame of frames) for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before.menu[dimension] - frame[dimension]) <= 1, JSON.stringify(frames));
        assert.ok(elevationEvidence.length > count, 'explicit right-click fetched terrain');
        assert.ok(await evaluate(() => document.querySelector('.bpb-map-location-value').textContent.startsWith('≈ ')));
        assert.equal(await evaluate(() => [...document.querySelectorAll('#bpb-peak-weather-menu [data-sizing-text]')].every(node => node.getAttribute('aria-hidden') === 'true' && getComputedStyle(node).visibility === 'hidden')), true);
        if (output && url.startsWith('/Peak')) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-location-${theme}-${width}.png`));
        const compact = await evaluate(() => {
            const menu = document.getElementById('bpb-peak-weather-menu');
            const primary = menu.querySelector('.bpb-map-location-value').getBoundingClientRect();
            const secondary = menu.querySelector('.bpb-map-location-alternative').getBoundingClientRect();
            return { width: menu.offsetWidth, height: menu.offsetHeight,
                sharedLine: secondary.left >= primary.right && secondary.top < primary.bottom };
        });
        assert.ok(compact.width <= 244 && compact.height <= 112 && compact.sharedLine,
            `elevation readout must stay compact with both units on one line: ${JSON.stringify(compact)}`);
        // Stress the complete accepted elevation range in both unit orders.
        // Only the visible labels change; the real sizing reservations and CSS
        // must keep the surrounding page and popup stable without clipping.
        for (const labels of [['≈ -39,370 ft', '-12,000 m'], ['≈ -12,000 m', '-39,370 ft'], ['≈ 10,000 m', '32,808 ft']]) {
            await evaluate(([primary, secondary]) => {
                document.querySelector('.bpb-map-location-value > span').textContent = primary;
                document.querySelector('.bpb-map-location-alternative > span').textContent = secondary;
            }, labels);
            stable(before, await evaluate(geometry));
        }
        await press(firefoxMode ? '\uE00C' : 'Escape');
        assert.equal(await evaluate(() => document.getElementById('bpb-peak-weather-menu').hidden), true);
        cases.push(`${url} ${theme} ${width} pending/success`); measurements.push(before);
    }
    // No-data and service failures keep the identical menu footprint. Reopening
    // after a transient failure is a fresh lookup, with no automatic retries.
    for (const mode of ['elevation-missing', 'elevation-error', 'elevation-limited']) {
        setMode(mode); await navigate(origin + urls[0]); await open(); const pending = await evaluate(geometry);
        await wait(() => ['unavailable', 'limited'].includes(document.getElementById('bpb-peak-weather-menu').dataset.state), mode);
        stable(pending, await evaluate(geometry));
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-location-${mode}.png`));
        if (mode === 'elevation-error') {
            await press(firefoxMode ? '\uE00C' : 'Escape'); setMode('complete'); await open();
            await wait(() => document.getElementById('bpb-peak-weather-menu').dataset.state === 'ready', 'reopened transient failure recovers');
        }
        cases.push(mode);
    }
    // Real browser zoom exercises the wrapping reservations, without fixed
    // heights or hiding the coordinates to manufacture stable dimensions.
    await setSettings({ ...settings, showWeather: true, theme: 'dark' });
    setMode('elevation-loading'); await navigate(origin + urls[0]); await setZoom(2);
    await wait(() => document.getElementById('bpb-peak-weather')?.dataset.bpbMapWeather === 'ready', 'forecast action available');
    await open(); const enlarged = await evaluate(geometry);
    assert.ok(enlarged.action); setMode('complete'); release();
    await wait(() => document.getElementById('bpb-peak-weather-menu').dataset.state === 'ready', 'enlarged reading');
    stable(enlarged, await evaluate(geometry));
    if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-location-forecast-zoom200.png`));
    // A deliberate menu jump must be caught by the same assertion.
    await evaluate(() => { const menu = document.getElementById('bpb-peak-weather-menu'); menu.style.top = `${parseFloat(menu.style.top) + 5}px`; });
    const moved = await evaluate(geometry);
    assert.throws(() => stable(enlarged, moved), /menu.y/);
    await press(firefoxMode ? '\uE00C' : 'Escape'); await setZoom(1);
    await open(); const weatherCount = evidence.length;
    if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-location-forecast.png`));
    await click(`#${menuId} button`);
    await wait(() => document.querySelector('.bpb-week-location-name').textContent !== 'At the summit', 'shared menu selects weather point');
    assert.ok(evidence.length > weatherCount, 'forecast action requests selected coordinates');
    cases.push('200% browser zoom, wrapped text, geometry negative control, forecast pointer activation');
    setMode('error'); await click('.bpb-week-refresh');
    await wait(() => document.querySelector('.bpb-week-status')?.dataset.kind === 'rate-limit', 'weather cooldown');
    await open();
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-menu button').disabled), true);
    assert.equal(await evaluate(() => document.activeElement === document.getElementById('bpb-peak-weather-menu')), true);
    const limitedCount = evidence.length;
    await press(firefoxMode ? '\uE007' : 'Enter'); assert.equal(evidence.length, limitedCount, 'disabled weather cannot activate');
    await press(firefoxMode ? '\uE00C' : 'Escape');
    cases.push('weather cooldown keeps elevation usable and blocks keyboard activation');
    setMode('complete'); await setSettings({ ...settings, theme: 'light' }); await navigate(origin + urls[0]);
    await open(); await press(firefoxMode ? '\uE00C' : 'Escape');
    await evaluate(() => {
        const frame = document.getElementById('Gmap'); window.__bpbPreviousMapDocument = frame.contentDocument;
        frame.contentWindow.location.reload();
    });
    await wait(() => {
        const doc = document.getElementById('Gmap').contentDocument;
        return doc !== window.__bpbPreviousMapDocument && doc.readyState === 'complete';
    }, 'replacement map document loaded');
    await evaluate(() => { delete window.__bpbPreviousMapDocument; });
    await open();
    assert.equal(await evaluate(() => document.querySelectorAll('#bpb-peak-weather-menu').length), 1);
    await press(firefoxMode ? '\uE00C' : 'Escape');
    await evaluate(() => document.getElementById('Gmap').contentWindow.mapsPlaceholder.getContainer().focus());
    await press(firefoxMode ? '\uE008\uE03A\uE000' : 'Shift+F10');
    await wait(() => !document.getElementById('bpb-peak-weather-menu').hidden && document.getElementById('bpb-peak-weather-menu').dataset.keyboard === 'true', 'keyboard location menu at map center');
    assert.equal(await evaluate(() => document.querySelector('.bpb-weather-menu-coordinates').textContent), await evaluate(() => {
        const center = document.getElementById('Gmap').contentWindow.mapsPlaceholder.getCenter();
        return `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
    }));
    await press(firefoxMode ? '\uE00C' : 'Escape');
    cases.push('frame reload retains one menu and Shift+F10 opens a keyboard reading');
    // The exact same menu receives a hit from the real packaged terrain frame.
    await setSettings({ ...settings, enable3dMap: true, theme: 'light' }); setMode('complete');
    await resize(1440, 1000); await navigate(origin + urls[0]);
    await click('#bpb-terrain-toggle');
    await wait(() => document.getElementById('bpb-terrain-toggle')?.textContent === '2D' && document.getElementById('bpb-terrain-frame')?.getAttribute('aria-hidden') !== 'true', 'terrain active');
    const renderer = await evaluateTerrain(() => {
        const canvas = document.querySelector('canvas'), gl = canvas?.getContext('webgl2');
        const debug = gl?.getExtension('WEBGL_debug_renderer_info'); return debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    });
    assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
    await evaluate(() => document.getElementById('bpb-terrain-frame').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await settledPosition(true);
    const terrainPoint = await evaluate(() => {
        window.__bpbLocationMessages = [];
        window.addEventListener('message', event => {
            if (event.data?.__bpbMapLocation || event.data?.__bpbTerrainFrame || event.data?.__bpbTerrain) {
                window.__bpbLocationMessages.push({ type: event.data.type, tag: event.data.__bpbMapLocation ? 'location' : event.data.__bpbTerrainFrame ? 'frame' : 'terrain',
                    generation: event.data.generation, x: event.data.x, y: event.data.y });
                if (window.__bpbLocationMessages.length > 20) window.__bpbLocationMessages.shift();
            }
        });
        const frame = document.getElementById('bpb-terrain-frame'); frame.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = frame.getBoundingClientRect(); return { x: r.left + r.width * .4, y: r.top + r.height * .55 };
    });
    await evaluateTerrain(() => {
        window.__bpbPointerTrace = [];
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'contextmenu']) document.addEventListener(type, event => {
            window.__bpbPointerTrace.push({ type, target: event.target.tagName, trusted: event.isTrusted, x: event.clientX, y: event.clientY });
        }, true);
    });
    await clickPoint(terrainPoint.x, terrainPoint.y, 'right');
    try { await wait(() => !document.getElementById('bpb-peak-weather-menu').hidden && document.getElementById('bpb-peak-weather-menu').dataset.state === 'ready', '3D location reading independent of weather'); }
    catch (error) {
        const terrainDiagnostic = await evaluateTerrain(() => {
            const point = document.elementFromPoint(window.innerWidth * .4, window.innerHeight * .55);
            return { viewport: [window.innerWidth, window.innerHeight], hit: point?.outerHTML.slice(0, 600),
                pointer: window.__bpbPointerTrace, hidden: document.hidden,
                rootStyle: getComputedStyle(document.getElementById('bpb-terrain-map')).pointerEvents,
                root: document.getElementById('bpb-terrain-map')?.getBoundingClientRect().toJSON(),
                canvas: document.querySelector('canvas')?.getBoundingClientRect().toJSON(), focus: document.activeElement?.tagName };
        });
        throw new Error(`${error.message}; ${JSON.stringify(await evaluate(() => ({ messages: window.__bpbLocationMessages,
            menu: document.getElementById('bpb-peak-weather-menu').outerHTML, active: document.activeElement?.id,
            frame: document.getElementById('bpb-terrain-frame').getBoundingClientRect().toJSON() })))}; terrain=${JSON.stringify(terrainDiagnostic)}`);
    }
    if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-location-terrain.png`));
    await press(firefoxMode ? '\uE00C' : 'Escape');
    await evaluateTerrain(() => document.querySelector('canvas').focus());
    await press(firefoxMode ? '\uE008\uE03A\uE000' : 'Shift+F10');
    await wait(() => !document.getElementById('bpb-peak-weather-menu').hidden && document.getElementById('bpb-peak-weather-menu').dataset.keyboard === 'true', '3D keyboard location menu');
    await press(firefoxMode ? '\uE00C' : 'Escape');
    cases.push('hardware 3D pointer and keyboard reading without a weather card');
    assert.ok(cases.length >= 23, 'zero or missing cases must fail');
    return { cases, viewports: [[1440, 1000], [375, 1000]], zoom: '100%, 200%', renderer, measurements: measurements.length };
}
