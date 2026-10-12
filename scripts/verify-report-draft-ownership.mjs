// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

const resources = createResourceStack();
try {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-draft-ownership-'));
    resources.defer('draft profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('HTTPS fixture', () => fixture.close());
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
        args: [...fixture.chromeTrustArgs,
            `--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('draft browser', () => context.close());
    const registry = await context.newPage();
    await registry.goto('chrome://extensions-internals/');
    const extension = await registry.waitForFunction(() => {
        try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); }
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
    const old = await open();
    const newer = await open();
    await newer.locator('.bpb-re-surface').fill('Newer recovery copy');
    await newer.getByText('Draft saved on this device', { exact: false }).waitFor();
    await old.close();
    assert.match((await control.evaluate(async draftKey => (await chrome.storage.local.get(draftKey))[draftKey], key)).text, /Newer recovery copy/);
    const conflict = await open();
    await newer.locator('.bpb-re-surface').fill('Newest recovery copy');
    await newer.getByText('Draft saved on this device', { exact: false }).waitFor();
    await conflict.locator('.bpb-re-surface').fill('Different work in this tab');
    await conflict.getByText('Another tab saved this draft', { exact: false }).waitFor();
    assert.match((await control.evaluate(async draftKey => (await chrome.storage.local.get(draftKey))[draftKey], key)).text, /Newest recovery copy/);
    const output = process.env.BPB_DRAFT_OUTPUT;
    if (output) {
        await mkdir(output, { recursive: true });
        for (const [width, theme] of [[1000, 'light'], [375, 'dark']]) {
            await conflict.setViewportSize({ width, height: 760 });
            await conflict.locator('html').evaluate((element, value) => { element.dataset.bpbTheme = value; }, theme);
            await conflict.locator('#bpb-report-editor').screenshot({ path: path.join(output, `draft-conflict-${width}-${theme}.png`) });
        }
    }
    console.log(JSON.stringify({ verification: 'report-draft-ownership', hidden: true, browser: context.browser().version(), viewports: [1000, 375] }));
} finally {
    await resources.dispose();
}
