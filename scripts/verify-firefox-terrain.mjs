#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, location, requestAnimationFrame */

import { createServer } from 'node:https';

import { firefox } from 'playwright';

import {
    createFixtureCertificate,
    resolveFixtureFile,
    sendFixtureError,
    sendFixtureFile,
    sendFixtureNotFound,
    sendFixtureText,
    instrumentTerrainFrameHtml,
    instrumentTerrainFrameModule,
} from './browser-verification-fixtures.mjs';
import {
    closeServer,
    createResourceStack,
    listenServer,
} from './resource-stack.mjs';


const viewport = { width: 1000, height: 760 };
const fixtureHost = 'www.peakbagger.com';
const syntheticTerrariumWebp = Buffer.from(
    'UklGRoIAAABXRUJQVlA4THYAAAAv/8F/AD8gFkzyR94dhICgyHPTY/6zQwZFtW1TKqigggoqqKCC/rM/wx3R/wkI/M//A+P38h+YpefnP1DLz8t/4Fauz38gV4/Pf2DXtuc/0OvT+Y//+I/41uc/wDsv/wHdffkP4N6T/4DtvfkP0P6T/4CM/8Ef',
    'base64',
);
// The showcase must be served over HTTPS. src/peakbagger/peakbagger-request.js
// refuses any URL whose protocol is not https: — a deliberate security property
// — and the analyzer fetches its GPX through that guard, so over http:// the
// route never loads and the 3D toggle never enables.
function createFixtureServer({ key, cert }) {
    const server = createServer({ key, cert }, async (request, response) => {
        try {
            const url = new URL(request.url, `https://${fixtureHost}`);
            if (url.pathname.toLowerCase() === '/async/pllbb.aspx') {
                const bounds = ['miny', 'maxy', 'minx', 'maxx'].map(name =>
                    Number(url.searchParams.get(name)));
                if (bounds.some(value => !Number.isFinite(value))) {
                    sendFixtureText(response, 400, 'bad bounds');
                    return;
                }
                const [miny, maxy, minx, maxx] = bounds;
                const latitude = (miny + maxy) / 2;
                const longitude = (minx + maxx) / 2;
                sendFixtureText(
                    response, 200,
                    `<ts><t i="58603" n="Iron Mountain" a="${latitude}" o="${longitude}" c="1" r="246"/></ts>`,
                    'text/xml; charset=utf-8');
                return;
            }

            const showcaseRoutes = {
                '/climber/ascent.aspx': '/scripts/showcase/terrain.html',
                '/map/mastermap.aspx': '/scripts/showcase/terrain-native-map.html',
            };
            let pathname = showcaseRoutes[url.pathname.toLowerCase()] || decodeURIComponent(url.pathname);
            if (pathname.startsWith('/scripts/showcase/terrain-tiles/')) {
                pathname = '/scripts/showcase/terrain-basemap-tile.png';
            }
            const file = await resolveFixtureFile(pathname);
            if (!file) {
                sendFixtureNotFound(response, 'not found');
                return;
            }
            await sendFixtureFile(response, file, {
                transform: url.pathname === '/dist/terrain/terrain.html'
                    ? instrumentTerrainFrameHtml
                    : (url.pathname === '/dist/terrain/terrain-frame.js'
                        ? instrumentTerrainFrameModule
                        : null),
            });
        } catch (error) {
            sendFixtureError(response, error);
        }
    });
    return server;
}

