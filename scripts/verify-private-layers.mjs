// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, chrome, innerWidth, MouseEvent, location, scrollY, File, DataTransfer, Event */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:https';
import { createBrowserFixtureServer, createFixtureCertificate, waitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { snowMapDocument, snowMapDem } from './verify-snow-map-fixture.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { setFirefoxContentViewport } from './firefox-content-viewport.mjs';
import { PRIVATE_LIMITS } from '../src/maps/custom-overlay-private.js';
const [kind, ...args] = process.argv.slice(2);
assert(['chrome', 'firefox'].includes(kind) && args.every(arg => arg.startsWith('--screenshots=')), 'Usage: node scripts/verify-private-layers.mjs chrome|firefox [--screenshots=PATH]');
const shots = args.find(arg => arg.startsWith('--screenshots='))?.slice(14), secret = 'fixture_KEY+PRIVATE/123';
const resources = createResourceStack();
try {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bpb-private-layers-'));resources.defer('private layer files', () => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');await cp(path.resolve('dist'), source, { recursive: true });
    const file = path.join(source, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    // Test-only pregrant. Native browser permission dialogs are not exercised.
    manifest.host_permissions.push('https://tiles.example.com/*');await writeFile(file, JSON.stringify(manifest));
    // Hold only this disposable editor's writes so actual shipped controls can
    // be inspected while pending and after a recoverable local-write failure.
    const editorFile = path.join(source, 'custom-overlay/editor.js');
    await writeFile(editorFile, (await readFile(editorFile, 'utf8')) + `;
        {const api=globalThis.browser||globalThis.chrome,original=api.runtime.sendMessage.bind(api.runtime),root=document.documentElement;let pending;
        api.runtime.sendMessage=message=>{
            if(message.type!=='CUSTOM_OVERLAYS_SAVE'||root.dataset.verificationSave!=='hold')return original(message);
            root.dataset.verificationSaves=String(Number(root.dataset.verificationSaves||0)+1);
            return new Promise(resolve=>{pending={message,resolve};});
        };
        new MutationObserver(()=>{const action=root.dataset.verificationRelease;if(!action||!pending)return;
            delete root.dataset.verificationRelease;const current=pending;pending=null;
            if(action==='error')current.resolve({ok:false,error:'Saving is temporarily unavailable. Your private entries are still here.'});
            else original(current.message).then(current.resolve);
        }).observe(root,{attributes:true,attributeFilter:['data-verification-release']});}
    `);
    const terrainFile = path.join(source, 'terrain/terrain-frame.js');
    await writeFile(terrainFile, (await readFile(terrainFile, 'utf8')) + `;
        {const api=globalThis.browser||globalThis.chrome,original=api.runtime.sendMessage.bind(api.runtime);
        api.runtime.sendMessage=message=>{if(message.type==='CUSTOM_PRIVATE_GET')document.documentElement.dataset.verificationPrivateReads=String(Number(document.documentElement.dataset.verificationPrivateReads||0)+1);return original(message);};}
    `);
    const html = await snowMapDocument(), fixture = await createBrowserFixtureServer({ temporaryRoot: root, masterMapDocument: html, peakMapDocument: html,
        bigMapDocument: '<!doctype html><style>html,body{margin:0;height:100%}iframe{width:100%;height:650px;border:0}</style><iframe id="if" src="/map/MasterMap.aspx?t=G&amp;d=2296&amp;gt=rc"></iframe>' });resources.defer('Peakbagger fixture', () => fixture.close());
    const providerRoot = path.join(root, 'provider');await mkdir(providerRoot);const cert = await createFixtureCertificate({ directory: providerRoot });
    const requests = [];let png, lastProviderRequest = performance.now();
    const server = createServer(cert, async (request, response) => {
        const url = new URL(request.url, 'https://tiles.example.com');requests.push({ path: url.pathname, origin: request.headers.origin });lastProviderRequest = performance.now();
        assert.equal(url.searchParams.get('api_key'), secret);assert.equal(request.headers.cookie, undefined);assert.equal(request.headers.referer, undefined);
        if (url.pathname === '/source.json') {
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ tilejson: '3.0.0', minzoom: 0, maxzoom: 18, tiles: [`https://${request.headers.host}/tiles/{z}/{x}/{y}.png`] }));return;
        }
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });response.end(png);
    });resources.defer('private provider', () => closeServer(server));await listenServer(server, 0, '127.0.0.1');
    const origin = `https://www.peakbagger.com:${fixture.port}`, provider = `https://tiles.example.com:${server.address().port}`;
    let evaluate, admin, click, fill, inside, options, map, access, activate, openReview, setViewport, setReviewViewport, shot, extensionUrl, version, terrainEvaluate;
    if (kind === 'chrome') {
        const { chromium } = await import('playwright');
        const trust = '--ignore-certificate-errors-spki-list=' + [fixture, cert].flatMap(item => item.chromeTrustArgs.map(arg => arg.split('=').slice(1).join('='))).join(',');
        assertChromeLaunchAllowed();
        const context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1000, height: 900 },ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            args: [trust, '--no-proxy-server', '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1,MAP tiles.example.com 127.0.0.1', `--load-extension=${source}`, `--disable-extensions-except=${source}`] });
        resources.defer('private Chrome', () => context.close());
        await context.route('https://tiles.mapterhorn.com/**', route => route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' },body: snowMapDem }));
        const registry = await context.newPage();await registry.goto('chrome://extensions-internals/');
        const extension = await registry.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
        extensionUrl = `chrome-extension://${extension.id}`;options = await context.newPage();await options.goto(extensionUrl + '/options/options.html#custom-map-layers');
        map = await context.newPage();await map.goto(origin + '/map/BigMap.aspx?t=A');
        evaluate = (fn, arg) => map.evaluate(fn, arg);admin = (fn, arg) => options.evaluate(fn, arg);
        inside = async (fn, arg) => options.frames().find(frame => frame.url().includes('/custom-overlay/editor.html'))?.evaluate(fn, arg);
        click = (surface, selector) => surface === 'editor' ? options.frameLocator('#custom-layer-dialog iframe').locator(selector).click() : (surface === 'access' ? access : surface === 'options' ? options : map).locator(selector).click();
        fill = (selector, value) => options.frameLocator('#custom-layer-dialog iframe').locator(selector).fill(value);
        activate = surface => (surface === 'options' ? options : map).bringToFront();
        openReview = async () => { const next = context.waitForEvent('page');await click('map', '[data-bpb-private-layer]');access = await next;await access.waitForLoadState();return fn => access.evaluate(fn); };
        setViewport = size => options.setViewportSize(size);shot = (surface, file) => (surface === 'access' ? access : surface === 'options' ? options : map).screenshot({ path: file });version = context.browser().version();
        setReviewViewport = size => access.setViewportSize(size);
        terrainEvaluate = (fn, arg) => map.frames().find(frame => frame.url().includes('/terrain/terrain.html'))?.evaluate(fn, arg);
    } else {
        const { Builder, By } = await import('selenium-webdriver'), firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot: root, distDir: source });resources.defer('private Firefox source', () => prepared.cleanup());resources.defer('private Firefox processes', () => stopOwnedFirefoxProcesses(root));
        const profile = path.join(root, 'profile');await mkdir(profile);
        const configuration = new firefox.Options().addArguments('-headless').enableBidi().setProfile(profile).setAcceptInsecureCerts(true)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,tiles.example.com').setPreference('webgl.sanitize-unmasked-renderer', false);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(configuration).setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${root}`)).build();resources.defer('private Firefox', () => quitFirefoxDriver(driver, root));
        const addon = await driver.installAddon(prepared.sourceDir, true);await driver.setContext(firefox.Context.CHROME);
        extensionUrl = (await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("");', addon)).replace(/\/$/, '');await driver.setContext(firefox.Context.CONTENT);
        await driver.get(extensionUrl + '/options/options.html#custom-map-layers');options = await driver.getWindowHandle();await driver.switchTo().newWindow('tab');map = await driver.getWindowHandle();await driver.get(origin + '/map/BigMap.aspx?t=A');
        const run = async (handle, fn, arg) => { await driver.switchTo().window(handle);return driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null); };
        evaluate = (fn, arg) => run(map, fn, arg);admin = (fn, arg) => run(options, fn, arg);
        inside = async (fn, arg) => { await driver.switchTo().window(options);try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));return await driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null); } finally { await driver.switchTo().defaultContent(); } };
        click = async (surface, selector) => { await driver.switchTo().window(surface === 'access' ? access : surface === 'options' || surface === 'editor' ? options : map);try {
            if (surface === 'editor') await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));await driver.findElement(By.css(selector)).click();
        } finally { await driver.switchTo().defaultContent(); } };
        fill = async (selector, value) => { await driver.switchTo().window(options);try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));const field = await driver.findElement(By.css(selector));await field.clear();await field.sendKeys(value); } finally { await driver.switchTo().defaultContent(); } };
        activate = async surface => { const handle = surface === 'options' ? options : map;
            if (surface !== 'options') await admin(async target => { const api = globalThis.browser || chrome;const tabs = await api.tabs.query({});const tab = tabs.find(item => item.url === target);await api.tabs.update(tab.id, { active: true }); }, origin + '/map/BigMap.aspx?t=A');
            await driver.switchTo().window(handle);
        };
        openReview = async () => { const before = await driver.getAllWindowHandles();await click('map', '[data-bpb-private-layer]');access = await waitForCondition(async () => (await driver.getAllWindowHandles()).find(handle => !before.includes(handle)), { description: 'Firefox approval tab' });return fn => run(access, fn); };
        setViewport = async size => { await driver.switchTo().window(options);await driver.manage().window().setRect({ width: Math.max(500, size.width), height: size.height + 85 }); };
        // Firefox BiDi cannot override a privileged extension-page viewport.
        setReviewViewport = async size => { await driver.switchTo().window(access);await driver.manage().window().setRect({ width: Math.max(500, size.width), height: size.height + 85 }); };
        shot = async (surface, file) => { await driver.switchTo().window(surface === 'access' ? access : surface === 'options' ? options : map);await writeFile(file, await driver.takeScreenshot(), 'base64'); };version = (await driver.getCapabilities()).getBrowserVersion();
        terrainEvaluate = async fn => { await driver.switchTo().window(map);try { await driver.switchTo().frame(await driver.findElement(By.id('bpb-terrain-frame')));return await driver.executeScript(`return (${fn})();`); } finally { await driver.switchTo().defaultContent(); } };
        await setFirefoxContentViewport(driver, { width: 1000, height: 900 });
    }
    const wait = (fn, description) => waitForCondition(fn, { description, timeoutMs: 30000 });
    png = Buffer.from(await evaluate(() => { const canvas = document.createElement('canvas');canvas.width = canvas.height = 256;const ctx = canvas.getContext('2d');ctx.fillStyle = '#d22';ctx.fillRect(0, 0, 256, 256);return canvas.toDataURL().split(',')[1]; }), 'base64');
    await admin(async () => (globalThis.browser || chrome).runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: { showSnotel: false, showWeather: false, showSunMoon: false, enable3dMap: true, terrainCacheLimitMb: 0 } }));
    await evaluate(() => location.reload());await wait(() => evaluate(() => !!document.querySelector('#bpb-terrain-toggle')), '3D toggle after authoritative settings');
    await click('options', '#custom-layer-add');await wait(() => inside(() => !!document.getElementById('name')), 'Settings editor');
    await fill('#name', 'Private tiles');await fill('#url', `${provider}/source.json`);await click('editor', '#private-parameters > summary');await click('editor', '#add-parameter');
    await fill('.parameter-row input[id^=parameter-key]', 'api_key');await fill('.parameter-row input[id^=parameter-value]', secret);
    for (const width of [1000, 375]) for (const theme of ['light', 'dark']) {
        await setViewport({ width, height: 900 });await inside(value => { document.documentElement.dataset.theme = value; }, theme);
        const fit = await inside(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, hidden: document.querySelector('.parameter-row input[type=password]')?.value.length > 0 }));assert(!fit.overflow);assert(fit.hidden);
        if (shots) { await mkdir(shots, { recursive: true });await shot('options', path.join(shots, `private-${kind}-editor-${width}-${theme}.png`)); }
        await click('editor', '#private-access-help > summary');
        await inside(() => document.getElementById('private-access-help').scrollIntoView({ block:'center' }));
        assert(await inside(() => document.documentElement.scrollWidth <= innerWidth), 'approval help fits the editor');
        if (shots) await shot('options', path.join(shots, `private-${kind}-help-${width}-${theme}.png`));
        await click('editor', '#private-access-help > summary');
    }
    await inside(() => { document.documentElement.dataset.verificationSave = 'hold';document.getElementById('save').scrollIntoView({ block: 'center', behavior: 'instant' }); });
    const geometry = () => inside(() => Object.fromEntries(['save', 'test', 'cancel', 'private-parameters'].map(id => { const r = document.getElementById(id).getBoundingClientRect();return [id, [r.x, r.y, r.width, r.height]]; }).concat([['scroll', [scrollY]], ['focus', [document.activeElement?.id === 'save' ? 1 : 0]]])));
    await inside(() => document.getElementById('save').focus({ preventScroll: true }));const anchored = await geometry();
    const stable = async () => { const after = await geometry();for (const key of Object.keys(anchored)) for (const [index, value] of after[key].entries()) assert(Math.abs(value - anchored[key][index]) <= 1, `private Save ${key} moved`);assert.equal(after.focus[0], 1); };
    for (const outcome of ['error', 'success']) {
        const writes = await inside(() => Number(document.documentElement.dataset.verificationSaves || 0));
        await click('editor', '#save');await wait(() => inside(() => Number(document.documentElement.dataset.verificationSaves || 0)).then(count => count > writes), 'private source detected and save write pending');await stable();
        const attempts = await inside(() => document.documentElement.dataset.verificationSaves);await inside(() => document.getElementById('save').click());assert.equal(await inside(() => document.documentElement.dataset.verificationSaves), attempts);
        await inside(result => document.documentElement.dataset.verificationRelease = result, outcome);
        await wait(() => inside(() => document.getElementById('save').getAttribute('aria-disabled') === 'false'), 'private save settled');await stable();
        assert.equal(await inside(() => document.querySelector('.parameter-row input[type=password]').value), secret);
    }
    assert.equal(await inside(() => document.getElementById('feedback').textContent), 'Saved on this device.');
    assert.equal(await inside(() => document.getElementById('advanced').open), false, 'private metadata detection must not require Advanced');
    assert.equal(requests.filter(request => request.path === '/source.json').length, 1, 'Settings reads private metadata once');
    await setViewport({ width: 1000, height: 900 });
    const snapshot = await admin(async () => { const api = globalThis.browser || chrome;return { local: await api.storage.local.get(null), exported: await api.runtime.sendMessage({ type: 'SETTINGS_FILE_EXPORT' }) }; });
    assert(!JSON.stringify(snapshot.local).includes(secret), 'secret leaked into storage.local');
    assert(snapshot.exported.ok && snapshot.exported.content.includes(secret), 'manual settings files include private map parameters without the account credential checkbox');
    await click('editor', '#cancel');await wait(() => admin(() => !document.getElementById('custom-layer-dialog').open), 'editor dismissed');
    // Supply only this synthetic file at the native input boundary; retain the
    // shipped parser, review, confirmation and worker transaction.
    await admin(content => {
        const transfer = new DataTransfer();transfer.items.add(new File([content], 'private-map-settings.json', { type:'application/json' }));
        const input = document.getElementById('settings-backup-file');input.files = transfer.files;input.dispatchEvent(new Event('change', { bubbles:true }));
    }, snapshot.exported.content);
    await wait(() => admin(() => !document.getElementById('settings-backup-confirmation').hidden), 'private settings import review');
    assert(await admin(() => document.getElementById('settings-backup-confirmation-detail').textContent.includes('Includes private map URLs and request parameters.')));
    for (const width of [1000, kind === 'firefox' ? 500 : 375]) for (const theme of ['light','dark']) {
        await setViewport({ width,height:900 });await admin(value => {
            document.documentElement.dataset.bpbTheme = value;location.hash = '#github-settings-backup';
            document.getElementById('settings-backup-confirmation').scrollIntoView({ block:'center',behavior:'instant' });
        }, theme);
        await wait(() => admin(() => {
            const rect = document.getElementById('settings-backup-confirmation').getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= document.documentElement.clientHeight;
        }), 'settings import review visible in the viewport');
        assert(await admin(() => document.documentElement.scrollWidth <= innerWidth), 'settings file review fits the viewport');
        if (shots) await shot('options',path.join(shots,`private-${kind}-file-review-${width}-${theme}.png`));
    }
    await click('options','#settings-backup-confirm');
    await wait(() => admin(() => document.getElementById('settings-backup-confirmation').hidden), 'private map file imported through Settings');
    await setViewport({ width:1000,height:900 });
    console.log(JSON.stringify({ stage: 'saved', library: await admin(() => ({ status: document.getElementById('custom-layer-status').textContent, rows: document.getElementById('custom-layer-list').children.length, dialog: document.getElementById('custom-layer-dialog').open })) }));
    await click('options', '#custom-layer-list .custom-layer-actions > button:first-of-type');await wait(() => inside(() => document.querySelector('.parameter-row input[type=password]')?.value.length > 0), 'saved parameter restored for editing');
    assert.equal(await inside(() => document.querySelector('.parameter-row input[type=password]').value), secret);await click('editor', '#cancel');await wait(() => admin(() => !document.getElementById('custom-layer-dialog').open), 'edit dismissed');
    await activate('map');await wait(() => evaluate(() => !!document.querySelector('.bpb-map-layers > button')?.getClientRects().length), 'active map overlay control');
    await click('map', '.bpb-map-layers > button');await wait(() => evaluate(() => !!document.querySelector('.bpb-custom-source input[type=checkbox]')), 'private layer row');
    await evaluate(() => { window.privateMessages = [];window.addEventListener('message', event => { if (event.data?.__bpbCustomOverlays) window.privateMessages.push(JSON.stringify(event.data)); }); });
    await click('map', '.bpb-custom-source input[type=checkbox]');await waitForCondition(() => evaluate(() => ({ text: document.querySelector('.bpb-custom-feedback')?.textContent,summary: document.querySelector('.bpb-custom-source summary')?.innerText,
        frames: [...document.querySelectorAll('iframe')].map(frame => { try { const w = frame.contentWindow;return { url: w.location.pathname, hidden: w.document.hidden, width: w.innerWidth, height: w.innerHeight, tiles: w.document.querySelectorAll('.bpb-custom-overlays canvas').length, pane: w.mapsPlaceholder?.getPane('bpb-custom-overlays')?.outerHTML.slice(0,800),map: w.mapsPlaceholder && {zoom:w.mapsPlaceholder.getZoom(),size:w.mapsPlaceholder.getSize(),layers:Object.values(w.mapsPlaceholder._layers).map(l=>({grid:!!l.createTile,tiles:l._tiles&&Object.keys(l._tiles).length,min:l.options?.minZoom,max:l.options?.maxZoom,loaded:l._loading}))} }; } catch { return {}; } }) })), { description: 'unapproved request rejected',isReady: value => value.text?.includes('Approve') });assert.equal(requests.length, 1, 'only the explicit Settings metadata check may fetch before map approval');
    await evaluate(() => document.querySelector('.bpb-custom-source').open = true);
    const grantLabel = `${PRIVATE_LIMITS.grantRequests.toLocaleString('en-US')} requests for ${PRIVATE_LIMITS.grantMs / 3600000} hours`;
    assert((await evaluate(() => document.querySelector('.bpb-custom-feedback').textContent)).includes(grantLabel), 'map must explain the enforced allowance');
    const review = await openReview();await waitForCondition(() => review(() => ({ ready: document.getElementById('allow').getAttribute('aria-disabled') === 'false', status: document.getElementById('status').textContent })), { description: 'approval details', isReady: value => value.ready });
    assert.equal(await review(() => document.querySelector('strong').textContent), grantLabel);
    assert((await review(() => document.querySelector('.sub').textContent)).includes(`${PRIVATE_LIMITS.hourlyRequests.toLocaleString('en-US')} requests per hour and ${PRIVATE_LIMITS.dailyRequests.toLocaleString('en-US')} per day`));
    for (const width of [1000, kind === 'firefox' ? 500 : 375]) for (const theme of ['light', 'dark']) {
        await setReviewViewport({ width, height: 900 });await review(theme === 'dark'
            ? () => { document.documentElement.dataset.bpbTheme = 'dark'; }
            : () => { document.documentElement.dataset.bpbTheme = 'light'; });
        const fit = await review(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, actions: [...document.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect();return { left: rect.left, right: rect.right, height: rect.height, visible: !!button.getClientRects().length };
        }) }));
        assert(!fit.overflow);assert(fit.actions.every(action => action.visible && action.left >= 0 && action.right <= width && action.height >= 44), 'approval actions must fit the viewport');
        if (shots) await shot('access', path.join(shots, `private-${kind}-approval-${width}-${theme}.png`));
    }
    const approvalGeometry = () => review(() => [...document.querySelectorAll('h1,.actions button')].map(element => {
        const rect = element.getBoundingClientRect();return [rect.x, rect.y, rect.width, rect.height];
    }).concat([[scrollY]]));
    const approvalBefore = await approvalGeometry();
    await click('access', '#allow');await wait(() => review(() => document.getElementById('status').textContent.startsWith('Approved.')), 'approved map allowance');
    const approvalAfter = await approvalGeometry();assert(approvalAfter.every((rect, index) => rect.every((value, axis) => Math.abs(value - approvalBefore[index][axis]) <= 1)), 'approval actions and reading position must remain anchored');
    await setReviewViewport({ width: 1000, height: 900 });
    await activate('map');await click('map', '.bpb-custom-actions button:not([data-bpb-private-layer])');
    await waitForCondition(() => evaluate(() => ({ summary: document.querySelector('.bpb-custom-source summary')?.innerText, feedback: document.querySelector('.bpb-custom-feedback')?.textContent,
        replies: window.privateMessages.filter(text => text.includes('privateReply')).map(text => { const data = JSON.parse(text);return { ok: data.reply?.ok, code: data.reply?.code, diagnostic: data.reply?.diagnostic }; }).slice(-5) })), { description: 'private raster painted in 2D',timeoutMs: 30000,isReady: value => value.summary?.includes('60%') });assert(requests.length > 0);
    assert(!await evaluate(value => document.documentElement.outerHTML.includes(value) || window.privateMessages.some(text => text.includes(value)), secret), 'secret appeared in Peakbagger DOM or messages');
    // Malicious MAIN messages can request only stored resources, never a URL or
    // a different document's secret. Synthetic events cannot open approval.
    const before = requests.length;await evaluate(() => {
        const row = document.querySelector('[data-bpb-private-layer]');row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        window.postMessage({ __bpbCustomOverlays: true, dir: 'toCS', type: 'privateGet', message: { requestId: 'forged', id: row.dataset.bpbPrivateLayer, revision: Number(row.dataset.revision), resource: 'fetch', url: 'https://evil.example/leak' } }, location.origin);
    });await wait(() => evaluate(() => window.privateMessages.some(text => text.includes('forged') && text.includes('privateReply'))), 'forged destination rejected');assert.equal(requests.length, before);
    if (shots) await shot('map', path.join(shots, `private-${kind}-2d.png`));
    await click('map', '#bpb-terrain-toggle');if (await evaluate(() => !!document.querySelector('.bpb-terrain-consent-primary'))) await click('map', '.bpb-terrain-consent-primary');
    await wait(() => evaluate(() => !!document.querySelector('#bpb-terrain-frame')), '3D frame');
    const renderer = await wait(async () => { try { return await terrainEvaluate(() => { const canvas = document.querySelector('canvas.maplibregl-canvas'), gl = canvas?.getContext('webgl2');const info = gl?.getExtension('WEBGL_debug_renderer_info');return info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL); }); } catch { return null; } }, 'hardware WebGL');
    assert(!/swiftshader|software|llvmpipe/i.test(renderer));await wait(() => evaluate(() => document.querySelector('.bpb-custom-source summary')?.innerText.includes('60%')), 'private raster painted in 3D');
    assert(await terrainEvaluate(() => Number(document.documentElement.dataset.verificationPrivateReads) > 0), '3D must read tiles through the worker, including cache hits');
    if (shots) await shot('map', path.join(shots, `private-${kind}-3d.png`));
    // A first completed paint can precede MapLibre's remaining tile queue.
    // Establish network quiescence before attributing requests to the reload.
    await waitForCondition(() => ({ quietMs:performance.now()-lastProviderRequest, requests:requests.length }), { description:'private provider idle after 3D tiles',isReady:value=>value.quietMs>=500 });
    const beforeReload = requests.length;await evaluate(() => location.reload());await wait(() => evaluate(() => !!document.querySelector('#bpb-terrain-toggle')), 'map reloaded');
    await wait(() => evaluate(() => !!document.querySelector('.bpb-map-layers > button')?.getClientRects().length), 'reloaded map overlay control');
    await click('map', '.bpb-map-layers > button');await click('map', '.bpb-custom-source input[type=checkbox]');
    await wait(() => evaluate(() => document.querySelector('.bpb-custom-feedback')?.textContent.includes('Approve')), 'navigation revoked private approval');assert.equal(requests.length, beforeReload);
    console.log(JSON.stringify({ verification: 'private-layers', kind, version, hidden: true, viewport: '1000x900', editorWidths: [1000, kind === 'firefox' ? 500 : 375], requests: requests.length, renderer, noPreapprovalMapRequests: true, metadataDetectedPrivately: true, secretAbsentFromPageAndPublicStorage: true, privateMapFileRoundTrip: true, permissionFixture: 'pregranted', nativePermissionPrompt: 'not tested' }));
    await resources.dispose();
} catch (error) { await resources.dispose(error); }
