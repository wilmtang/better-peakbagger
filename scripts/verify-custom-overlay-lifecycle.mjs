// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global window, document */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
import { build } from 'esbuild';
import { chromium, firefox } from 'playwright';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createFixtureCertificate } from './browser-verification-fixtures.mjs';
import { snowMapDocument } from './verify-snow-map-fixture.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';

const [browserName, selection = 'startup'] = process.argv.slice(2);
assert.ok(process.argv.length <= 4 && ['chrome', 'firefox'].includes(browserName) && selection === 'startup',
    'Usage: node scripts/verify-custom-overlay-lifecycle.mjs chrome|firefox [startup]');
const resources = createResourceStack();
try {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-custom-lifecycle-'));
    resources.defer('lifecycle fixture directory', () => rm(temporaryRoot, { recursive: true, force: true }));
    const bundle = await build({ stdin: { contents: "import {createCustomRenderer} from './src/maps/custom-overlay-render.js'; import {parseCustomData} from './src/maps/custom-overlay-data.js'; window.lifecycleRenderer=createCustomRenderer; window.lifecycleParse=parseCustomData;", resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false });
    const certificate = await createFixtureCertificate({ directory: temporaryRoot });
    resources.defer('lifecycle certificate', () => certificate.remove());
    const html = (await snowMapDocument()).replace('</body>', '<script src="/lifecycle.js"></script></body>');
    const server = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
        response.setHeader('content-type', request.url === '/lifecycle.js' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/lifecycle.js' ? bundle.outputFiles[0].contents : html);
    });
    resources.defer('lifecycle HTTPS server', () => closeServer(server)); await listenServer(server, 0, '127.0.0.1');
    const engine = browserName === 'chrome' ? chromium : firefox;
    assertChromeLaunchAllowed();
    const context = await engine.launchPersistentContext(path.join(temporaryRoot, 'profile'), {
        headless: true, viewport: { width: 1000, height: 760 },
        ...(browserName === 'chrome' ? { channel: 'chromium', args: [...certificate.chromeTrustArgs, '--no-proxy-server', '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
            : { ignoreHTTPSErrors: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }),
    });
    resources.defer('lifecycle browser', () => context.close());
    const mvt = Buffer.from(fromGeojsonVt({ trails: { features: [{ type: 1, geometry: [[2048, 2048]], tags: {} }] } }, { version: 2, extent: 4096 })).toString('base64');
    let cases = 0;
    for (const width of [1000, 390]) for (const theme of ['light', 'dark']) for (const kind of ['geojson', 'raster', 'mvt']) {
        const page = await context.newPage(); await page.setViewportSize({ width, height: 760 });
        await page.goto(`https://www.peakbagger.com:${server.address().port}/map/MasterMap.aspx`);
        const result = await page.evaluate(async ({ kind, theme, mvt }) => {
            document.documentElement.dataset.bpbTheme = theme;
            const map = window.mapsPlaceholder, statuses = [];
            let release;
            const held = new Promise(resolve => { release = resolve; });
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#26734d'; ctx.fillRect(0, 0, 256, 256);
            const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            window.fetch = async url => {
                await held;
                if (url.endsWith('meta.json')) return Response.json({ tilejson: '3.0.0', minzoom: 0, maxzoom: 18, tiles: [`https://tiles.example.com/{z}/{x}/{y}.${kind === 'mvt' ? 'pbf' : 'png'}`] });
                if (url.endsWith('.geojson')) return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-121.76, 46.85] } }] });
                return kind === 'mvt' ? new Response(Uint8Array.from(atob(mvt), char => char.charCodeAt(0))) : new Response(png, { headers: { 'content-type': 'image/png' } });
            };
            const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind,
                source: kind === 'geojson' ? { dataUrl: 'https://tiles.example.com/data.geojson' } : { tiles: [], metadataUrl: 'https://tiles.example.com/meta.json', minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
                approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: kind === 'raster' ? [] : [{ sourceLayer: 'trails', geometry: 'point', color: '#26734d', radius: 5, width: 2, fillOpacity: .3 }] } };
            const renderer = window.lifecycleRenderer({ win: window, map, parse: async job => window.lifecycleParse(job), onStatus: (_id, status) => statuses.push(status) });
            try {
                if (map.getPane('bpb-custom-overlays')) throw new Error('Fixture already has custom pane.');
                renderer.update([source]); renderer.update([source]);
                release();
                const end = performance.now() + 10000;
                while (statuses.at(-1)?.pending || !statuses.at(-1)?.message) {
                    if (performance.now() > end) throw new Error('Paint timeout: ' + JSON.stringify(statuses.at(-1)));
                    await new Promise(resolve => window.requestAnimationFrame(resolve));
                }
                if (statuses.at(-1).error) throw new Error(JSON.stringify(statuses.at(-1)));
                window.lifecycleDispose = () => renderer.dispose();
                return { loaded: true, canvases: document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas').length };
            } catch (error) { renderer.dispose(); throw error; }
        }, { kind, theme, mvt });
        assert.ok(result.loaded && result.canvases > 0, `${theme}/${width}/${kind} paints on a fresh map`);
        if (process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS) {
            await mkdir(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.BPB_CUSTOM_LIFECYCLE_SCREENSHOTS, `${browserName}-${selection}-${kind}-${theme}-${width}.png`) });
        }
        await page.evaluate(() => window.lifecycleDispose());
        cases++; await page.close();
    }
    assert.equal(cases, 12);
    console.log(JSON.stringify({ verification: 'custom-overlay-lifecycle', selection, cases, browser: context.browser().version(), hidden: true, widths: [1000, 390], height: 760, renderer: 'Leaflet canvas 2D' }));
} finally { await resources.dispose(); }
