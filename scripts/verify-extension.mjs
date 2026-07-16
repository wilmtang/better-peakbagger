// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the REAL unpacked extension in hidden Chrome and drives a local
// Peakbagger stand-in, so the actual manifest decides script order and worlds.
//
// This covers what nothing else does. npm test evals sources by hand, so it
// cannot see manifest order. scripts/verify-terrain-visual.mjs stubs
// window.BPBSettings *and* answers the bridge protocol itself, so it never runs
// src/settings.js or src/bridge.js. And manifest.background.scripts is the
// Firefox path -- Chrome ignores it and uses background.js's own importScripts.
// Two shipped regressions lived in exactly those blind spots.
//
// Browser notes, both learned the hard way:
//   - Chrome *stable* 137+ refuses --load-extension. Use Chrome for Testing,
//     which Playwright installs.
//   - Playwright's default headless is chrome-headless-shell, a separate binary
//     with no extension support at all. channel:'chromium' + headless:true runs
//     full Chrome for Testing in new headless, which does load extensions.
//
// Hidden: no window is shown and the user's browser/profile is never touched.

import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.error('This check needs Playwright: npm install && npx playwright install chromium');
    process.exit(1);
}

const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Synthetic</name><trkseg>${
    Array.from({ length: 60 }, (_, i) =>
        `<trkpt lat="${(46.85 + i * 0.0006).toFixed(6)}" lon="${(-121.76 + i * 0.0004).toFixed(6)}">`
        + `<ele>${1500 + i * 25}</ele><time>2026-07-01T13:${String(i % 60).padStart(2, '0')}:00Z</time></trkpt>`
    ).join('')}</trkseg></trk></gpx>`;

const ascentHtml = `<!doctype html><html><head><title>Ascent</title></head><body>
<table><tr><td>Elevation:</td><td>10,781 ft</td></tr></table>
<iframe src="/map/MasterMap.aspx?t=P&d=2296&c=900001&hj=300" width="450" height="450"></iframe>
<a href="/track.gpx">Download this GPS track</a>
<a href="/map/BigMap.aspx?t=A">Full Screen Map</a>
</body></html>`;

const bigMapHtml = `<!doctype html><html><head><title>Full Screen Map</title></head><body>
<iframe id="if" src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300"></iframe>
</body></html>`;

// Enough of Peakbagger's frame for the analyzer's overlay and layer sync to
// bind. Its Leaflet globals are page-owned, exactly as on the live site.
const masterMapHtml = `<!doctype html><html><body>
<select id="selmap"><option value="L_CT">Topo</option></select>
<div class="leaflet-control-zoom" style="position:absolute;bottom:10px;right:10px;width:30px;height:60px"></div>
<script>
  class Polyline {
    constructor(latLngs = [], options = {}) { this.latLngs = latLngs; this.options = options; this.events = {}; }
    addTo(map) { map.addLayer(this); return this; }
    bringToBack() { return this; }
    getLatLngs() { return this.latLngs; }
    setStyle(style) { Object.assign(this.options, style); return this; }
    on(type, handler) { (this.events[type] ||= []).push(handler); return this; }
  }
  class Polygon extends Polyline {}
  class MapStub {
    constructor(layers = []) { this.layers = []; this.events = {}; layers.forEach(layer => this.addLayer(layer)); }
    addLayer(layer) { layer._map = this; this.layers.push(layer); for (const fn of this.events.layeradd || []) fn({ layer }); return this; }
    eachLayer(callback) { this.layers.slice().forEach(callback); }
    invalidateSize() {}
    on(type, handler) { (this.events[type] ||= []).push(handler); return this; }
    removeLayer(layer) { this.layers = this.layers.filter(candidate => candidate !== layer); layer._map = null; }
  }
  window.L = {
    Polyline, Polygon, Map: MapStub,
    polyline: (latLngs, options) => new Polyline(latLngs, options),
    circleMarker: (latLng, options) => new Polyline([latLng], options)
  };
  window.mapsPlaceholder = new MapStub([
    new Polyline([{ lat: 46.85, lng: -121.76 }, { lat: 46.87, lng: -121.74 }], { color: '#d9483b', weight: 3 })
  ]);
