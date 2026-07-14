#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_BIN || ({
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')
}[process.platform] || 'google-chrome');
const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'better-peakbagger-terrain-visual'));
const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.gpx', 'application/gpx+xml; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png']
]);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const safeFile = async pathname => {
    const resolved = path.resolve(root, `.${pathname}`);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    try {
        return (await stat(resolved)).isFile() ? resolved : null;
    } catch {
        return null;
    }
};

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const file = await safeFile(decodeURIComponent(url.pathname));
        if (!file) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        response.writeHead(200, {
            'content-type': contentTypes.get(path.extname(file)) || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        response.end(await readFile(file));
    } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error.stack || error.message);
    }
});

const waitForDebugPort = async (profile, child, timeoutMs = 10000) => {
    const activePortFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Chrome exited before opening CDP (${child.exitCode})`);
        try {
            const [port] = (await readFile(activePortFile, 'utf8')).trim().split('\n');
            if (/^\d+$/.test(port)) return Number(port);
        } catch { /* Chrome has not written the port file yet. */ }
        await delay(50);
    }
    throw new Error('Timed out waiting for Chrome DevToolsActivePort');
};

const connectCdp = async url => {
    if (typeof WebSocket !== 'function') throw new Error('This verification script requires a Node.js runtime with global WebSocket support');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.id) {
            const promise = pending.get(message.id);
            if (!promise) return;
            pending.delete(message.id);
            if (message.error) promise.reject(new Error(`${promise.method}: ${message.error.message}`));
            else promise.resolve(message.result);
            return;
        }
        for (const listener of listeners.get(message.method) || []) listener(message.params);
    });

    return {
        call(method, params = {}) {
            const id = nextId++;
            socket.send(JSON.stringify({ id, method, params }));
            return new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
        },
        on(method, listener) {
            if (!listeners.has(method)) listeners.set(method, []);
            listeners.get(method).push(listener);
        },
        close() { socket.close(); }
    };
};

const evaluate = async (cdp, expression) => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
    return result.result.value;
};

const waitForPageState = async (cdp, expression, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
        try {
            lastValue = await evaluate(cdp, expression);
            if (lastValue && lastValue.ready) return lastValue;
        } catch { /* Navigation may replace the execution context mid-poll. */ }
        await delay(200);
    }
    throw new Error(`Timed out waiting for page state: ${JSON.stringify(lastValue)}`);
};

const capture = async (cdp, file) => {
    const { data } = await cdp.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
    });
    await writeFile(file, Buffer.from(data, 'base64'));
};

const navigate = async (cdp, url, width, height) => {
    await cdp.call('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false
    });
    await cdp.call('Page.navigate', { url });
    await waitForPageState(cdp, '({ ready: document.readyState === "complete" })', 15000);
};

await mkdir(outputDir, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const serverPort = server.address().port;
const profile = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-terrain-profile-'));
const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeStderr = '';
chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-20000); });

let cdp;
try {
    const debugPort = await waitForDebugPort(profile, chrome);
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = pages.find(candidate => candidate.type === 'page');
    if (!page) throw new Error('Chrome opened no debuggable page');
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await Promise.all([
        cdp.call('Page.enable'),
        cdp.call('Runtime.enable'),
        cdp.call('Network.enable')
    ]);

    const terrainRequests = [];
    const runtimeErrors = [];
    cdp.on('Network.requestWillBeSent', ({ request }) => {
        if (/\.mapterhorn\.com\//.test(request.url)) terrainRequests.push(request.url);
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text || 'Unknown runtime exception');
    });

    const baseUrl = `http://127.0.0.1:${serverPort}/scripts/showcase/terrain.html`;
    await navigate(cdp, `${baseUrl}?mode=notice`, 1000, 900);
    await waitForPageState(cdp, `(() => {
        const notice = document.getElementById('bpb-terrain-disclosure');
        return { ready: notice && notice.style.display === 'block', text: notice && notice.textContent };
    })()`);
    await delay(400);
    if (terrainRequests.length) throw new Error('Terrain requests started before the consent action');
    await capture(cdp, path.join(outputDir, 'consent-default-450.png'));

    await navigate(cdp, `${baseUrl}?mode=terrain&map=wide`, 1280, 950);
    const ready = await waitForPageState(cdp, `(() => {
        const toggle = document.getElementById('bpb-terrain-toggle');
        const surface = document.getElementById('bpb-terrain-map');
        const message = document.getElementById('bpb-terrain-message');
        return {
            ready: toggle && toggle.textContent === '2D map' && surface && surface.style.visibility === 'visible',
            toggle: toggle && toggle.textContent,
            message: message && message.textContent,
            canvas: surface && surface.querySelector('canvas') && {
                width: surface.querySelector('canvas').width,
                height: surface.querySelector('canvas').height
            }
        };
    })()`);
    await delay(1200);
    if (!terrainRequests.some(url => url.endsWith('/tilejson.json'))) throw new Error('The consented view did not request Mapterhorn TileJSON');
    if (!terrainRequests.some(url => url.endsWith('.webp'))) throw new Error('The consented view did not request terrain tiles');
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);
    await capture(cdp, path.join(outputDir, 'terrain-wide-800.png'));

    await navigate(cdp, `${baseUrl}?mode=terrain&theme=dark`, 1000, 900);
    const darkReady = await waitForPageState(cdp, `(() => {
        const toggle = document.getElementById('bpb-terrain-toggle');
        const surface = document.getElementById('bpb-terrain-map');
        return {
            ready: toggle && toggle.textContent === '2D map' && surface
                && surface.style.visibility === 'visible' && surface.dataset.theme === 'dark',
            canvas: surface && surface.querySelector('canvas') && {
                width: surface.querySelector('canvas').width,
                height: surface.querySelector('canvas').height
            }
        };
    })()`);
    await delay(800);
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);
    await capture(cdp, path.join(outputDir, 'terrain-dark-450.png'));

    console.log(`Hidden Chrome visual verification passed (${ready.canvas.width}x${ready.canvas.height} wide, ${darkReady.canvas.width}x${darkReady.canvas.height} default).`);
    console.log(`Screenshots: ${outputDir}`);
} catch (error) {
    if (chromeStderr) error.message += `\nChrome stderr (tail):\n${chromeStderr}`;
    throw error;
} finally {
    if (cdp) cdp.close();
    server.close();
    if (chrome.exitCode === null) chrome.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => chrome.once('exit', resolve)),
        delay(2000).then(() => { if (chrome.exitCode === null) chrome.kill('SIGKILL'); })
    ]);
    await rm(profile, { recursive: true, force: true });
}
