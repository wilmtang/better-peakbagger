#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

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
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml; charset=utf-8']
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
        // Peakbagger's own peak-marker feed: answer like /Async/PLLBB.aspx,
        // with synthetic peaks placed inside whatever box was requested so a
        // dot always lands near the camera center.
        if (url.pathname.toLowerCase() === '/async/pllbb.aspx') {
            const bounds = ['miny', 'maxy', 'minx', 'maxx'].map(name => Number(url.searchParams.get(name)));
            if (bounds.some(value => !Number.isFinite(value))) {
                response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                response.end('Bad bounds');
                return;
            }
            const [miny, maxy, minx, maxx] = bounds;
            const cy = (miny + maxy) / 2;
            const cx = (minx + maxx) / 2;
            const dy = (maxy - miny) / 8;
            const dx = (maxx - minx) / 8;
            response.writeHead(200, { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' });
            response.end(`<?xml version='1.0' encoding='UTF-8'?><ts>`
                + `<t i="58603" n="Iron Mountain" a="${cy}" o="${cx}" c="1" r="246"/>`
                + `<t i="38375" n="Peak 6057" a="${cy + dy}" o="${cx + dx}" c="0" r="137"/>`
                + `<t i="-114297" n="Peak 5000 (Prov)" a="${cy - dy}" o="${cx - dx}" c="2" r="10"/>`
                + `</ts>`);
            return;
        }
        const showcaseRoutes = {
            '/climber/ascent.aspx': '/scripts/showcase/terrain.html',
            '/map/bigmap.aspx': '/scripts/showcase/big-map.html',
            // The synthetic MasterMap pages are served at a real MasterMap.aspx
            // path so the peak-feed client can read its parameters from the
            // iframe URL exactly as it does on the live site.
            '/map/mastermap.aspx': url.searchParams.get('big') === '1'
                ? '/scripts/showcase/big-map-native.html'
                : '/scripts/showcase/terrain-native-map.html'
        };
        let pathname = showcaseRoutes[url.pathname.toLowerCase()] || decodeURIComponent(url.pathname);
        if (pathname.startsWith('/scripts/showcase/terrain-tiles/')) {
            pathname = '/scripts/showcase/terrain-basemap-tile.png';
        }
        const file = await safeFile(pathname);
        if (!file) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        response.writeHead(200, {
            'content-type': contentTypes.get(path.extname(file)) || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        let contents = await readFile(file);
        if (url.pathname === '/dist/terrain/terrain.html') {
            // The extension resources live under dist/; map getURL('x') to /dist/x
            // so the frame's MapLibre worker and the frame bundle resolve there.
            contents = Buffer.from(contents.toString('utf8').replace('</head>', `  <script>
    globalThis.chrome = { runtime: { getURL: resource => new URL('/dist/' + resource, location.origin).href } };
  </script>
</head>`));
        } else if (url.pathname === '/dist/options/options.html' && url.searchParams.get('visual') === '1') {
            contents = Buffer.from(contents.toString('utf8').replace('    <script src="options.js"></script>\n', ''));
        }
        response.end(contents);
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

// Poll a Node-side condition (network requests recorded off CDP events) instead
// of sleeping a fixed span and hoping. A sleep that is long enough on an idle
// machine is not long enough on a loaded one, and the failure reads as a
// product bug rather than a slow tick.
const waitForCondition = async (predicate, describe, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // await: an async predicate returns a Promise, which is always truthy.
        if (await predicate()) return;
        if (Date.now() >= deadline) throw new Error(await describe());
        await delay(100);
    }
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

const captureBuffer = async cdp => {
    const { data } = await cdp.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
    });
    return Buffer.from(data, 'base64');
};

const capture = async (cdp, file) => {
    await writeFile(file, await captureBuffer(cdp));
};

// Minimal decoder for the 8-bit non-interlaced RGB(A) PNGs Chrome emits, so
// WebGL output (which DOM queries cannot see) can be asserted by pixel color.
const decodePng = buffer => {
    let offset = 8;
    const idat = [];
    let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        offset += 12 + length;
    }
    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error(`Unsupported screenshot PNG (depth ${bitDepth}, color ${colorType}, interlace ${interlace})`);
    }
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = pixels.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const left = x >= bpp ? out[x - bpp] : 0;
            const up = prev ? prev[x] : 0;
            const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
            let value = row[x];
            if (filter === 1) value += left;
            else if (filter === 2) value += up;
            else if (filter === 3) value += Math.floor((left + up) / 2);
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
                value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            }
            out[x] = value & 0xff;
        }
    }
    return { width, height, bpp, pixels };
};

