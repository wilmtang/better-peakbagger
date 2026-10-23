// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Documentation-only prototype renderer. Never loads the extension or live APIs.
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { assertChromeLaunchAllowed } from '../../../../scripts/chrome-launch-guard.mjs';
import { createFixtureCertificate, resolveFixtureFile, sendFixtureFile } from '../../../../scripts/browser-verification-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const preflight = process.argv.slice(2).includes('--preflight');
assert(process.argv.slice(2).every(arg => arg === '--preflight'), 'Unknown argument');
assertChromeLaunchAllowed();
await access(chromium.executablePath());
await access(firefox.executablePath());
const certificate = await createFixtureCertificate({ label: 'garmin-mock' });
const server = createServer({ key: certificate.key, cert: certificate.cert }, async (request, response) => {
    try {
        const pathname = new URL(request.url, 'https://www.peakbagger.com').pathname;
        if (pathname === '/preflight') {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('<!doctype html><html data-bpb-theme="light"><link rel="stylesheet" href="/src/theme/panel.css"><h1>Mock renderer ready</h1></html>');
            return;
        }
        if (!pathname.startsWith('/docs/plans/mocks/garmin-api/')
            && pathname !== '/src/theme/panel.css' && pathname !== '/icons/icon-48.png') {
            response.writeHead(404); response.end(); return;
        }
        const file = await resolveFixtureFile(pathname, root);
        if (!file) { response.writeHead(404); response.end(); return; }
        await sendFixtureFile(response, file);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
});
const browsers = [];
const failures = [];
try {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `https://www.peakbagger.com:${server.address().port}`;
    const browser = await chromium.launch({ channel: 'chromium', headless: true,
        args: ['--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1', ...certificate.chromeTrustArgs] });
    browsers.push(browser);
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(`${origin}/preflight`);
    assert.equal(await page.locator('h1').textContent(), 'Mock renderer ready');
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(241, 239, 223)');
    console.log(`Preflight: hidden Chromium ${browser.version()}, shared panel CSS loaded over isolated HTTPS.`);
    if (!preflight) {
        const { verifyAndCapture } = await import('./verify.mjs');
        await mkdir(path.join(here, 'images'), { recursive: true });
        await verifyAndCapture({ page, origin, output: path.join(here, 'images'), capture: true });
        const ff = await firefox.launch({ headless: true,
            firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        browsers.push(ff);
        const ffPage = await ff.newPage({ viewport: { width: 1180, height: 900 }, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
        await verifyAndCapture({ page: ffPage, origin, capture: false });
        console.log(`Verified hidden Chromium ${browser.version()} and Firefox ${ff.version()}; DOM/CSS only, no WebGL.`);
    }
} finally {
    for (const browser of browsers.reverse()) {
        try { await browser.close(); } catch (error) { failures.push(error); }
    }
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await certificate.remove();
    await assert.rejects(access(certificate.root));
    if (failures.length) throw new AggregateError(failures, 'Browser teardown failed');
}
