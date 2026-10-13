// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Headless HTTPS fixture: real extension in Chrome; shipped assets and a
// controlled settings worker in Firefox (the full verifier covers its manifest).
/* global document, getComputedStyle, localStorage */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer, projectRoot, waitForCondition } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

assertChromeLaunchAllowed();
const resources = createResourceStack();
const output = process.env.BPB_LINK_ORDER_ARTIFACTS;
const firefoxMode = process.argv.includes('--firefox');
let failure;
try {
    if (output) await mkdir(output, { recursive: true });
    const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-peak-link-order-'));
    resources.defer('link-order profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('HTTPS fixture', () => fixture.close());
    const dist = path.join(projectRoot, 'dist');
    let context;
    if (firefoxMode) {
        context = await firefox.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: true,
            firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
    } else {
        assertChromeLaunchAllowed();
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true,
            ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
                '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
        });
    }
    resources.defer('hidden browser', () => context.close());
    const page = await context.newPage();
    if (firefoxMode) await page.addInitScript(() => {
        const sync = {
            get: async () => ({ bpbSettings: JSON.parse(localStorage.getItem('fixture-settings') || '{}') }),
            set: async values => localStorage.setItem('fixture-settings', JSON.stringify(values.bpbSettings)),
        };
        let queue = Promise.resolve();
        globalThis.chrome = { storage: { sync }, runtime: { sendMessage: message => {
            const operation = queue.then(async () => {
                const current = (await sync.get()).bpbSettings;
                const next = { ...current, ...message.patch };
                await sync.set({ bpbSettings: next });
                return { ok: true, settings: next };
            });
            queue = operation.catch(() => {});
            return operation;
        } } };
    });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === 'www.peakbagger.com'
        ? route.continue() : route.abort());
    // Small native peak table with the exact coordinate/Nation/Links anchors.
    // Constrain the column independently of unrelated native map/table overflow.
    await page.route('**/Peak.aspx?*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
        body { margin: 16px; font: 13px Verdana, sans-serif; } table { width: 100%; max-width: 600px; table-layout: fixed; }
        td { padding: 4px; } a { color: #0645ad; } html[data-bpb-theme="dark"] a { color: #80bfff; }
        html[data-bpb-theme="dark"] body { background: #202020; color: #d3d3d3; }
        </style></head><body><table class="gray"><tr><td>Latitude/Longitude (WGS84)</td><td>46.851731, -121.760395 (Dec Deg)</td></tr>
        <tr><td>Nation</td><td>United States</td></tr><tr><td colspan="2"><b>Links</b><br><br><a id="native" href="https://example.org">Native link</a></td></tr></table></body></html>` }));
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const open = async () => {
        await page.goto(`${origin}/Peak.aspx?pid=2296`);
        if (firefoxMode) {
            await page.addStyleTag({ content: await readFile(path.join(dist, 'css/peak-links.css'), 'utf8') });
            for (const file of ['theme-early.js', 'theme.js', 'peak-links.js']) {
                await page.addScriptTag({ content: await readFile(path.join(dist, 'content', file), 'utf8') });
            }
        }
        await page.locator('.bpb-peak-links__grip').first().waitFor();
    };
    await open();
    const worker = firefoxMode ? page : context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const setOrder = async order => worker.evaluate(async peakLinkOrder => {
        const current = (await globalThis.chrome.storage.sync.get('bpbSettings')).bpbSettings;
        await globalThis.chrome.storage.sync.set({ bpbSettings: { ...current, peakLinkOrder } });
    }, order);
    const savedOrder = () => worker.evaluate(async () => (await globalThis.chrome.storage.sync.get('bpbSettings')).bpbSettings?.peakLinkOrder);
    const savedVisibleOrder = expected => waitForCondition(savedOrder, {
        description: `saved planning-link order ${expected.join(', ')}`,
        isReady: order => expected.every((key, index) => order?.[index] === key),
    });
    const keys = () => page.locator('#bpb-peak-links [data-link-key]').evaluateAll(items => items.map(item => item.dataset.linkKey));
    const handle = key => page.locator(`[data-link-key="${key}"] .bpb-peak-links__grip`);
    const settled = () => page.waitForFunction(() => [...document.querySelectorAll('#bpb-peak-links .bpb-peak-links__item')]
        .every(item => item.getAnimations().every(animation => animation.playState !== 'running')));
    const bounds = selector => page.locator(selector).evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
    });
    const stable = (before, after, label) => {
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - after[key]) <= 1,
            `${label}: ${key} moved by ${after[key] - before[key]}px`);
    };
    const capture = async name => {
        if (output) await page.locator('#bpb-peak-links').screenshot({ path: path.join(output, `${firefoxMode ? 'firefox-' : ''}${name}.png`) });
    };
    const dragToEnd = async key => {
        const box = await handle(key).boundingBox();
        const last = await page.locator('[data-link-key]').last().boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, last.y + last.height - 4, { steps: 12 });
        await page.locator('[data-dragging]').waitFor();
        return { x: box.x + box.width / 2, y: last.y + last.height - 4 };
    };
    for (const theme of ['light', 'dark']) for (const [width, textScale] of [[1200, 1], [375, 1], [375, 1.5]]) {
        const name = `${theme}-${width}-${textScale}`;
        await setOrder(['windy', 'copernicus', 'airnow', 'avalanche']);
        await page.setViewportSize({ width, height: 1000 });
        await open();
        await page.evaluate(({ theme, textScale }) => {
            document.documentElement.dataset.bpbTheme = theme;
            document.body.style.fontSize = `${13 * textScale}px`;
        }, { theme, textScale });
        const panel = await bounds('#bpb-peak-links'), native = await bounds('#native');
        const link = page.locator('[data-link-key="windy"] a');
        const linkBounds = await link.boundingBox();
        const gripBefore = await bounds('[data-link-key="windy"] .bpb-peak-links__grip');
        await handle('windy').hover();
        stable(gripBefore, await bounds('[data-link-key="windy"] .bpb-peak-links__grip'), 'grip hover');
        await handle('windy').focus();
        stable(gripBefore, await bounds('[data-link-key="windy"] .bpb-peak-links__grip'), 'grip focus');
        await capture(`${name}-focus`);
        await handle('windy').evaluate(element => element.blur());
        await page.mouse.move(0, 0);
        assert.equal(await handle('windy').evaluate(element => getComputedStyle(element).borderTopWidth), '0px', 'native dark form styling must not turn grips into boxed buttons');
        await capture(`${name}-idle`);
        const saved = await savedOrder();
        await dragToEnd('windy');
        stable(panel, await bounds('#bpb-peak-links'), 'drag panel bounds');
        stable(native, await bounds('#native'), 'native link during drag');
        assert.deepEqual(await savedOrder(), saved, 'preview is not persisted');
        await capture(`${name}-drag`);
        await page.keyboard.press('Escape');
        await page.mouse.up(); await settled();
        assert.deepEqual(await keys(), ['windy', 'copernicus', 'airnow', 'avalanche']);
        assert.deepEqual(await savedOrder(), saved);
        stable(panel, await bounds('#bpb-peak-links'), 'cancel panel bounds');
        await dragToEnd('windy');
        await page.mouse.up(); await settled();
        assert.deepEqual(await keys(), ['copernicus', 'airnow', 'avalanche', 'windy']);
        await page.waitForFunction(() => document.querySelector('.bpb-peak-links__status').textContent.includes('position 4 of 4'));
        await savedVisibleOrder(['copernicus', 'airnow', 'avalanche', 'windy']);
        stable(panel, await bounds('#bpb-peak-links'), 'drop panel bounds');
        stable(native, await bounds('#native'), 'native link after drop');
        await capture(`${name}-drop`);
        await handle('windy').press('ArrowUp'); await settled();
        assert.deepEqual(await keys(), ['copernicus', 'airnow', 'windy', 'avalanche']);
        assert.equal(await handle('windy').evaluate(element => element === document.activeElement), true);
        await handle('windy').press('Home'); await settled();
        await savedVisibleOrder(['windy', 'copernicus', 'airnow', 'avalanche']);
        stable(panel, await bounds('#bpb-peak-links'), 'keyboard panel bounds');
        // Direct clicks and selecting link text never start a reorder gesture.
        await page.mouse.move(linkBounds.x + 4, linkBounds.y + 4); await page.mouse.down();
        await page.mouse.move(linkBounds.x + 25, linkBounds.y + 8);
        assert.equal(await page.locator('[data-dragging]').count(), 0);
        await page.mouse.up();
        await open();
        await page.waitForFunction(() => document.querySelector('[data-link-key]')?.dataset.linkKey === 'windy');
        console.log(`Passed ${name}: hover/focus, drag preview, cancel, drop, keyboard, reload; panel/native geometry ≤1px.`);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await handle('windy').press('End');
    assert.equal(await page.locator('[data-link-key]').evaluateAll(items => items.some(item => item.getAnimations().length)), false);
    await open();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-link-key]')].at(-1)?.dataset.linkKey === 'windy');
    // Hold the settings write (the real worker in Chrome) to inspect failure UI.
    // The isolated profile is disposed even if any assertion fails.
    await worker.evaluate(() => {
        const area = globalThis.chrome.storage.sync;
        globalThis.__originalLinkOrderSet = area.set.bind(area);
        area.set = values => new Promise((resolve, reject) => {
            globalThis.__finishLinkOrderSet = success => {
                globalThis.__finishLinkOrderSet = null;
                if (success) globalThis.__originalLinkOrderSet(values).then(resolve, reject);
                else reject(new Error('Fixture write failed'));
            };
        });
    });
    await handle('windy').press('Home');
    await waitForCondition(() => worker.evaluate(() => typeof globalThis.__finishLinkOrderSet === 'function'),
        { description: 'real worker settings write is pending' });
    const pendingGrip = await bounds('[data-link-key="windy"] .bpb-peak-links__grip');
    await capture('save-pending');
    await worker.evaluate(() => globalThis.__finishLinkOrderSet(false));
    await page.locator('.bpb-peak-links__status[data-error]').waitFor();
    stable(pendingGrip, await bounds('[data-link-key="windy"] .bpb-peak-links__grip'), 'save failure grip');
    await capture('save-error');
    await handle('copernicus').press('ArrowDown');
    await waitForCondition(() => worker.evaluate(() => typeof globalThis.__finishLinkOrderSet === 'function'),
        { description: 'retry settings write is pending' });
    const retryGrip = await bounds('[data-link-key="copernicus"] .bpb-peak-links__grip');
    await worker.evaluate(() => globalThis.__finishLinkOrderSet(true));
    await page.locator('.bpb-peak-links__status[data-error]').waitFor({ state: 'hidden' });
    stable(retryGrip, await bounds('[data-link-key="copernicus"] .bpb-peak-links__grip'), 'retry completion grip');
    console.log(`Passed ${firefoxMode ? 'controlled settings' : 'real worker'} slow save → visible error → retry; grip geometry ≤1px. Error detail deliberately expands below the list.`);
    assert.deepEqual(pageErrors, []);
    console.log(`Verified hidden ${context.browser().browserType().name()} ${context.browser().version()}, ${firefoxMode ? 'shipped assets with controlled settings' : 'real dist manifest/worker'}, HTTPS fixture. No WebGL surface. Native focus/window placement and physical touch remain untested.`);
} catch (error) { failure = error; }
await resources.dispose(failure);
