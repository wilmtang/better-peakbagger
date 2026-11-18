// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />
// Hidden real-extension checks with refused requests; no provider writes.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createResourceStack } from './resource-stack.mjs';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createVerificationRoot, launchVerificationChrome, PEAKBAGGER_HOST_RULE } from './verification-launch.mts';

if (process.argv.length > 2) throw new Error('Usage: node scripts/verify-api-rate-limits.mts');

const resources = createResourceStack();
const output = process.env.BPB_API_LIMIT_OUTPUT;
let failure: unknown = null;
try {
    if (output) await mkdir(output, { recursive: true });
    const profile = await createVerificationRoot(resources, 'bpb-api-limits-', 'API limit profile');
    // Preserve the required helper option despite its incomplete JS-inferred signature.
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile } as never);
    resources.defer('API limit HTTPS server', () => fixture.close());
    const dist = path.resolve('dist');
    const context = await launchVerificationChrome(resources, 'API limit browser', profile, {
        viewport: { width: 1000, height: 760 }, trustArgs: fixture.chromeTrustArgs, hosts: [PEAKBAGGER_HOST_RULE], extension: dist,
    });
    const page = await context.newPage();
    await page.goto('chrome://extensions-internals/');
    const record = await page.waitForFunction(() => {
        try { return JSON.parse(document.body.innerText).find((item: { name: string; id: string }) => item.name === 'Better Peakbagger'); }
        catch { return false; }
    }).then(handle => handle.jsonValue());
    await page.goto(`chrome-extension://${record.id}/options/options.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: -1 }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
        const original = globalThis.fetch;
        globalThis.fetch = (url: RequestInfo | URL, init?: RequestInit) => String(url) === 'https://github.com/login/device/code'
            ? Promise.resolve(new Response('unreadable', { status: 429, headers: { 'retry-after': '120' } }))
            : original(url, init);
    });
    await page.evaluate(() => { chrome.permissions.contains = async () => true; });
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await page.locator('.github-error').filter({ hasText: 'GitHub request limit reached' }).waitFor();
    assert.match(await page.locator('.github-error').textContent() || '', /Try again in about 2 minutes/);
    for (const theme of ['light', 'dark']) {
        await page.evaluate(async next => { const stored = await chrome.storage.sync.get('bpbSettings'); await chrome.storage.sync.set({ bpbSettings: { ...(stored.bpbSettings as object), theme: next } }); }, theme);
        await page.waitForFunction(next => document.documentElement.dataset.bpbTheme === next, theme);
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
        globalThis.fetch = (url: RequestInfo | URL, init?: RequestInit) => String(url).startsWith('https://www.peakbagger.com/')
            ? Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '120' } })) : original(url, init);
    });
    await page.goto(`chrome-extension://${record.id}/options/favorites.html`);
    await page.locator('#ignored-tab').click();
    await page.locator('#ignored-add-input').fill('900002');
    await page.locator('#ignored-add-button').click();
    await page.locator('#ignored-status').filter({ hasText: 'Peakbagger request limit reached' }).waitFor();
    await page.waitForFunction(() => !(document.getElementById('ignored-add-button') as HTMLButtonElement).disabled);
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
        link.href = '/climber/climber.aspx?cid=900003'; link.textContent = 'Morgan Summit'; document.querySelector('main')!.append(link);
    });
    await profilePage.locator('#api-warning-climber + .bpb-climber-actions-trigger').click();
    await profilePage.locator('#bpb-climber-card-ignore').click();
    await profilePage.locator('.bpb-climber-card-feedback').filter({ hasText: 'Peakbagger request limit reached' }).waitFor();
    if (output) await profilePage.locator('#bpb-climber-card').screenshot({ path: path.join(output, 'climber-card-limit.png') });
    console.log(JSON.stringify({ browser: context.browser()!.version(), hidden: true, viewports: [375, 1000], themes: ['light', 'dark'], cases: ['device-authorization-429', 'ignored-lookup', 'climber-card-ignore'] }));
} catch (error) { failure = error; }
await resources.dispose(failure as null);
