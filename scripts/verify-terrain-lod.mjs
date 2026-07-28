#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the repeatable form of the measurement that diagnosed the
// 3D tilt detail collapse (docs/plans/3d-tilt-detail-blink.md, section 9).
//
// It drives the real extension frame — the same dist/ bundle terrain:verify
// loads — on hardware GL, headless, with locally generated Terrarium DEM tiles
// served at a realistic per-tile delay. For every camera it reads MapLibre's own
// coords framebuffer, which encodes the render-to-texture tile each screen pixel
// was drawn from, and resolves that tile to the DEM level it wanted and the DEM
// level it actually got. Every percentage below is therefore a share of the
// surface the user sees, not a share of tiles.
//
// What it cannot see: the real Mapterhorn service, the real drape providers, and
// anything about native focus or window placement. A live spot-check through
// `npm run terrain:verify` is still required before release.

import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_BIN || ({
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')
}[process.platform] || 'google-chrome');
const execFileAsync = promisify(execFile);

const FIXTURE_HOST = 'www.peakbagger.com';
const MAPTERHORN_TILE_ORIGIN = 'https://tiles.mapterhorn.com';
// The plan measured at 1100x700 with 140 ms per tile; keep both so the numbers
// here and the numbers in the plan are comparable.
const FRAME_WIDTH = 1100;
const FRAME_HEIGHT = 700;
const TILE_DELAY_MS = 140;
const DEM_TILE_PIXELS = 512;
// The camera the sweep runs from. Zoom is set explicitly rather than inherited
// from the fixture route's fitBounds, so the measured levels do not move when
// the showcase track or the frame size changes; zoom 14 puts the near ground at
// level 13, matching the plan's census. The sweep also moves to ground the boot
// camera never covered, because otherwise "cold" is a fiction: framing the route
// at pitch 60 already fetches the whole horizon ladder, and every later tilt is
// then served from a warm cache no matter what the code does.
const SWEEP_ZOOM = 14;
const SWEEP_CENTER = [-118.5, 43.5];
// Pitch sweep: 3-degree steps across the band the plan measured, then one step
// back so reversing a gesture is measured too.
const SWEEP_START_PITCH = 55;
const SWEEP_STEPS = [58, 61, 64, 67, 70, 73, 76, 73];
const CENSUS_PITCHES = [60, 62, 66, 70];
// A level holding less than this share of the surface is a tile-boundary seam,
// not a band of the picture; the ladder-gap check ignores it.
const LEVEL_SHARE_FLOOR = 0.005;
const SETTLE_TIMEOUT_MS = 12000;
const SETTLE_POLL_MS = 20;

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

// ---------------------------------------------------------------------------
// Synthetic DEM tiles
// ---------------------------------------------------------------------------

// A continuous mountain range evaluated straight from mercator coordinates:
// valleys near 300 m, summits near 2,900 m, ridges roughly 1.5 km apart at the
// test latitude, plus a slower swell so the coarse levels carry real structure
// rather than an alias of the ridges. Generating rather than downloading keeps
// this check offline, repeatable, and free of live Mapterhorn traffic.
const RIDGE_MERCATOR = 5.7e-5;  // ~1.5 km at 48.7 degrees north
const elevationAt = (mercatorX, mercatorY) => {
    const fine = Math.sin(2 * Math.PI * mercatorX / RIDGE_MERCATOR)
        * Math.cos(2 * Math.PI * mercatorY / RIDGE_MERCATOR);
    const coarse = Math.sin(2 * Math.PI * mercatorX / (8 * RIDGE_MERCATOR))
        * Math.cos(2 * Math.PI * mercatorY / (8 * RIDGE_MERCATOR));
    return 300 + 1300 * (1 + 0.75 * fine + 0.25 * coarse);
};

const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

const crc32 = buffer => {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
};

// Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768. MapLibre
// decodes whatever image format the browser can read, so PNG stands in for
// Mapterhorn's WebP — the encoding has no bearing on which tile level MapLibre
// picks, which is what this check measures.
const demTilePng = (z, x, y) => {
    const size = DEM_TILE_PIXELS;
    const dimension = 2 ** z;
    const stride = size * 3 + 1;
    const raw = Buffer.alloc(stride * size);
    for (let row = 0; row < size; row++) {
        const mercatorY = (y + (row + 0.5) / size) / dimension;
        let offset = row * stride + 1;
        for (let column = 0; column < size; column++) {
            const mercatorX = (x + (column + 0.5) / size) / dimension;
            const value = elevationAt(mercatorX, mercatorY) + 32768;
            const whole = Math.floor(value);
            raw[offset++] = (whole >> 8) & 0xff;
            raw[offset++] = whole & 0xff;
            raw[offset++] = Math.min(255, Math.floor((value - whole) * 256));
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;   // bit depth
    header[9] = 2;   // colour type: truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
};

const demTileCache = new Map();
const demTile = (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    if (!demTileCache.has(key)) demTileCache.set(key, demTilePng(z, x, y));
    return demTileCache.get(key);
};

const boundedMapterhornTile = value => {
    try {
        const url = new URL(value);
        if (url.origin !== MAPTERHORN_TILE_ORIGIN) return null;
        const match = url.pathname.match(/^\/(\d{1,2})\/(\d+)\/(\d+)\.webp$/);
        if (!match) return null;
        const z = Number(match[1]), x = Number(match[2]), y = Number(match[3]);
        const dimension = 2 ** z;
        if (z < 0 || z > 18 || x < 0 || x >= dimension || y < 0 || y >= dimension) return null;
        return { z, x, y };
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------------------
// Fixture server
// ---------------------------------------------------------------------------

// The showcase must be served over HTTPS on a Peakbagger hostname:
// src/peakbagger/peakbagger-request.js refuses any other protocol or host, and
// the GPX Analyzer fetches the route through that guard, so a plain-HTTP fixture
// makes the extension refuse its own fixture and the 3D toggle never enables.
// Self-signed for this host only, deleted in teardown.
const certificateRoot = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-lod-cert-'));
const keyPath = path.join(certificateRoot, 'fixture-key.pem');
const certificatePath = path.join(certificateRoot, 'fixture-cert.pem');
try {
    await execFileAsync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-subj', `/CN=${FIXTURE_HOST}`, '-days', '1',
        '-keyout', keyPath, '-out', certificatePath
    ]);
} catch (error) {
    throw new Error(`Could not create the isolated HTTPS fixture certificate: ${error.message}`);
}
const [fixtureKey, fixtureCert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);

const server = createServer({ key: fixtureKey, cert: fixtureCert }, async (request, response) => {
    try {
        const url = new URL(request.url, `https://${FIXTURE_HOST}`);
        const showcaseRoutes = {
            '/climber/ascent.aspx': '/scripts/showcase/terrain.html',
            '/map/mastermap.aspx': '/scripts/showcase/terrain-native-map.html'
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
            // Extension resources live under dist/; map getURL('x') to /dist/x so
            // the frame's MapLibre worker and bundle resolve. Exposing the frame's
            // Map instance is what lets this check read MapLibre's own tile
            // bookkeeping; production publishes no MapLibre internals.
            contents = Buffer.from(contents.toString('utf8').replace('</head>', `  <script>
    globalThis.chrome = { runtime: { getURL: resource => new URL('/dist/' + resource, location.origin).href } };
  </script>
</head>`).replace('  <script src="terrain-frame.js"></script>', `  <script>
    maplibregl.Map = new Proxy(maplibregl.Map, {
      construct(Target, args, newTarget) {
        const instance = Reflect.construct(Target, args, newTarget);
        globalThis.__bpbTerrainTestMap = instance;
        return instance;
      }
    });
  </script>
  <script src="terrain-frame.js"></script>`));
        }
        response.end(contents);
    } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error.stack || error.message);
    }
});

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

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
    if (typeof WebSocket !== 'function') {
        throw new Error('This verification script requires a Node.js runtime with global WebSocket support');
    }
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

