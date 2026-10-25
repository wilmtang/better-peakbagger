// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Real unpacked extension; masked Peakbagger HTML, GPX and map APIs.
/* global document, window, innerWidth, innerHeight, requestAnimationFrame, getComputedStyle, chrome */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createBrowserFixtureServer, projectRoot } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { suspectSegments, segmentsGpx } from '../test/helpers/suspect-gpx.mjs';

export async function verifyGpxHeader({ evaluate, resize, click, press, wait, screenshot, setTheme }) {
    await wait(() => /^Interactive Stats:/.test(document.querySelector('.bpb-gpx-stats')?.textContent || ''));
    const original = await evaluate(() => {
        const panel = document.querySelector('#bpb-gpx-analysis');
        return { theme: panel.dataset.theme, fontSize: panel.style.fontSize };
    });
    const read = () => {
        const box = element => {
            const r = element.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
        };
        const panel = document.querySelector('#bpb-gpx-analysis');
        const header = panel.querySelector('.bpb-gpx-header');
        const controls = panel.querySelector('.bpb-gpx-controls');
        return {
            header: box(header), controls: box(controls), stats: box(panel.querySelector('.bpb-gpx-stats')),
            legend: box(panel.querySelector('.bpb-gpx-chart-legend')), chart: box(panel.querySelector('canvas')),
            following: box(panel.querySelector('.bpb-gpx-coordinate-controls')), panel: box(panel),
            scroll: window.scrollY,
            viewport: { width: innerWidth, height: innerHeight },
            theme: panel.dataset.theme, background: getComputedStyle(panel).backgroundColor,
            overflow: [...header.querySelectorAll('select, label, .bpb-gpx-timing > span, .bpb-gpx-point-count, .bpb-gpx-segment-disclosure')].filter(element => {
                const r = element.getBoundingClientRect(), p = panel.getBoundingClientRect();
                return r.left < p.left || r.right > p.right + 1 || element.scrollWidth > element.clientWidth + 1;
            }).map(element => element.textContent),
            fits: panel.getBoundingClientRect().right <= innerWidth + 1,
        };
    };
    let cases = 0;
    const themes = setTheme ? ['light', 'dark'] : [original.theme];
    for (const theme of themes) {
        await setTheme?.(theme);
        for (const [width, scale] of [[1600, 1], [800, 1], [390, 1], [390, 2]]) {
            await resize(width, 900);
            await evaluate(new Function(`document.querySelector('#bpb-gpx-analysis').style.fontSize = '${16 * scale}px';`));
            await wait(() => document.querySelector('canvas').getBoundingClientRect().width > 0);
            const state = await evaluate(read);
            await screenshot?.(`${theme}-${width}-text${scale}`);
            assert.equal(state.theme, theme);
            assert.deepEqual(state.viewport, { width, height: 900 }, 'header checks must use the requested content viewport');
            assert.equal(state.background, theme === 'dark' ? 'rgb(35, 38, 42)' : 'rgb(250, 250, 250)');
            assert.ok(state.fits, `${theme}/${width}/${scale}: panel overflow: ${JSON.stringify(state)}`);
            assert.deepEqual(state.overflow, [], `${theme}/${width}/${scale}: clipped header content`);
            if (width === 1600) {
                assert.ok(Math.abs(state.controls.y - state.stats.y) <= 4,
                    `controls and summary must share a row: ${JSON.stringify(state)}`);
                assert.ok(state.header.height <= 100, `compact header exceeded 100px: ${JSON.stringify(state)}`);
            }
            // Sample every painted frame: toggling a chart series must leave
            // controls, surrounding content and reading position anchored.
            await evaluate(async () => {
                const button = document.querySelector('.bpb-gpx-chart-legend button');
                button.scrollIntoView({ block: 'center' });
                button.focus({ preventScroll: true });
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            await evaluate(new Function(`
                const read = (${read.toString()});
                window.__gpxHeaderProbe = { samples: [read()], running: true };
                const sample = () => {
                    if (!window.__gpxHeaderProbe.running) return;
                    window.__gpxHeaderProbe.samples.push(read());
                    requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            `));
            await press('.bpb-gpx-chart-legend button:first-child', 'Enter');
            await wait(() => document.querySelector('.bpb-gpx-chart-legend button').getAttribute('aria-pressed') === 'false');
            await click('.bpb-gpx-chart-legend button:first-child');
            await wait(() => document.querySelector('.bpb-gpx-chart-legend button').getAttribute('aria-pressed') === 'true');
            const samples = await evaluate(async () => {
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                window.__gpxHeaderProbe.running = false;
                return window.__gpxHeaderProbe.samples;
            });
            for (const sample of samples) {
                assert.equal(sample.scroll, samples[0].scroll, 'legend changed document scroll');
                for (const region of ['header', 'controls', 'legend', 'chart', 'following', 'panel']) {
                    for (const key of ['x', 'y', 'width', 'height']) assert.ok(
                        Math.abs(sample[region][key] - samples[0][region][key]) <= 1,
                        `${theme}/${width}/${scale}: ${region}.${key} moved during legend interaction`);
                }
            }
            const focus = await evaluate(() => ({
                legend: document.activeElement.matches('.bpb-gpx-chart-legend button'),
            }));
            assert.ok(focus.legend, 'series activation must retain focus');
            console.log(`${theme}/${width}/text${scale}: ${state.header.height}px header, readable controls, stable series toggles`);
            cases++;
        }
    }
    assert.equal(cases, themes.length * 4);
    await evaluate(new Function(`
        const original = ${JSON.stringify(original)};
        const panel = document.querySelector('#bpb-gpx-analysis');
        panel.style.fontSize = original.fontSize;
    `));
    if (await evaluate(() => Boolean(document.querySelector('.bpb-gpx-segment-disclosure')))) {
        await resize(390, 900);
        await click('.bpb-gpx-segment-disclosure');
        const sourceAction = () => evaluate(() => {
            const r = document.querySelector('.bpb-gpx-segment-view').getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
        });
        const before = await sourceAction();
        await click('.bpb-gpx-segment-view');
        await wait(() => /Use interpreted view/.test(document.querySelector('.bpb-gpx-segment-view').textContent));
        const after = await sourceAction();
        for (const key of Object.keys(before)) assert.ok(Math.abs(before[key] - after[key]) <= 1,
            `narrow source-view action ${key}: ${before[key]} → ${after[key]}`);
        await click('.bpb-gpx-segment-view');
        await wait(() => /Show all source segments/.test(document.querySelector('.bpb-gpx-segment-view').textContent));
        await click('.bpb-gpx-segment-disclosure');
    }
    await press('#bpb-gpx-analysis canvas', 'ArrowRight');
    const originalUnits = await evaluate(() => {
        const units = document.getElementById('bpb-gpx-units'), previous = units.value;
        units.value = 'imperial'; units.dispatchEvent(new Event('change'));
        return previous;
    });
    await wait(() => /(?:miles|ft)/.test(document.getElementById('bpb-gpx-coordinate-status').textContent));
    await evaluate(new Function(`const units = document.getElementById('bpb-gpx-units'); units.value = ${JSON.stringify(originalUnits)}; units.dispatchEvent(new Event('change'));`));

}

async function main() {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/verify-gpx-header.mjs');
    assertChromeLaunchAllowed();
    const resources = createResourceStack();
    let primaryError;
    try {
        const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-gpx-header-'));
        resources.defer('GPX header profile', () => rm(profile, { recursive: true, force: true }));
        const fixture = await createBrowserFixtureServer({ temporaryRoot: profile,
            analyzerGpxByCase: { suspect: segmentsGpx(suspectSegments()) } });
        resources.defer('GPX header fixture', () => fixture.close());
        assertChromeLaunchAllowed();
        const context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true,
            ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            viewport: { width: 1600, height: 900 },
            args: [...fixture.chromeTrustArgs,
                `--disable-extensions-except=${path.join(projectRoot, 'dist')}`,
                `--load-extension=${path.join(projectRoot, 'dist')}`,
                '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
        });
        resources.defer('GPX header browser', () => context.close());
        console.log(`Hidden Chrome ${context.browser().version()}; disposable profile ${profile}; native 2D canvas`);
        const page = await context.newPage();
        const artifacts = process.env.BPB_VERIFY_GPX_HEADER_ARTIFACTS;
        if (artifacts) await mkdir(artifacts, { recursive: true });
        for (const variant of ['success', 'suspect']) {
            await page.goto(`https://www.peakbagger.com:${fixture.port}/climber/ascent.aspx?aid=analyzer-${variant}`);
            const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
            await verifyGpxHeader({
                evaluate: fn => page.evaluate(fn),
                resize: (width, height) => page.setViewportSize({ width, height }),
                click: selector => page.locator(selector).click(),
                press: (selector, key) => page.locator(selector).press(key),
                wait: fn => page.waitForFunction(fn),
                setTheme: async theme => {
                    await worker.evaluate(async theme => {
                        const { bpbSettings } = await chrome.storage.sync.get('bpbSettings');
                        await chrome.storage.sync.set({ bpbSettings: { ...bpbSettings, theme } });
                    }, theme);
                    await page.waitForFunction(theme => document.querySelector('#bpb-gpx-analysis')?.dataset.theme === theme, theme);
                },
                screenshot: artifacts ? name => page.locator('.bpb-gpx-header').screenshot({ path: path.join(artifacts, `${variant}-${name}.png`) }) : null,
            });
        }
    } catch (error) {
        primaryError = error;
    }
    await resources.dispose(primaryError);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
