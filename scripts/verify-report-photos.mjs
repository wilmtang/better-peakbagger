// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document, ClipboardItem */
// Hidden packaged-extension coverage. ImgBB responses and its optional
// permission check are fixture-owned; no real upload or permission prompt.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';

const resources = createResourceStack();
const root = process.cwd();
let failure = null;
try {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-report-photos-'));
    resources.defer('report photo profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('report photo HTTPS fixture', () => fixture.close());
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('report photo browser', () => context.close());
    const registry = await context.newPage();
    await registry.goto('chrome://extensions-internals/');
    const record = await registry.waitForFunction(() => {
        try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); }
        catch { return false; }
    }).then(handle => handle.jsonValue());
    await registry.close();
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${record.id}/options/options.html`);
    await settings.evaluate(async () => {
        await chrome.storage.local.set({ bpbImgbbAuth: { key: 'fixture-key', savedAt: new Date().toISOString() } });
        await chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: -1 });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => { chrome.permissions.contains = async () => true; });
    let uploads = 0;
    const posts = [];
    await context.route('https://api.imgbb.com/**', route => {
        uploads++;
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ success: true, status: 200, data: {
                id: `fixture-${uploads}`, url_viewer: 'https://ibb.co/fixture', url: 'https://i.ibb.co/fixture/photo.png',
                display_url: 'https://i.ibb.co/fixture/photo.png', width: 800, height: 500, size: 3000,
                time: 1788868800, expiration: 0, thumb: { url: 'https://i.ibb.co/fixture/thumb.png' },
                delete_url: 'https://ibb.co/fixture/delete',
            } }) });
    });
    const html = await readFile(path.join(root, 'test/fixtures/pages/climber-ascentedit.html'), 'utf8');
    await context.route('**/climber/ascentedit.aspx**', async route => {
        if (route.request().method() === 'POST') posts.push(route.request().postData());
        await route.fulfill({ contentType: 'text/html', body: html });
    });
    const report = await context.newPage();
    const url = `https://www.peakbagger.com:${fixture.port}/climber/ascentedit.aspx?cid=900001`;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    await report.goto(url);
    await report.locator('.bpb-re-surface').waitFor();
    await report.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800; canvas.height = 500;
        const paint = canvas.getContext('2d');
        const sky = paint.createLinearGradient(0, 0, 0, 500);
        sky.addColorStop(0, '#a4c9df'); sky.addColorStop(1, '#eff5f8');
        paint.fillStyle = sky; paint.fillRect(0, 0, 800, 500);
        paint.fillStyle = '#647c81'; paint.beginPath(); paint.moveTo(0, 500); paint.lineTo(280, 120);
        paint.lineTo(480, 340); paint.lineTo(640, 180); paint.lineTo(800, 500); paint.fill();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    await report.locator('.bpb-re-surface').click();
    await report.keyboard.press('Meta+V');
    await report.locator('.bpb-re-local-photo-status').filter({ hasText: 'until you save' }).waitFor();
    assert.equal(uploads, 0);
    await report.locator('.bpb-re-local-photo-actions button').waitFor();
    await report.waitForFunction(() => document.querySelector('.bpb-re-surface img')?.naturalWidth === 800);
    const output = process.env.BPB_REPORT_PHOTOS_OUTPUT || path.join(root, 'tmp/report-photos');
    await mkdir(output, { recursive: true });
    await report.locator('#bpb-report-editor').screenshot({ path: path.join(output, 'pasted-light.png') });
    await report.locator('html').evaluate(element => { element.dataset.bpbTheme = 'dark'; });
    await report.locator('#bpb-report-editor').screenshot({ path: path.join(output, 'pasted-dark.png') });
    await report.locator('html').evaluate(element => { element.dataset.bpbTheme = 'light'; });
    // Reload and explicitly restore the draft: no blob URL or pixels are put
    // in JournalText, and the library resolves the same persisted reference.
    await report.reload();
    await report.locator('.bpb-re-draft-restore').click();
    await report.waitForFunction(() => document.querySelector('.bpb-re-surface img')?.naturalWidth === 800);
    const opened = context.waitForEvent('page').catch(error => { console.error('Open editor failed:', error.message); return null; });
    await report.locator('.bpb-re-image-resize img').dblclick();
    const editor = await opened;
    await editor.locator('#upload-insert').filter({ hasText: 'Save and return' }).waitFor();
    await editor.waitForFunction(() => document.querySelector('#editor-workspace')?.hidden === false);
    await editor.locator('#photo-alt').fill('Mountain route');
    await editor.locator('#upload-insert').click();
    await editor.getByText('Photo updated in the report. It will upload when you save the TR.', { exact: true }).waitFor();
    await report.waitForFunction(() => document.querySelector('.bpb-re-surface img')?.alt === 'Mountain route');
    assert.equal(uploads, 0);
    await editor.screenshot({ path: path.join(output, 'saved-photo-editor.png') });
    await report.setViewportSize({ width: 720, height: 900 });
    await report.locator('#bpb-report-editor').screenshot({ path: path.join(output, 'pasted-narrow.png') });
    await report.locator('#SaveButton').click();
    await report.waitForURL(url, { waitUntil: 'domcontentloaded' });
    await report.waitForFunction(() => !document.querySelector('.bpb-re-local-photo-status')?.textContent.includes('Uploading'));
    // Request dispatch is the native form's observable boundary; fixture POST
    // handling does not claim that Peakbagger accepted a real ascent.
    const deadline = Date.now() + 20000;
    while (!posts.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(posts.length, 1);
    assert.equal(uploads, 1);
    const reportText = /name="JournalText"\r\n\r\n([\s\S]*?)\r\n--/.exec(posts[0])?.[1]
        ?? new URLSearchParams(posts[0]).get('JournalText');
    assert.match(reportText, /https:\/\/i\.ibb\.co\/fixture\/photo\.png/);
    assert.doesNotMatch(reportText, /bpb-photo\.invalid|data:image|blob:/);
    console.log(JSON.stringify({ browser: context.browser().version(), mode: 'hidden', viewports: ['1280x900', '720x900'], uploads, posts: posts.length, output }));
} catch (error) { console.error('Primary failure:', error); failure = error; }
await resources.dispose(failure);
