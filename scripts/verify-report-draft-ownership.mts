// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { createVerificationRoot, launchVerificationChrome, PEAKBAGGER_HOST_RULE } from './verification-launch.mts';

if (process.argv.length > 2) throw new Error('Usage: node scripts/verify-report-draft-ownership.mts');

const resources = createResourceStack();
try {
    const profile = await createVerificationRoot(resources, 'bpb-draft-ownership-', 'draft profile');
    // Preserve the required helper option despite its incomplete JS-inferred signature.
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile } as never);
    resources.defer('HTTPS fixture', () => fixture.close());
    const context = await launchVerificationChrome(resources, 'draft browser', profile, {
        viewport: { width: 1000, height: 760 }, trustArgs: fixture.chromeTrustArgs,
        extension: path.resolve('dist'), hosts: [PEAKBAGGER_HOST_RULE],
    });
    const registry = await context.newPage();
    await registry.goto('chrome://extensions-internals/');
    const extension = await registry.waitForFunction(() => {
        try { return JSON.parse(document.body.innerText).find((item: { name: string; id: string }) => item.name === 'Better Peakbagger'); }
        catch { return false; }
    }).then(handle => handle.jsonValue());
    await registry.close();
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extension.id}/options/options.html`);
    const html = await readFile('test/fixtures/pages/climber-ascentedit.html', 'utf8');
    await context.route('**/climber/ascentedit.aspx**', route => route.fulfill({ contentType: 'text/html', body: html }));
    const key = 'bpbReportDraft:900001:new';
    const open = async () => {
        const page = await context.newPage();
        await page.goto(`https://www.peakbagger.com:${fixture.port}/climber/ascentedit.aspx?cid=900001`);
        await page.locator('.bpb-re-surface').waitFor();
        return page;
    };
    const expiredKey = 'bpbReportDraft:900001:a123';
    await control.evaluate(async draftKey => chrome.storage.local.set({ [draftKey]: {
        text: 'Expired unrelated report', mode: 'rich', savedAt: Date.now() - 15 * 86400000,
    } }), expiredKey);
    const solo = await open();
    await control.waitForFunction(async draftKey => !(await chrome.storage.local.get(draftKey))[draftKey], expiredKey);
    await solo.locator('.bpb-re-surface').fill('Work in the only open editor');
    await solo.locator('.bpb-re-status').filter({ hasText: /Draft saved|saved this draft|draft changed|Draft not saved/ }).waitFor();
    assert.match(await solo.locator('.bpb-re-status').textContent() || '', /Draft saved on this device/,
        'pruning another draft must not claim that a second tab saved this report');
    await solo.close();
    await control.evaluate(async draftKey => chrome.storage.local.remove(draftKey), key);
    const old = await open();
    const newer = await open();
    await newer.locator('.bpb-re-surface').fill('Newer recovery copy');
    await newer.getByText('Draft saved on this device', { exact: false }).waitFor();
    await old.close();
    assert.match((await control.evaluate(async draftKey => (await chrome.storage.local.get(draftKey))[draftKey] as { text: string }, key)).text, /Newer recovery copy/);
    const conflict = await open();
    await newer.locator('.bpb-re-surface').fill('Newest recovery copy');
    await newer.getByText('Draft saved on this device', { exact: false }).waitFor();
    await conflict.locator('.bpb-re-surface').fill('Different work in this tab');
    await conflict.getByText('The saved draft changed', { exact: false }).waitFor();
    assert.match((await control.evaluate(async draftKey => (await chrome.storage.local.get(draftKey))[draftKey] as { text: string }, key)).text, /Newest recovery copy/);
    const output = process.env.BPB_DRAFT_OUTPUT;
    if (output) {
        await mkdir(output, { recursive: true });
        for (const [width, theme] of [[1000, 'light'], [375, 'dark']] as const) {
            await conflict.setViewportSize({ width, height: 760 });
            await conflict.locator('html').evaluate((element, value) => { (element as HTMLElement).dataset.bpbTheme = value; }, theme);
            await conflict.locator('#bpb-report-editor').screenshot({ path: path.join(output, `draft-conflict-${width}-${theme}.png`) });
        }
    }
    console.log(JSON.stringify({ verification: 'report-draft-ownership', hidden: true, browser: context.browser()!.version(), viewports: [1000, 375] }));
} finally {
    await resources.dispose();
}
