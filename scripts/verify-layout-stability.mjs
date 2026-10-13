// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Transition geometry checks against shipped UI assets with controlled APIs.
// Fixtures are isolated HTTPS Peakbagger pages; no live data or accounts are used.
/* global document */
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer, fixtureContentType, projectRoot } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

const selected = process.argv.find(value => value.startsWith('--surface='))?.split('=')[1];
const output = process.env.BPB_JITTER_ARTIFACTS;
if (output) await mkdir(output, { recursive: true });
const assets = new Map();
async function asset(file) {
    if (!assets.has(file)) assets.set(file, await readFile(path.join(projectRoot, 'dist', file)));
    return assets.get(file);
}
export const geometry = async (page, selector) => page.locator(selector).evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
});
function stable(before, after, label, keys = ['x', 'y', 'width', 'height']) {
    for (const key of keys) assert.ok(Math.abs(before[key] - after[key]) <= 1,
        `${label}: ${key} shifted ${after[key] - before[key]}px; ${JSON.stringify({ before, after })}`);
}
async function capture(page, label) {
    if (output) await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
}
async function load(page, origin, file, initialize, argument) {
    await page.addInitScript(initialize, argument);
    await page.goto(`${origin}/dist/${file}`);
}
async function popupCase(page, origin, variant) {
    await load(page, origin, 'popup/popup.html', ({ theme }) => {
        const job = { phase: 'ready', provider: 'garmin', activityId: '777', hasCachedGpx: true, selectedIds: [1],
            trackSummary: { originalPointCount: 50, retainedPointCount: 50, maxDeviationM: 0 },
            matches: [{ id: 1, name: 'A very long mountain name for a narrow popup', classification: 'strong', confidence: 98,
                evidence: { distanceM: 2, trackQuality: 1 } }] };
        globalThis.chrome = {
            tabs: { query: async () => [{ id: 9 }], create: async () => ({}), update: async () => ({}) },
            storage: { sync: { get: async () => ({ bpbSettings: { theme } }), set: async () => {} },
                onChanged: { addListener() {}, removeListener() {} } },
            runtime: { openOptionsPage: async () => {}, sendMessage: async message => {
                if (['CAPTURE_START', 'CAPTURE_STATUS'].includes(message.type)) return job;
                if (message.type === 'CAPTURE_OPEN_DRAFTS') return new Promise(resolve => {
                    globalThis.__finishOpen = fail => resolve(fail
                        ? { phase: 'error', error: { message: 'Drafts could not be opened. Try again.' } }
                        : { job: { ...job, phase: 'opened' }, groupWarning: true });
                });
                if (message.type === 'CAPTURE_CLEAR') return new Promise(resolve => {
                    globalThis.__finishClear = () => resolve({ ok: false, error: { message: 'The captured track could not be deleted. Try again.' } });
                });
                return { ok: true };
            } },
        };
    }, variant);
    await page.locator('#open-drafts').filter({ hasText: 'Open 1 draft' }).waitFor();
    const button = '#open-drafts';
    const before = await geometry(page, button);
    await page.click(button);
    await page.waitForFunction(() => typeof globalThis.__finishOpen === 'function');
    stable(before, await geometry(page, button), 'popup pending');
    await page.evaluate(() => globalThis.__finishOpen(true));
    await page.waitForFunction(() => !document.getElementById('open-drafts').disabled);
    stable(before, await geometry(page, button), 'popup error');
    await page.click(button);
    await page.waitForFunction(() => document.getElementById('open-drafts').disabled);
    await page.evaluate(() => globalThis.__finishOpen(false));
    await page.locator(button).filter({ hasText: 'Show opened drafts' }).waitFor();
    stable(before, await geometry(page, button), 'popup grouped completion');
    const clearBefore = await geometry(page, '#clear-capture');
    await page.click('#clear-capture');
    await page.waitForFunction(() => typeof globalThis.__finishClear === 'function');
    stable(clearBefore, await geometry(page, '#clear-capture'), 'popup clear pending');
    await page.evaluate(() => globalThis.__finishClear());
    await page.locator('#clear-capture').filter({ hasText: 'Delete captured track data' }).waitFor();
    stable(clearBefore, await geometry(page, '#clear-capture'), 'popup clear error');
    await capture(page, `${variant.name}-popup-error`);
}
async function accessCase(page, origin, variant) {
    for (const id of ['gaia', 'onx', 'alltrails', 'caltopo']) {
        await load(page, origin, `${id}/access.html`, ({ theme }) => {
            globalThis.chrome = {
                storage: { sync: { get: async () => ({ bpbSettings: { theme } }) },
                    onChanged: { addListener() {} } },
                permissions: { request: () => new Promise((resolve, reject) => {
                    globalThis.__finishPermission = result => result === 'error' ? reject(new Error('Unavailable')) : resolve(result);
                }) },
            };
        }, variant);
        const selector = `#allow-${id}`;
        const before = await geometry(page, selector);
        for (const result of ['error', false, true]) {
            await page.click(selector);
            await page.waitForFunction(id => document.getElementById(`allow-${id}`).disabled, id);
            stable(before, await geometry(page, selector), `${id} pending`);
            await page.evaluate(result => globalThis.__finishPermission(result), result);
            await page.waitForFunction(({ id, result }) => result === true
                ? !document.getElementById(`close-${id}`).hidden
                : !document.getElementById(`allow-${id}`).disabled, { id, result });
            stable(before, await geometry(page, selector), `${id} ${result}`);
        }
        await capture(page, `${variant.name}-${id}-access`);
    }
}
const cases = { popup: popupCase, access: accessCase };
const resources = createResourceStack();
let failure = null;
try {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-jitter-fixture-'));
    resources.defer('jitter fixture directory', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('jitter fixture server', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
        if (process.argv.includes('--chrome-only') && name !== 'chrome') continue;
        if (engine === chromium) assertChromeLaunchAllowed();
        const browser = await engine.launch({ headless: true, ...(engine === chromium
            ? { channel: 'chromium', args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
            : { firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }) });
        try {
            for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
                for (const [surface, check] of Object.entries(cases)) {
                    if (selected && selected !== surface) continue;
                    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, colorScheme: theme });
                    try {
                        await context.route(`${origin}/dist/**`, async route => {
                            const file = new URL(route.request().url()).pathname.slice('/dist/'.length);
                            if (file.includes('..')) return route.abort();
                            try { await route.fulfill({ body: await asset(file), contentType: fixtureContentType(file) }); }
                            catch { await route.fulfill({ status: 404, body: 'Missing shipped fixture asset' }); }
                        });
                        const page = await context.newPage();
                        const variant = { theme, width, name: `${name}-${theme}-${width}` };
                        await check(page, origin, variant);
                        console.log(JSON.stringify({ browser: name, version: browser.version(), hidden: true,
                            surface, theme, viewport: `${width}x900`, result: 'passed' }));
                    } finally { await context.close(); }
                }
            }
        } finally { await browser.close(); }
    }
} catch (error) { failure = error; }
await resources.dispose(failure);