// Centroid of the pixels matching a color predicate — used to find a rendered
// peak ring on the composited screenshot and to prove it disappears.
const findColorCluster = (png, matches) => {
    let count = 0, sumX = 0, sumY = 0;
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const i = (y * png.width + x) * png.bpp;
            if (matches(png.pixels[i], png.pixels[i + 1], png.pixels[i + 2])) {
                count++;
                sumX += x;
                sumY += y;
            }
        }
    }
    return count ? { count, x: Math.round(sumX / count), y: Math.round(sumY / count) } : { count: 0, x: NaN, y: NaN };
};

// The climbed ring paints pure #00ff00 at 0.95 opacity — nothing in the
// terrain palette, drape fixture, or controls comes near this.
const isClimbedRingGreen = (r, g, b) => g > 220 && r < 110 && b < 110;

const findClimbedRing = async cdp => findColorCluster(decodePng(await captureBuffer(cdp)), isClimbedRingGreen);

const waitForClimbedRing = async (cdp, { present, label, timeoutMs = 12000 }) => {
    const deadline = Date.now() + timeoutMs;
    let cluster = { count: 0 };
    while (Date.now() < deadline) {
        cluster = await findClimbedRing(cdp);
        if (present ? cluster.count >= 15 : cluster.count <= 2) return cluster;
        await delay(400);
    }
    throw new Error(`${label}: expected the climbed peak ring to be ${present ? 'visible' : 'gone'} (matched ${cluster.count} pixels)`);
};

// Wait until the climbed ring is not just present but resting: two successive
// screenshots agreeing on its centroid, so a click aimed at it cannot race a
// dots refresh that moves the synthetic peaks.
const waitForStableClimbedRing = async (cdp, label, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    let previous = null;
    for (;;) {
        const cluster = await findClimbedRing(cdp);
        if (cluster.count >= 15 && previous
            && Math.abs(cluster.x - previous.x) <= 1 && Math.abs(cluster.y - previous.y) <= 1) return cluster;
        if (Date.now() >= deadline) {
            throw new Error(`${label}: no stable climbed ring (last ${JSON.stringify(cluster)})`);
        }
        previous = cluster.count >= 15 ? cluster : null;
        await delay(300);
    }
};

