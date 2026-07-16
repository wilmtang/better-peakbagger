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
        const showcaseRoutes = {
            '/climber/ascent.aspx': '/scripts/showcase/terrain.html',
            '/map/bigmap.aspx': '/scripts/showcase/big-map.html'
        };
        let pathname = showcaseRoutes[url.pathname] || decodeURIComponent(url.pathname);
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
        if (url.pathname === '/terrain/terrain.html') {
            contents = Buffer.from(contents.toString('utf8').replace('</head>', `  <script>
    // Mirror the real chrome.runtime.getURL, which normalizes through the URL
    // parser and percent-encodes {} braces — the packaged-extension behavior
    // any URL template built via getURL must survive.
    globalThis.chrome = { runtime: { getURL: resource => new URL(resource, location.origin + '/').href } };
  </script>
</head>`));
        } else if (url.pathname === '/options/options.html' && url.searchParams.get('visual') === '1') {
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
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
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

    const terrainRequests = [];
    const basemapRequests = [];
    const glyphRequests = [];
    const runtimeErrors = [];
    cdp.on('Network.requestWillBeSent', ({ request }) => {
        if (/\.mapterhorn\.com\//.test(request.url)) terrainRequests.push(request.url);
        if (/\/scripts\/showcase\/terrain-tiles\//.test(request.url)) basemapRequests.push(request.url);
        if (/\/vendor\/glyphs\//.test(request.url)) glyphRequests.push(request.url);
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
    await delay(1200);
    if (!terrainRequests.some(url => url.endsWith('.webp'))) throw new Error('The 3D view did not request terrain tiles');
    if (!basemapRequests.length) throw new Error(`The 3D view did not request the selected Leaflet raster layer (badge: ${ready.badge || 'missing'})`);
    if (!/Synthetic topographic map/.test(ready.badge || '')) throw new Error(`The selected layer was not retained: ${ready.badge}`);
    // The peak label fetched its vendored glyph range with the {fontstack} and
    // {range} placeholders substituted (never percent-encoded away).
    if (!glyphRequests.some(url => /\/vendor\/glyphs\/Open-Sans-Semibold\/\d+-\d+\.pbf$/.test(url))) {
        throw new Error(`The 3D view did not fetch a vendored glyph range for the peak label (saw: ${glyphRequests.join(', ') || 'none'})`);
    }
    if (glyphRequests.some(url => /%7B|\{/.test(url))) throw new Error(`Glyph template placeholders were not substituted: ${glyphRequests.join(', ')}`);
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);
    const ascentMetrics = await measureToggleGap(cdp);
    if (ascentMetrics.gap < 0) throw new Error(`Ascent 3D toggle overlaps the zoom controls (gap ${ascentMetrics.gap}px)`);
    if (ascentMetrics.gap > 40) throw new Error(`Ascent 3D toggle floats too far above the zoom controls (gap ${ascentMetrics.gap}px)`);
    await capture(cdp, path.join(outputDir, 'terrain-wide-800.png'));
    await assertPlainScrollZooms(cdp, 'Ascent 3D');

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
    await delay(1200);
    if (bigMap3d.mount !== 'bpb-map-viewport') throw new Error('BigMap terrain frame did not mount in the shared viewport');
    if (!bigMap3d.fullBleed) throw new Error('BigMap terrain frame is not full-bleed');
    if (!terrainRequests.some(url => url.endsWith('.webp'))) throw new Error('BigMap 3D did not request terrain tiles');
    if (basemapRequests.length <= bigMapBasemapBefore) throw new Error('BigMap 3D did not drape the synthetic layer read from the native map');
    if (runtimeErrors.length) throw new Error(`Runtime exception: ${runtimeErrors.join('\n')}`);
    const bigMapMetrics = await measureToggleGap(cdp);
    if (bigMapMetrics.gap < 0) throw new Error(`BigMap 3D toggle overlaps the zoom controls (gap ${bigMapMetrics.gap}px)`);
    if (bigMapMetrics.gap > 40) throw new Error(`BigMap 3D toggle floats too far above the zoom controls (gap ${bigMapMetrics.gap}px)`);
    await capture(cdp, path.join(outputDir, 'bigmap-3d.png'));
    await assertPlainScrollZooms(cdp, 'BigMap 3D (group tracks)');

    const optionsUrl = `http://127.0.0.1:${serverPort}/options/options.html?visual=1`;
    await navigate(cdp, optionsUrl, 1000, 700);
    const disclosure = await waitForPageState(cdp, `(() => {
        const description = document.getElementById('enable-3d-map-desc');
        return {
            ready: Boolean(description),
            text: description && description.textContent,
            link: description && description.querySelector('a') && description.querySelector('a').href
        };
    })()`);
    if (!/viewed map area and request metadata/i.test(disclosure.text || '')
        || !/selected map layer from its provider/i.test(disclosure.text || '')
        || !/^https:\/\/mapterhorn\.com\/privacy-policy\/$/.test(disclosure.link || '')) {
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
