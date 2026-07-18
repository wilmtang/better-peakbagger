// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the REAL unpacked extension in hidden Chrome and drives a local
// Peakbagger stand-in, so the actual manifest decides script order and worlds.
//
// This covers what nothing else does. npm test evaluates the built bundles in
// jsdom, so it cannot see how a browser interprets manifest order and worlds.
// scripts/verify-terrain-visual.mjs provides storage and bridge-protocol stubs,
// so it does not exercise the real cross-world bridge. The worker also has to
// boot through the manifest's single bundled background entry. Two shipped
// regressions lived in exactly those blind spots.
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
// The unpacked extension is the built bundle tree, not the source root.
const dist = path.join(root, 'dist');

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

const peakHtml = `<!doctype html><html><head><title>Mount Shuksan</title></head><body>
<h1>Mount Shuksan, Washington</h1>
<table style="width:760px"><tr><td style="text-align:center">
<b>Dynamic Map</b><br>
<iframe id="Gmap" src="/map/MasterMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300"
  width="100%" height="425px"></iframe><br>
<img src="/image/MainPeakPinkCircle.gif">&nbsp;Mount Shuksan&nbsp;(Unclimbed!)<br>
<a href="/map/BigMap.aspx?cy=48.83115&cx=-121.60214&z=14&l=L_CT|L_OT&t=P&d=2829&c=0&hj=300">
  Click Here for a Full Screen Map
</a>
</td></tr></table>
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

// The ascent editor is exercised against the real captured form, so the
// content script meets Peakbagger's actual DOM (JournalText, hints row, the
// Save/Preview controls) rather than a hand-written stand-in.
const ascentEditHtml = await readFile(
    path.join(root, 'test', 'fixtures', 'pages', 'climber-ascentedit.html'), 'utf8');

const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const send = (type, body) => { response.writeHead(200, { 'content-type': type }); response.end(body); };
    if (/ascentedit\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', ascentEditHtml);
    if (/ascent\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', ascentHtml);
    if (/peak\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', peakHtml);
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
            `--disable-extensions-except=${dist}`,
            `--load-extension=${dist}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'
        ]
    });

    // --- The MV3 service worker actually boots -------------------------------
    // Chrome boots the bundled worker selected by the manifest. A missing
    // source in its bundle or an initialization failure can prevent the
    // coordinator from registering its listener and leave capture silently dead.
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
            // theme.js imports settings in the isolated-world bundle, so this
            // attribute proves that bundle initialized there.
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

    // --- 3D off (the default): the toggle stays available but gates traffic --
    const offPage = await openAscent();
    const off = await readToggle(offPage);
    check(off.isolatedWorldReady !== null,
        'settings.js did not initialise in the isolated world (the bridge would be silent)');
    check(off.analyzerPanel, 'the GPX analyzer panel never rendered');
    check(/Interactive Stats/.test(off.stats), `the analyzer never produced stats: ${off.stats.slice(0, 80)}`);
    check(off.visible === true,
        `with 3D disabled the toggle must remain visible, but display=${off.display} visible=${off.visible}`);
    check(off.disabled === false,
        `the disabled feature's toggle should still be actionable after the route parses: title=${JSON.stringify(off.title)}`);
    await offPage.locator('#bpb-terrain-toggle').click();
    const consent = await offPage.locator('#bpb-terrain-consent').waitFor({ state: 'visible', timeout: 5000 })
        .then(async () => offPage.evaluate(() => {
            const dialog = document.querySelector('#bpb-terrain-consent [role="dialog"]');
            return {
                text: dialog?.textContent || '',
                modal: dialog?.getAttribute('aria-modal'),
                links: Array.from(dialog?.querySelectorAll('a') || [], link => link.href)
            };
        })).catch(() => null);
    check(consent?.modal === 'true', `the first-use 3D confirmation did not render as a modal: ${JSON.stringify(consent)}`);
    check(/Mapterhorn/.test(consent?.text || '') && /OpenFreeMap/.test(consent?.text || ''),
        `the first-use confirmation did not name both providers: ${JSON.stringify(consent)}`);
    check(consent?.links.some(link => link === 'https://mapterhorn.com/privacy-policy/')
        && consent?.links.some(link => link === 'https://openfreemap.org/privacy/'),
        `the first-use confirmation is missing provider privacy links: ${JSON.stringify(consent)}`);
    await offPage.locator('.bpb-terrain-consent-secondary').click();
    check(await offPage.locator('#bpb-terrain-consent').count() === 0,
        'declining the first-use confirmation did not close it');

    // Re-open and accept through a real protocol-driven pointer event. HTTPS
    // is intercepted so this verifies the privileged setting write and
    // continuation without contacting any tile provider.
    await context.route('https://**', route => route.abort());
    await offPage.locator('#bpb-terrain-toggle').click();
    await offPage.locator('#bpb-terrain-consent').waitFor({ state: 'visible', timeout: 5000 });
    await offPage.locator('.bpb-terrain-consent-primary').click();
    await offPage.locator('#bpb-terrain-consent').waitFor({ state: 'detached', timeout: 5000 });
    if (extensionId) {
        const consentCheckPage = await context.newPage();
        await consentCheckPage.goto(`chrome-extension://${extensionId}/options/options.html`);
        const enabledByConsent = await consentCheckPage.evaluate(async () =>
            (await chrome.storage.sync.get('bpbSettings')).bpbSettings?.enable3dMap === true);
        check(enabledByConsent, 'trusted confirmation did not persist enable3dMap');
        await consentCheckPage.close();
    }
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
                // Bundle readiness is proven by the toggle (checked below); no
                // module publishes a global anymore.
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

        const peakPage = await context.newPage();
        const peakErrors = [];
        peakPage.on('pageerror', error => peakErrors.push(String(error)));
        await peakPage.goto(`http://www.peakbagger.com:${port}/Peak.aspx?pid=2829`, { waitUntil: 'load' });
        const peakState = await peakPage.waitForFunction(() => {
            const button = document.getElementById('bpb-terrain-toggle');
            const mount = document.getElementById('bpb-map-viewport');
            const iframe = document.getElementById('Gmap');
            if (!button || !mount || !iframe) return false;
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !button.disabled ? {
                text: button.textContent,
                mountClass: mount.className,
                mountHeight: mount.getBoundingClientRect().height,
                iframePreserved: iframe.parentElement === mount,
                // The MAIN-world coordinator bundle self-contains basemap,
                // peak-markers, and schema via ES imports, so its toggle existing
                // (this state being truthy) proves those loaded. The isolated
                // theme bundle is confirmed separately by the theme attribute.
                isolatedWorldReady: document.documentElement.getAttribute('data-bpb-theme') !== null
            } : false;
        }, null, { timeout: 10000 }).then(handle => handle.jsonValue()).catch(() => null);
        check(peakState?.text === '3D',
            `the Peak page must show an enabled 3D toggle (state=${JSON.stringify(peakState)}, errors=${JSON.stringify(peakErrors)})`);
        check(peakState?.mountClass === 'bpb-terrain-mount-peak' && peakState?.iframePreserved === true,
            `the Peak map wrapper must preserve the native iframe (state=${JSON.stringify(peakState)})`);
        check(peakState?.mountHeight === 425,
            `the Peak map wrapper must preserve the native 425px height (state=${JSON.stringify(peakState)})`);
        check(peakState?.isolatedWorldReady,
            `the Peak isolated-world theme bundle did not initialize (state=${JSON.stringify(peakState)})`);
        if (process.env.BPB_VERIFY_PEAK_SCREENSHOT) {
            await peakPage.screenshot({ path: process.env.BPB_VERIFY_PEAK_SCREENSHOT, fullPage: true });
        }
        await peakPage.evaluate(() => {
            window.__bpbPeakTerrainInit = null;
            window.addEventListener('message', event => {
                const data = event.data;
                if (event.source === window && data?.__bpbTerrain === true
                    && data.dir === 'toCS' && data.type === 'init') {
                    window.__bpbPeakTerrainInit = data;
                }
            });
        });
        await peakPage.locator('#bpb-terrain-toggle').click();
        const peakInit = await peakPage.waitForFunction(() => window.__bpbPeakTerrainInit, null, { timeout: 5000 })
            .then(handle => handle.jsonValue()).catch(() => null);
        check(JSON.stringify(peakInit?.focus) === JSON.stringify([48.83115, -121.60214])
            && peakInit?.focusZoom === 13
            && peakInit?.focusPeak?.id === 2829
            && !Object.hasOwn(peakInit || {}, 'routeSegments'),
            `the real Peak-page click did not start a route-free summit view (init=${JSON.stringify(peakInit)})`);
        const peakFrameCreated = await peakPage.locator('#bpb-terrain-frame').waitFor({ state: 'attached', timeout: 3000 })
            .then(() => true).catch(() => false);
        check(peakFrameCreated, 'the isolated terrain bridge did not create a frame for the Peak-page summit view');
        await peakPage.close();
    }

    // --- Trip-report editor on the real ascent form --------------------------
    // Real typing and real execCommand formatting, which jsdom cannot cover.
    {
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        const editorUrl = `http://www.peakbagger.com:${port}/climber/ascentedit.aspx?cid=900001`;
        const editorPage = await context.newPage();
        const editorErrors = [];
        editorPage.on('pageerror', error => editorErrors.push(String(error)));
        await editorPage.goto(editorUrl, { waitUntil: 'load' });

        const mounted = await editorPage.locator('#bpb-report-editor').waitFor({ state: 'visible', timeout: 10000 })
            .then(() => true).catch(() => false);
        check(mounted, `the trip-report editor never mounted on the real form (errors=${JSON.stringify(editorErrors)})`);

        if (mounted) {
            const nativeHidden = await editorPage.evaluate(() => {
                const textarea = document.getElementById('JournalText');
                return getComputedStyle(textarea).display === 'none' && !!textarea.form;
            });
            check(nativeHidden, 'the native textarea should be hidden but still inside the form');

            await editorPage.locator('.bpb-re-surface').click();
            await editorPage.keyboard.type('Summit day was ');
            await editorPage.keyboard.press(`${modifier}+b`);
            await editorPage.keyboard.type('windy');
            await editorPage.keyboard.press(`${modifier}+b`);
            await editorPage.keyboard.type('.');
            await editorPage.keyboard.press('Enter');
            await editorPage.keyboard.type('Second paragraph.');

            const synced = await editorPage.waitForFunction(() =>
                document.getElementById('JournalText').value
                === 'Summit day was [b]windy[/b].\n\nSecond paragraph.', null, { timeout: 5000 })
                .then(() => true).catch(() => false);
            check(synced, `real typing + Ctrl/Cmd+B did not sync bracket markup into JournalText (value=${
                JSON.stringify(await editorPage.evaluate(() => document.getElementById('JournalText').value))})`);

            const savedStatus = await editorPage.waitForFunction(() =>
                /Draft saved on this device/.test(document.querySelector('.bpb-re-status')?.textContent || ''),
            null, { timeout: 5000 }).then(() => true).catch(() => false);
            check(savedStatus, 'the local-draft autosave status never appeared');

            await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Markdown', exact: true }).click();
            const markdownValue = await editorPage.evaluate(() => document.querySelector('.bpb-re-md').value);
            check(markdownValue === 'Summit day was **windy**.\n\nSecond paragraph.',
                `switching to markdown did not convert the content (value=${JSON.stringify(markdownValue)})`);
            await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Preview', exact: true }).click();
            const previewHtml = await editorPage.evaluate(() => document.querySelector('.bpb-re-preview').innerHTML);
            check(/<b>windy<\/b>/.test(previewHtml),
                `the markdown preview did not render the final formatting (html=${JSON.stringify(previewHtml)})`);

            // A reload serves the pristine form again; the draft must be
            // offered back and restore into the mode it was written in.
            await editorPage.reload({ waitUntil: 'load' });
            const offered = await editorPage.locator('.bpb-re-draft').waitFor({ state: 'visible', timeout: 10000 })
                .then(() => true).catch(() => false);
            check(offered, 'a differing local draft was not offered after reload');
            if (offered) {
                await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Restore draft', exact: true }).click();
                const restored = await editorPage.evaluate(() => ({
                    mode: document.getElementById('bpb-report-editor').dataset.mode,
                    value: document.getElementById('JournalText').value
                }));
                check(restored.mode === 'markdown'
                    && restored.value === 'Summit day was [b]windy[/b].\n\nSecond paragraph.',
                `restoring the draft did not bring back content and mode (state=${JSON.stringify(restored)})`);
            }

            // Exercise the broader Marked-token pipeline through the real
            // manifest order, not just the unit-test loader.
            await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Write', exact: true }).click();
            await editorPage.locator('.bpb-re-md').fill([
                '## Route notes',
                '',
                '> Windy ~~retreat~~.',
                '',
                '| Peak | Elev |',
                '| --- | ---: |',
                '| Baker | 10781 |',
                '',
                '`inline_code()`',
                '',
                '---'
            ].join('\n'));
            const expandedSync = await editorPage.waitForFunction(() => {
                const value = document.getElementById('JournalText').value;
                return value.includes('[h2]Route notes[/h2]')
                    && value.includes('[blockquote]Windy [s]retreat[/s].[/blockquote]')
                    && value.includes('[table border="1"]')
                    && value.includes('[code]inline_code()[/code]')
                    && value.endsWith('[hr]');
            }, null, { timeout: 5000 }).then(() => true).catch(() => false);
            check(expandedSync, `expanded Markdown did not reach JournalText (value=${
                JSON.stringify(await editorPage.evaluate(() => document.getElementById('JournalText').value))})`);
            await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Preview', exact: true }).click();
            const expandedPreview = await editorPage.evaluate(() => {
                const preview = document.querySelector('.bpb-re-preview');
                return ['H2', 'BLOCKQUOTE', 'TABLE', 'S', 'CODE', 'HR']
                    .every(tag => preview.querySelector(tag));
            });
            check(expandedPreview, 'expanded Markdown preview omitted a supported semantic element');
            if (process.env.BPB_VERIFY_EDITOR_SCREENSHOT) {
                await editorPage.locator('#bpb-report-editor').screenshot({
                    path: process.env.BPB_VERIFY_EDITOR_SCREENSHOT
                });
            }
            if (process.env.BPB_VERIFY_EDITOR_RICH_SCREENSHOT) {
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Rich text', exact: true
                }).click();
                await editorPage.locator('#bpb-report-editor').screenshot({
                    path: process.env.BPB_VERIFY_EDITOR_RICH_SCREENSHOT
                });
            }
            check(editorErrors.length === 0, `the editor page threw: ${JSON.stringify(editorErrors)}`);
        }
        await editorPage.close();
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
console.log('  - the 3D toggle stays visible when disabled and opens the provider/privacy confirmation');
console.log('  - trusted confirmation persists the feature gate without contacting tile providers');
console.log('  - the Full Screen BigMap receives settings and shows an enabled 3D toggle');
console.log('  - the Peak Dynamic Map preserves its native frame and shows an enabled 3D toggle');
console.log('  - clicking Peak 3D creates the isolated frame with a route-free summit focus');
console.log('  - the trip-report editor mounts on the captured ascent form, real typing and');
console.log('    Ctrl/Cmd+B sync bracket markup into JournalText, markdown mode + preview');
console.log('    convert headings, quotes, tables, strike, code, and rules, and a reloaded');
console.log('    page offers and restores the draft');