async function main() {
    const resources = createResourceStack();
    let primaryError = null;
    try {
        const certificate = await createFixtureCertificate({ host: fixtureHost, label: 'firefox-terrain' });
        resources.defer('Firefox terrain certificate', () => certificate.remove());
        const server = createFixtureServer(certificate);
        resources.defer('Firefox terrain server', () => closeServer(server));
        await listenServer(server, 0, '127.0.0.1');
        const port = server.address().port;

        const browser = await firefox.launch({
            headless: true,
            firefoxUserPrefs: {
                'network.dns.localDomains': fixtureHost,
                'webgl.disabled': false,
            },
        });
        resources.defer('Firefox terrain browser', () => browser.close());
        // The fixture certificate is generated per run for this host only, and the
        // route handler below is the thing that keeps live origins unreachable.
        const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
        resources.defer('Firefox terrain context', () => context.close());
        const page = await context.newPage();
        const errors = [];
        const requests = { terrain: 0, basemap: 0, peaks: 0 };
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text());
        });
        page.on('request', request => {
            const url = request.url();
            if (url.startsWith('https://tiles.mapterhorn.com/')) requests.terrain += 1;
            if (url.includes('/terrain-tiles/')) requests.basemap += 1;
            if (/\/Async\/PLLBB\.aspx/i.test(url)) requests.peaks += 1;
        });
        // One handler rather than a mock plus a blanket abort: the fixture origin is
        // itself https now, so an unconditional `https://**` abort would tear down
        // the page under test. Everything not explicitly allowed still fails closed.
        const fixtureOrigin = `https://${fixtureHost}:${port}/`;
        await page.route('https://**', route => {
            const url = route.request().url();
            if (url.startsWith('https://tiles.mapterhorn.com/')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'image/webp',
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-store',
                        'X-BPB-Terrain-Fixture': 'synthetic-terrarium-v1',
                    },
                    body: syntheticTerrariumWebp,
                });
            }
            if (url.startsWith(fixtureOrigin)) return route.continue();
            return route.abort();
        });

        await page.goto(
            `${fixtureOrigin}climber/ascent.aspx?mode=idle&map=wide`,
            { waitUntil: 'load' },
        );
        await page.waitForFunction(() => {
            const toggle = document.getElementById('bpb-terrain-toggle');
            const nativeMap = document.querySelector('iframe[src*="MasterMap.aspx" i]');
            try {
                return Boolean(toggle && !toggle.disabled && nativeMap?.contentWindow?.mapsPlaceholder);
            } catch {
                return false;
            }
        });
        const terrainBeforeAuthorizationProbe = requests.terrain;
        const syntheticState = await page.evaluate(async () => {
            document.getElementById('bpb-terrain-toggle').click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return {
                issueAttempts: globalThis.__bpbTerrainFixtureIssueAttempts,
                frame: Boolean(document.getElementById('bpb-terrain-frame')),
            };
        });
        if (syntheticState.issueAttempts !== 0 || syntheticState.frame) {
            throw new Error(`A synthetic Firefox terrain click crossed the activation boundary: ${JSON.stringify(syntheticState)}`);
        }
        await page.evaluate(async () => {
            const frame = document.createElement('iframe');
            frame.id = 'bpb-direct-terrain-probe';
            frame.src = '/dist/terrain/terrain.html';
            document.body.append(frame);
        });
        await page.waitForFunction(() => {
            const frame = document.getElementById('bpb-direct-terrain-probe');
            frame?.contentWindow?.postMessage({
                __bpbTerrainFrame: true,
                dir: 'toFrame',
                type: 'init',
                activation: 'guessed-fixture-capability',
            }, location.origin);
            return globalThis.__bpbTerrainFixtureAuthorizationAttempts > 0;
        });
        const directFrameState = await page.evaluate(() => {
            const frame = document.getElementById('bpb-direct-terrain-probe');
            const result = {
                map: Boolean(frame?.contentWindow?.__bpbTerrainTestMap),
                issueAttempts: globalThis.__bpbTerrainFixtureIssueAttempts,
                authorizationAttempts: globalThis.__bpbTerrainFixtureAuthorizationAttempts,
            };
            frame?.remove();
            return result;
        });
        if (directFrameState.map || directFrameState.issueAttempts !== 0
            || requests.terrain !== terrainBeforeAuthorizationProbe) {
            throw new Error(`Direct Firefox terrain embedding started provider work: ${JSON.stringify(directFrameState)}`);
        }

        await page.goto(
            `${fixtureOrigin}climber/ascent.aspx?mode=terrain&map=wide`,
            { waitUntil: 'load' },
        );
        await page.waitForFunction(() => document.documentElement.dataset.bpbTerrainFixtureReady === 'true');
        await page.locator('#bpb-terrain-toggle').click();
        try {
            await page.waitForFunction(() => {
                const frame = document.getElementById('bpb-terrain-frame');
                const win = frame?.contentWindow;
                const map = win?.__bpbTerrainTestMap;
                return frame?.style.opacity === '1' && map?.loaded()
          && map.getLayer('bpb-route') && map.getLayer('bpb-peaks-ring')
          && map.getSource('basemap');
            }, null, { timeout: 45_000 });
        } catch (error) {
            const state = await page.evaluate(() => {
                const frame = document.getElementById('bpb-terrain-frame');
                const map = frame?.contentWindow?.__bpbTerrainTestMap;
                return {
                    frame: Boolean(frame),
                    frameOpacity: frame?.style.opacity || null,
                    frameReadyState: frame?.contentDocument?.readyState || null,
                    map: Boolean(map),
                    mapLoaded: map?.loaded() || false,
                    route: Boolean(map?.getLayer('bpb-route')),
                    peaks: Boolean(map?.getLayer('bpb-peaks-ring')),
                    basemap: Boolean(map?.getSource('basemap')),
                };
            });
            throw new Error(`Timed out waiting for Firefox terrain readiness: ${JSON.stringify({ state, requests, errors })}`, {
                cause: error,
            });
        }

        const frame = page.frameLocator('#bpb-terrain-frame');
        const rendererState = await frame.locator('canvas.maplibregl-canvas').evaluate(canvas => {
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            const info = gl?.getExtension('WEBGL_debug_renderer_info');
            const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
            const map = globalThis.__bpbTerrainTestMap;
            return {
                renderer,
                zoom: map.getZoom(),
                pitch: map.getPitch(),
                canvas: { width: canvas.width, height: canvas.height },
                terrain: Boolean(map.getTerrain()),
                route: Boolean(map.getLayer('bpb-route')),
                basemap: Boolean(map.getSource('basemap')),
                peaks: Boolean(map.getLayer('bpb-peaks-ring')),
                peakMarker: Boolean(document.querySelector('.bpb-terrain-peak-marker')),
            };
        });
        if (!rendererState.renderer) throw new Error('Firefox exposed no WebGL renderer');
        if (/swiftshader|software|llvmpipe/i.test(rendererState.renderer)) {
            throw new Error(`Refusing Firefox terrain verification on software WebGL (${rendererState.renderer})`);
        }
        if (!rendererState.terrain || !rendererState.route || !rendererState.basemap
      || !rendererState.peaks || !rendererState.peakMarker
      || rendererState.canvas.width === 0 || rendererState.canvas.height === 0) {
            throw new Error(`Firefox terrain surface was incomplete: ${JSON.stringify(rendererState)}`);
        }
        const peakMarker = frame.locator('.bpb-terrain-peak-marker').first();
        await peakMarker.waitFor({ state: 'visible', timeout: 10_000 });
        await peakMarker.click();
        const peakLink = frame.locator('.maplibregl-popup .bpb-peak-popup a');
        await peakLink.waitFor({ state: 'visible', timeout: 8_000 });
        if (!/\/peak\.aspx\?pid=58603$/.test(await peakLink.getAttribute('href') || '')) {
            throw new Error('Firefox peak marker opened the wrong popup link');
        }

        const canvas = frame.locator('canvas.maplibregl-canvas');
        const box = await canvas.boundingBox();
        if (!box) throw new Error('Firefox terrain canvas had no pointer target');
        const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(center.x, center.y);
        await page.mouse.wheel(0, -360);
        await page.waitForFunction(previous => {
            const map = document.getElementById('bpb-terrain-frame')?.contentWindow?.__bpbTerrainTestMap;
            return map?.getZoom() > previous;
        }, rendererState.zoom, { timeout: 8_000 });

        const pitchBefore = await canvas.evaluate(() => globalThis.__bpbTerrainTestMap.getPitch());
        await page.mouse.move(center.x, center.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(center.x, center.y - 180, { steps: 8 });
        await page.mouse.up({ button: 'right' });
        await page.waitForFunction(previous => {
            const map = document.getElementById('bpb-terrain-frame')?.contentWindow?.__bpbTerrainTestMap;
            return Math.abs((map?.getPitch() ?? previous) - previous) > 2;
        }, pitchBefore, { timeout: 8_000 });

        // Firefox on macOS rewrites Ctrl+primary into a secondary-button gesture.
        // Exercise that production alternative separately from the normal right drag.
        const ctrlPitchBefore = await canvas.evaluate(() => globalThis.__bpbTerrainTestMap.getPitch());
        await page.keyboard.down('Control');
        await page.mouse.move(center.x, center.y);
        await page.mouse.down({ button: 'left' });
        await page.mouse.move(center.x, center.y + 100, { steps: 6 });
        await page.mouse.up({ button: 'left' });
        await page.keyboard.up('Control');
        await page.waitForFunction(previous => {
            const map = document.getElementById('bpb-terrain-frame')?.contentWindow?.__bpbTerrainTestMap;
            return Math.abs((map?.getPitch() ?? previous) - previous) > 1;
        }, ctrlPitchBefore, { timeout: 8_000 });

        await page.evaluate(() => {
            const mount = document.querySelector('.terrain-check .map-shell');
            mount.style.width = '620px';
        });
        const resized = await page.waitForFunction(() => {
            const frameElement = document.getElementById('bpb-terrain-frame');
            const win = frameElement?.contentWindow;
            const canvasElement = frameElement?.contentDocument?.querySelector('canvas.maplibregl-canvas');
            const map = win?.__bpbTerrainTestMap;
            return canvasElement?.width > 0 && canvasElement.width < 800
        && map?.loaded() && map.getLayer('bpb-route') ? {
                    width: canvasElement.width,
                    height: canvasElement.height,
                    route: Boolean(map.getLayer('bpb-route')),
                } : false;
        }, null, { timeout: 10_000 }).then(handle => handle.jsonValue());
        if (!resized.route || requests.terrain === 0 || requests.basemap === 0 || requests.peaks === 0) {
            throw new Error(`Firefox terrain fixtures were incomplete: ${JSON.stringify({ resized, requests })}`);
        }
        if (errors.length) throw new Error(`Firefox terrain runtime errors:\n${errors.join('\n')}`);

        console.log('Firefox terrain verification passed:');
        console.log(`  - Firefox ${browser.version()}, hidden/headless ${viewport.width}x${viewport.height}`);
        console.log(`  - renderer: ${rendererState.renderer}`);
        console.log('  - synthetic activation and direct-frame authorization negatives passed');
        console.log('  - terrain/basemap/route/peaks rendered; scroll zoom, right drag, Ctrl-drag, and resize passed');
        console.log(`  - resized canvas ${resized.width}x${resized.height}; native focus/window placement was not tested`);
    } catch (error) {
        primaryError = error;
    }
    await resources.dispose(primaryError);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
