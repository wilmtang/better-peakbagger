#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Render the Grand Teton store capture with the shipped MapLibre/Chart.js
// builds against live Mapterhorn terrain and OpenFreeMap OSM vector tiles.

import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'store-assets', 'showcase-6-grand-teton-3d-route.png'));
const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp']
]);

const safeFile = async pathname => {
    const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
    try { return (await stat(file)).isFile() ? file : null; } catch { return null; }
};

const server = createServer(async (request, response) => {
    try {
        const file = await safeFile(new URL(request.url, 'http://127.0.0.1').pathname);
        if (!file) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        response.writeHead(200, { 'content-type': contentTypes.get(path.extname(file)) || 'application/octet-stream' });
        response.end(await readFile(file));
    } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error.stack || error.message);
    }
});

const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

await listen();
const { port } = server.address();
let browser;
try {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const providerRequests = new Set();
    const browserErrors = [];
    page.on('console', message => {
        if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', error => browserErrors.push(`page: ${error.message}`));
    page.on('requestfailed', request => browserErrors.push(`request: ${request.url()} (${request.failure()?.errorText || 'failed'})`));
    page.on('request', request => {
        const host = new URL(request.url()).hostname;
        if (host === 'tiles.mapterhorn.com' || host === 'tiles.openfreemap.org') providerRequests.add(host);
    });
    await page.goto(`http://127.0.0.1:${port}/scripts/showcase/teton-live-terrain.html`, { waitUntil: 'domcontentloaded' });
    const renderer = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const extension = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return extension && gl ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : '';
    });
    if (!renderer || /swiftshader|software/i.test(renderer)) {
        throw new Error(`A hardware renderer is required for the terrain capture (renderer=${renderer || 'unavailable'})`);
    }
    await page.waitForFunction(() => window.__tetonReady === true, null, { timeout: 30000 }).catch(async () => {
        const state = await page.evaluate(() => window.__tetonState || null);
        throw new Error(`Grand Teton terrain did not become ready (state=${JSON.stringify(state)}, errors=${JSON.stringify(browserErrors)})`);
    });
    if (!providerRequests.has('tiles.mapterhorn.com') || !providerRequests.has('tiles.openfreemap.org')) {
        throw new Error(`The live providers did not both load (requests=${JSON.stringify([...providerRequests])})`);
    }
    await mkdir(path.dirname(output), { recursive: true });
    await page.screenshot({ path: output });
    console.log(`Rendered ${output}`);
    console.log(`Renderer: ${renderer} (hidden Chrome for Testing, 1280x800)`);
    console.log(`Live providers: ${[...providerRequests].sort().join(', ')}`);
} finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}
