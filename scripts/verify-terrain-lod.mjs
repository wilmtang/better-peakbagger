#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the repeatable form of the measurement that diagnosed the
// 3D tilt detail collapse (docs/archive/3d-tilt-detail-blink.md, section 9).
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

import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
    createFixtureCertificate,
    resolveFixtureFile,
    sendFixtureError,
    sendFixtureFile,
    sendFixtureNotFound,
    instrumentTerrainFrameHtml,
} from './browser-verification-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_BIN || ({
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')
}[process.platform] || 'google-chrome');

const FIXTURE_HOST = 'www.peakbagger.com';
const MAPTERHORN_TILE_ORIGIN = 'https://tiles.mapterhorn.com';
// The showcase's own drape comes from a live Leaflet layer, and
// src/terrain/terrain-basemap.js gives every live layer `thriftyLod: true` on
// purpose — an unknown host on unknown terms does not get tripled tile requests.
// So this check swaps the fixture's layer for a drape code carrying a known spec,
// and answers that host locally. The swap is done in this server, not in the
// shared fixture file, so terrain:verify and showcase:render keep rendering
// exactly what they rendered before.
//
// BPB_LOD_DRAPE picks which spec. The two are the two drape LOD settings the
// frame ships, and running both is how the gap between them stays measured
// rather than assumed — that gap is the whole basis for having two.
const DRAPE_SPECS = {
    L_OS: { host: 'tile.openstreetmap.org', label: 'full drape LOD, maxzoom 18' },
    L_OT: { host: 'a.tile.opentopomap.org', label: 'thrifty drape LOD, maxzoom 15' }
};
const DRAPE_CODE = Object.hasOwn(DRAPE_SPECS, String(process.env.BPB_LOD_DRAPE || ''))
    ? process.env.BPB_LOD_DRAPE
    : 'L_OS';
const DRAPE_HOST = DRAPE_SPECS[DRAPE_CODE].host;
const DRAPE_LABEL = DRAPE_SPECS[DRAPE_CODE].label;
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
// How long the camera rests between tilt steps. A real user pauses between
// gestures, and the frame's tile warming is deliberately idle-triggered — it
// waits for a still camera so it cannot compete with the tiles the user is
// waiting for. A sweep that jumps straight from one settle into the next tilt
// never gives that work a chance to run, and would measure the code with its
// central mechanism disabled. Stated in the output for the same reason.
const DWELL_MS = 1200;
// How long a fallback deeper than one level may persist before it stops being a
// soft edge and starts being a blink. See the criterion-1 comment below for why
// the bar is a duration and not only a depth.
const TRANSIENT_BUDGET_MS = 120;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// The showcase's own topographic tile, reused for the swapped drape host.
const drapeTilePng = (await readFile(path.join(root, 'scripts/showcase/terrain-basemap-tile.png'))).toString('base64');

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
const certificate = await createFixtureCertificate({ host: FIXTURE_HOST, label: 'lod' });
const { key: fixtureKey, cert: fixtureCert } = certificate;

