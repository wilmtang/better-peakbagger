// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Chrome loads the real unpacked extension. Firefox renders the same shipped
// bundle with fixture-owned settings APIs; neither submits a live account.
/* global document, window, chrome, getComputedStyle, FormData, scrollX, scrollY, innerWidth */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

const [browserName, ...extra] = process.argv.slice(2);
if (!['chrome', 'firefox'].includes(browserName) || extra.length) {
    throw new Error('Usage: node scripts/verify-profile-editor.mjs chrome|firefox');
}
const output = process.env.BPB_PROFILE_EDITOR_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const resources = createResourceStack();
let failure;
try {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-profile-editor-'));
    resources.defer('profile editor test profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('profile editor HTTPS fixture', () => fixture.close());
    let context;
    let settingsPage;
    if (browserName === 'chrome') {
        assertChromeLaunchAllowed();
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true,
            viewport: { width: 1280, height: 900 },
            args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${path.resolve('dist')}`,
                `--load-extension=${path.resolve('dist')}`,
                '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
        });
        resources.defer('profile editor Chrome', () => context.close());
        const registry = await context.newPage();
        await registry.goto('chrome://extensions-internals/');
        const record = await registry.waitForFunction(() => {
            try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); }
            catch { return false; }
        }).then(handle => handle.jsonValue());
        await registry.goto(`chrome-extension://${record.id}/options/options.html`);
        settingsPage = registry;
        await registry.evaluate(async () => {
            await chrome.storage.sync.set({ bpbSettings: { enableReportEditor: true,
                addReportCredit: true, enableGithubBackup: true, reportEditorMode: 'rich' } });
            await chrome.storage.local.set({ 'bpbReportDraft:900001:new': {
                text: 'Private ascent draft must stay separate', mode: 'rich', savedAt: Date.now(),
            } });
        });
        resources.defer('profile editor draft isolation', async () => {
            const draft = await registry.evaluate(async () => (await chrome.storage.local.get('bpbReportDraft:900001:new'))['bpbReportDraft:900001:new']);
            assert.equal(draft.text, 'Private ascent draft must stay separate');
        });
    } else {
        const browser = await firefox.launch({ headless: true,
            firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        resources.defer('profile editor Firefox', () => browser.close());
        context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
        await context.addInitScript(() => {
            const listeners = [];
            let settings = { enableReportEditor: true, reportEditorMode: 'rich', addReportCredit: true, enableGithubBackup: true };
            window.chrome = {
                storage: { sync: { get: async () => ({ bpbSettings: settings }) }, local: {},
                    onChanged: { addListener: listener => listeners.push(listener), removeListener() {} } },
                runtime: { getURL: value => `https://extension.invalid/${value}`,
                    onMessage: { addListener() {}, removeListener() {} },
                    sendMessage: async message => {
                        if (message.type !== 'SETTINGS_PATCH') throw new Error(`Unexpected profile message: ${message.type}`);
                        settings = { ...settings, ...message.patch };
                        for (const listener of listeners) listener({ bpbSettings: { newValue: settings } }, 'sync');
                        return { ok: true, settings };
                    } },
            };
        });
    }
    const html = await readFile('test/fixtures/pages/climber-climberedit.html', 'utf8');
    await context.route('**/climber/climberedit.aspx**', route => {
        assert.equal(route.request().method(), 'GET', 'the verifier must intercept all account submissions');
        return route.fulfill({ contentType: 'text/html', body: html });
    });
    const page = await context.newPage();
    await page.goto(`https://www.peakbagger.com:${fixture.port}/climber/climberedit.aspx?cid=900001`);
    if (browserName === 'firefox') {
        await page.addStyleTag({ path: 'dist/css/report-editor.css' });
        await page.addScriptTag({ path: 'dist/content/theme.js' });
        await page.addScriptTag({ path: 'dist/vendor/marked.umd.js' });
        await page.addScriptTag({ path: 'dist/content/profile-editor.js' });
    }
    if (output) await page.screenshot({ path: path.join(output, `${browserName}-initial.png`) });
    await page.waitForFunction(() => !!document.querySelector('#bpb-report-editor [contenteditable="true"]'), null, { timeout: 5000 })
        .catch(() => assert.fail('The account biography has no rich editor; ClimberText remains a native textarea.'));
    await page.evaluate(() => {
        window.profileProbe = { submissions: [] };
        document.getElementById('Form1').addEventListener('submit', event => {
            event.preventDefault();
            window.profileProbe.submissions.push(Object.fromEntries(new FormData(event.target)));
        });
    });
    const geometry = () => page.evaluate(() => {
        const rect = selector => {
            const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
            if (!width && !height) return { x: 0, y: 0, width: 0, height: 0 };
            return { x: x + scrollX, y: y + scrollY, width, height };
        };
        return { save: rect('#CreateUpdateAccount'), heading: rect('#biography-heading'),
            editor: rect('#bpb-report-editor'), following: rect('#following-native'),
            imageAction: rect('.bpb-re-imagebox .bpb-re-linkapply'), scrollX, scrollY };
    });
    const stable = async (before, checkScroll = true) => {
        const after = await geometry();
        for (const node of ['save', 'heading', 'editor', 'following', 'imageAction']) for (const dimension of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[node][dimension] - after[node][dimension]) <= 1,
                `${node}.${dimension} shifted: ${JSON.stringify({ before, after })}`);
        }
        if (checkScroll) for (const axis of ['scrollX', 'scrollY']) {
            assert.ok(Math.abs(before[axis] - after[axis]) <= 1, 'the reading position moved');
        }
    };
    let cases = 0;
    for (const width of [1280, 720, 390]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        // Halving the CSS viewport exercises the reflow of 200% browser zoom;
        // CSS zoom on body keeps viewport units unchanged and is not equivalent.
        await page.setViewportSize({ width: Math.floor(width / zoom), height: Math.floor(900 / zoom) });
        await (settingsPage || page).evaluate(async theme => {
            const result = await chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: { theme } });
            if (!result?.ok) throw new Error('Fixture theme preference could not be set');
        }, theme);
        await page.waitForFunction(theme => document.documentElement.dataset.bpbTheme === theme, theme);
        const rich = page.getByRole('button', { name: 'Rich text', exact: true });
        await rich.click();
        const surface = page.locator('.bpb-re-surface');
        await surface.fill('Biography for this climber.');
        await page.waitForFunction(() => document.getElementById('ClimberText').value === 'Biography for this climber.');
        await page.locator('#biography-heading').scrollIntoViewIfNeeded();
        const before = await geometry();
        await page.getByRole('button', { name: 'Insert image', exact: true }).click();
        const imageUrl = page.getByRole('textbox', { name: 'Image URL (HTTPS)', exact: true });
        await imageUrl.fill('javascript:alert(1)');
        await page.getByRole('button', { name: 'Add image', exact: true }).click();
        await page.locator('.bpb-re-imagebox [role="alert"]').waitFor({ state: 'visible' });
        // The popover deliberately opens above the toolbar; scrolling a hidden
        // control into view is browser behavior, so compare after it is in view.
        const open = await geometry();
        await imageUrl.fill('still invalid');
        await page.getByRole('button', { name: 'Add image', exact: true }).click();
        await stable(open);
        assert.equal(await page.locator('.bpb-re-photo-launch').count(), 0);
        await imageUrl.press('Escape');
        await stable(before, false);
        assert.equal(await page.locator('.bpb-re-manage').count(), 0);
        await page.getByRole('button', { name: 'Markdown', exact: true }).click();
        await page.locator('.cm-content').fill('I enjoy **ridges** and [trails](https://example.com/).');
        await page.waitForFunction(() => document.querySelector('.bpb-re-preview b')?.textContent === 'ridges');
        if (output) await page.locator('#bpb-report-editor').screenshot({ path: path.join(output, `${browserName}-${width}-${theme}-${zoom}-markdown.png`) });
        await page.getByRole('button', { name: 'Plain', exact: true }).focus();
        await page.keyboard.press('Enter');
        assert.match(await page.locator('#ClimberText').inputValue(), /\[b\]ridges\[\/b\]/);
        assert.equal(await page.locator('#native-hints').isVisible(), true);
        if (output) await page.locator('#ClimberText').screenshot({ path: path.join(output, `${browserName}-${width}-${theme}-${zoom}-plain.png`) });
        await rich.click();
        assert.equal(await page.locator('#native-hints').isVisible(), false);
        const layout = await page.evaluate(() => {
            const element = document.getElementById('bpb-report-editor');
            return { width: element.getBoundingClientRect().width, viewport: innerWidth,
                alignment: getComputedStyle(element).textAlign,
                overflow: element.scrollWidth - element.clientWidth };
        });
        if (output) await page.locator('#bpb-report-editor').screenshot({ path: path.join(output, `${browserName}-${width}-${theme}-${zoom}.png`) });
        assert.ok(layout.width <= layout.viewport && layout.overflow <= 1, JSON.stringify(layout));
        assert.equal(layout.alignment, 'left', 'the native centered paragraph must not center biography prose');
        assert.equal(await surface.evaluate(element => getComputedStyle(element).backgroundColor),
            theme === 'dark' ? 'rgb(24, 26, 27)' : 'rgb(255, 255, 255)', 'the actual editor theme must match the case');
        cases++;
    }
    assert.equal(cases, 12, 'every profile viewport/theme/zoom case must run');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.bpb-re-surface').fill('Saved biography');
    // No debounce wait: clicking the native Save must synchronously flush.
    await page.locator('#CreateUpdateAccount').click();
    const submitted = await page.evaluate(() => window.profileProbe.submissions);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].ClimberText, 'Saved biography');
    assert.equal(submitted[0].NewEmail, 'fixture@example.invalid');
    assert.equal(submitted[0].NewPassword, '');
    console.log(JSON.stringify({ browser: browserName, version: context.browser()?.version(), headless: true,
        cases, viewports: [1280, 720, 390], height: 900, zoomReflow: [1, 2], themes: ['light', 'dark'],
        accountPosts: 0, fixtureSubmissions: submitted.length,
        extension: browserName === 'chrome' ? 'real unpacked dist' : 'shipped bundle; settings APIs stubbed' }));
} catch (error) { failure = error; }
await resources.dispose(failure);