// Gate on the condition, never on a fixed sleep, and report the live value at
// failure time rather than a snapshot taken earlier.
const waitForPageState = async (cdp, expression, timeoutMs = 40000) => {
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

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

// MapLibre renders a "coords" framebuffer whose alpha channel names the
// render-to-texture tile each pixel was drawn from (Terrain.getCoordsTexture).
// Reading it in one pass gives the exact per-pixel tile provenance the plan
// measured, without a readPixels round trip per sample. Each RTT tile is then
// resolved to the DEM level it asked for (overscaledZ - deltaZoom, the offset
// the plan's appendix warns about) and the DEM level it actually got.
const PROBE = `(() => {
    const frame = document.getElementById('bpb-terrain-frame');
    const win = frame && frame.contentWindow;
    const map = win && win.__bpbTerrainTestMap;
    if (!map || !map.terrain || !map.terrain.painter) {
        return { ready: false, reason: map ? 'terrain is not enabled yet' : 'the 3D frame is not up' };
    }
    const terrain = map.terrain;
    const tileManager = terrain.tileManager;
    const source = tileManager.getSource();
    const painter = terrain.painter;
    try {
        // MapLibre only rebuilds the coords framebuffer when the camera matrix
        // changes or a tile arrives — not when the render-to-texture key set
        // grows. Left alone it therefore describes a set of tiles that is one or
        // two horizon tiles behind the live one, and those are exactly the tiles
        // a tilt is waiting for: the shortfall would go unmeasured and every
        // tilt would look instantaneous. Force the rebuild on every probe.
        painter.terrainFacilitator.depthDirty = true;
        painter.maybeDrawDepth(true);
        painter.maybeDrawCoords();
    } catch (error) {
        return { ready: false, reason: 'coords framebuffer: ' + error.message };
    }
    const framebuffer = terrain.getFramebuffer('coords');
    const width = framebuffer.width, height = framebuffer.height;
    if (!(width > 0) || !(height > 0)) return { ready: false, reason: 'empty coords framebuffer' };
    const pixels = new win.Uint8Array(width * height * 4);
    const gl = painter.context.gl;
    painter.context.bindFramebuffer.set(framebuffer.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    painter.context.bindFramebuffer.set(null);

    // Alpha 255 - index identifies the RTT tile (see Terrain.pointCoordinate).
    // Each is resolved once to the DEM level it asked for and the DEM level it
    // actually got; the pixel loop then only looks up an alpha byte.
    const byAlpha = new Map();
    const tileShortfalls = {};
    terrain.coordsIndex.forEach((key, index) => {
        const tile = tileManager.getTileByID(key);
        if (!tile) return;
        let desired = tile.tileID.overscaledZ - tileManager.deltaZoom;
        if (desired > source.maxzoom) desired = source.maxzoom;
        if (desired < source.minzoom) return;
        const demTile = tileManager.getSourceTile(tile.tileID, true);
        const actual = demTile && demTile.dem ? demTile.tileID.overscaledZ : null;
        byAlpha.set(255 - index, { desired: desired, actual: actual });
        // Counted per tile as well as per pixel: a tile can want a level it has
        // not got and still contribute no pixels, because distant terrain is
        // often hidden behind a nearer ridge. Reporting only the pixel-weighted
        // figure would hide those, and hiding them is how a check comes to read
        // as "nothing was short" when something was.
        const key2 = actual === null ? 'none' : String(desired - actual);
        tileShortfalls[key2] = (tileShortfalls[key2] || 0) + 1;
    });

    const levels = {}, shortfalls = {};
    let surface = 0, sky = 0;
    const step = 4;
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const entry = byAlpha.get(pixels[(y * width + x) * 4 + 3]);
            if (!entry) { sky++; continue; }
            surface++;
            const level = entry.actual === null ? 'none' : String(entry.actual);
            levels[level] = (levels[level] || 0) + 1;
            const shortfall = entry.actual === null ? 'none' : String(entry.desired - entry.actual);
            shortfalls[shortfall] = (shortfalls[shortfall] || 0) + 1;
        }
    }
    return {
        ready: surface > 0,
        reason: surface > 0 ? '' : 'no terrain surface on screen',
        surface: surface, sky: sky, levels: levels, shortfalls: shortfalls,
        pitch: Math.round(map.getPitch() * 100) / 100,
        zoom: Math.round(map.getZoom() * 1000) / 1000,
        rttTiles: tileManager.getRenderableTiles().length,
        // How many off-screen elevation tiles MapLibre will keep before
        // evicting. Reported so the retention setting is a measured number
        // rather than an assumption about where a Map option landed.
        retainedTileCeiling: tileManager.tileManager._outOfViewCache
            ? tileManager.tileManager._outOfViewCache.max
            : null,
        // A camera change is not visible to this probe until MapLibre has
        // painted it: before that first frame the render-to-texture key set and
        // the coords framebuffer still describe the previous camera, and a
        // settled previous frame would read as an instantly settled new one.
        renders: map.__bpbRenders || 0,
        idle: map.loaded() === true
            && (typeof map.areTilesLoaded !== 'function' || map.areTilesLoaded() === true),
        framebuffer: { width: width, height: height },
        tiles: tileShortfalls
    };
})()`;

// 'none' — no DEM tile at any level — is worse than any finite shortfall.
const NO_DATA = 99;
const worstOf = (counts, total) => {
    let levels = 0, share = 0;
    for (const [key, count] of Object.entries(counts || {})) {
        const value = key === 'none' ? NO_DATA : Number(key);
        if (value <= 0) continue;
        if (value > levels) { levels = value; share = count / total; }
        else if (value === levels) share = Math.max(share, count / total);
    }
    return { levels, share };
};

const worstShortfall = sample => worstOf(sample.shortfalls, sample.surface);
// The same shortfall counted per render-to-texture tile, including tiles that
// happen to contribute no pixels because a nearer ridge hides them.
const worstTileShortfall = sample => worstOf(sample.tiles, Math.max(1, sample.rttTiles));

const describeShortfall = worst => worst.levels === 0
    ? 'none'
    : `${worst.levels === NO_DATA ? 'no DEM data' : `${worst.levels} levels too coarse`}`
        + ` over ${(worst.share * 100).toFixed(0)}% of the surface`;

const describeTileShortfall = worst => worst.levels === 0
    ? 'none'
    : `${worst.levels === NO_DATA ? 'no DEM data' : `${worst.levels} levels`} on `
        + `${(worst.share * 100).toFixed(0)}% of tiles`;

const levelShares = sample => Object.entries(sample.levels || {})
    .map(([key, count]) => ({ level: key === 'none' ? null : Number(key), share: count / sample.surface }))
    .sort((a, b) => (b.level ?? -1) - (a.level ?? -1));

const describeLevels = sample => levelShares(sample)
    .map(entry => `${entry.level === null ? 'no data' : `level ${entry.level}`} (${(entry.share * 100).toFixed(0)}%)`)
    .join(', ');

// The widest gap between adjacent levels present in one frame, ignoring shares
// small enough to be a tile-boundary seam rather than a band of the picture.
const widestLevelGap = sample => {
    const present = levelShares(sample)
        .filter(entry => entry.level !== null && entry.share >= LEVEL_SHARE_FLOOR)
        .map(entry => entry.level);
    let widest = 0;
    for (let i = 1; i < present.length; i++) widest = Math.max(widest, present[i - 1] - present[i]);
    return widest;
};

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const serverPort = server.address().port;
const profile = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-lod-profile-'));
const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    // Headless Chrome reaches the real hardware renderer, so no ANGLE override
    // belongs here; the renderer is asserted below rather than assumed.
    `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`,
    '--ignore-certificate-errors',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeStderr = '';
chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-20000); });

