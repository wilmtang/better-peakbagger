// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real unpacked extension, HTTPS owner fixture, hidden Chrome, no live GitHub.
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { createFixtureCertificate, projectRoot } from './browser-verification-fixtures.mts';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mts';
import { createVerificationRoot, launchVerificationChrome, PEAKBAGGER_HOST_RULE } from './verification-launch.mts';

// Worker- and page-world probes the evaluated callbacks install; each callback
// casts in place because the shared Node program must not widen the globals.
interface BackupWorker { __backupRequests: number; __backupWrites: number; __releaseBackupRead: (() => void) | undefined }
interface BackupWindow { __backupDocument: string; __backupRestored: boolean }

if (process.argv.length > 2) throw new Error('Usage: node scripts/verify-ascent-backup-lifecycle.mts');

const resources = createResourceStack();
let failure: unknown = null;
try {
    const profile = await createVerificationRoot(resources, 'bpb-backup-lifecycle-', 'profile');
    const certificate = await createFixtureCertificate({ directory: profile as never });
    assert.ok(certificate);
    resources.defer('certificate', () => certificate.remove());
    const ascent = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    const edit = new JSDOM(await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascentedit.html'), 'utf8'));
    edit.window.document.getElementById('PeakListBox')!.innerHTML = '<option selected value="2296">Mount Rainier</option>';
    edit.window.document.getElementById('DateText')!.setAttribute('value', '2026-07-12');
    const editHtml = edit.serialize();
    edit.window.close();
    const server = createServer(certificate, (request, response) => {
        const pathname = new URL(request.url || '/', 'https://www.peakbagger.com').pathname;
        const isGpx = /GPXFile/i.test(pathname);
        response.writeHead(200, { 'content-type': isGpx ? 'application/gpx+xml' : 'text/html' });
        response.end(isGpx ? '<gpx><trk><trkseg></trkseg></trk></gpx>'
            : /ascentedit/i.test(pathname) ? editHtml
                : /ascent.aspx/i.test(pathname) ? ascent : '<html><body>Away</body></html>');
    });
    resources.defer('server', () => closeServer(server));
    await listenServer(server, 0, '127.0.0.1');
    const origin = `https://www.peakbagger.com:${(server.address() as AddressInfo).port}`;
    const dist = path.join(projectRoot, 'dist');
    const context = await launchVerificationChrome(resources, 'browser', profile, {
        viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--disable-back-forward-cache', '--enable-unsafe-swiftshader'],
        trustArgs: certificate.chromeTrustArgs, extension: dist, hosts: [PEAKBAGGER_HOST_RULE],
    });
    const page = await context.newPage();
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    await worker.evaluate(async () => {
        const probe = globalThis as unknown as BackupWorker;
        probe.__backupRequests = 0;
        probe.__backupWrites = 0;
        globalThis.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
            if (!String(url).startsWith('https://api.github.com/')) throw new Error('Unexpected fixture network');
            probe.__backupRequests++;
            if (init.method && init.method !== 'GET') probe.__backupWrites++;
            if (probe.__backupRequests === 1) await new Promise<void>(resolve => { probe.__releaseBackupRead = resolve; });
            return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        };
        await chrome.storage.local.set({ bpbGithubAuth: { token: 'fixture-only',
            repo: { owner: 'fixture', name: 'backup', branch: 'main' } } });
        // Backup consent is device-local. A sync-only fixture leaves the
        // installation's existing disabled record authoritative.
        const { bpbDeviceSettings } = await chrome.storage.local.get('bpbDeviceSettings');
        await chrome.storage.local.set({ bpbDeviceSettings: { schemaVersion: 1,
            settings: { ...(bpbDeviceSettings as { settings?: object } | undefined)?.settings, enableGithubBackup: true, autoGithubBackup: false } } });
    });
    await page.reload();
    try {
        await page.locator('.bpb-gh-control').getByRole('status').filter({ hasText: 'Checking GitHub…' }).waitFor({ timeout: 10000 });
    } catch (error) {
        console.error('Backup fixture state:', await page.locator('.bpb-gh-control').evaluateAll(nodes => nodes.map(node => node.outerHTML)),
            'requests:', await worker.evaluate(() => (globalThis as unknown as BackupWorker).__backupRequests));
        throw error;
    }
    await page.waitForFunction(() => !!document.querySelector('.bpb-gh-control'));
    // Wait against the worker itself; a mounted label can precede its request.
    await assert.doesNotReject(async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await worker.evaluate(() => !!(globalThis as unknown as BackupWorker).__releaseBackupRead)) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('The initial GitHub comparison never reached the worker');
    });
    await page.evaluate(() => {
        const probe = window as unknown as BackupWindow;
        probe.__backupDocument = 'original';
        window.addEventListener('pageshow', event => { probe.__backupRestored = event.persisted; });
    });
    await page.goto(`${origin}/away`);
    await worker.evaluate(() => (globalThis as unknown as BackupWorker).__releaseBackupRead!());
    await page.goBack({ waitUntil: 'commit' });
    await page.locator('.bpb-gh-btn').getByText('Back up ascent and TR').waitFor({ timeout: 10000 });
    assert.deepEqual(await page.evaluate(() => ({ token: (window as unknown as BackupWindow).__backupDocument,
        restored: (window as unknown as BackupWindow).__backupRestored, controls: document.querySelectorAll('.bpb-gh-control').length })),
    { token: 'original', restored: true, controls: 1 });
    assert.equal(await worker.evaluate(() => (globalThis as unknown as BackupWorker).__backupWrites), 0);
    if (process.env.BPB_BACKUP_SCREENSHOT) {
        await page.screenshot({ path: `${process.env.BPB_BACKUP_SCREENSHOT}-wide.png` });
    }
    await page.setViewportSize({ width: 390, height: 760 });
    await page.locator('.bpb-gh-control').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.bpb-gh-btn').isVisible(), true);
    if (process.env.BPB_BACKUP_SCREENSHOT) {
        await page.screenshot({ path: `${process.env.BPB_BACKUP_SCREENSHOT}-narrow.png` });
    }
    console.log(`Hidden Chromium ${context.browser()!.version()}: exact BFCache document resumed its backup check; one control, zero writes; 1000x760 and 390x760.`);
} catch (error) { failure = error; }
await resources.dispose(failure as null);