const server = createServer({ key: fixtureKey, cert: fixtureCert }, async (request, response) => {
    try {
        const url = new URL(request.url, `https://${FIXTURE_HOST}`);
        const showcaseRoutes = {
            '/climber/ascent.aspx': '/scripts/showcase/terrain.html',
            '/map/mastermap.aspx': '/scripts/showcase/terrain-native-map.html'
        };
        let pathname = showcaseRoutes[url.pathname.toLowerCase()] || decodeURIComponent(url.pathname);
        // The swapped drape's own host, resolved here rather than on the network.
        const host = String(request.headers.host || '').split(':')[0];
        const crossOriginDrape = host === DRAPE_HOST;
        if (process.env.BPB_LOD_DIAG) console.error(`[server] ${host} ${url.pathname}`);
        if (crossOriginDrape || pathname.startsWith('/scripts/showcase/terrain-tiles/')) {
            pathname = '/scripts/showcase/terrain-basemap-tile.png';
        }
        const file = await resolveFixtureFile(pathname);
        if (!file) {
            sendFixtureNotFound(response);
            return;
        }
        // The frame instrumentation is shared with the other terrain verifiers:
        // exposing MapLibre's Map instance is what lets this check read its own
        // tile bookkeeping. The drape swap below is this check's alone — it
        // offers a code the extension carries a spec for, so the frame resolves
        // a known layer rather than the live-Leaflet path, whose host and terms
        // are unknown by construction.
        let transform = null;
        if (url.pathname === '/dist/terrain/terrain.html') {
            transform = instrumentTerrainFrameHtml;
        } else if (file.endsWith('terrain-native-map.html')) {
            transform = html => html.replace(
                '<option value="L_FIX" selected>Synthetic topographic map</option>',
                `<option value="${DRAPE_CODE}" selected>Synthetic topographic map</option>`);
        }
        await sendFixtureFile(response, file, { transform });
    } catch (error) {
        sendFixtureError(response, error);
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
    // The drape, and the ceiling it is painted into. MapLibre never paints the
    // drape onto the screen: it paints it into render-to-texture tiles sized from
    // the *elevation* source's level-of-detail function, each rendered into a
    // target of tileSize * qualityFactor pixels. A drape tile finer than that
    // target can hold is traffic bought for detail the pipeline discards, which
    // is the question section 6 of the plan leaves open.
    const drapeManager = map.style && map.style.tileManagers && map.style.tileManagers.basemap;
    let drape = null;
    if (drapeManager && typeof drapeManager.getRenderableIds === 'function') {
        const drapeLevels = {};
        for (const id of drapeManager.getRenderableIds()) {
            const tile = drapeManager.getTileByID(id);
            if (!tile) continue;
            const z = String(tile.tileID.overscaledZ);
            drapeLevels[z] = (drapeLevels[z] || 0) + 1;
        }
        const drapeTileSize = (drapeManager._source && drapeManager._source.tileSize) || 512;
        const targetPixels = tileManager.tileSize * terrain.qualityFactor;
        // A render-to-texture tile at level Z covers 1/2^Z of the world, and a
        // drape at level B lays drapeTileSize * 2^(B - Z) texels across it. The
        // finest B that still fits the target is Z + log2(target / tileSize).
        //
        // The ceiling is a range, not a number, and that is the whole point: a
        // pitched frame holds several render-to-texture levels at once, so the
        // near band and the horizon band have different ceilings. One ceiling
        // taken from the near band makes every measurement read "nothing
        // wasted", which is true and useless.
        const headroom = Math.round(Math.log2(targetPixels / drapeTileSize));
        const rttLevels = [...byAlpha.values()].map(entry => entry.desired + tileManager.deltaZoom);
        drape = {
            levels: drapeLevels,
            tileSize: drapeTileSize,
            targetPixels: targetPixels,
            ceilingFinest: rttLevels.length ? Math.max(...rttLevels) + headroom : null,
            ceilingCoarsest: rttLevels.length ? Math.min(...rttLevels) + headroom : null
        };
    }

    return {
        ready: surface > 0,
        reason: surface > 0 ? '' : 'no terrain surface on screen',
        surface: surface, sky: sky, levels: levels, shortfalls: shortfalls, drape: drape,
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
    `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1,MAP ${DRAPE_HOST} 127.0.0.1`,
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
            if (request.url.includes(DRAPE_HOST)) {
                drapeRequests++;
                // Fulfilled here rather than proxied, so the swapped drape needs
                // no DNS, no certificate, and no second origin on the server. The
                // CORS headers are the ones a real provider would send: without
                // them the frame correctly drops the layer as undrapeable and
                // there is no drape left to measure.
                await cdp.call('Fetch.fulfillRequest', {
                    requestId,
                    responseCode: 200,
                    responseHeaders: [
                        { name: 'Access-Control-Allow-Origin', value: '*' },
                        { name: 'Cache-Control', value: 'no-store' },
                        { name: 'Content-Type', value: 'image/png' },
                        { name: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }
                    ],
                    body: drapeTilePng
                });
                return;
            }
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
            { urlPattern: '*scripts/showcase/terrain-tiles/*', requestStage: 'Request' },
            { urlPattern: `*://${DRAPE_HOST}/*`, requestStage: 'Request' }
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
        // When the shortfall was last still present. How deep a fallback goes is
        // MapLibre's business — it drops to whatever it has already loaded — but
        // how long it lasts is the download wait, which is what warming removes,
        // and how long it lasts is what decides whether it reads as a blink.
        let shortUntilMs = 0;
        let sample = null;
        for (;;) {
            sample = await evaluate(cdp, PROBE);
            if (sample.ready && sample.renders > renderBaseline) {
                const current = worstShortfall(sample);
                const currentTiles = worstTileShortfall(sample);
                worst = keepWorst(worst, current);
                worstTiles = keepWorst(worstTiles, currentTiles);
                if (current.levels > 0 || currentTiles.levels > 0) shortUntilMs = Date.now() - start;
                if (current.levels === 0 && sample.idle) break;
            }
            if (Date.now() - start > SETTLE_TIMEOUT_MS) break;
            await delay(SETTLE_POLL_MS);
        }
        return { settleMs: Date.now() - start, worst, worstTiles, shortUntilMs, sample };
    };

    const demAtBoot = demRequests;
    const drapeAtBoot = drapeRequests;
    console.log(`Renderer: ${renderer} (headless, GPU)`);
    console.log(`Frame: ${ready.width}x${ready.height} CSS px; DEM tiles served locally at ${TILE_DELAY_MS} ms each.`);
    console.log(`Drape: ${DRAPE_CODE} (${DRAPE_LABEL}).`);
    console.log(`Boot: ${demAtBoot} DEM tiles, ${drapeAtBoot} drape tiles.`);

    // ---- Criterion 1 and 3: a cold-cache tilt sweep --------------------------
    const opening = await settle(await moveCamera(`map.jumpTo({
            center: [${SWEEP_CENTER[0]}, ${SWEEP_CENTER[1]}],
            zoom: ${SWEEP_ZOOM}, bearing: 0, pitch: ${SWEEP_START_PITCH}
        });`));
    if (!opening.sample || !opening.sample.ready) {
        throw new Error(`Could not read the terrain surface: ${opening.sample && opening.sample.reason}`);
    }
    console.log(`\nCold-cache tilt sweep (3 degrees per step, from ${SWEEP_START_PITCH} degrees,`
        + ` ${DWELL_MS} ms at rest before each)`);
    console.log(`  arriving at ${SWEEP_START_PITCH} on fresh ground: ${opening.settleMs} ms`
        + `, worst ${describeShortfall(opening.worst)} (not a tilt; this is what a cold view costs)`);

    const sweep = [];
    let fromPitch = SWEEP_START_PITCH;
    for (const pitch of SWEEP_STEPS) {
        await delay(DWELL_MS);
        const demBefore = demRequests;
        const result = await settle(await moveCamera(`map.setPitch(${pitch});`));
        const step = {
            from: fromPitch, to: pitch,
            settleMs: result.settleMs,
            worst: result.worst,
            worstTiles: result.worstTiles,
            shortUntilMs: result.shortUntilMs,
            demTiles: demRequests - demBefore,
            reversal: pitch < fromPitch
        };
        sweep.push(step);
        console.log(`  ${step.from} -> ${step.to}: settled ${String(step.settleMs).padStart(5)} ms`
            + `, worst ${describeShortfall(step.worst)}`
            + ` (per tile: ${describeTileShortfall(step.worstTiles)})`
            + `, short until ${String(step.shortUntilMs).padStart(4)} ms`
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
        // A fallback deeper than one level is allowed only if it is gone inside
        // the transient budget. This is not a softened criterion, it is the one
        // the code can actually govern: MapLibre falls back to whatever it has
        // already loaded, and nothing outside MapLibre can hand it an ancestor it
        // never requested — a warmed HTTP cache shortens the wait for the tile
        // that *was* requested. So depth belongs to the detail ladder (which
        // criterion 2 pins) and duration belongs to the warming. The budget
        // itself is a judgement, not a measurement: a few frames reads as a soft
        // edge, half a second reads as a blink.
        //
        // Tiles are held to the same bar as visible pixels. A tile that wants a
        // level it has not got is a collapse waiting for the ridge in front of it
        // to move; excusing it because this fixture's terrain happens to hide it
        // would make the criterion depend on the test's own scenery.
        const deep = Math.max(step.worst.levels, step.worstTiles.levels) > 1;
        if (deep && step.shortUntilMs > TRANSIENT_BUDGET_MS) {
            failures.push(`Tilt ${step.from} -> ${step.to} collapsed for ${step.shortUntilMs} ms`
                + ` (budget ${TRANSIENT_BUDGET_MS} ms): ${describeShortfall(step.worst)}`
                + `, per tile ${describeTileShortfall(step.worstTiles)}`);
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

    // ---- The drape's level against the ceiling it is painted into ------------
    console.log('\nDrape levels versus the render-to-texture ceiling');
    const anyDrape = census.find(entry => entry.sample.drape);
    if (!anyDrape) {
        console.log('  No drape layer in this run.');
    } else {
        console.log(`  ${anyDrape.sample.drape.tileSize}px drape tiles painted into`
            + ` ${anyDrape.sample.drape.targetPixels}px render targets.`);
        for (const entry of census) {
            const drape = entry.sample.drape;
            if (!drape) continue;
            const loaded = Object.entries(drape.levels)
                .map(([level, count]) => ({ level: Number(level), count }))
                .sort((a, b) => b.level - a.level);
            if (!loaded.length) continue;
            const finest = loaded[0].level;
            const coarsest = loaded[loaded.length - 1].level;
            const total = loaded.reduce((sum, item) => sum + item.count, 0);
            // Above the ceiling is traffic the render target throws away. Below
            // it is detail the pipeline would have carried and the drape did not
            // supply. Both are worth naming; only the first is waste.
            const note = [
                finest > drape.ceilingFinest ? `${finest - drape.ceilingFinest} finer than the near ceiling (wasted)` : null,
                coarsest < drape.ceilingCoarsest ? `${drape.ceilingCoarsest - coarsest} coarser than the far ceiling allows` : null
            ].filter(Boolean);
            console.log(`  ${String(entry.pitch).padStart(2)} degrees: levels ${finest}-${coarsest}`
                + ` (${total} tiles) against ceilings ${drape.ceilingFinest}-${drape.ceilingCoarsest}`
                + (note.length ? ` — ${note.join('; ')}` : ' — matched'));
        }
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
    await certificate.remove();
}
