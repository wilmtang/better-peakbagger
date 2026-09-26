// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real unpacked extension, HTTPS owner fixture, hidden Chrome, no live GitHub.
/* global chrome, window, document */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';
import { createFixtureCertificate, projectRoot } from './browser-verification-fixtures.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';

const resources = createResourceStack();
let failure;
try {
    const profile = await mkdtemp(path.join(tmpdir(), 'bpb-backup-lifecycle-'));
    resources.defer('profile', () => rm(profile, { recursive: true, force: true }));
    const certificate = await createFixtureCertificate({ directory: profile });
    resources.defer('certificate', () => certificate.remove());
    const ascent = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    const edit = new JSDOM(await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascentedit.html'), 'utf8'));
    edit.window.document.getElementById('PeakListBox').innerHTML = '<option selected value="2296">Mount Rainier</option>';
    edit.window.document.getElementById('DateText').setAttribute('value', '2026-07-12');
    const editHtml = edit.serialize();
    edit.window.close();
    const server = createServer(certificate, (request, response) => {
        const pathname = new URL(request.url, 'https://www.peakbagger.com').pathname;
        const isGpx = /GPXFile/i.test(pathname);
        response.writeHead(200, { 'content-type': isGpx ? 'application/gpx+xml' : 'text/html' });
        response.end(isGpx ? '<gpx><trk><trkseg></trkseg></trk></gpx>'
            : /ascentedit/i.test(pathname) ? editHtml
                : /ascent.aspx/i.test(pathname) ? ascent : '<html><body>Away</body></html>');
    });
    resources.defer('server', () => closeServer(server));
    await listenServer(server, 0, '127.0.0.1');
    const origin = `https://www.peakbagger.com:${server.address().port}`;
    const dist = path.join(projectRoot, 'dist');
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
        viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--disable-back-forward-cache', '--enable-unsafe-swiftshader'],
        args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('browser', () => context.close());
    const page = await context.newPage();
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    await worker.evaluate(async () => {
        globalThis.__backupRequests = 0;
        globalThis.__backupWrites = 0;
        globalThis.fetch = async (url, init = {}) => {
            if (!String(url).startsWith('https://api.github.com/')) throw new Error('Unexpected fixture network');
            globalThis.__backupRequests++;
            if (init.method && init.method !== 'GET') globalThis.__backupWrites++;
            if (globalThis.__backupRequests === 1) await new Promise(resolve => { globalThis.__releaseBackupRead = resolve; });
            return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        };
        await chrome.storage.local.set({ bpbGithubAuth: { token: 'fixture-only',
            repo: { owner: 'fixture', name: 'backup', branch: 'main' } } });
        await chrome.storage.sync.set({ bpbSettings: { enableGithubBackup: true, autoGithubBackup: false } });
    });
    await page.reload();
    await page.locator('.bpb-gh-control').getByText('Checking GitHub…').waitFor();
    await page.waitForFunction(() => !!document.querySelector('.bpb-gh-control'));
    // Wait against the worker itself; a mounted label can precede its request.
    await assert.doesNotReject(async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await worker.evaluate(() => !!globalThis.__releaseBackupRead)) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('The initial GitHub comparison never reached the worker');
    });
    await page.evaluate(() => {
        window.__backupDocument = 'original';
        window.addEventListener('pageshow', event => { window.__backupRestored = event.persisted; });
    });
    await page.goto(`${origin}/away`);
    await worker.evaluate(() => globalThis.__releaseBackupRead());
    await page.goBack({ waitUntil: 'commit' });
    await page.locator('.bpb-gh-btn').getByText('Back up ascent and TR').waitFor({ timeout: 10000 });
    assert.deepEqual(await page.evaluate(() => ({ token: window.__backupDocument,
        restored: window.__backupRestored, controls: document.querySelectorAll('.bpb-gh-control').length })),
    { token: 'original', restored: true, controls: 1 });
    assert.equal(await worker.evaluate(() => globalThis.__backupWrites), 0);
    if (process.env.BPB_BACKUP_SCREENSHOT) {
        await page.screenshot({ path: `${process.env.BPB_BACKUP_SCREENSHOT}-wide.png` });
    }
    await page.setViewportSize({ width: 390, height: 760 });
    await page.locator('.bpb-gh-control').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.bpb-gh-btn').isVisible(), true);
    if (process.env.BPB_BACKUP_SCREENSHOT) {
        await page.screenshot({ path: `${process.env.BPB_BACKUP_SCREENSHOT}-narrow.png` });
    }
    console.log(`Hidden Chromium ${context.browser().version()}: exact BFCache document resumed its backup check; one control, zero writes; 1000x760 and 390x760.`);
} catch (error) { failure = error; }
await resources.dispose(failure);