let cdp;
const failures = [];
try {
    const debugPort = await waitForDebugPort(profile, chrome);
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = pages.find(candidate => candidate.type === 'page');
    if (!page) throw new Error('Chrome opened no debuggable page');
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await Promise.all([cdp.call('Page.enable'), cdp.call('Runtime.enable')]);

    // A software renderer paints plausible screenshots and proves nothing about
    // the renderer users have, so fail closed and report what we got.
    const renderer = await evaluate(cdp, `(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return null;
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    })()`);
    if (!renderer) throw new Error('No WebGL context: this suite cannot measure the 3D map');
    if (/swiftshader|software|llvmpipe/i.test(renderer)) {
        throw new Error(`Refusing to measure the 3D map on a software renderer (${renderer}).`);
    }

    let demRequests = 0;
    let drapeRequests = 0;
    const unexpected = [];
    cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
        const serve = async () => {
            if (/\/scripts\/showcase\/terrain-tiles\//.test(request.url)) {
                drapeRequests++;
                await cdp.call('Fetch.continueRequest', { requestId });
                return;
            }
            const tile = boundedMapterhornTile(request.url);
            if (request.method !== 'GET' || !tile) {
                unexpected.push(`${request.method} ${request.url}`);
                await cdp.call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
                return;
            }
            demRequests++;
            const body = demTile(tile.z, tile.x, tile.y);
            // A realistic download time is what makes a missing level visible;
            // an instant tile server hides the entire effect under test.
            await delay(TILE_DELAY_MS);
            await cdp.call('Fetch.fulfillRequest', {
                requestId,
                responseCode: 200,
                responseHeaders: [
                    { name: 'Access-Control-Allow-Origin', value: '*' },
                    { name: 'Cache-Control', value: 'no-store' },
                    { name: 'Content-Type', value: 'image/png' },
                    { name: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }
                ],
                body: body.toString('base64')
            });
        };
        void serve().catch(() => { /* The request was cancelled or the page went away. */ });
    });
    await cdp.call('Fetch.enable', {
        patterns: [
            { urlPattern: '*://mapterhorn.com/*', requestStage: 'Request' },
            { urlPattern: '*://*.mapterhorn.com/*', requestStage: 'Request' },
            { urlPattern: '*scripts/showcase/terrain-tiles/*', requestStage: 'Request' }
        ]
    });

    await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: FRAME_WIDTH + 140, height: FRAME_HEIGHT + 320, deviceScaleFactor: 1, mobile: false
    });
    await cdp.call('Page.navigate', {
        url: `https://${FIXTURE_HOST}:${serverPort}/climber/ascent.aspx`
            + `?mode=terrain&viewport=${FRAME_WIDTH}x${FRAME_HEIGHT}`
    });
    await waitForPageState(cdp, '({ ready: document.readyState === "complete" })', 20000);

    const ready = await waitForPageState(cdp, `(() => {
        const frame = document.getElementById('bpb-terrain-frame');
        const map = frame && frame.contentWindow && frame.contentWindow.__bpbTerrainTestMap;
        if (!map || typeof map.isSourceLoaded !== 'function') return { ready: false, reason: 'no 3D frame yet' };
        if (!map.terrain) return { ready: false, reason: 'terrain not attached' };
        if (!map.isSourceLoaded('terrain')) return { ready: false, reason: 'DEM source still loading' };
        const canvas = map.getCanvas();
        return {
            ready: canvas.clientWidth > 0 && canvas.clientHeight > 0,
            width: canvas.clientWidth, height: canvas.clientHeight
        };
    })()`, 60000);

    // Count painted frames so the probe can tell a settled new camera from a
    // still-unpainted one.
    await evaluate(cdp, `(() => {
        const map = document.getElementById('bpb-terrain-frame').contentWindow.__bpbTerrainTestMap;
        map.__bpbRenders = 0;
        map.on('render', () => { map.__bpbRenders++; });
        return true;
    })()`);

    const moveCamera = async body => evaluate(cdp, `(() => {
        const map = document.getElementById('bpb-terrain-frame').contentWindow.__bpbTerrainTestMap;
        const renders = map.__bpbRenders || 0;
        ${body}
        return renders;
    })()`);

    // Poll the live shortfall until the new camera has painted, every tile it
    // wants has arrived, and nothing on screen is below its intended detail —
    // recording the worst state seen on the way and how long it took.
    const keepWorst = (worst, current) => current.levels > worst.levels
        || (current.levels === worst.levels && current.share > worst.share) ? current : worst;
    const settle = async renderBaseline => {
        const start = Date.now();
        let worst = { levels: 0, share: 0 };
        let worstTiles = { levels: 0, share: 0 };
        let sample = null;
        for (;;) {
            sample = await evaluate(cdp, PROBE);
            if (sample.ready && sample.renders > renderBaseline) {
                const current = worstShortfall(sample);
                worst = keepWorst(worst, current);
                worstTiles = keepWorst(worstTiles, worstTileShortfall(sample));
                if (current.levels === 0 && sample.idle) break;
            }
            if (Date.now() - start > SETTLE_TIMEOUT_MS) break;
            await delay(SETTLE_POLL_MS);
        }
        return { settleMs: Date.now() - start, worst, worstTiles, sample };
    };

    const demAtBoot = demRequests;
    const drapeAtBoot = drapeRequests;
    console.log(`Renderer: ${renderer} (headless, GPU)`);
    console.log(`Frame: ${ready.width}x${ready.height} CSS px; DEM tiles served locally at ${TILE_DELAY_MS} ms each.`);
    console.log(`Boot: ${demAtBoot} DEM tiles, ${drapeAtBoot} drape tiles.`);

    // ---- Criterion 1 and 3: a cold-cache tilt sweep --------------------------
    const opening = await settle(await moveCamera(`map.jumpTo({
            center: [${SWEEP_CENTER[0]}, ${SWEEP_CENTER[1]}],
            zoom: ${SWEEP_ZOOM}, bearing: 0, pitch: ${SWEEP_START_PITCH}
        });`));
    if (!opening.sample || !opening.sample.ready) {
        throw new Error(`Could not read the terrain surface: ${opening.sample && opening.sample.reason}`);
    }
    console.log(`\nCold-cache tilt sweep (3 degrees per step, from ${SWEEP_START_PITCH} degrees)`);
    console.log(`  arriving at ${SWEEP_START_PITCH} on fresh ground: ${opening.settleMs} ms`
        + `, worst ${describeShortfall(opening.worst)} (not a tilt; this is what a cold view costs)`);

    const sweep = [];
    let fromPitch = SWEEP_START_PITCH;
    for (const pitch of SWEEP_STEPS) {
        const demBefore = demRequests;
        const result = await settle(await moveCamera(`map.setPitch(${pitch});`));
        const step = {
            from: fromPitch, to: pitch,
            settleMs: result.settleMs,
            worst: result.worst,
            worstTiles: result.worstTiles,
            demTiles: demRequests - demBefore,
            reversal: pitch < fromPitch
        };
        sweep.push(step);
        console.log(`  ${step.from} -> ${step.to}: ${String(step.settleMs).padStart(5)} ms`
            + `, worst ${describeShortfall(step.worst)}`
            + ` (per tile: ${describeTileShortfall(step.worstTiles)})`
            + `, ${step.demTiles} DEM tiles`);
        fromPitch = pitch;
    }
    const demAfterSweep = demRequests;

    for (const step of sweep) {
        if (step.reversal) {
            if (step.worst.levels > 0) {
                failures.push(`Reversing a tilt (${step.from} -> ${step.to}) fell short: ${describeShortfall(step.worst)}`);
            }
            continue;
        }
        if (step.worst.levels > 1) {
            failures.push(`Tilt ${step.from} -> ${step.to} collapsed: ${describeShortfall(step.worst)}`);
        }
        // Held to the same bar as the visible surface. A tile that wants a level
        // it has not got is a collapse waiting for the ridge in front of it to
        // move; excusing it because this fixture's terrain happens to hide it
        // would make the criterion depend on the test's own scenery.
        if (step.worstTiles.levels > 1) {
            failures.push(`Tilt ${step.from} -> ${step.to} left tiles short: ${describeTileShortfall(step.worstTiles)}`);
        }
    }

    // ---- Criterion 2: the detail ladder has no missing rungs -----------------
    console.log('\nSettled level census');
    const census = [];
    for (const pitch of CENSUS_PITCHES) {
        const result = await settle(await moveCamera(`map.setPitch(${pitch});`));
        if (!result.sample || !result.sample.ready) {
            failures.push(`Could not census pitch ${pitch}: ${result.sample && result.sample.reason}`);
            continue;
        }
        const gap = widestLevelGap(result.sample);
        census.push({ pitch, gap, sample: result.sample });
        console.log(`  ${String(pitch).padStart(2)} degrees: ${describeLevels(result.sample)}`
            + ` — widest gap ${gap}, ${result.sample.rttTiles} RTT tiles`);
        if (gap > 2) failures.push(`At ${pitch} degrees the detail ladder skips ${gap} levels in one frame`);
    }

    // ---- Criterion 4: traffic stays bounded ---------------------------------
    console.log('\nTraffic');
    console.log(`  DEM tiles: ${demAtBoot} on boot, ${demAfterSweep - demAtBoot} across the sweep`
        + `, ${demRequests - demAfterSweep} across the census, ${demRequests} total.`);
    console.log(`  Drape tiles: ${drapeRequests} total.`);
    console.log(`  Peak render-to-texture tiles: ${Math.max(...census.map(entry => entry.sample.rttTiles), 0)}`
        + ' (MapLibre pools 30).');
    console.log(`  Off-screen elevation tiles retained before eviction: ${opening.sample.retainedTileCeiling}.`);

    if (unexpected.length) {
        failures.push(`Blocked unexpected provider requests: ${[...new Set(unexpected)].join(', ')}`);
    }

    console.log('\nThis ran hidden (headless Chrome, hardware GL) against the built dist/ frame with locally'
        + '\ngenerated DEM tiles. It does not exercise the real Mapterhorn service or the real drape'
        + '\nproviders; `npm run terrain:verify` remains the live spot-check.');

    if (failures.length) {
        console.error(`\n${failures.length} acceptance criterion failure(s):`);
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exitCode = 1;
    } else {
        console.log('\nAll four acceptance criteria passed.');
    }
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
    // The fixture key and certificate are disposable and must not outlive the run.
    await rm(certificateRoot, { recursive: true, force: true });
}
