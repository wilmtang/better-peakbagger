// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, chrome, scrollY, innerWidth, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
import { chromium } from 'playwright';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createBrowserFixtureServer, createFixtureCertificate } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';
import { snowMapDocument, snowMapDem } from './verify-snow-map-fixture.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';

const firefoxMode = process.argv[2] === '--firefox';
assert.ok(process.argv.length === 2 || process.argv.length === 3 && firefoxMode, 'Usage: node scripts/verify-custom-overlays.mjs [--firefox]');
const resources = createResourceStack(); let failure, failurePage, diagnostics;
try {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-custom-verify-'));
    resources.defer('custom temporary profile', () => rm(temporaryRoot, { recursive: true, force: true }));
    const nativeHtml = (await snowMapDocument()).replace('</script></body>', "mapsPlaceholder.eachLayer(layer=>{if(layer instanceof L.Polyline && !(layer instanceof L.Polygon))layer.on('mouseover',()=>{}).on('click',()=>{}).bindPopup('Native route');});</script></body>");
    const fixture = await createBrowserFixtureServer({ temporaryRoot, masterMapDocument: nativeHtml, peakMapDocument: nativeHtml }); resources.defer('custom HTTPS fixture', () => fixture.close());
    const providerDirectory = path.join(temporaryRoot, 'provider'); await mkdir(providerDirectory);
    const certificate = await createFixtureCertificate({ directory: providerDirectory }); resources.defer('provider certificate', () => certificate.remove());
    const requests = [], origins = new Set(), releases = [], networkErrors = []; let denied = false, held = false, png;
    const mvt = Buffer.from(fromGeojsonVt({ trails: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] } }, { version: 2, extent: 4096 }));
    const provider = createServer({ key: certificate.key, cert: certificate.cert }, async (request, response) => {
        requests.push(request.url); origins.add(request.headers.origin);
        assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.referer, undefined);
        if (held) await new Promise(resolve => releases.push(resolve));
        const geo = request.url.endsWith('.geojson'), vector = request.url.endsWith('.pbf');
        response.writeHead(200, { 'content-type': geo ? 'application/geo+json' : vector ? 'application/vnd.mapbox-vector-tile' : 'image/png', 'cache-control': 'no-store', ...denied ? {} : { 'access-control-allow-origin': '*' } });
        response.end(geo ? JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-122, 46], [-121, 46], [-121, 48], [-122, 48], [-122, 46]]] } }] }) : vector ? mvt : png);
    });
    resources.defer('custom provider', () => closeServer(provider)); await listenServer(provider, 0, '127.0.0.1');
    const providerOrigin = `https://tiles.example.com:${provider.address().port}`;
    diagnostics = () => ({ requests: requests.slice(-10), origins: [...origins], providerOrigin, networkErrors: networkErrors.slice(-10) });
    const dist = path.resolve('dist'), origin = `https://www.peakbagger.com:${fixture.port}`;
    resources.defer('custom held replies', () => releases.splice(0).forEach(resolve => resolve()));
    if (firefoxMode) {
        await verifyFirefox({ resources, temporaryRoot, origin, providerOrigin, setPng: value => { png = value; }, deny: value => { denied = value; }, requests, origins });
    } else {
        const trust = '--ignore-certificate-errors-spki-list=' + [fixture, certificate].flatMap(item => item.chromeTrustArgs.map(argument => argument.split('=').slice(1).join('='))).join(',');
        assertChromeLaunchAllowed();
        const browser = await chromium.launchPersistentContext(temporaryRoot, { channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
            ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], args: [trust, '--no-proxy-server', '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1,MAP tiles.example.com 127.0.0.1', `--load-extension=${dist}`, `--disable-extensions-except=${dist}`] });
        resources.defer('custom Chromium', () => browser.close());
        const page = failurePage = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => { if (request.url().includes('tiles.example.com')) networkErrors.push({ url: request.url(), error: request.failure() }); });
        page.on('console', message => { if (message.type() === 'error' && message.text().includes('tiles.example.com')) networkErrors.push(message.text()); });
        await browser.route('https://tiles.mapterhorn.com/**', route => route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: snowMapDem }));
        const admin = await browser.newPage(); await admin.goto('chrome://extensions-internals/');
        const extension = await admin.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
        await admin.goto(`chrome-extension://${extension.id}/options/options.html`);
        await admin.evaluate(async () => chrome.storage.sync.set({ bpbSettings: { showSnotel: false, showWeather: false, showSunMoon: false, enable3dMap: true, terrainCacheLimitMb: 0 } }));
        await page.goto(`${origin}/map/MasterMap.aspx?t=G&gt=rc`);
        await page.getByRole('button', { name: /^Overlays/ }).click();
        await page.getByRole('button', { name: 'Add custom overlay', exact: true }).click();
        const editor = page.frameLocator('iframe[title="Custom map overlays"]');
        await editor.locator('#name').fill('Custom raster'); await editor.locator('#url').fill(`${providerOrigin}/{z}/{x}/{y}.png`);
        png = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256; const context = canvas.getContext('2d'); context.fillStyle = '#ef2719'; context.fillRect(0, 0, 256, 256); return canvas.toDataURL().split(',')[1]; }), 'base64');
        resources.defer('custom held replies', () => releases.splice(0).forEach(resolve => resolve()));
        await editor.locator('#preview').click(); await editor.locator('#feedback').filter({ hasText: 'Preview enabled' }).waitFor();
        await editor.locator('#test').click(); await editor.locator('#feedback').filter({ hasText: 'Other zooms and locations remain unchecked' }).waitFor();
        await editor.locator('#save').click(); await editor.locator('#feedback').filter({ hasText: 'Saved on this device' }).waitFor();
        await editor.locator('#cancel').click();
        const raster = page.getByRole('checkbox', { name: 'Custom raster', exact: true }); await raster.check();
        await page.waitForFunction(() => [...document.querySelectorAll('.bpb-custom-source summary')].some(element => element.textContent.includes('Custom raster') && element.textContent.includes('60%')));
        assert.ok(requests.length > 0, 'enabled raster fetches directly');
        const nativePaint = await page.evaluate(() => Object.values(window.mapsPlaceholder._layers).filter(layer => layer.options?.pane === 'bpb-custom-overlays').flatMap(layer => Object.values(layer._tiles || {}).map(tile => [...tile.el.getContext('2d').getImageData(128, 128, 1, 1).data])));
        assert.ok(nativePaint.some(pixel => pixel[0] > 200 && pixel[3] > 0), 'custom raster actually painted');
        await raster.uncheck(); const stopped = requests.length;
        for (const [name, kind, url] of [['Custom polygons', 'geojson', `${providerOrigin}/data.geojson`], ['Custom MVT', 'mvt', `${providerOrigin}/{z}/{x}/{y}.pbf`]]) {
            await page.getByRole('button', { name: 'Add custom overlay', exact: true }).click();
            await editor.locator('#name').fill(name); await editor.locator('#kind').selectOption(kind); await editor.locator('#url').fill(url);
            if (kind === 'mvt') await editor.locator('[id$="-sourceLayer"]').fill('trails');
            await editor.locator('[id$="-geometry"]').selectOption('polygon');
            await editor.locator('#save').click(); await editor.locator('#feedback').filter({ hasText: 'Saved on this device' }).waitFor(); await editor.locator('#cancel').click();
            await page.getByRole('checkbox', { name, exact: true }).check();
            await page.waitForFunction(name => [...document.querySelectorAll('.bpb-custom-source summary')].some(element => element.textContent.includes(name) && element.textContent.includes('60%')), name);
        }
        assert.ok(requests.length > stopped, 'vector requests loaded through packaged workers');
        denied = true;
        const mvtRow = page.locator('.bpb-custom-source').filter({ hasText: 'Custom MVT' }); await mvtRow.locator('summary').first().click();
        await mvtRow.getByRole('button', { name: 'Retry', exact: true }).click();
        await mvtRow.locator('.bpb-custom-feedback').filter({ hasText: /Check the URL and the provider/ }).waitFor();
        denied = false; held = true;
        const retry = mvtRow.getByRole('button', { name: 'Retry', exact: true }); const before = await retry.boundingBox();
        await retry.click(); await page.waitForFunction(() => [...document.querySelectorAll('.bpb-custom-source summary')].some(element => element.textContent.includes('Custom MVT') && element.textContent.includes('Loading')));
        const during = await retry.boundingBox(); assert.ok(Math.abs(before.y - during.y) <= 1, 'Retry stays anchored while pending');
        held = false; releases.splice(0).forEach(resolve => resolve());
        await page.waitForFunction(() => [...document.querySelectorAll('.bpb-custom-source summary')].some(element => element.textContent.includes('Custom MVT') && element.textContent.includes('60%')));
        assert.deepEqual(errors, []);
        const screenshots = process.env.BPB_CUSTOM_SCREENSHOTS;
        await admin.goto(`chrome-extension://${extension.id}/options/options.html#custom-map-layers`);
        const library = admin.locator('#custom-layer-list'); await library.locator('li').nth(2).waitFor();
        assert.equal(await library.locator('li').count(), 3, 'central Options manager shows the shared library');
        if (process.env.BPB_PREVIOUS_PANEL_CSS) {
            const original = await readFile(process.env.BPB_PREVIOUS_PANEL_CSS, 'utf8');
            await admin.evaluate(() => { document.querySelector('link[href$="panel.css"]').disabled = true; });
            const prior = await admin.addStyleTag({ content: original });
            const old = await admin.evaluate(() => ({ root: getComputedStyle(document.documentElement).overscrollBehaviorY,
                content: getComputedStyle(document.querySelector('.content')).overscrollBehaviorY, canvas: getComputedStyle(document.documentElement).backgroundColor }));
            assert.equal(old.root, 'auto'); assert.equal(old.content, 'auto'); assert.equal(old.canvas, 'rgba(0, 0, 0, 0)', 'previous CSS reproduces the exposed unthemed root');
            await prior.evaluate(element => element.remove()); await admin.evaluate(() => { document.querySelector('link[href$="panel.css"]').disabled = false; });
        }
        await admin.setViewportSize({ width: 375, height: 800 }); await admin.evaluate(() => document.documentElement.dataset.bpbTheme = 'dark');
        await admin.locator('#custom-layer-add').click();
        const optionsEditor = admin.frameLocator('#custom-layer-dialog iframe');
        await optionsEditor.locator('#name').fill('Temporary options layer'); await optionsEditor.locator('#url').fill(`${providerOrigin}/{z}/{x}/{y}.png`);
        assert.equal(await optionsEditor.locator('#library button').count(), 0, 'embedded editor shows only the source form');
        if (screenshots) { await mkdir(screenshots, { recursive: true }); await admin.screenshot({ path: path.join(screenshots, 'custom-options-editor-dark.png') }); }
        await optionsEditor.locator('#save').click(); await optionsEditor.locator('#feedback').filter({ hasText: 'Saved on this device' }).waitFor();
        await optionsEditor.locator('#cancel').click();
        const temporary = library.locator('li').filter({ hasText: 'Temporary options layer' }); await temporary.getByRole('button', { name: 'Remove', exact: true }).click();
        await temporary.getByRole('button', { name: 'Keep layer', exact: true }).click();
        await temporary.getByRole('button', { name: 'Remove', exact: true }).click();
        await admin.evaluate(() => { const send = chrome.runtime.sendMessage.bind(chrome.runtime); chrome.runtime.sendMessage = async (...args) => { if (args[0]?.type === 'CUSTOM_OVERLAYS_REMOVE') { chrome.runtime.sendMessage = send; await new Promise(resolve => { window.releaseLayerRemove = resolve; }); } return send(...args); }; });
        const remove = temporary.getByRole('button', { name: 'Remove layer', exact: true }), bounds = await remove.boundingBox();
        await remove.click(); await admin.waitForFunction(() => document.querySelector('#custom-layer-list li:last-child .custom-layer-remove button').getAttribute('aria-disabled') === 'true');
        const pendingBounds = await remove.boundingBox(); for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(bounds[key] - pendingBounds[key]) <= 1, `layer removal keeps ${key} anchored`);
        await admin.evaluate(() => window.releaseLayerRemove());
        await temporary.waitFor({ state: 'detached' });
        for (const [width, theme] of [[1000, 'light'], [375, 'dark']]) {
            await admin.setViewportSize({ width, height: 800 });
            await admin.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            await admin.locator('#custom-map-layers').scrollIntoViewIfNeeded();
            const policy = await admin.evaluate(() => ({ background: getComputedStyle(document.documentElement).backgroundColor,
                root: getComputedStyle(document.documentElement).overscrollBehaviorY, content: getComputedStyle(document.querySelector('.content')).overscrollBehaviorY,
                sidebar: getComputedStyle(document.querySelector('.side-nav')).overscrollBehaviorY }));
            assert.equal(policy.root, 'none'); assert.equal(policy.content, 'none'); assert.equal(policy.sidebar, 'none');
            assert.ok(policy.background !== 'rgba(0, 0, 0, 0)', 'Options root canvas has a theme background');
            const scroller = admin.locator('.content');
            await scroller.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
            const top = await scroller.boundingBox(); await admin.mouse.move(top.x + top.width / 2, top.y + 30); await admin.mouse.wheel(0, -1200);
            assert.equal(await scroller.evaluate(element => element.scrollTop), 0, 'top boundary does not scroll the outer frame');
            await admin.mouse.wheel(0, 300); await admin.waitForFunction(() => document.querySelector('.content').scrollTop > 0);
            await scroller.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })); await admin.mouse.wheel(0, 1200);
            assert.ok(await scroller.evaluate(element => Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)) <= 1), 'bottom boundary remains clamped');
            assert.equal(await admin.evaluate(() => window.scrollY), 0, 'overscroll never chains into the root');
            await admin.locator('#custom-map-layers').scrollIntoViewIfNeeded();
            assert.ok(await admin.locator('#custom-map-layers').evaluate(element => element.scrollWidth <= element.clientWidth), 'central manager fits');
            if (screenshots) { await mkdir(screenshots, { recursive: true }); await admin.screenshot({ path: path.join(screenshots, `custom-options-${theme}.png`) }); }
        }
        const file = await admin.evaluate(async () => chrome.runtime.sendMessage({ type: 'SETTINGS_FILE_EXPORT' }));
        assert.equal(JSON.parse(file.content).customLayers.sources.length, 3, 'actual worker settings export includes layers');
        await admin.evaluate(async () => { const reply = await chrome.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET' }); const source = reply.registry.sources[0]; await chrome.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_REMOVE', id: source.id, expectedRevision: source.revision }); });
        await admin.locator('#settings-backup-file').setInputFiles({ name: 'restored-settings.json', mimeType: 'application/json', buffer: Buffer.from(file.content) });
        await admin.locator('#settings-backup-confirmation-detail').filter({ hasText: '3 saved layers' }).waitFor();
        await admin.locator('#settings-backup-confirm').click();
        await admin.locator('#settings-backup-confirmation').waitFor({ state: 'hidden' });
        await library.locator('li').nth(2).waitFor();
        await admin.setViewportSize({ width: 1000, height: 760 });
        if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, 'custom-map.png') }); }
        await page.getByRole('button', { name: 'Add custom overlay', exact: true }).click();
        await page.setViewportSize({ width: 375, height: 800 });
        if (screenshots) await page.screenshot({ path: path.join(screenshots, 'custom-editor-narrow.png') });
        assert.ok((await editor.locator('#save').boundingBox()).width > 50);
        await admin.evaluate(async target => { const tabs = await chrome.tabs.query({}); const tab = tabs.find(item => item.url === target); await chrome.tabs.setZoom(tab.id, 2); }, page.url());
        assert.ok(await editor.locator('#form').evaluate(form => form.scrollWidth <= form.clientWidth), 'editor fits at 200% browser zoom');
        const wordsFit = () => editor.locator('footer.actions').evaluate(footer => [...footer.querySelectorAll('button')].filter(button => button.getClientRects().length).every(button => {
            const text = button.firstChild;
            return [...text.textContent.matchAll(/\S+/g)].every(match => { const range = document.createRange(); range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length); return range.getClientRects().length === 1; });
        }));
        assert.ok(await wordsFit(), 'enlarged action labels never break inside words');
        await editor.locator('head').evaluate(head => { const style = document.createElement('style'); style.id = 'historical-footer'; style.textContent = '.actions button{padding:6px 12px;overflow-wrap:anywhere}'; head.append(style); });
        assert.equal(await wordsFit(), false, 'the assertion detects the historical enlarged-label regression');
        await editor.locator('#historical-footer').evaluate(style => style.remove()); assert.ok(await wordsFit());
        if (screenshots) await page.screenshot({ path: path.join(screenshots, 'custom-editor-zoom.png') });
        await admin.evaluate(async target => { const tabs = await chrome.tabs.query({}); const tab = tabs.find(item => item.url === target); await chrome.tabs.setZoom(tab.id, 1); }, page.url());
        await editor.locator('#cancel').click();
        await page.setViewportSize({ width: 1000, height: 760 });
        const surfaces = ['A','P','G','L','C','R','W','K','I','J','S','E','U','M','F'];
        for (const type of surfaces) {
            await page.goto(`${origin}/map/MasterMap.aspx?t=${type}&gt=rt`);
            await page.getByRole('button', { name: /^Overlays/ }).click();
            await page.getByRole('checkbox', { name: 'Custom raster', exact: true }).waitFor();
            assert.equal(await page.locator('.bpb-map-layers').count(), 1);
            assert.equal(await page.getByRole('checkbox', { name: 'Custom raster', exact: true }).isChecked(), false, 'unrelated maps start off');
            for (const name of ['Custom raster', 'Custom polygons', 'Custom MVT']) await page.getByRole('checkbox', { name, exact: true }).check();
            await page.waitForFunction(() => [...document.querySelectorAll('.bpb-custom-source summary')].filter(element => element.textContent.includes('60%')).length === 3);
        }
        await page.evaluate(() => {
            const first = window.mapsPlaceholder.getContainer(); first.style.width = '50%'; window.mapsPlaceholder.invalidateSize();
            const box = document.createElement('div'); box.style.cssText = 'position:absolute;left:50%;top:0;width:50%;height:100%'; document.body.append(box);
            window.extraCustomMap = window.L.map(box).setView([46.85, -121.76], 10);
        });
        await page.waitForFunction(() => document.querySelectorAll('.bpb-map-layers').length === 2);
        const secondary = page.locator('.bpb-map-layers').nth(1); await secondary.getByRole('button', { name: /^Overlays/ }).click();
        assert.equal(await secondary.getByRole('checkbox', { name: 'Custom MVT', exact: true }).isChecked(), false, 'second instance starts independently');
        await secondary.getByRole('checkbox', { name: 'Custom MVT', exact: true }).check();
        await page.evaluate(() => window.extraCustomMap.remove()); await page.waitForFunction(() => document.querySelectorAll('.bpb-map-layers').length === 1);
        await page.goto(`${origin}/peak.aspx?pid=2829`);
        await page.evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; });
        assert.equal(await page.locator('html').evaluate(root => getComputedStyle(root).overscrollBehaviorY), 'none', 'dark Peakbagger page disables vertical bounce');
        await page.getByRole('button', { name: /^Overlays/ }).click(); await page.getByRole('checkbox', { name: 'Custom raster', exact: true }).check();
        await page.getByRole('link', { name: 'Click Here for a Full Screen Map' }).click();
        await page.getByRole('button', { name: /^Overlays/ }).click();
        await page.getByRole('checkbox', { name: 'Custom raster', exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('input[aria-label="Custom raster"]')?.checked);
        await page.reload(); await page.getByRole('button', { name: /^Overlays/ }).click();
        assert.equal(await page.getByRole('checkbox', { name: 'Custom raster', exact: true }).isChecked(), false, 'handoff is consumed once');
        await browser.route(`${origin}/map/BigMap.aspx*`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body{margin:0}iframe{width:100%;height:650px;border:0}</style><iframe id="if" src="/map/MasterMap.aspx?t=G&amp;d=2296&amp;gt=rc"></iframe>' }));
        await page.goto(`${origin}/map/BigMap.aspx?t=G&d=2296&gt=rc`);
        await page.getByRole('button', { name: /^Overlays/ }).click();
        for (const name of ['Custom raster', 'Custom MVT', 'Custom polygons']) await page.getByRole('checkbox', { name, exact: true }).check();
        await page.locator('#bpb-terrain-toggle').click();
        if (await page.locator('.bpb-terrain-consent-primary').count()) await page.locator('.bpb-terrain-consent-primary').click();
        const terrain = page.frameLocator('#bpb-terrain-frame');
        await terrain.locator('canvas.maplibregl-canvas').waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll('.bpb-custom-source summary')].filter(element => element.textContent.includes('60%')).length === 3, null, { timeout: 30000 });
        const renderer = await terrain.locator('canvas.maplibregl-canvas').evaluate(canvas => { const gl = canvas.getContext('webgl2'); const extension = gl.getExtension('WEBGL_debug_renderer_info'); return extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL); });
        assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
        assert.ok(origins.has(origin) && origins.has(`chrome-extension://${extension.id}`), 'provider receives both actual renderer origins');
        const requestCount = requests.length;
        const terrainRaster = page.locator('.bpb-custom-source').filter({ hasText: 'Custom raster' }); await terrainRaster.locator('summary').first().focus(); await terrainRaster.locator('summary').first().press('Enter');
        await terrainRaster.getByRole('button', { name: 'Edit source', exact: true }).click();
        await editor.locator('#test').click(); await editor.locator('#feedback').filter({ hasText: 'This area (3D)' }).waitFor();
        const editorPolicy = await editor.locator('html').evaluate(root => ({ background: getComputedStyle(root).backgroundColor, overscroll: getComputedStyle(root).overscrollBehaviorY }));
        assert.equal(editorPolicy.overscroll, 'none'); assert.ok(editorPolicy.background !== 'rgba(0, 0, 0, 0)', 'embedded editor root canvas is painted');
        assert.ok(requests.length > requestCount, '3D probes make uncached direct requests');
        await editor.locator('#cancel').click();
        if (screenshots) await page.screenshot({ path: path.join(screenshots, 'custom-terrain.png') });
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ verification: 'custom-overlays', browser: browser.browser().version(), hidden: true, requests: requests.length, surfaces: surfaces.length, renderer, rasterPixels: true, vectorWorkers: true, corsRecovery: true, retryAnchored: true, scrollBoundaries: true, previousCanvasProof: !!process.env.BPB_PREVIOUS_PANEL_CSS }));
    }
} catch (error) { failure = error; try { const live = await failurePage?.frameLocator('iframe[title="Custom map overlays"]').locator('#feedback').textContent({ timeout: 1000 }); console.error(JSON.stringify({ live, ...diagnostics?.() })); } catch { /* Preserve the original failure. */ } }
await resources.dispose(failure);
if (failure) throw failure;

