// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, requestAnimationFrame, getComputedStyle */

import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import {
    createFixtureCertificate, resolveFixtureFile, sendFixtureFile, sendFixtureText,
    sendFixtureError, instrumentTerrainFrameHtml, instrumentTerrainFrameModule, waitForCondition,
} from './browser-verification-fixtures.mjs';
import { createResourceStack, closeServer, listenServer } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { snowMapDem } from './verify-snow-map-fixture.mjs';

const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--firefox'), `Unknown map-controls arguments: ${args.join(' ')}`);
const firefoxMode = args.includes('--firefox');
const artifacts = process.env.BPB_VERIFY_MAP_CONTROLS_ARTIFACTS;
const host = 'www.peakbagger.com';
const resources = createResourceStack();
let primaryError;
try {
    const profile = await mkdtemp(path.join(tmpdir(), 'bpb-map-controls-'));
    resources.defer('map controls profile', () => rm(profile, { recursive: true, force: true }));
    const certificate = await createFixtureCertificate({ host, directory: profile });
    resources.defer('map controls certificate', () => certificate.remove());
    const server = createServer(certificate, async (request, response) => {
        try {
            const url = new URL(request.url, `https://${host}`);
            if (url.pathname.toLowerCase() === '/async/pllbb.aspx') return sendFixtureText(response, 200, '<ts/>', 'text/xml');
            const routes = {
                '/peak.aspx': '/scripts/showcase/peak-map.html',
                '/climber/ascent.aspx': '/scripts/showcase/terrain.html',
                '/map/bigmap.aspx': '/scripts/showcase/big-map.html',
                '/map/mastermap.aspx': url.searchParams.has('big')
                    ? '/scripts/showcase/big-map-native.html' : '/scripts/showcase/terrain-native-map.html',
            };
            const pathname = url.pathname.startsWith('/scripts/showcase/terrain-tiles/')
                ? '/scripts/showcase/terrain-basemap-tile.png' : routes[url.pathname.toLowerCase()] || url.pathname;
            const file = await resolveFixtureFile(pathname);
            if (!file) return sendFixtureText(response, 404, 'Not found');
            await sendFixtureFile(response, file, {
                transform: pathname === '/dist/terrain/terrain.html' ? instrumentTerrainFrameHtml
                    : pathname === '/dist/terrain/terrain-frame.js' ? instrumentTerrainFrameModule : null,
            });
        } catch (error) { sendFixtureError(response, error); }
    });
    resources.defer('map controls fixture server', () => closeServer(server));
    await listenServer(server, 0, '127.0.0.1');
    const origin = `https://${host}:${server.address().port}`;
    if (!firefoxMode) assertChromeLaunchAllowed();
    const context = await (firefoxMode ? firefox : chromium).launchPersistentContext(profile, firefoxMode ? {
        headless: true,
        ignoreHTTPSErrors: firefoxMode,
        firefoxUserPrefs: { 'network.dns.localDomains': host, 'webgl.sanitize-unmasked-renderer': false,
            ...(process.platform === 'darwin' ? { 'webgl.disable-angle': false } : {}) },
    } : { channel: 'chromium', headless: true, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [...certificate.chromeTrustArgs, `--host-resolver-rules=MAP ${host} 127.0.0.1`] });
    resources.defer('map controls context', () => context.close());
    const browser = context.browser();
    console.log(`Hidden ${firefoxMode ? 'Firefox' : 'Chrome'} ${browser.version()}; disposable profile ${profile}`);
    let hold = false;
    const held = new Set();
    const release = () => { hold = false; for (const resolve of held) resolve(); held.clear(); };
    resources.defer('held terrain tiles', release);
    await context.route(/^https:\/\/tiles\.mapterhorn\.com\//, async route => {
        if (hold) await new Promise(resolve => held.add(resolve));
        await route.fulfill({ status: 200, contentType: 'image/webp', body: snowMapDem, headers: { 'access-control-allow-origin': '*' } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    // Fixtures own storage and activation stubs; all three page coordinators,
    // the frame bridge protocol and MapLibre renderer are shipped bundles.
    const read = () => page.evaluate(() => {
        const rect = element => {
            if (!element) return null;
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return { button: rect(document.getElementById('bpb-terrain-toggle')),
            map: rect(document.querySelector('#bpb-map-viewport, .bpb-terrain-mount-fullscreen')),
            following: rect(document.querySelector('.bpb-sun-calculator, #bpb-gpx-panel')),
            scrollX: window.scrollX, scrollY: window.scrollY };
    });
    const stable = (before, after, label) => {
        for (const key of ['button', 'map', 'following']) for (const dimension of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs((before[key]?.[dimension] || 0) - (after[key]?.[dimension] || 0)) <= 1,
                `${label}: ${key}.${dimension} moved: ${JSON.stringify({ before, after })}`);
        }
        assert.equal(after.scrollY, before.scrollY, `${label}: reading position moved`);
        assert.equal(after.scrollX, before.scrollX, `${label}: horizontal scroll moved`);
    };
    const sample = () => page.evaluate(() => {
        window.__controlSamples = [];
        window.__sampleControls = true;
        const tick = () => {
            const r = document.getElementById('bpb-terrain-toggle').getBoundingClientRect();
            window.__controlSamples.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            if (window.__sampleControls) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const checkSamples = async (before, label) => {
        const samples = await page.evaluate(() => { window.__sampleControls = false; return window.__controlSamples; });
        assert.ok(samples.length > 0, `${label}: no painted states sampled`);
        for (const button of samples) stable(before, { ...before, button }, label);
    };
    const waitIdle = () => page.waitForFunction(() => {
        const button = document.getElementById('bpb-terrain-toggle');
        return button.textContent === '3D' && !button.hasAttribute('aria-busy');
    });
    const waitActive = () => page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.textContent === '2D'
        && document.getElementById('bpb-terrain-frame')?.style.opacity === '1');
    const screenshot = async name => {
        if (!artifacts) return;
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, `${firefoxMode ? 'firefox' : 'chrome'}-${name}.png`) });
    };
    const failures = [];
    let cases = 0;
    for (const [surface, url] of [
        ['peak', '/Peak.aspx?pid=2829'],
        ['ascent', '/climber/ascent.aspx?aid=1&mode=terrain&map=wide'],
        ['big-map', '/map/BigMap.aspx?t=G&mode3d=1'],
        ['big-peak', '/map/BigMap.aspx?t=P&d=2829&cy=48.83115&cx=-121.60214&z=14&mode3d=1'],
    ]) for (const [width, theme] of surface === 'peak'
        ? [[1280, 'light'], [1280, 'dark'], [375, 'light'], [375, 'dark']]
        : [[1280, 'light'], [375, 'dark']]) {
        const label = `${surface}/${width}/${theme}`;
        console.log(`Checking ${label}`);
        let stage = 'native fixture';
        try {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto(`${origin}${url}&theme=${theme}`);
            await page.waitForFunction(() => {
                const button = document.getElementById('bpb-terrain-toggle');
                const native = document.querySelector('iframe[src*="MasterMap.aspx" i]');
                return button && !button.disabled && native?.contentWindow?.mapsPlaceholder;
            });
            // Fit the showcase's fixed presentation shell to the same narrow
            // map dimensions users can choose in the real page's resize rail.
            await page.addStyleTag({ content: '.terrain-check {box-sizing:border-box;width:100%;padding:8px;margin:0}.terrain-check .map-shell {width:100%;min-height:0}' });
            await page.locator('#bpb-terrain-toggle').evaluate(button => button.scrollIntoView({ block: 'center', behavior: 'instant' }));
            // Every pending-state case must take the network path, including
            // a summit already visited in an earlier viewport in this profile.
            await page.evaluate(() => window.caches.delete('bpb-mapterhorn-dem-v1'));
            await page.locator('#bpb-terrain-toggle').focus();
            const before = await read();
            await screenshot(`${surface}-${width}-2d`);
            const point = { x: before.button.x + before.button.width / 2, y: before.button.y + before.button.height / 2 };
            hold = true;
            stage = 'loading';
            await sample();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-busy') === 'true');
            // Cancel an actual pending renderer, after its first held DEM read.
            // The coordinator label can precede the asynchronous frame creation.
            await waitForCondition(() => held.size > 0, { description: `${label}: renderer waiting for terrain` });
            stable(before, await read(), `${label}/loading`);
            await screenshot(`${surface}-${width}-pending`);
            await page.keyboard.press('Space');
            stage = 'cancel';
            await waitIdle();
            stable(before, await read(), `${label}/cancel`);
            release();
            await page.mouse.click(point.x, point.y);
            stage = 'active';
            await waitActive();
            const frame = page.frameLocator('#bpb-terrain-frame');
            const renderer = await frame.locator('canvas.maplibregl-canvas').evaluate(canvas => {
                const gl = canvas.getContext('webgl2'), info = gl.getExtension('WEBGL_debug_renderer_info');
                return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            });
            assert.ok(renderer && !/software|swiftshader|llvmpipe/i.test(renderer), `Hardware WebGL required: ${renderer}`);
            if (process.platform === 'darwin') assert.match(renderer, /ANGLE Metal Renderer/, 'macOS verification requires Metal');
            console.log(`${label}: ${renderer}`);
            stable(before, await read(), `${label}/active`);
            if (surface === 'peak') {
                stage = 'layer picker focus';
                const picker = frame.locator('.bpb-terrain-picker');
                const pickerState = () => picker.evaluate(element => {
                    const style = getComputedStyle(element), r = element.getBoundingClientRect();
                    // Firefox retains the frame's last activeElement when
                    // Tab leaves its document; that element no longer has focus.
                    return { focused: document.activeElement === element && document.hasFocus(), visible: element.matches(':focus-visible'),
                        scheme: style.colorScheme, outline: style.outlineStyle, width: style.outlineWidth,
                        offset: style.outlineOffset, color: style.outlineColor,
                        rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
                });
                for (const scale of [1, 2]) {
                    // Enlarged text also exercises the picker's constrained
                    // width without changing the renderer's camera or canvas.
                    await frame.locator('#bpb-terrain-map').evaluate((map, scale) => { map.style.fontSize = `${12 * scale}px`; }, scale);
                    const idle = await pickerState();
                    await page.keyboard.press('Tab');
                    await picker.focus();
                    const focused = await pickerState();
                    await screenshot(`${surface}-${width}-${theme}-picker-focus-${scale}x`);
                    assert.equal(focused.focused && focused.visible, true, `${label}: keyboard focus is visible`);
                    assert.equal(focused.outline, 'solid', `${label}: native focus halo must be replaced`);
                    assert.equal(focused.scheme, theme, `${label}: native menu must follow the map theme`);
                    assert.equal(focused.width, '2px', `${label}: use the compact map-control focus ring`);
                    assert.equal(focused.offset, '-2px', `${label}: focus must stay inside the scrolling control stack`);
                    assert.equal(focused.color, theme === 'dark' ? 'rgb(121, 184, 255)' : 'rgb(47, 111, 208)');
                    assert.deepEqual(focused.rect, idle.rect, `${label}: focus moved or resized the layer picker`);
                    await picker.press('Escape');
                    assert.equal((await pickerState()).focused, true, `${label}: Escape keeps focus in the picker`);
                    assert.equal(await frame.locator('#bpb-terrain-map').count(), 1, `${label}: picker Escape must not exit 3D`);
                    await picker.press('Tab');
                    await waitForCondition(pickerState, { description: `${label}: keyboard can leave the picker`,
                        isReady: state => !state.focused });
                    assert.deepEqual((await pickerState()).rect, idle.rect, `${label}: blur moved or resized the layer picker`);
                    stable(before, await read(), `${label}/picker-${scale}x`);
                }
                await frame.locator('#bpb-terrain-map').evaluate(map => { map.style.fontSize = ''; });
            }
            const group = await frame.locator('.maplibregl-ctrl-group').boundingBox();
            const button = (await read()).button;
            assert.ok(group.y - button.y - button.height >= 7, `${label}: toggle overlaps zoom: ${JSON.stringify({ group, button })}`);
            await frame.locator('.maplibregl-ctrl-attrib-button').click();
            stable(before, await read(), `${label}/attribution`);
            const expandedGroup = await frame.locator('.maplibregl-ctrl-group').boundingBox();
            assert.ok(expandedGroup.y - button.y - button.height >= 7,
                `${label}: expanded attribution pushes zoom into toggle: ${JSON.stringify({ expandedGroup, button })}`);
            await screenshot(`${surface}-${width}-3d`);
            stage = 'return';
            await page.mouse.click(point.x, point.y);
            await waitIdle();
            stable(before, await read(), `${label}/return`);
            await page.mouse.click(point.x, point.y);
            stage = 'renderer error';
            await waitActive();
            await frame.locator('canvas.maplibregl-canvas').evaluate(canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
            await waitIdle();
            const failed = await read();
            // The analyzer deliberately reveals a new error detail in its
            // panel. That disclosure may expand once; the map, action and
            // document scroll must still stay anchored, and retry restores it.
            stable(before, surface === 'ascent' ? { ...failed, following: before.following } : failed, `${label}/renderer-error`);
            await page.mouse.click(point.x, point.y);
            stage = 'retry';
            await waitActive();
            stable(before, await read(), `${label}/retry`);
            await checkSamples(before, label);
            cases++;
        } catch (error) {
            release();
            const live = await page.evaluate(() => ({ toggle: document.getElementById('bpb-terrain-toggle')?.outerHTML,
                frame: document.getElementById('bpb-terrain-frame')?.outerHTML,
                native: document.querySelector('iframe[src*="MasterMap.aspx" i]')?.src,
                focus: document.activeElement?.outerHTML.slice(0, 150) })).catch(() => null);
            console.error(`${label}/${stage}: ${error.message}; live=${JSON.stringify(live)}`);
            failures.push(`${label}/${stage}: ${error.message}`);
        }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(pageErrors, [], 'fixture page errors');
    assert.ok(cases > 0, 'No map controls cases passed');
    console.log(`Hidden ${firefoxMode ? 'Firefox' : 'Chrome'} ${browser.version()}: ${cases} stable map-control cases passed (1280/375 × 1000).`);
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