</script></body></html>`;

const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const send = (type, body) => { response.writeHead(200, { 'content-type': type }); response.end(body); };
    if (/ascent\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', ascentHtml);
    if (/bigmap\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', bigMapHtml);
    if (/mastermap\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', masterMapHtml);
    if (/track\.gpx/i.test(url.pathname)) return send('application/gpx+xml', gpx);
    response.writeHead(404); response.end('not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const profile = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-extension-'));
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

let context;
try {
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1000, height: 760 },
        args: [
            `--disable-extensions-except=${root}`,
            `--load-extension=${root}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'
        ]
    });

    // --- The MV3 service worker actually boots -------------------------------
    // Chrome resolves the worker's dependencies through background.js's own
    // importScripts. When one is missing, settings.js bails, background.js
    // returns before addListener, and capture is silently dead.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    check(!!worker, 'the extension service worker never started');
    const extensionId = worker ? new URL(worker.url()).host : null;

    if (extensionId) {
        const optionsPage = await context.newPage();
        await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
        // A live worker answers; a bailed-out one has no listener at all.
        const reply = await optionsPage.evaluate(async () =>
            chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: -1 })
                .then(value => ({ ok: true, value: value ?? null }))
                .catch(error => ({ ok: false, error: String(error) })));
        check(reply.ok, `the worker never answered CAPTURE_STATUS (capture would be dead): ${reply.error || ''}`);
        await optionsPage.close();
    }

    const openAscent = async () => {
        const page = await context.newPage();
        await page.goto(`http://www.peakbagger.com:${port}/climber/ascent.aspx?aid=1`, { waitUntil: 'load' });
        await page.waitForTimeout(2000);
        return page;
    };

    const readToggle = page => page.evaluate(() => {
        const button = document.getElementById('bpb-terrain-toggle');
        return {
            // theme.js is isolated-world and bails without BPBSettings, so this
            // attribute proves settings.js initialised there.
            isolatedWorldReady: document.documentElement.getAttribute('data-bpb-theme'),
            analyzerPanel: !!document.getElementById('bpb-gpx-analysis'),
            stats: document.querySelector('#bpb-gpx-analysis div')?.textContent || '',
            exists: !!button,
            hidden: button ? button.hasAttribute('hidden') : null,
            display: button ? getComputedStyle(button).display : null,
            visible: button ? button.getBoundingClientRect().width > 0 : null,
            disabled: button ? button.disabled : null,
            title: button ? button.title : null
        };
    });

    // --- 3D off (the default): the toggle must not be on the map -------------
    const offPage = await openAscent();
    const off = await readToggle(offPage);
    check(off.isolatedWorldReady !== null,
        'settings.js did not initialise in the isolated world (the bridge would be silent)');
    check(off.analyzerPanel, 'the GPX analyzer panel never rendered');
    check(/Interactive Stats/.test(off.stats), `the analyzer never produced stats: ${off.stats.slice(0, 80)}`);
    check(off.visible === false,
        `with 3D disabled the toggle must be hidden, but display=${off.display} visible=${off.visible}`);
    await offPage.close();

    // --- 3D on: the toggle appears and enables once the route parses ---------
    if (extensionId) {
        const optionsPage = await context.newPage();
        await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
        await optionsPage.evaluate(async () => {
            const current = (await chrome.storage.sync.get('bpbSettings')).bpbSettings || {};
            await chrome.storage.sync.set({ bpbSettings: { ...current, enable3dMap: true } });
        });
        await optionsPage.close();

        const onPage = await openAscent();
        const on = await readToggle(onPage);
        check(on.visible === true, `with 3D enabled the toggle must be visible (display=${on.display})`);
        check(on.disabled === false,
            `the toggle should enable once the route parses, but stayed greyed: title=${JSON.stringify(on.title)}`);
        await onPage.close();

        const bigMapPage = await context.newPage();
        const bigMapErrors = [];
        bigMapPage.on('pageerror', error => bigMapErrors.push(String(error)));
        const bigMapCdp = await context.newCDPSession(bigMapPage);
        await bigMapCdp.send('Runtime.enable');
        bigMapCdp.on('Runtime.exceptionThrown', event => {
            bigMapErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'unknown exception');
        });
        await bigMapPage.goto(`http://www.peakbagger.com:${port}/map/BigMap.aspx?t=A&d=2296`, { waitUntil: 'load' });
        const bigMapToggle = await bigMapPage.waitForFunction(() => {
            const button = document.getElementById('bpb-terrain-toggle');
            if (!button) return false;
            const rect = button.getBoundingClientRect();
            const state = {
                visible: rect.width > 0 && rect.height > 0,
                disabled: button.disabled,
                display: getComputedStyle(button).display
            };
            return state.visible && !state.disabled ? state : false;
        }, null, { timeout: 10000 }).then(handle => handle.jsonValue()).catch(() => null);
        const bigMapState = await bigMapPage.evaluate(() => {
            const iframe = document.getElementById('if');
            return {
                url: location.href,
                metricsReady: !!window.BPBGpxMetrics,
                basemapReady: !!window.BPBTerrainBasemap,
                peakMarkersReady: !!window.BPBPeakMarkers,
                schemaReady: !!window.BPBSettingsSchema,
                mountExists: !!document.getElementById('bpb-map-viewport'),
                iframeMapReady: !!iframe?.contentWindow?.mapsPlaceholder,
                iframeLeafletReady: !!iframe?.contentWindow?.L,
                stylesheets: [...document.styleSheets].map(sheet => sheet.href)
            };
        });
        check(bigMapToggle?.visible === true,
            `with 3D enabled the BigMap toggle must be visible (toggle=${JSON.stringify(bigMapToggle)}, page=${JSON.stringify(bigMapState)}, errors=${JSON.stringify(bigMapErrors)})`);
        check(bigMapToggle?.disabled === false,
            `the BigMap toggle should enable once its native route is ready (state=${JSON.stringify(bigMapToggle)})`);
        await bigMapPage.close();
    }
} finally {
    if (context) await context.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
}

if (failures.length) {
    console.error('Real-extension verification FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log('Real-extension verification passed (hidden Chrome for Testing, new headless):');
console.log('  - the MV3 service worker boots and answers messages (capture is alive)');
console.log('  - settings.js initialises in the isolated world and the bridge answers');
console.log('  - the GPX analyzer renders stats from the real manifest load order');
console.log('  - the 3D toggle is hidden when disabled and enabled when the route parses');
console.log('  - the Full Screen BigMap receives settings and shows an enabled 3D toggle');