async function verifyFirefox({ resources, temporaryRoot, origin, providerOrigin, setPng, deny, requests, origins }) {
    const { Builder, By, Key } = await import('selenium-webdriver');
    const firefox = (await import('selenium-webdriver/firefox.js')).default;
    const prepared = await prepareFirefoxSource({ temporaryRoot }); resources.defer('custom Firefox source', () => prepared.cleanup());
    resources.defer('custom Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
    const profile = path.join(temporaryRoot, 'profile'); await mkdir(profile);
    const options = new firefox.Options().addArguments('-headless').enableBidi().setProfile(profile).setAcceptInsecureCerts(true)
        .setPreference('network.dns.localDomains', 'www.peakbagger.com,peakbagger.com,tiles.example.com').setPreference('network.proxy.type', 0)
        .setPreference('webgl.sanitize-unmasked-renderer', false).setPreference('webgl.disable-angle', false);
    if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
    const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
        .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`)).build();
    resources.defer('custom Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
    const addon = await driver.installAddon(prepared.sourceDir, true);
    await driver.setContext(firefox.Context.CHROME);
    const extensionUrl = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("custom-overlay/editor.html");', addon);
    await driver.setContext(firefox.Context.CONTENT);
    const evaluate = (fn, ...args) => driver.executeScript(`return (${fn})(...arguments);`, ...args);
    const click = async selector => (await driver.findElement(By.css(selector))).click();
    const wait = (fn, message) => driver.wait(fn, 15000, message);
    const bidi = await driver.getBidi(), networkErrors = [];
    const send = async request => { const result = await bidi.send(request); if (result.type === 'error') throw new Error(`${request.method}: ${result.message}`); return result; };
    await bidi.subscribe('network.beforeRequestSent');
    const dem = event => {
        if (!event.isBlocked || !event.request.url.startsWith('https://tiles.mapterhorn.com/')) return;
        void send({ method: 'network.provideResponse', params: { request: event.request.request, statusCode: 200,
            headers: [{ name: 'content-type', value: { type: 'string', value: 'image/webp' } }, { name: 'access-control-allow-origin', value: { type: 'string', value: '*' } }],
            body: { type: 'base64', value: snowMapDem.toString('base64') } } }).catch(error => networkErrors.push(error.message));
    };
    bidi.on('network.beforeRequestSent', dem); resources.defer('custom Firefox network listener', () => bidi.off('network.beforeRequestSent', dem));
    await send({ method: 'network.addIntercept', params: { phases: ['beforeRequestSent'], urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'tiles.mapterhorn.com' }] } });
    await driver.get(extensionUrl);
    setPng(Buffer.from(await evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256; const context = canvas.getContext('2d'); context.fillStyle = '#ef2719'; context.fillRect(0, 0, 256, 256); return canvas.toDataURL().split(',')[1]; }), 'base64'));
    const definitions = ['raster', 'geojson', 'mvt'].map(kind => ({ id: `custom:${crypto.randomUUID()}`, revision: 1, name: `Custom ${kind}`, kind,
        source: kind === 'geojson' ? { dataUrl: `${providerOrigin}/data.geojson` } : { tiles: [`${providerOrigin}/{z}/{x}/{y}.${kind === 'mvt' ? 'pbf' : 'png'}`], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
        approvedOrigins: [providerOrigin], attribution: { text: 'Fixture data' }, appearance: { opacity: 60,
            rules: kind === 'raster' ? [] : [{ geometry: 'polygon', color: '#26734d', width: 2, radius: 5, fillOpacity: .3, ...kind === 'mvt' ? { sourceLayer: 'trails' } : {} }] } }));
    const setup = await evaluate(async sources => {
        const api = globalThis.browser || globalThis.chrome;
        await api.storage.sync.set({ bpbSettings: { showSnotel: false, showWeather: false, showSunMoon: false, enable3dMap: true, terrainCacheLimitMb: 0 } });
        return Promise.all(sources.map(source => api.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_SAVE', id: source.id, source, expectedRevision: 0 })));
    }, definitions);
    assert.ok(setup.every(reply => reply.ok), 'packaged editor setup uses authorized store writes');
    const optionsUrl = extensionUrl.replace('custom-overlay/editor.html', 'options/options.html');
    await driver.get(optionsUrl + '#custom-map-layers');
    await wait(() => evaluate(() => document.querySelectorAll('#custom-layer-list li').length === 3), 'Firefox central layer manager');
    await click('#custom-layer-add');
    await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));
    await wait(() => evaluate(() => document.getElementById('form-title')?.textContent === 'Add custom overlay'), 'Options editor initialized');
    assert.equal(await evaluate(() => document.querySelectorAll('#library button').length), 0, 'Firefox embedded editor has no duplicate manager');
    await (await driver.findElement(By.id('name'))).sendKeys('Options Firefox source');
    await (await driver.findElement(By.id('url'))).sendKeys(`${providerOrigin}/{z}/{x}/{y}.png`);
    await click('#save'); await wait(() => evaluate(() => document.getElementById('feedback').textContent.includes('Saved on this device')), 'Firefox manager saves layer');
    await click('#cancel'); await driver.switchTo().defaultContent();
    await wait(() => evaluate(() => document.querySelectorAll('#custom-layer-list li').length === 4), 'manager updates after save');
    const removeSelector = '#custom-layer-list li:last-child';
    await click(removeSelector + ' .custom-layer-actions button:last-child'); await click(removeSelector + ' .custom-layer-remove button:first-of-type');
    await wait(() => evaluate(() => document.querySelectorAll('#custom-layer-list li').length === 3), 'manager removes layer');
    await evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; });
    await driver.manage().window().setRect({ width: 480, height: 900 });
    await evaluate(() => document.getElementById('custom-map-layers').scrollIntoView());
    assert.ok(await evaluate(() => { const panel = document.getElementById('custom-map-layers'); return panel.scrollWidth <= panel.clientWidth; }), 'Firefox Options layer list fits');
    assert.deepEqual(await evaluate(() => ['html', '.content', '.side-nav'].map(selector => getComputedStyle(document.querySelector(selector)).overscrollBehaviorY)), ['none', 'none', 'none']);
    assert.notEqual(await evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgba(0, 0, 0, 0)');
    await evaluate(() => document.querySelector('.content').scrollTo({ top: 0, behavior: 'instant' }));
    const scrollTarget = await evaluate(() => { const rect = document.querySelector('.content').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 30) }; });
    await driver.actions({ async: true }).scroll(scrollTarget.x, scrollTarget.y, 0, -1200).perform();
    assert.equal(await evaluate(() => document.querySelector('.content').scrollTop), 0);
    await driver.actions({ async: true }).scroll(scrollTarget.x, scrollTarget.y, 0, 300).perform();
    await wait(() => evaluate(() => document.querySelector('.content').scrollTop > 0), 'normal panel scrolling remains available');
    await evaluate(() => { const content = document.querySelector('.content'); content.scrollTo({ top: content.scrollHeight, behavior: 'instant' }); });
    await driver.actions({ async: true }).scroll(scrollTarget.x, scrollTarget.y, 0, 1200).perform();
    assert.ok(await evaluate(() => { const content = document.querySelector('.content'); return Math.abs(content.scrollTop - (content.scrollHeight - content.clientHeight)) <= 1 && scrollY === 0; }));
    await evaluate(() => document.getElementById('custom-map-layers').scrollIntoView());
    if (process.env.BPB_CUSTOM_SCREENSHOTS) { await mkdir(process.env.BPB_CUSTOM_SCREENSHOTS, { recursive: true }); await writeFile(path.join(process.env.BPB_CUSTOM_SCREENSHOTS, 'custom-options-firefox-dark.png'), await driver.takeScreenshot(), 'base64'); }
    await driver.get(`${origin}/map/MasterMap.aspx?t=G&gt=rc`);
    await send({ method: 'browsingContext.setViewport', params: { context: await driver.getWindowHandle(), viewport: { width: 1000, height: 760 } } });
    await wait(() => driver.findElements(By.css('.bpb-layers-trigger')).then(elements => elements.length === 1), 'native overlay control');
    await click('.bpb-layers-trigger');
    for (const source of definitions) await click(`input[aria-label="${source.name}"]`);
    const ready = () => evaluate(() => [...document.querySelectorAll('.bpb-custom-source summary')].filter(element => element.textContent.includes('60%')).length === 3);
    await wait(ready, 'all native custom overlays loaded');
    assert.ok(await evaluate(() => [...document.querySelectorAll('.leaflet-bpb-custom-overlays-pane canvas')].some(canvas => [...canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].at(-1) > 0)), 'native overlay pixels');
    const row = '.bpb-custom-source:has(input[aria-label="Custom mvt"])';
    await evaluate(selector => { document.querySelector(selector).open = true; }, row);
    deny(true); await click(`${row} .bpb-custom-actions button:first-child`);
    await wait(() => evaluate(selector => document.querySelector(`${selector} .bpb-custom-feedback`).textContent.includes('CORS'), row), 'actual missing CORS header is reported');
    const geometry = () => evaluate(selector => { const rect = document.querySelector(`${selector} .bpb-custom-actions`).getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scroll: scrollY }; }, row);
    const before = await geometry(); deny(false);
    await (await driver.findElement(By.css(`${row} .bpb-custom-actions button:first-child`))).sendKeys(Key.SPACE);
    await wait(ready, 'Firefox keyboard retry recovers'); const after = await geometry();
    for (const key of Object.keys(before)) assert.ok(Math.abs(before[key] - after[key]) <= 1, `Firefox retry ${key} remains stable`);
    await evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; });
    await click('[data-bpb-custom-editor=""]');
    await send({ method: 'browsingContext.setViewport', params: { context: await driver.getWindowHandle(), viewport: { width: 375, height: 800 } } });
    await driver.switchTo().frame(await driver.findElement(By.css('iframe[title="Custom map overlays"]')));
    await wait(() => evaluate(() => document.getElementById('form-title')?.textContent === 'Add custom overlay'), 'packaged editor ready');
    assert.equal(await evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY), 'none');
    assert.ok(await evaluate(() => document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.body).color !== 'rgb(35, 54, 41)'), 'narrow dark editor fits');
    const screenshots = process.env.BPB_CUSTOM_SCREENSHOTS;
    if (screenshots) { await mkdir(screenshots, { recursive: true }); await writeFile(path.join(screenshots, 'custom-editor-firefox-narrow.png'), await driver.takeScreenshot(), 'base64'); }
    await click('#cancel'); await driver.switchTo().defaultContent();
    await driver.get(`${origin}/map/BigMap.aspx?t=A&d=2296&c=900001`);
    await send({ method: 'browsingContext.setViewport', params: { context: await driver.getWindowHandle(), viewport: { width: 1000, height: 760 } } });
    await wait(() => driver.findElements(By.css('.bpb-layers-trigger')).then(elements => elements.length === 1), 'parent map owns one control');
    await click('.bpb-layers-trigger'); for (const source of definitions) await click(`input[aria-label="${source.name}"]`);
    await wait(() => driver.findElements(By.id('bpb-terrain-toggle')).then(elements => elements.length > 0), '3D toggle');
    await click('#bpb-terrain-toggle');
    if ((await driver.findElements(By.css('.bpb-terrain-consent-primary'))).length) await click('.bpb-terrain-consent-primary');
    await wait(ready, 'all custom overlays loaded in real Firefox terrain');
    await driver.switchTo().frame(await driver.findElement(By.id('bpb-terrain-frame')));
    const renderer = await evaluate(() => { const gl = document.querySelector('canvas.maplibregl-canvas')?.getContext('webgl2'); const extension = gl?.getExtension('WEBGL_debug_renderer_info'); return extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL); });
    assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `Firefox hardware renderer required: ${renderer}`);
    await driver.switchTo().defaultContent();
    if (screenshots) await writeFile(path.join(screenshots, 'custom-terrain-firefox.png'), await driver.takeScreenshot(), 'base64');
    assert.ok(origins.has(origin) && [...origins].some(value => value?.startsWith('moz-extension://')), 'both real request origins reached the provider');
    assert.deepEqual(networkErrors, []);
    console.log(JSON.stringify({ verification: 'custom-overlays-firefox', browser: (await driver.getCapabilities()).getBrowserVersion(), hidden: true, renderer, requests: requests.length, nativePixels: true, vectorWorkers: true, corsRecovery: true, keyboardRetry: true, scrollBoundaries: true }));
}
