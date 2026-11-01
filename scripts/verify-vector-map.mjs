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
assert.ok(new Set(args).size === args.length && args.every(arg => ['--firefox', '--preflight', '--live'].includes(arg))
    && !(args.includes('--preflight') && args.includes('--live')), 'Usage: node scripts/verify-vector-map.mjs [--firefox] [--preflight | --live]');
const firefoxMode = args.includes('--firefox'), preflight = args.includes('--preflight'), liveMode = args.includes('--live');
const root = path.resolve(import.meta.dirname, '..'), resources = createResourceStack();
let failure, summary, failurePage;
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
        headless: true, ignoreHTTPSErrors: true,
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
    let mode = 'hold'; const held = new Set();
    const release = () => { for (const done of held) done(); held.clear(); };
    resources.defer('held vector styles', release);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWPYvHnzfwAHNwL9GPw68wAAAABJRU5ErkJggg==', 'base64');
    await context.route('**/vector-native/**', route => route.fulfill({ contentType: 'image/png', body: png }));
    const tile = Buffer.from(fromGeojsonVt({ land: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] } }, { version: 2, extent: 4096 }));
    const style = { version: 8, sources: { fixture: { type: 'vector', url: 'https://tiles.openfreemap.org/vector.json' } }, layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#d5dec9' } },
        { id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'land', paint: { 'fill-color': '#c4ddac' } },
    ] };
    await context.route('https://tiles.openfreemap.org/**', async route => {
        const url = route.request().url(); requests.push(url);
        assert.equal(route.request().headers().cookie, undefined); assert.equal(route.request().headers().referer, undefined);
        if (liveMode) return route.continue();
        if (url.endsWith('/styles/liberty') && mode === 'hold') await new Promise(resolve => held.add(resolve));
        const metadata = url.endsWith('/vector.json');
        try {
            await route.fulfill({ status: mode === 'error' && url.endsWith('/styles/liberty') ? 503 : 200,
                headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
                contentType: url.endsWith('.pbf') ? 'application/x-protobuf' : 'application/json',
                body: url.endsWith('.pbf') ? tile : JSON.stringify(metadata
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
    if (preflight) summary = { preflight: true, cases: 1, renderer, browser: context.browser().version() };
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
        assert.deepEqual(errors, []);
        summary = { verification: '2d-vector-map', hidden: true, browser: context.browser().version(), renderer,
            cases: cases + 3, viewports: '1280/375 × 800, light/dark, 200% CSS zoom', realExtension: !firefoxMode,
            syntheticProvider: true, loadingSuccessErrorRetryCancellation: true, stableGeometry: true, nativeMarkerInteraction: true };
    }
} catch (error) {
    failure = error;
    if (failurePage && !failurePage.isClosed()) console.error(await failurePage.evaluate(() => ({
        selected: document.getElementById('selmap')?.value, busy: document.getElementById('selmap')?.getAttribute('aria-busy'),
        events: window.vectorEvents, focused: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(),
        status: document.querySelector('.bpb-vector-status')?.outerHTML, slot: document.querySelector('.bpb-vector-slot')?.outerHTML,
    })).catch(() => null));
}
await resources.dispose(failure);
assert.ok(summary?.cases > 0, 'No vector-map verification cases executed');
console.log(JSON.stringify(summary));
