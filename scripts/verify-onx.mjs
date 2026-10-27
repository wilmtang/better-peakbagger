// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, chrome, getComputedStyle, scrollY */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { createFixtureCertificate, waitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { setFirefoxContentViewport } from './firefox-content-viewport.mjs';
const [kind, ...args] = process.argv.slice(2);
assert(['chrome', 'firefox'].includes(kind) && args.length <= 1 && args.every(arg => /^--screenshots=.+$/.test(arg)), 'Usage: verify-onx.mjs chrome|firefox [--screenshots=PATH]');
const screenshots = args.find(arg => arg.startsWith('--screenshots='))?.slice(14);
const resources = createResourceStack();
let failure;
try {
    const root = await mkdtemp(path.join(tmpdir(), 'bpb-onx-'));
    resources.defer('onX fixture files', () => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'dist'); await cp(path.resolve('dist'), source, { recursive: true });
    const manifestFile = path.join(source, 'manifest.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    // Native optional-host approval is pregranted only in this disposable copy.
    // Keep identity.onxmaps.com ungranted: real URL redaction is under test.
    manifest.host_permissions.push('https://backcountry.onxmaps.com/*');
    await writeFile(manifestFile, JSON.stringify(manifest));
    const cert = await createFixtureCertificate({ label: 'onx' }); resources.defer('onX certificate', () => cert.remove());
    const ascent = await readFile('test/fixtures/pages/climber-ascent.html', 'utf8');
    const gpx = '<gpx version="1.1"><trk><name>Synthetic route</name><trkseg><trkpt lat="37" lon="-119"><ele>100</ele></trkpt><trkpt lat="37.001" lon="-119.001"><ele>101</ele></trkpt></trkseg></trk></gpx>';
    let mode = 'ready', loggedIn = false, deliveries = 0, imports = 0, sourceReads = 0;
    const server = createServer(cert, (request, response) => {
        const host = request.headers.host.split(':')[0];
        response.setHeader('content-type', 'text/html');
        if (host === 'identity.onxmaps.com') {
            response.end(`<h1>Sign in fixture</h1>${mode === 'silent' ? '<script>location.replace("https://backcountry.onxmaps.com/backcountry/map/content/import?authenticated=1")</script>' : ''}`);return;
        }
        if (host === 'backcountry.onxmaps.com') {
            const url = new URL(request.url, 'https://backcountry.onxmaps.com');
            if ((mode === 'login' || mode === 'silent') && !loggedIn && !url.searchParams.has('authenticated')) {
                response.writeHead(302, { location: 'https://identity.onxmaps.com/login' });response.end();return;
            }
            response.end(`<h1>onX importer fixture</h1><div id="loading">Loading…</div><main></main>
                <script>
                window.deliveries=0;window.imports=0;
                function ready(){document.querySelector('#loading').remove();document.querySelector('main').innerHTML='<input id="add-files-input" type="file" accept=".gpx,.kml"><button data-test="import-card-import-button" disabled>Import</button>';
                document.querySelector('input').onchange=async e=>{window.deliveries++;window.received=await e.target.files[0].text();fetch('/delivered',{method:'POST'});
                ${mode === 'stalled' ? '' : "document.querySelector('main').insertAdjacentHTML('beforeend','<p data-test=\"file-item\">Saved file</p>');document.querySelector('button').disabled=false;"}};
                document.querySelector('button').onclick=()=>{window.imports++;fetch('/imported',{method:'POST'});};}
                ${mode === 'delayed' ? 'window.makeReady=ready;' : 'ready();'}
                </script>`);return;
        }
        if (request.url.startsWith('/climber/GPXFile.aspx')) { sourceReads++; response.setHeader('content-type', 'application/gpx+xml'); response.end(gpx);return; }
        response.end(ascent);
    });
    // Count receipt without exposing the GPX or relying on a provider Save.
    server.prependListener('request', (request, response) => {
        if (request.url === '/delivered') { deliveries++; response.writeHead(204); response.end(); }
        if (request.url === '/imported') { imports++; response.writeHead(204); response.end(); }
    });
    // The main listener must not write after these instrumentation responses.
    const listeners = server.listeners('request'); server.removeAllListeners('request');
    server.on('request', (req, res) => { listeners[0](req, res); if (!res.writableEnded) listeners[1](req, res); });
    resources.defer('onX HTTPS fixture', () => closeServer(server)); await listenServer(server, 0, '127.0.0.1');
    const sockets = new Set();
    const proxy = httpServer((_req, res) => { res.writeHead(403); res.end(); });
    proxy.on('connect', (request, socket, head) => {
        socket.on('error', () => {});
        if (!/^(backcountry|identity)\.onxmaps\.com:443$/.test(request.url)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return; }
        const remote = connect(server.address().port, '127.0.0.1');
        for (const item of [socket, remote]) { sockets.add(item); item.on('close', () => sockets.delete(item)); }
        remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
        remote.on('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); remote.pipe(socket); socket.pipe(remote); });
    });
    resources.defer('onX proxy', async () => { for (const socket of sockets) socket.destroy(); await closeServer(proxy); });
    await listenServer(proxy, 0, '127.0.0.1');
    const origin = `https://www.peakbagger.com:${server.address().port}`;
    let evaluate, admin, navigate, key, viewport, shot, version, targetEvaluate, targetNavigate;
    if (kind === 'chrome') {
        const { chromium } = await import('playwright'); assertChromeLaunchAllowed();
        const context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true,
            viewport: { width: 1280, height: 900 }, proxy: { server: `http://127.0.0.1:${proxy.address().port}`, bypass: 'www.peakbagger.com,127.0.0.1,localhost' },
            args: [...cert.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1', `--load-extension=${source}`, `--disable-extensions-except=${source}`] });
        resources.defer('onX Chrome', () => context.close());
        const registry = await context.newPage();await registry.goto('chrome://extensions-internals/');
        const extension = await registry.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find(x => x.name === 'Better Peakbagger'); } catch { return false; } }).then(h => h.jsonValue());
        const options = await context.newPage();await options.goto(`chrome-extension://${extension.id}/options/options.html`);
        const page = await context.newPage();
        evaluate = (fn, arg) => page.evaluate(fn, arg); admin = (fn, arg) => options.evaluate(fn, arg); navigate = url => page.goto(url);
        key = selector => page.locator(selector).press('Enter');viewport = size => page.setViewportSize(size);shot = file => page.screenshot({ path: file });version = context.browser().version();
        const target = () => context.pages().filter(p => /https:\/\/(backcountry|identity)\.onxmaps\.com/.test(p.url())).at(-1);
        targetEvaluate = (fn, arg) => target().evaluate(fn, arg);targetNavigate = url => target().goto(url);
    } else {
        const { Builder, By, Key } = await import('selenium-webdriver'), firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot: root, distDir: source }); resources.defer('onX Firefox source', () => prepared.cleanup());
        resources.defer('onX Firefox processes', () => stopOwnedFirefoxProcesses(root));
        const profile = path.join(root, 'profile');await mkdir(profile);
        const options = new firefox.Options().addArguments('-headless').enableBidi().setProfile(profile).setAcceptInsecureCerts(true)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com').setPreference('network.proxy.type', 1)
            .setPreference('network.proxy.ssl', '127.0.0.1').setPreference('network.proxy.ssl_port', proxy.address().port)
            .setPreference('network.proxy.no_proxies_on', 'www.peakbagger.com,127.0.0.1,localhost');
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
            .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${root}`)).build();
        resources.defer('onX Firefox', () => quitFirefoxDriver(driver, root));
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        const optionsUrl = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        await driver.setContext(firefox.Context.CONTENT);await driver.get(optionsUrl);const optionsHandle = await driver.getWindowHandle();
        await driver.switchTo().newWindow('tab');const sourceHandle = await driver.getWindowHandle();
        evaluate = (fn, arg) => driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null);
        admin = async (fn, arg) => { await driver.switchTo().window(optionsHandle);try { return await driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null); } finally { await driver.switchTo().window(sourceHandle); } };
        navigate = url => driver.get(url);key = selector => driver.findElement(By.css(selector)).sendKeys(Key.ENTER);
        viewport = size => setFirefoxContentViewport(driver, size);shot = async file => writeFile(file, await driver.takeScreenshot(), 'base64');version = (await driver.getCapabilities()).getBrowserVersion();
        const target = async () => (await driver.getAllWindowHandles()).filter(h => h !== optionsHandle && h !== sourceHandle).at(-1);
        targetEvaluate = async (fn, arg) => { await driver.switchTo().window(await target());try { return await evaluate(fn, arg); } finally { await driver.switchTo().window(sourceHandle); } };
        targetNavigate = async url => { await driver.switchTo().window(await target());try { await driver.get(url); } finally { await driver.switchTo().window(sourceHandle); } };
    }
    await admin(async () => { const api = globalThis.browser || chrome;await api.runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: { mapProvidersEnabled: ['onx'], showSunMoon: false, showWeather: false } }); });
    const button = '[data-provider="onx"]';
    const state = () => evaluate(() => ({ label: document.querySelector('[data-provider="onx"]')?.innerText.trim(),
        busy: document.querySelector('[data-provider="onx"]')?.getAttribute('aria-busy'), message: document.querySelector('.bpb-map-handoff-status')?.innerText,
        open: !!document.querySelector('.bpb-onx-open') && !document.querySelector('.bpb-onx-open').hidden }));
    const wait = (predicate, description, timeoutMs = 12_000) => waitForCondition(state, { description, isReady: predicate, timeoutMs });
    let cases = 0;
    for (const selected of ['ready', 'silent', 'login', 'stalled', 'delayed']) {
        mode = selected;loggedIn = false;
        await navigate(`${origin}/climber/ascent.aspx?aid=7654321&sample=${cases}`);
        await wait(s => s.label === 'Send to onX', 'onX control ready');
        const before = deliveries, started = performance.now();await key(button);
        if (selected === 'delayed') {
            await wait(s => s.open && /Waiting for onX/.test(s.message), 'slow startup exposes Open onX');
            await targetEvaluate(() => window.makeReady());
        }
        if (selected === 'login') {
            const outcome = await wait(s => s.busy === 'false' && s.label === 'Continue export', 'login attention within budget');
            assert.match(outcome.message, /sign in if prompted/);assert.equal(deliveries, before);
            loggedIn = true;await targetNavigate('https://backcountry.onxmaps.com/backcountry/map/content/import');
            await key(button);
        }
        await wait(s => s.busy === 'false' && (selected === 'stalled' ? /Check onX/.test(s.message) : /Ready in onX/.test(s.message)), `onX ${selected} terminal state`);
        assert.ok(performance.now() - started < (selected === 'login' ? 22_000 : 12_000), 'attempts remain bounded');
        await waitForCondition(() => Promise.resolve(deliveries), { description: 'exactly one GPX receipt', isReady: n => n === before + 1 });
        assert.equal(imports, 0);assert.equal(await targetEvaluate(() => window.received), gpx);cases++;
    }
    if (screenshots) await mkdir(screenshots, { recursive: true });
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) for (const zoom of [1, 1.5]) {
        mode = width === 390 && theme === 'dark' && zoom === 1.5 ? 'stalled' : 'delayed';await admin(async theme => { const api = globalThis.browser || chrome;await api.runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: { theme } }); }, theme);
        await viewport({ width, height: 900 });await navigate(`${origin}/climber/ascent.aspx?aid=7654321&layout=${cases}`);
        await wait(s => s.label === 'Send to onX', 'layout idle');
        await waitForCondition(() => evaluate(() => !!globalThis.Chart?.getChart?.(document.querySelector('#bpb-gpx-analysis canvas'))), { description: 'surrounding analyzer has finished mounting' });
        await evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
        const geometry = () => evaluate(() => {
            const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
            return { button: box('[data-provider="onx"]'), panel: box('.bpb-map-handoff-control'), following: box('#owneractions'), scrollY };
        });
        await evaluate(() => { document.querySelector('[data-provider="onx"]').focus(); return new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); });
        const readable = await evaluate(() => {
            const node = document.querySelector('.bpb-map-handoff-status');
            return node.getBoundingClientRect().width / parseFloat(getComputedStyle(node).fontSize);
        });
        assert.ok(readable >= 10, `feedback remains readable with one provider: ${readable}em`);
        const before = await geometry();await key(button);
        await wait(s => s.busy === 'true' && s.open, 'layout pending with Open onX');
        const pending = await geometry();
        for (const surface of ['button', 'panel', 'following']) for (const field of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[surface][field] - pending[surface][field]) <= 1, `${surface}.${field} moved during pending`);
        }
        assert.equal(await evaluate(() => document.activeElement === document.querySelector('[data-provider="onx"]')), true);
        const receipts = deliveries;
        await key(button);
        assert.equal(deliveries, receipts, 'keyboard activation while busy cannot resend');
        if (mode === 'delayed') await targetEvaluate(() => window.makeReady());
        await wait(s => s.busy === 'false' && (mode === 'stalled' ? /Check onX/.test(s.message) : /Ready in onX/.test(s.message)), 'layout terminal state');
        const after = await geometry();
        for (const surface of ['button', 'panel', 'following']) for (const field of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[surface][field] - after[surface][field]) <= 1, `${surface}.${field} moved: ${JSON.stringify({ before, after })}`);
        }
        assert.equal(before.scrollY, after.scrollY);
        assert.equal(await evaluate(() => document.activeElement === document.querySelector('[data-provider="onx"]')), true);
        if (screenshots) await shot(path.join(screenshots, `${kind}-${theme}-${width}-zoom${zoom}.png`));cases++;
    }
    assert.equal(cases, 13, 'all selected onX cases must execute');
    assert.equal(await admin(async () => JSON.stringify(await (globalThis.browser || chrome).storage.session.get(null)).includes('<gpx')), false);
    console.log(JSON.stringify({ browser: kind, version, hidden: true, renderer: 'static HTML; no WebGL', cases, sourceReads, deliveries, imports,
        viewports: ['1280x900', '390x900'], themes: ['light', 'dark'], zoom: [1, 1.5], nativePermissions: 'not inspected', liveOnx: 'stubbed HTTPS authentication and importer' }));
} catch (error) { failure = error; }
await resources.dispose(failure);