const clickAt = async (cdp, x, y) => {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

// The vertical gap between the floating toggle's bottom and the 3D zoom stack's
// top, in page pixels. Negative means the toggle overlaps (covers) the zoom.
const measureToggleGap = cdp => evaluate(cdp, `(() => {
    const toggle = document.getElementById('bpb-terrain-toggle');
    const frame = document.getElementById('bpb-terrain-frame');
    const nav = frame && frame.contentDocument && frame.contentDocument.querySelector('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-group');
    if (!toggle || !nav) return { gap: NaN };
    const fr = frame.getBoundingClientRect();
    const tr = toggle.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    return { toggleBottom: Math.round(tr.bottom), navTop: Math.round(fr.top + nr.top), gap: Math.round((fr.top + nr.top) - tr.bottom) };
})()`);

// Same, for the 2D state: the toggle's bottom against the native Leaflet zoom
// (inside the same-origin MasterMap iframe). This exercises the same live
// measurement the extension uses to anchor the toggle in 2D.
const measureNative2dGap = cdp => evaluate(cdp, `(() => {
    const toggle = document.getElementById('bpb-terrain-toggle');
    const iframe = document.querySelector('iframe[src*="MasterMap.aspx" i]');
    const zoom = iframe && iframe.contentDocument && iframe.contentDocument.querySelector('.leaflet-control-zoom');
    if (!toggle || !zoom) return { gap: NaN };
    const tr = toggle.getBoundingClientRect();
    const ir = iframe.getBoundingClientRect();
    const zr = zoom.getBoundingClientRect();
    return { toggleBottom: Math.round(tr.bottom), zoomTop: Math.round(ir.top + zr.top), gap: Math.round((ir.top + zr.top) - tr.bottom) };
})()`);

// Full Screen keeps its Leaflet map (and zoom) in the same-origin #if MasterMap
// iframe, so the native zoom is measured through the iframe (offset included),
// exercising the iframe branch of the extension's toggle placement.
const measureBigMap2dGap = cdp => evaluate(cdp, `(() => {
    const toggle = document.getElementById('bpb-terrain-toggle');
    const iframe = document.querySelector('iframe#if, iframe[src*="MasterMap.aspx" i]');
    const zoom = iframe && iframe.contentDocument && iframe.contentDocument.querySelector('.leaflet-control-zoom');
    if (!toggle || !zoom) return { gap: NaN };
    const tr = toggle.getBoundingClientRect();
    const ir = iframe.getBoundingClientRect();
    const zr = zoom.getBoundingClientRect();
    return { toggleBottom: Math.round(tr.bottom), zoomTop: Math.round(ir.top + zr.top), gap: Math.round((ir.top + zr.top) - tr.bottom) };
})()`);

// Plain scroll must zoom the 3D map directly — the same gesture the native 2D
// map answers, with no ⌘/Ctrl modifier. The MapLibre scale control is the
// observable: its displayed distance changes when the zoom actually changes.
const assertPlainScrollZooms = async (cdp, label) => {
    const target = await evaluate(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const doc = frame && frame.contentDocument;
        const scale = doc && doc.querySelector('.maplibregl-ctrl-scale');
        if (!frame || !scale) return null;
        if (doc.querySelector('.maplibregl-cooperative-gesture-screen')) return { cooperative: true };
        const rect = frame.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            scale: scale.textContent
        };
    })()`);
    if (!target) throw new Error(`${label}: terrain frame or scale control missing before the scroll-zoom check`);
    if (target.cooperative) throw new Error(`${label}: cooperative-gesture overlay present — plain scroll would demand a modifier`);
    for (let tick = 0; tick < 4; tick++) {
        await cdp.call('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: target.x, y: target.y, deltaX: 0, deltaY: -240
        });
        await delay(120);
    }
    await waitForPageState(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const scale = frame && frame.contentDocument
            && frame.contentDocument.querySelector('.maplibregl-ctrl-scale');
        return {
            ready: Boolean(scale) && scale.textContent !== ${JSON.stringify(target.scale)},
            scale: scale && scale.textContent
        };
    })()`, 8000).catch(() => {
        throw new Error(`${label}: plain scroll did not zoom the 3D map (scale stuck at "${target.scale}")`);
    });
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
    // Headless Chrome still reaches the real GPU (Metal on macOS, and the
    // platform default elsewhere), so no ANGLE override belongs here. Forcing
    // SwiftShader would software-render MapLibre's terrain — minutes of pegged
    // CPU, an 8192 texture cap, and a renderer the users never run. The
    // hardware renderer is asserted below rather than assumed.
    '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1',
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

    // A software renderer would still paint plausible-looking screenshots, so a
    // silent fall back to SwiftShader could pass this suite while proving
    // nothing about what users see. Fail closed, and report the renderer.
    const renderer = await evaluate(cdp, `(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return null;
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    })()`);
    if (!renderer) throw new Error('No WebGL context: this suite cannot verify the 3D map');
    if (/swiftshader|software|llvmpipe/i.test(renderer)) {
        throw new Error(`Refusing to verify the 3D map on a software renderer (${renderer}). `
            + 'MapLibre terrain must be checked on the GPU users actually render with.');
    }
    console.log(`Renderer: ${renderer} (headless, GPU)`);

    const terrainRequests = [];
    const basemapRequests = [];
    const peakFeedRequests = [];
    const runtimeErrors = [];
    cdp.on('Network.requestWillBeSent', ({ request }) => {
        if (/\.mapterhorn\.com\//.test(request.url)) terrainRequests.push(request.url);
        if (/\/scripts\/showcase\/terrain-tiles\//.test(request.url)) basemapRequests.push(request.url);
        if (/\/Async\/PLLBB\.aspx\?/i.test(request.url)) peakFeedRequests.push(request.url);
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text || 'Unknown runtime exception');
    });

    const baseUrl = `http://www.peakbagger.com:${serverPort}/climber/ascent.aspx`;
    await navigate(cdp, `${baseUrl}?mode=idle`, 1000, 900);
    await waitForPageState(cdp, `(() => {
        const toggle = document.getElementById('bpb-terrain-toggle');
        return {
            ready: toggle && !toggle.disabled,
            disclosureExists: Boolean(document.getElementById('bpb-terrain-disclosure'))
        };
    })()`);
    await delay(400);
    if (await evaluate(cdp, 'Boolean(document.getElementById("bpb-terrain-disclosure"))')) {
        throw new Error('The removed in-map privacy notice is still present');
    }
    if (terrainRequests.length || basemapRequests.length) throw new Error('3D tile requests started before the map button was clicked');
    if (peakFeedRequests.length) throw new Error('The peak feed was queried while the 2D map was still native');
    const ascent2dMetrics = await measureNative2dGap(cdp);
    if (!Number.isFinite(ascent2dMetrics.gap)) throw new Error('Could not measure the 2D toggle against the native zoom');
    if (ascent2dMetrics.gap < 0) throw new Error(`Ascent 2D toggle overlaps the native zoom (gap ${ascent2dMetrics.gap}px)`);
    if (ascent2dMetrics.gap > 40) throw new Error(`Ascent 2D toggle floats too far above the native zoom (gap ${ascent2dMetrics.gap}px)`);
    await capture(cdp, path.join(outputDir, 'map-default-450.png'));

    await navigate(cdp, `${baseUrl}?mode=terrain&map=wide`, 1280, 950);
    const ready = await waitForPageState(cdp, `(() => {
        const toggle = document.getElementById('bpb-terrain-toggle');
        const frame = document.getElementById('bpb-terrain-frame');
        const surface = frame && frame.contentDocument && frame.contentDocument.getElementById('bpb-terrain-map');
        const message = document.getElementById('bpb-terrain-message');
        return {
            ready: toggle && toggle.textContent === '2D' && frame && frame.style.opacity === '1' && surface,
            toggle: toggle && toggle.textContent,
            message: message && message.textContent,
            badge: (() => {
                const select = surface && surface.querySelector('.bpb-terrain-picker');
                return select && select.selectedIndex >= 0 ? select.options[select.selectedIndex].textContent : '';
            })(),
            canvas: surface && surface.querySelector('canvas') && {
                width: surface.querySelector('canvas').width,
                height: surface.querySelector('canvas').height
            }
        };
    })()`);
    // Read the picker fresh rather than trusting the snapshot taken the instant
    // the frame surfaced: the drape is applied a beat later, so that snapshot
    // reported "Terrain only" on a loaded machine and failed a working build.
    const activeBadge = () => evaluate(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const surface = frame && frame.contentDocument && frame.contentDocument.getElementById('bpb-terrain-map');
        const select = surface && surface.querySelector('.bpb-terrain-picker');
        return select && select.selectedIndex >= 0 ? select.options[select.selectedIndex].textContent : '';
    })()`);
    await waitForCondition(() => terrainRequests.some(url => url.endsWith('.webp')),
        () => 'The 3D view did not request terrain tiles');
    await waitForCondition(() => basemapRequests.length,
        async () => `The 3D view did not request the selected Leaflet raster layer (badge: ${await activeBadge() || 'missing'})`);
    await waitForCondition(async () => /Synthetic topographic map/.test(await activeBadge()),
        async () => `The selected layer was not retained: ${await activeBadge()}`);
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);
    const ascentMetrics = await measureToggleGap(cdp);
    if (ascentMetrics.gap < 0) throw new Error(`Ascent 3D toggle overlaps the zoom controls (gap ${ascentMetrics.gap}px)`);
    if (ascentMetrics.gap > 40) throw new Error(`Ascent 3D toggle floats too far above the zoom controls (gap ${ascentMetrics.gap}px)`);
    await capture(cdp, path.join(outputDir, 'terrain-wide-800.png'));

    // Peak dots: the 3D camera settle must query the native feed with the
    // parameters from the MasterMap iframe URL (ascent map: type + climber
    // id, no subject pid), render the rings, open the name-link popup on
    // click, and drop everything once the view widens past the native cutoff.
    if (!peakFeedRequests.length) throw new Error('The 3D view did not ask the peak feed after settling');
    const feedUrl = new URL(peakFeedRequests[0]);
    if (feedUrl.searchParams.get('t') !== 'A' || feedUrl.searchParams.get('cid') !== '900001'
        || feedUrl.searchParams.get('pid') !== null) {
        throw new Error(`Peak feed query does not mirror the native map: ${peakFeedRequests[0]}`);
    }
    const ring = await waitForClimbedRing(cdp, { present: true, label: 'Ascent 3D peaks' });
    await clickAt(cdp, ring.x, ring.y);
    const peakPopup = await waitForPageState(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const link = frame && frame.contentDocument
            && frame.contentDocument.querySelector('.maplibregl-popup .bpb-peak-popup a');
        return {
            ready: Boolean(link),
            href: link && link.href,
            text: link && link.textContent,
            target: link && link.target,
            rel: link && link.rel
        };
    })()`, 8000).catch(() => {
        throw new Error(`Ascent 3D peaks: clicking the rendered ring at ${ring.x},${ring.y} opened no popup`);
    });
    if (!/\/peak\.aspx\?pid=58603$/.test(peakPopup.href) || peakPopup.text !== 'Iron Mountain'
        || peakPopup.target !== '_blank' || !/noopener/.test(peakPopup.rel || '')) {
        throw new Error(`Peak popup is wrong: ${JSON.stringify(peakPopup)}`);
    }
    await capture(cdp, path.join(outputDir, 'terrain-peaks-popup.png'));

    await assertPlainScrollZooms(cdp, 'Ascent 3D');

    // Regression: the dots must stay hoverable and clickable with the camera
    // tilted toward horizontal. MapLibre's layer-scoped events resolve the
    // cursor through the terrain surface behind the ring — at high pitch that
    // lands kilometers past the peak (or in the sky), so the dots went dead;
    // the frame now hit-tests the billboarded rings in screen space. Right-
    // drag far past the 80° pitch clamp, then hover and click the ring.
    const peakFeedBeforeTilt = peakFeedRequests.length;
    const tilt = { x: 640, y: 600 };
    await cdp.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: tilt.x, y: tilt.y, button: 'right', buttons: 2, clickCount: 1
    });
    for (let step = 1; step <= 5; step++) {
        await cdp.call('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: tilt.x, y: tilt.y - step * 60, buttons: 2
        });
        await delay(60);
    }
    await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: tilt.x, y: tilt.y - 300, button: 'right', buttons: 2, clickCount: 1
    });
    // A pitch change alone re-keys the clamped view bounds, so the settle must
    // produce a fresh feed request — its absence means the gesture never
    // registered and the tilted checks below would silently re-test pitch 60.
    await waitForCondition(() => peakFeedRequests.length > peakFeedBeforeTilt,
        () => 'Tilting the camera settled into no new peak-feed request — the right-drag pitch gesture did not register');
    const tiltedRing = await waitForStableClimbedRing(cdp, 'Ascent 3D tilted peaks');
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tiltedRing.x, y: tiltedRing.y });
    await waitForPageState(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const canvas = frame && frame.contentDocument && frame.contentDocument.querySelector('.maplibregl-canvas');
        return { ready: Boolean(canvas) && canvas.style.cursor === 'pointer', cursor: canvas ? canvas.style.cursor : 'no-canvas' };
    })()`, 8000).catch(() => {
        throw new Error(`Ascent 3D tilted peaks: hovering the ring at ${tiltedRing.x},${tiltedRing.y} showed no pointer cursor`);
    });
    const stalePopup = await evaluate(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        return Boolean(frame && frame.contentDocument && frame.contentDocument.querySelector('.maplibregl-popup'));
    })()`);
    if (stalePopup) throw new Error('A stale popup is already open before the tilted-ring click');
    // Click the upper half of the ring — the pixels whose behind-the-billboard
    // terrain is farthest away (or sky), where the old path failed hardest.
    await clickAt(cdp, tiltedRing.x, tiltedRing.y - 5);
    const tiltedPopup = await waitForPageState(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const link = frame && frame.contentDocument
            && frame.contentDocument.querySelector('.maplibregl-popup .bpb-peak-popup a');
        return { ready: Boolean(link), href: link && link.href, text: link && link.textContent };
    })()`, 8000).catch(() => {
        throw new Error(`Ascent 3D tilted peaks: clicking the rendered ring at ${tiltedRing.x},${tiltedRing.y - 5} opened no popup`);
    });
    if (!/\/peak\.aspx\?pid=58603$/.test(tiltedPopup.href) || tiltedPopup.text !== 'Iron Mountain') {
        throw new Error(`Tilted peak popup is wrong: ${JSON.stringify(tiltedPopup)}`);
    }
    await capture(cdp, path.join(outputDir, 'terrain-peaks-tilted-popup.png'));

    // Zoom far out: the dots and any open popup must clear, exactly like the
    // native map when it covers too big an area.
    const scrollTarget = { x: Math.round(1280 / 2), y: Math.round(950 / 2) };
    for (let tick = 0; tick < 14; tick++) {
        await cdp.call('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: scrollTarget.x, y: scrollTarget.y, deltaX: 0, deltaY: 240
        });
        await delay(120);
    }
    await waitForClimbedRing(cdp, { present: false, label: 'Ascent 3D zoomed out' });
    const orphanPopup = await evaluate(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        return Boolean(frame && frame.contentDocument && frame.contentDocument.querySelector('.maplibregl-popup'));
    })()`);
    if (orphanPopup) throw new Error('The peak popup outlived its cleared dot after zooming out');
    await capture(cdp, path.join(outputDir, 'terrain-peaks-zoomed-out.png'));

    // Regression: dragging the host page's resize handle reshapes the frame
    // many times per second. Every map.resize() re-allocates the canvas
    // backing store, which the browser clears — and MapLibre's own repaint
    // waits for the next animation frame, so each drag step composited one
    // blank frame and the 3D view flickered. The frame must redraw
    // synchronously inside its ResizeObserver callback, before the browser
    // paints. Probe: arm when the map canvas's backing store is re-allocated;
    // if no WebGL draw has landed by the next animation frame, a cleared
    // canvas reached the compositor.
    const probeInstalled = await evaluate(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const win = frame && frame.contentWindow;
        const canvas = frame && frame.contentDocument
            && frame.contentDocument.querySelector('.maplibregl-canvas');
        if (!win || !canvas) return false;
        const probe = win.__bpbResizeProbe = { resizes: 0, blankFrames: 0, cleared: false, canvas };
        const descriptor = win.Object.getOwnPropertyDescriptor(win.HTMLCanvasElement.prototype, 'width');
        win.Object.defineProperty(win.HTMLCanvasElement.prototype, 'width', {
            configurable: true,
            get() { return descriptor.get.call(this); },
            set(value) {
                descriptor.set.call(this, value);
                if (this !== probe.canvas) return;
                probe.resizes += 1;
                probe.cleared = true;
                win.requestAnimationFrame(() => { if (probe.cleared) probe.blankFrames += 1; });
            }
        });
        for (const contextType of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
            const proto = win[contextType] && win[contextType].prototype;
            if (!proto) continue;
            for (const method of ['drawArrays', 'drawElements']) {
                const original = proto[method];
                proto[method] = function (...args) { probe.cleared = false; return original.apply(this, args); };
            }
        }
        return true;
    })()`);
    if (!probeInstalled) throw new Error('Could not instrument the terrain frame for the resize-flicker probe');
    // Resize through the handle's keyboard path: it funnels into the same
    // applyMapViewportSize → iframe resize → frame ResizeObserver chain as the
    // pointer drag, and the flicker mechanism is input-agnostic. (A synthetic
    // CDP pointer drag is not retargeted by setPointerCapture once the cursor
    // crosses the iframe, so the mouse gesture cannot be scripted reliably.)
    const handleFocused = await evaluate(cdp, `(() => {
        const handle = document.getElementById('bpb-map-resize-handle');
        if (!handle) return false;
        handle.focus();
        return document.activeElement === handle;
    })()`);
    if (!handleFocused) throw new Error('The map resize handle is missing or unfocusable while 3D is active');
    for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowUp', 'ArrowLeft', 'ArrowUp', 'ArrowLeft']) {
        const keyCode = key === 'ArrowUp' ? 38 : 37;
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode, modifiers: 8
        });
        await cdp.call('Input.dispatchKeyEvent', {
            type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode, modifiers: 8
        });
        await delay(80);
    }
    await waitForPageState(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const probe = frame && frame.contentWindow && frame.contentWindow.__bpbResizeProbe;
        return { ready: Boolean(probe) && probe.resizes > 0, resizes: probe && probe.resizes };
    })()`, 8000).catch(() => {
        throw new Error('Resizing via the handle never resized the 3D canvas — the frame ResizeObserver did not run');
    });
    // Two frame-local animation frames flush every armed verdict before reading.
    const resizeVerdict = await evaluate(cdp, `(() => {
        const win = document.getElementById('bpb-terrain-frame').contentWindow;
        return new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
            resolve({ resizes: win.__bpbResizeProbe.resizes, blankFrames: win.__bpbResizeProbe.blankFrames });
        })));
    })()`);
    if (resizeVerdict.blankFrames > 0) {
        throw new Error(`Resizing the 3D view composited ${resizeVerdict.blankFrames} cleared frame(s) across `
            + `${resizeVerdict.resizes} canvas resizes — the resize flicker is back`);
    }
    console.log(`Resize-flicker probe: ${resizeVerdict.resizes} canvas resizes, 0 blank frames.`);
    await capture(cdp, path.join(outputDir, 'terrain-resized.png'));
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);

    await navigate(cdp, `${baseUrl}?mode=terrain&theme=dark`, 1000, 900);
    const darkReady = await waitForPageState(cdp, `(() => {
        const toggle = document.getElementById('bpb-terrain-toggle');
        const frame = document.getElementById('bpb-terrain-frame');
        const surface = frame && frame.contentDocument && frame.contentDocument.getElementById('bpb-terrain-map');
        return {
            ready: toggle && toggle.textContent === '2D' && frame && frame.style.opacity === '1'
                && surface && surface.dataset.theme === 'dark',
            canvas: surface && surface.querySelector('canvas') && {
                width: surface.querySelector('canvas').width,
                height: surface.querySelector('canvas').height
            }
        };
    })()`);
    await delay(800);
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);
    await capture(cdp, path.join(outputDir, 'terrain-dark-450.png'));

    // Full Screen BigMap: the floating toggle sits over the native map in 2D…
    const peakFeedBeforeBigMap = peakFeedRequests.length;
    const bigMapUrl = `http://www.peakbagger.com:${serverPort}/map/bigmap.aspx`;
    await navigate(cdp, `${bigMapUrl}?t=G`, 1000, 760);
    const bigMap2d = await waitForPageState(cdp, `(() => {
        const toggle = document.getElementById('bpb-terrain-toggle');
        return {
            ready: Boolean(toggle) && toggle.disabled === false && toggle.textContent === '3D',
            mount: toggle && toggle.parentElement && toggle.parentElement.id
        };
    })()`);
    if (bigMap2d.mount !== 'bpb-map-viewport') throw new Error(`BigMap toggle is not in the shared mount: ${bigMap2d.mount}`);
    await delay(300);
    const bigMap2dMetrics = await measureBigMap2dGap(cdp);
    if (!Number.isFinite(bigMap2dMetrics.gap)) throw new Error('Could not measure the BigMap 2D toggle against the native zoom');
    if (bigMap2dMetrics.gap < 0) throw new Error(`BigMap 2D toggle overlaps the native zoom (gap ${bigMap2dMetrics.gap}px)`);
    if (bigMap2dMetrics.gap > 40) throw new Error(`BigMap 2D toggle floats too far above the native zoom (gap ${bigMap2dMetrics.gap}px)`);
    await capture(cdp, path.join(outputDir, 'bigmap-2d.png'));

    // …and flips the full-bleed 3D terrain over it, hiding the native map, when clicked.
    const bigMapBasemapBefore = basemapRequests.length;
    await navigate(cdp, `${bigMapUrl}?t=G&mode3d=1`, 1000, 760);
    const bigMap3d = await waitForPageState(cdp, `(() => {
        const toggle = document.getElementById('bpb-terrain-toggle');
        const frame = document.getElementById('bpb-terrain-frame');
        const surface = frame && frame.contentDocument && frame.contentDocument.getElementById('bpb-terrain-map');
        // Full Screen hides the native MasterMap #if iframe (not a top-page #map)
        // behind the full-bleed terrain when 3D is active.
        const nativeMap = document.getElementById('if');
        return {
            ready: toggle && toggle.textContent === '2D' && frame && frame.style.opacity === '1'
                && surface && nativeMap && nativeMap.style.visibility === 'hidden',
            mount: frame && frame.parentElement && frame.parentElement.id,
            fullBleed: Boolean(frame && frame.parentElement && frame.parentElement.classList.contains('bpb-terrain-mount-fullscreen'))
        };
    })()`);
    if (bigMap3d.mount !== 'bpb-map-viewport') throw new Error('BigMap terrain frame did not mount in the shared viewport');
    if (!bigMap3d.fullBleed) throw new Error('BigMap terrain frame is not full-bleed');
    await waitForCondition(() => terrainRequests.some(url => url.endsWith('.webp')),
        () => 'BigMap 3D did not request terrain tiles');
    await waitForCondition(() => basemapRequests.length > bigMapBasemapBefore,
        () => 'BigMap 3D did not drape the synthetic layer read from the native map');
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);
    const bigMapMetrics = await measureToggleGap(cdp);
    if (bigMapMetrics.gap < 0) throw new Error(`BigMap 3D toggle overlaps the zoom controls (gap ${bigMapMetrics.gap}px)`);
    if (bigMapMetrics.gap > 40) throw new Error(`BigMap 3D toggle floats too far above the zoom controls (gap ${bigMapMetrics.gap}px)`);
    await capture(cdp, path.join(outputDir, 'bigmap-3d.png'));
    await assertPlainScrollZooms(cdp, 'BigMap 3D (group tracks)');
    if (peakFeedRequests.length !== peakFeedBeforeBigMap) {
        throw new Error('A group map queried the peak feed — the native map never shows other peaks there');
    }

    const optionsUrl = `http://127.0.0.1:${serverPort}/options/options.html?visual=1`;
    await navigate(cdp, optionsUrl, 1000, 700);
    const disclosure = await waitForPageState(cdp, `(() => {
        const description = document.getElementById('enable-3d-map-desc');
        return {
            ready: Boolean(description),
            text: description && description.textContent,
            links: description && Array.from(description.querySelectorAll('a'), link => link.href)
        };
    })()`);
    if (!/viewed map area and request metadata/i.test(disclosure.text || '')
        || !/OpenFreeMap.*OpenStreetMap data/i.test(disclosure.text || '')
        || !/selected map layer.*named provider/i.test(disclosure.text || '')
        || !disclosure.links?.includes('https://mapterhorn.com/privacy-policy/')
        || !disclosure.links?.includes('https://openfreemap.org/privacy/')) {
        throw new Error(`The General setting is missing the 3D privacy disclosure: ${JSON.stringify(disclosure)}`);
    }
    await delay(400);
    await capture(cdp, path.join(outputDir, 'options-general.png'));

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
