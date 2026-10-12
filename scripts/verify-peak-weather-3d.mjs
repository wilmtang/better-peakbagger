// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, chrome, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrowserFixtureServer, waitForCondition } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { weatherFixture } from '../test/helpers/weather-fixture.mjs';

assertChromeLaunchAllowed();
const root = path.resolve(import.meta.dirname, '..'), resources = createResourceStack();
const output = process.env.BPB_VERIFY_WEATHER_SCREENSHOT_DIR;
let failure;
try {
    const profile = await mkdtemp(path.join(tmpdir(), 'bpb-weather-3d-'));
    resources.defer('3D weather profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('3D weather HTTPS fixtures', () => fixture.close());
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], viewport: { width: 1440, height: 1100 },
        args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${path.join(root, 'dist')}`,
            `--load-extension=${path.join(root, 'dist')}`, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] });
    resources.defer('3D weather browser', () => context.close());
    const requests = [];
    await context.route('https://api.open-meteo.com/v1/forecast?*', async route => {
        const query = new URL(route.request().url()).searchParams;
        requests.push(Object.fromEntries(query));
        const body = weatherFixture({ startDate: query.get('start_date'),
            hours: (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24,
            latitude: Number(query.get('latitude')), longitude: Number(query.get('longitude')),
            elevation: query.has('elevation') ? Number(query.get('elevation')) : 1200 });
        await route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.storage.sync.set({ bpbSettings: { enable3dMap: true, showSunMoon: false, theme: 'light', units: 'imperial' } }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`https://www.peakbagger.com:${fixture.port}/peak.aspx?pid=2296&week-weather=map`);
    await page.locator('#bpb-peak-weather').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.bpb-week-day').length === 16);
    await page.locator('#Gmap').scrollIntoViewIfNeeded();
    await page.locator('#bpb-terrain-toggle').click();
    await page.waitForFunction(() => document.getElementById('bpb-terrain-frame')?.style.opacity === '1', null, { timeout: 60_000 });
    const canvas = page.frameLocator('#bpb-terrain-frame').locator('.maplibregl-canvas');
    const renderer = await canvas.evaluate(node => {
        const gl = node.getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info');
        return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
    });
    assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware WebGL required: ${renderer}`);
    if (output) await mkdir(output, { recursive: true });
    for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.locator('#bpb-terrain-frame').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
        let previousBounds, stable = 0;
        await waitForCondition(async () => {
            const bounds = await canvas.boundingBox();
            const value = JSON.stringify(bounds);
            stable = bounds && value === previousBounds ? stable + 1 : 0; previousBounds = value;
            return { stable, bounds };
        }, { description: '3D canvas settles after viewport resizing', isReady: value => value.stable >= 3 });
        const bounds = await canvas.boundingBox();
        await page.mouse.click(bounds.x + bounds.width * .35, bounds.y + bounds.height * .45, { button: 'right' });
        await page.locator('#bpb-peak-weather-menu').waitFor({ state: 'visible' });
        if (output) await page.screenshot({ path: path.join(output, `chrome-peak-3d-location-menu-${width}.png`) });
        await page.locator('#bpb-peak-weather-menu button').click();
        await page.waitForFunction(() => document.querySelector('.bpb-week-location-name').textContent !== 'At the summit'
            && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false');
        assert.ok(!Object.hasOwn(requests.at(-1), 'elevation'));
        await page.locator('.bpb-week-location-reset').click();
        await page.waitForFunction(() => document.querySelector('.bpb-week-location-name').textContent === 'At the summit');
        await page.locator('#bpb-terrain-frame').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
        const drag = await canvas.boundingBox();
        const beforeView = await page.locator('.bpb-map-compass-disc').getAttribute('style');
        await page.mouse.move(drag.x + drag.width * .35, drag.y + drag.height * .45);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(drag.x + drag.width * .35 + 55, drag.y + drag.height * .45 + 45, { steps: 8 });
        await page.mouse.up({ button: 'right' });
        await page.waitForFunction(value => document.querySelector('.bpb-map-compass-disc').getAttribute('style') !== value, beforeView);
        await page.evaluate(async () => { for (let frame = 0; frame < 5; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); });
        assert.equal(await page.locator('#bpb-peak-weather-menu').evaluate(node => node.hidden), true, 'right-drag rotates without opening a weather menu');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: context.browser().version(), hidden: true, profile, renderer,
        viewports: [1440, 375], weatherRequests: requests.length, checks: ['3D context menu', 'selected coordinates', 'terrain elevation', 'reset', 'right-drag rotation'] }));
} catch (error) { failure = error; }
await resources.dispose(failure);
