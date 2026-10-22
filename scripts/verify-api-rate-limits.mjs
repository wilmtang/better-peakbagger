// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document */
// Hidden real-extension checks with refused requests; no provider writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';

if (process.argv.length > 2) throw new Error('Usage: node scripts/verify-api-rate-limits.mjs');

const resources = createResourceStack();
const output = process.env.BPB_API_LIMIT_OUTPUT;
let failure = null;
try {
    if (output) await mkdir(output, { recursive: true });
    const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-api-limits-'));
    resources.defer('API limit profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('API limit HTTPS server', () => fixture.close());
    const dist = path.resolve('dist');
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
        args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    resources.defer('API limit browser', () => context.close());
    const page = await context.newPage();
    await page.goto('chrome://extensions-internals/');
    const record = await page.waitForFunction(() => {
        try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); }
        catch { return false; }
    }).then(handle => handle.jsonValue());
    await page.goto(`chrome-extension://${record.id}/options/options.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: -1 }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
        const original = globalThis.fetch;
        globalThis.fetch = (url, init) => String(url) === 'https://github.com/login/device/code'
            ? Promise.resolve(new Response('unreadable', { status: 429, headers: { 'retry-after': '120' } }))
            : original(url, init);
    });
    await page.evaluate(() => { chrome.permissions.contains = async () => true; });
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await page.locator('.github-error').filter({ hasText: 'GitHub request limit reached' }).waitFor();
    assert.match(await page.locator('.github-error').textContent(), /Try again in about 2 minutes/);
    for (const theme of ['light', 'dark']) {
        await page.evaluate(async theme => { const stored = await chrome.storage.sync.get('bpbSettings'); await chrome.storage.sync.set({ bpbSettings: { ...stored.bpbSettings, theme } }); }, theme);
        await page.waitForFunction(theme => document.documentElement.dataset.bpbTheme === theme, theme);
        for (const width of [1000, 375]) {
            await page.setViewportSize({ width, height: 760 });
            await page.locator('#github-connection').scrollIntoViewIfNeeded();
            const geometry = await page.locator('.github-error').evaluate(node => {
                const rect = node.getBoundingClientRect();
                return { left: rect.left, right: rect.right, width: globalThis.innerWidth };
            });
            assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, JSON.stringify(geometry));
            if (output) await page.locator('#github-connection').screenshot({ path: path.join(output, `github-limit-${theme}-${width}.png`) });
        }
    }
    await page.addInitScript(() => {
        const original = globalThis.fetch;
        globalThis.fetch = (url, init) => String(url).startsWith('https://www.peakbagger.com/')
            ? Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '120' } })) : original(url, init);
    });
    await page.goto(`chrome-extension://${record.id}/options/favorites.html`);
    await page.locator('#ignored-tab').click();
    await page.locator('#ignored-add-input').fill('900002');
    await page.locator('#ignored-add-button').click();
    await page.locator('#ignored-status').filter({ hasText: 'Peakbagger request limit reached' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('ignored-add-button').disabled);
    assert.equal(await page.locator('#ignored-add-input').inputValue(), '900002');
    if (output) await page.locator('#ignored-workspace').screenshot({ path: path.join(output, 'ignored-lookup-limit.png') });

    const profilePage = await context.newPage();
    const profileHtml = await readFile('test/fixtures/pages/climber-other.html', 'utf8');
    await context.route('**/climber/climber.aspx?cid=900002', route => route.fulfill({ contentType: 'text/html', body: profileHtml }));
    await context.route('**/report/report.aspx**', route => route.fulfill({ status: 429, headers: { 'retry-after': '120' }, body: 'unreadable refusal' }));
    await context.route('**/climber/climber.aspx?cid=900003', route => route.fulfill({ status: 429, headers: { 'retry-after': '120' }, body: 'unreadable refusal' }));
    await profilePage.goto(`https://www.peakbagger.com:${fixture.port}/climber/climber.aspx?cid=900002`);
    await profilePage.evaluate(() => {
        const link = document.createElement('a'); link.id = 'api-warning-climber';
        link.href = '/climber/climber.aspx?cid=900003'; link.textContent = 'Morgan Summit'; document.querySelector('main').append(link);
    });
    await profilePage.locator('#api-warning-climber + .bpb-climber-actions-trigger').click();
    await profilePage.locator('#bpb-climber-card-ignore').click();
    await profilePage.locator('.bpb-climber-card-feedback').filter({ hasText: 'Peakbagger request limit reached' }).waitFor();
    if (output) await profilePage.locator('#bpb-climber-card').screenshot({ path: path.join(output, 'climber-card-limit.png') });
    console.log(JSON.stringify({ browser: context.browser().version(), hidden: true, viewports: [375, 1000], themes: ['light', 'dark'], cases: ['device-authorization-429', 'ignored-lookup', 'climber-card-ignore'] }));
} catch (error) { failure = error; }
await resources.dispose(failure);
