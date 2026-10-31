// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, chrome, getComputedStyle, innerWidth, scrollY, Image, Event, location */
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createFixtureCertificate, createBrowserFixtureServer, waitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { snowMapDocument, snowMapDem } from './verify-snow-map-fixture.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { setFirefoxContentViewport } from './firefox-content-viewport.mjs';
import { snowDepthCatalogue, snowDepthLegend } from '../test/helpers/snow-depth-fixture.mjs';

const [kind, ...args] = process.argv.slice(2);
assert.ok(['chrome', 'firefox'].includes(kind) && !args.length, 'Usage: node scripts/verify-snow-depth.mjs chrome|firefox');
const output = process.env.BPB_VERIFY_SNOW_DEPTH_SCREENSHOT_DIR;
const resources = createResourceStack(); let failure, diagnostics;
try {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-snow-depth-'));
    console.log(`Snow depth disposable root: ${temporaryRoot}`);
    resources.defer('snow depth profiles', () => rm(temporaryRoot, { recursive: true, force: true }));
    const nativeHTML = (await snowMapDocument()).replace('</script></body>', 'window.L_FIX=L.tileLayer(new URLSearchParams(location.search).get(\'base\'),{crossOrigin:true,referrerPolicy:\'no-referrer\',maxNativeZoom:11}).addTo(mapsPlaceholder);</script></body>');
    const fixture = await createBrowserFixtureServer({ temporaryRoot, masterMapDocument: nativeHTML,
        bigMapDocument: '<!doctype html><style>body{margin:0;font:14px system-ui}h1,h2{margin:8px}iframe{display:block;width:100%;height:650px;border:0}</style><h1 id="heading">Peakbagger map</h1><iframe id="if"></iframe><h2 id="following">Following native content</h2><script>document.getElementById("if").src="/map/MasterMap.aspx?t=A&d=2296&base="+encodeURIComponent(new URLSearchParams(location.search).get("base"));</script>' });
    resources.defer('snow depth HTTPS fixture', () => fixture.close());
    const certRoot = path.join(temporaryRoot, 'provider'); await mkdir(certRoot);
    const certificate = await createFixtureCertificate({ directory: certRoot }); resources.defer('snow provider certificate', () => certificate.remove());
    let png, basePNG, mode = 'ready'; const held = [], requests = [], origins = new Set();
    const release = value => { mode = value; held.splice(0).forEach(resolve => resolve()); };
    resources.defer('snow held tiles', () => release('ready'));
    const provider = createServer(certificate, async (request, response) => {
        const url = new URL(request.url, 'https://snow.example.com');
        requests.push(url); origins.add(request.headers.origin);
        assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.referer, undefined);
        const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
        if (url.pathname.endsWith('/query')) {
            assert.equal(url.searchParams.get('outFields'), 'idp_validtime');
            response.writeHead(200, { ...headers, 'content-type': 'application/json' }); response.end(JSON.stringify(snowDepthCatalogue())); return;
        }
        if (url.pathname.endsWith('/legend')) {
            response.writeHead(200, { ...headers, 'content-type': 'application/json' }); response.end(JSON.stringify(snowDepthLegend())); return;
        }
        assert.ok(url.pathname.endsWith('/export')); assert.equal(url.searchParams.get('layers'), 'show:3');
        assert.equal(url.searchParams.get('transparent'), 'true'); assert.equal(url.searchParams.get('bboxSR'), '3857');
        if (mode === 'hold') await new Promise(resolve => held.push(resolve));
        if (mode === 'error') { response.writeHead(404, headers); response.end(); return; }
        response.writeHead(200, { ...headers, 'content-type': 'image/png' }); response.end(png);
    });
    resources.defer('snow provider server', () => closeServer(provider)); await listenServer(provider, 0, '127.0.0.1');
    const providerOrigin = `https://snow.example.com:${provider.address().port}`, origin = `https://www.peakbagger.com:${fixture.port}`;
    const source = path.join(temporaryRoot, 'extension'); await cp(path.resolve('dist'), source, { recursive: true });
    // Only the fixed NOAA origin is redirected to controlled HTTPS responses.
    // All shipped state, controls, rendering, manifest and bridge code remain.
    for (const file of ['content/map-layers.js', 'terrain/terrain-frame.js']) {
        const filename = path.join(source, file), text = await readFile(filename, 'utf8');
        assert.ok(text.includes('https://mapservices.weather.noaa.gov'));
        let transformed = text.replaceAll('https://mapservices.weather.noaa.gov', providerOrigin);
        if (file === 'terrain/terrain-frame.js') {
            assert.ok(transformed.includes('startTerrainFrame(maplibre);'));
            transformed = transformed.replace('startTerrainFrame(maplibre);', 'startTerrainFrame({ ...maplibre, Map: new Proxy(maplibre.Map, { construct(Target, args, NewTarget) { const map = Reflect.construct(Target, args, NewTarget); globalThis.__snowDepthTestMap = map; return map; } }) });');
        }
        await writeFile(filename, transformed);
    }
    let evaluate, admin, click, key, viewport, screenshot, terrain, version, navigate;
    if (kind === 'chrome') {
        const trust = '--ignore-certificate-errors-spki-list=' + [fixture, certificate].map(item => item.chromeTrustArgs[0].split('=').slice(1).join('=')).join(',');
        assertChromeLaunchAllowed();
        const context = await chromium.launchPersistentContext(path.join(temporaryRoot, 'profile'), { channel: 'chromium', headless: true,
            viewport: { width: 1440, height: 1000 }, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            args: [trust, '--no-proxy-server', '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1,MAP snow.example.com 127.0.0.1', `--load-extension=${source}`, `--disable-extensions-except=${source}`] });
        resources.defer('snow Chrome', () => context.close());
        await context.route('https://tiles.mapterhorn.com/**', route => route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: snowMapDem }));
        await context.route('https://base.example.com/**', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: basePNG }));
        const options = await context.newPage(); await options.goto('chrome://extensions-internals/');
        const extension = await options.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
        await options.goto(`chrome-extension://${extension.id}/options/options.html`);
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        diagnostics = async () => ({ errors: errors.slice(-6), state: await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 500), controls: [...document.querySelectorAll('.bpb-map-layers')].map(el => ({ hidden: el.hidden, style: el.getAttribute('style') })), frames: [...document.querySelectorAll('iframe')].map(el => ({ src: el.src, text: el.contentDocument?.body?.innerText.slice(0, 300), leaflet: typeof el.contentWindow?.L, map: !!el.contentWindow?.mapsPlaceholder })) })) });
        evaluate = (fn, arg) => page.evaluate(fn, arg); admin = (fn, arg) => options.evaluate(fn, arg);
        click = selector => page.locator(selector).click(); key = (selector, value) => page.locator(selector).press(value);
        viewport = size => page.setViewportSize(size); navigate = url => page.goto(url);
        screenshot = file => page.screenshot(file ? { path: file } : {});
        terrain = async fn => { const frame = await page.locator('#bpb-terrain-frame').elementHandle(); return (await frame.contentFrame()).evaluate(fn); };
        version = context.browser().version();
    } else {
        const { Builder, By, Key } = await import('selenium-webdriver'), firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot, distDir: source }); resources.defer('snow Firefox source', () => prepared.cleanup());
        resources.defer('snow Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
        const profile = path.join(temporaryRoot, 'profile'); await mkdir(profile);
        const options = new firefox.Options().addArguments('-headless').enableBidi().setProfile(profile).setAcceptInsecureCerts(true)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,snow.example.com').setPreference('network.proxy.type', 0)
            .setPreference('webgl.sanitize-unmasked-renderer', false).setPreference('webgl.disable-angle', false);
        if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
            .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`)).build();
        resources.defer('snow Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        const optionsURL = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        await driver.setContext(firefox.Context.CONTENT); await driver.get(optionsURL); const optionsHandle = await driver.getWindowHandle();
        await driver.switchTo().newWindow('tab'); const mapHandle = await driver.getWindowHandle();
        evaluate = (fn, arg) => driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null);
        admin = async (fn, arg) => { await driver.switchTo().window(optionsHandle); try { return await evaluate(fn, arg); } finally { await driver.switchTo().window(mapHandle); } };
        click = async selector => (await driver.findElement(By.css(selector))).click();
        key = async (selector, value) => (await driver.findElement(By.css(selector))).sendKeys(value === 'Space' ? Key.SPACE : Key.ENTER);
        viewport = size => setFirefoxContentViewport(driver, size); navigate = url => driver.get(url);
        screenshot = async file => { const data = Buffer.from(await driver.takeScreenshot(), 'base64'); if (file) await writeFile(file, data); return data; };
        terrain = async fn => { await driver.switchTo().frame(await driver.findElement(By.id('bpb-terrain-frame'))); try { return await evaluate(fn); } finally { await driver.switchTo().defaultContent(); } };
        const bidi = await driver.getBidi(); await bidi.subscribe('network.beforeRequestSent');
        const intercept = event => {
            if (!event.isBlocked || !/^https:\/\/(?:tiles\.mapterhorn\.com|base\.example\.com)\//.test(event.request.url)) return;
            const base = event.request.url.startsWith('https://base.example.com/');
            void bidi.send({ method: 'network.provideResponse', params: { request: event.request.request, statusCode: 200,
                headers: [{ name: 'content-type', value: { type: 'string', value: base ? 'image/png' : 'image/webp' } }, { name: 'access-control-allow-origin', value: { type: 'string', value: '*' } }], body: { type: 'base64', value: (base ? basePNG : snowMapDem).toString('base64') } } });
        };
        bidi.on('network.beforeRequestSent', intercept); resources.defer('snow Firefox listener', () => bidi.off('network.beforeRequestSent', intercept));
        await bidi.send({ method: 'network.addIntercept', params: { phases: ['beforeRequestSent'], urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'tiles.mapterhorn.com' }, { type: 'pattern', protocol: 'https', hostname: 'base.example.com' }] } });
        version = (await driver.getCapabilities()).getBrowserVersion();
    }
    const wait = (read, description) => waitForCondition(read, { description, timeoutMs: 30000 });
    const patch = update => admin(async patch => (globalThis.browser || chrome).runtime.sendMessage({ type: 'SETTINGS_PATCH', patch }), update);
    await patch({ enable3dMap: true, showWeather: false, showSnotel: false, showSunMoon: false, terrainCacheLimitMb: 0, theme: 'light' });
    png = Buffer.from(await admin(() => { const c = document.createElement('canvas'); c.width = c.height = 256; const ctx = c.getContext('2d'); ctx.fillStyle = '#2875d0'; ctx.fillRect(64, 0, 192, 256); return c.toDataURL().split(',')[1]; }), 'base64');
    basePNG = Buffer.from(await admin(() => { const c = document.createElement('canvas'); c.width = c.height = 256; const ctx = c.getContext('2d'); ctx.fillStyle = '#e5e5e5'; ctx.fillRect(0, 0, 256, 256); return c.toDataURL().split(',')[1]; }), 'base64');
    await navigate(`${origin}/map/BigMap.aspx?t=A&d=2296&c=900001&base=${encodeURIComponent('https://base.example.com/{z}/{x}/{y}.png')}`);
    await wait(() => evaluate(() => !!document.querySelector('.bpb-layers-trigger') && !document.querySelector('.bpb-map-layers').hidden), 'shipped Overlays control');
    await click('.bpb-layers-trigger'); await click('[data-layer="snow"] .bpb-layers-disclosure');
    assert.equal(requests.length, 0, 'opening controls does not contact NOAA');
    const checkbox = '[data-layer="snow"] input', retry = '[data-overlay="snow"] .bpb-layers-retry';
    const geometry = () => evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        return { trigger: rect('.bpb-layers-trigger'), action: rect('[data-overlay="snow"] .bpb-layers-retry'), heading: rect('#heading'), following: rect('#following'), scrollY };
    });
    const stable = (a, b, label) => {
        for (const key of ['trigger', 'action', 'heading', 'following']) for (const dimension of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[key][dimension] - b[key][dimension]) <= 1, `${label}: ${key}.${dimension} ${JSON.stringify({ a, b })}`);
        assert.equal(a.scrollY, b.scrollY, `${label}: reading position`);
    };
    let inTerrain = false;
    const settle = async () => {
        if (inTerrain) {
            const expected = await evaluate(() => document.querySelector('[data-layer="snow"] input').checked ? Number(document.querySelector('[aria-label="Snow depth opacity"]').value) / 100 : null);
            await waitForCondition(() => terrain(() => { const map = globalThis.__snowDepthTestMap, layer = map.getStyle().layers.find(layer => layer.id.startsWith('bpb-overlay-snow-')); return layer ? map.getPaintProperty(layer.id, 'raster-opacity') : null; }), { description: 'terrain accepts snow opacity '+expected, timeoutMs: 30000, isReady: value => value === expected });
            await terrain(() => new Promise(resolve => { const map = globalThis.__snowDepthTestMap; map.once('idle', () => resolve(null)); map.triggerRepaint(); }));
        }
        else await wait(() => evaluate(() => { const win = document.getElementById('if').contentWindow; return [...win.document.querySelectorAll('.leaflet-bpb-overlay-snow-pane canvas')].every(tile => win.getComputedStyle(tile).opacity === '1'); }), 'Leaflet tile fades finished');
    };
    const painted = async () => evaluate(async data => {
        const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0, score = 0;
        const active3d = document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'true';
        const area = document.querySelector(active3d ? '#bpb-terrain-frame' : '#if').getBoundingClientRect();
        const masks = [...document.querySelectorAll('.bpb-map-layers,.bpb-layers-panel')].map(el => el.getBoundingClientRect());
        const scale = canvas.width / innerWidth;
        for (let i = 0; i < pixels.length; i += 4) {
            const x = (i / 4 % canvas.width) / scale, y = Math.floor(i / 4 / canvas.width) / scale;
            if (x < area.left || x >= area.right || y < area.top || y >= area.bottom || masks.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) continue;
            if (pixels[i + 2] > pixels[i + 1] + 8 && pixels[i + 2] > pixels[i] + 20) { count++; score += pixels[i + 2] - pixels[i]; }
        }
        return { count, score };
    }, (await screenshot()).toString('base64'));
    const changedPixels = async (first, second) => evaluate(async ({ first, second }) => {
        const images = await Promise.all([first, second].map(async data => { const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode(); return img; }));
        const canvas = document.createElement('canvas'); canvas.width = images[0].width; canvas.height = images[0].height; const ctx = canvas.getContext('2d');
        ctx.drawImage(images[0], 0, 0); const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(images[1], 0, 0); const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const active3d = document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'true', area = document.querySelector(active3d ? '#bpb-terrain-frame' : '#if').getBoundingClientRect();
        const masks = [...document.querySelectorAll('.bpb-map-layers,.bpb-layers-panel')].map(el => el.getBoundingClientRect()), scale = canvas.width / innerWidth; let changed = 0, total = 0;
        for (let i = 0; i < a.length; i += 4) { const x = (i / 4 % canvas.width) / scale, y = Math.floor(i / 4 / canvas.width) / scale;
            if (x < area.left || x >= area.right || y < area.top || y >= area.bottom || masks.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) continue;
            total++; if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 15) changed++;
        }
        return { changed, total, ratio: changed / total };
    }, { first: first.toString('base64'), second: second.toString('base64') });
    const waitPainted = () => waitForCondition(painted, { description: 'snow pixels actually painted', timeoutMs: 30000, isReady: value => value.count > 1000 });
    const ready = () => wait(() => evaluate(() => document.querySelector('[data-layer="snow"] .bpb-layers-value')?.hidden === false), 'snow tiles and metadata finish');
    const rowStatus = text => wait(() => evaluate(value => document.querySelector('[data-layer="snow"] .bpb-layers-row-status')?.textContent === value, text), `snow ${text}`);
    release('hold'); await key(checkbox, 'Space'); await rowStatus('Loading'); await wait(() => held.length > 0, 'held initial depth tiles');
    release('error'); await rowStatus('Couldn’t load');
    const original = await geometry();
    await evaluate(selector => document.querySelector(selector).focus(), retry); release('hold'); await key(retry, 'Enter'); await rowStatus('Loading');
    stable(original, await geometry(), 'error → retry pending');
    const catalogueRequests = () => requests.filter(url => url.pathname.endsWith('/query')).length;
    const busyRequests = catalogueRequests(); await key(retry, 'Enter'); assert.equal(catalogueRequests(), busyRequests, 'busy keyboard activation cannot duplicate catalogue reads');
    release('ready'); await ready(); stable(original, await geometry(), 'retry → success');
    assert.equal(await evaluate(selector => document.activeElement === document.querySelector(selector), retry), true, 'Refresh retains keyboard focus');
    assert.equal(await evaluate(() => document.querySelector('.bpb-snow-depth-time').title), '2026-10-30T00:00:00.000Z');
    assert.match(await evaluate(() => document.querySelector('[data-overlay="snow"] .bpb-layers-legend').textContent), /0–0.39 in/);
    let cases = 1, renderer;
    for (const dimension of ['2d', '3d']) {
        if (dimension === '3d') {
            await wait(() => evaluate(() => document.getElementById('bpb-terrain-toggle')?.disabled === false), 'terrain available');
            await click('#bpb-terrain-toggle');
            await wait(() => evaluate(() => document.getElementById('bpb-terrain-toggle')?.getAttribute('aria-pressed') === 'true'), 'terrain active');
            await ready(); inTerrain = true; await settle();
            await wait(() => terrain(() => !!globalThis.__snowDepthTestMap.getSource('basemap')), 'snow retains the native basemap drape');
            renderer = await terrain(() => { const gl = document.querySelector('canvas.maplibregl-canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
            assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
            release('error'); await key(checkbox, 'Space'); await settle(); await key(checkbox, 'Space'); await rowStatus('Couldn’t load');
            const beforeRetry = await geometry(); release('hold'); await key(retry, 'Enter'); await rowStatus('Loading');
            await wait(() => held.length > 0, '3D retry reaches the tile provider'); stable(beforeRetry, await geometry(), '3D retry pending');
            release('ready'); await ready(); await settle(); await waitPainted(); stable(beforeRetry, await geometry(), '3D retry finishes');
            assert.equal(await evaluate(selector => document.activeElement === document.querySelector(selector), retry), true, '3D retry retains focus');
            const sourceSpec = await terrain(() => { const map = globalThis.__snowDepthTestMap, layer = map.getStyle().layers.find(layer => layer.id.startsWith('bpb-overlay-snow-')); return { maxzoom: map.getStyle().sources[layer.source].maxzoom, sampling: map.getPaintProperty(layer.id, 'raster-resampling') }; });
            assert.equal(sourceSpec.maxzoom, 11); assert.equal(sourceSpec.sampling, 'nearest');
        }
        for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
            console.log(`Snow depth ${kind}: ${dimension} ${width}px ${theme}`);
            await viewport({ width, height: 1000 });
            await evaluate(value => { document.documentElement.dataset.bpbTheme = value; const doc = document.getElementById('if')?.contentDocument; if (doc) doc.documentElement.dataset.bpbTheme = value; }, theme);
            await wait(() => evaluate(value => document.documentElement.dataset.bpbTheme === value, theme), `${theme} theme`);
            await ready();
            await evaluate(() => { const slider = document.querySelector('[aria-label="Snow depth opacity"]'); slider.value = '60'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
            await settle();
            await waitPainted(); const solid = await screenshot();
            await evaluate(() => { const slider = document.querySelector('[aria-label="Snow depth opacity"]'); slider.focus(); slider.value = '30'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
            await ready(); await settle();
            await waitForCondition(async () => changedPixels(solid, await screenshot()), { description: '30 percent changes painted map pixels', timeoutMs: 30000, isReady: value => value.ratio > .01 });
            if (output) { await mkdir(output, { recursive: true }); await screenshot(path.join(output, `snow-depth-${kind}-${dimension}-${width}-${theme}.png`)); }
            const fit = await evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, legend: getComputedStyle(document.querySelector('[data-overlay="snow"] .bpb-layers-legend')).color }));
            assert.equal(fit.overflow, false); assert.equal(fit.width, width);
            const enabledPixels = await screenshot();
            await key(checkbox, 'Space'); await wait(() => evaluate(() => document.querySelector('[data-layer="snow"] input').checked === false), 'snow off'); await settle();
            await waitForCondition(async () => changedPixels(enabledPixels, await screenshot()), { description: 'snow off visibly restores the basemap', timeoutMs: 30000, isReady: value => value.ratio > .01 });
            await key(checkbox, 'Space'); await ready(); await settle(); await waitPainted(); cases++;
        }
        await evaluate(selector => { document.querySelector('.bpb-map-layers').style.fontSize = '26px'; document.querySelector(selector).scrollIntoView({ block: 'nearest' }); document.querySelector(selector).focus({ preventScroll: true }); }, retry);
        const enlarged = await geometry(); release('hold'); await key(retry, 'Enter'); await rowStatus('Loading');
        stable(enlarged, await geometry(), dimension+' 200% text pending');
        release('ready'); await ready(); await settle(); stable(enlarged, await geometry(), dimension+' 200% text success');
        // The old overflow was reproduced in Chrome. Firefox uses different
        // font metrics; it must fit the fixed layout without inventing a failure.
        if (kind === 'chrome' && dimension === '2d') {
            await evaluate(() => { const header = document.querySelector('.bpb-custom-header'); header.style.flexWrap = 'nowrap'; });
            assert.equal(await evaluate(() => { const panel = document.querySelector('.bpb-layers-panel'); return panel.scrollWidth > panel.clientWidth; }), true, 'the enlarged-layout assertion detects the historical footer overflow');
            await evaluate(() => { document.querySelector('.bpb-custom-header').style.flexWrap = ''; });
        }
        if (output) await screenshot(path.join(output, `snow-depth-${kind}-${dimension}-375-dark-200pct.png`));
        const enlargedFit = await evaluate(() => { const panel = document.querySelector('.bpb-layers-panel'); return { panelScroll: panel.scrollWidth, panelWidth: panel.clientWidth, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, overflowing: [...panel.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > panel.getBoundingClientRect().right + 1).map(el => ({ tag: el.tagName, className: el.className, width: el.getBoundingClientRect().width, text: el.textContent.slice(0, 60) })).slice(0, 8) }; });
        assert.ok(enlargedFit.panelScroll <= enlargedFit.panelWidth && enlargedFit.documentWidth <= enlargedFit.viewport, 'enlarged snow details wrap: '+JSON.stringify(enlargedFit));
        assert.equal(await evaluate(() => { const text = document.querySelector('[data-overlay="snow"] .bpb-layers-feedback > span').firstChild; if (!text) return true; return [...text.textContent.matchAll(/\S+/g)].every(match => { const range = document.createRange(); range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length); return range.getClientRects().length === 1; }); }), true, 'enlarged feedback wraps between words');
        await evaluate(() => { document.querySelector('.bpb-map-layers').style.fontSize = ''; }); cases++;
    }
    assert.ok(origins.has(origin) && [...origins].some(value => /^(?:chrome|moz)-extension:\/\//.test(value)), 'real page and extension origins both reach the CORS provider');
    assert.ok(cases > 1);
    console.log(JSON.stringify({ verification: 'snow-depth', browser: kind, version, hidden: true, renderer, cases, viewports: ['1440x1000', '375x1000'], requests: requests.length, proof: 'real extension; fixture NOAA replies and synthetic DEM; stable keyboard retry and native content' }));
} catch (error) { failure = error; if (diagnostics) console.error(JSON.stringify(await diagnostics())); } finally { await resources.dispose(failure); }
