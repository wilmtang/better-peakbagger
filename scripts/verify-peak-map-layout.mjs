// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Hidden, real unpacked extension on a disposable HTTPS Peakbagger fixture.
/* global document, chrome */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createBrowserFixtureServer, readSunCalculatorGeometry } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

assertChromeLaunchAllowed();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = process.env.BPB_VERIFY_PEAK_LAYOUT_ARTIFACTS;
const resources = createResourceStack();
let primaryError = null;
try {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-peak-layout-'));
    resources.defer('peak layout profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('peak layout fixture', () => fixture.close());
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        viewport: { width: 1280, height: 1000 },
        args: [...fixture.chromeTrustArgs,
            `--disable-extensions-except=${path.join(root, 'dist')}`,
            `--load-extension=${path.join(root, 'dist')}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('peak layout browser', () => context.close());
    console.log(`Hidden Chrome ${context.browser().version()}; disposable profile ${profile}`);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`https://www.peakbagger.com:${fixture.port}/Peak.aspx?pid=2829`);
    await page.locator('.bpb-sun-calculator__panel').waitFor({ state: 'visible' });
    // Representative native table sizing without a 760px mobile minimum.
    await page.addStyleTag({ content: 'body { margin: 12px; } table { max-width: 100%; }' });
    if (artifacts) await mkdir(artifacts, { recursive: true });

    const readBounds = () => page.evaluate(() => {
        const rect = element => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return {
            map: rect(document.querySelector('#bpb-map-viewport')),
            sun: rect(document.querySelector('.bpb-sun-calculator')),
            link: rect(Array.from(document.querySelectorAll('a')).find(link => link.textContent.includes('Full Screen Map'))),
        };
    });
    for (const theme of ['light', 'dark']) {
        await worker.evaluate(value => chrome.storage.sync.set({ bpbSettings: {
            theme: value, enable3dMap: true, showSunMoon: true,
        } }), theme);
        await page.waitForFunction(value => document.querySelector('.bpb-sun-calculator').dataset.theme === value, theme);
        for (const width of [1280, 780, 640, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            const bounds = await readBounds();
            assert.ok(bounds.sun.height < (bounds.sun.width > 680 ? 380 : bounds.sun.width <= 340 ? 600 : 570), JSON.stringify(bounds));
            for (const date of ['2026-06-21', '2026-12-21']) {
                await page.locator('.bpb-sun-calculator__date').fill(date);
                await page.locator('.bpb-sun-calculator__date').dispatchEvent('change');
                for (const [minute, clock] of [[0, '12:00 AM'], [720, '12:00 PM'], [1439, '11:59 PM']]) {
                    await page.locator('.bpb-sun-calculator__time').evaluate((slider, value) => {
                        slider.value = String(value);
                        slider.dispatchEvent(new Event('input', { bubbles: true }));
                    }, minute);
                    await page.waitForFunction(value => document.querySelector('.bpb-sun-calculator__clock').textContent === value
                        && document.querySelector('.bpb-sun-calculator__time').getAttribute('aria-valuetext').startsWith(`${value} `), clock);
                    const geometry = await page.evaluate(readSunCalculatorGeometry);
                    assert.deepEqual(geometry.overflowingText, [], `${theme}/${width}/${date}/${minute}: ${JSON.stringify(geometry)}`);
                    assert.deepEqual(geometry.overflowingContainers, [], JSON.stringify(geometry));
                    assert.deepEqual(await readBounds(), bounds, `date/time moved content at ${theme}/${width}`);
                }
            }
            assert.ok(await page.locator('.bpb-sun-calculator__time').evaluate(slider => slider.getBoundingClientRect().height >= 44));
            if (artifacts) await page.locator('.bpb-sun-calculator').screenshot({ path: path.join(artifacts, `sun-${theme}-${width}.png`) });
            console.log(`${theme}/${width}: Sun & Moon ${bounds.sun.height}px; no overflow or date/time movement`);
        }
    }
    assert.deepEqual(errors, []);
} catch (error) {
    primaryError = error;
}
await resources.dispose(primaryError);
