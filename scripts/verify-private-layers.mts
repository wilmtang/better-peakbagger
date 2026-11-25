// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import { createBrowserFixtureServer, createFixtureCertificate, waitForCondition as untypedWaitForCondition } from './browser-verification-fixtures.mts';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mts';
import { snowMapDocument, snowMapDem } from './verify-snow-map-fixture.mts';
import { prepareFirefoxSource } from './run-firefox.mts';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mts';
import { setFirefoxContentViewport } from './firefox-content-viewport.mts';
import { PRIVATE_LIMITS } from '../src/maps/custom-overlay-private.ts';
import { createVerificationRoot } from './verification-launch.mts';
import type { Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => T | Promise<T>, options: { description: string; timeoutMs?: number; isReady?: (value: T) => unknown }) => Promise<T>;
// Browser-neutral page access: Playwright evaluates the function, WebDriver its source.
type PageFn = <T>(fn: (arg: never) => T, arg?: unknown) => Promise<Awaited<T>>;
type Surface = 'map' | 'options' | 'editor' | 'access';
type Field = HTMLInputElement & HTMLDetailsElement;
type Geometry = Record<string, number[]>;
interface RefreshGeometry { rectangles: number[][]; scroll: number; focus: boolean }
// Page-world message log; callbacks cast in place so the shared program keeps Window unchanged.
interface PrivateWindow { privateMessages: string[] }
interface DiagnosticMap { getPane(name: string): HTMLElement | undefined; getZoom(): number; getSize(): unknown;
    _layers: Record<string, { createTile?: unknown; _tiles?: object; options?: { minZoom?: number; maxZoom?: number }; _loading?: unknown }> }
const [kind, ...args] = process.argv.slice(2);
assert(['chrome', 'firefox'].includes(kind) && args.every(arg => arg.startsWith('--screenshots=')), 'Usage: node scripts/verify-private-layers.mts chrome|firefox [--screenshots=PATH]');
const shots = args.find(arg => arg.startsWith('--screenshots='))?.slice(14), secret = 'fixture_KEY+PRIVATE/123';
const resources = createResourceStack();
try {
    const root = await createVerificationRoot(resources, 'bpb-private-layers-', 'private layer files');
    const source = path.join(root, 'source');await cp(path.resolve('dist'), source, { recursive: true });
    const manifestFile = path.join(source, 'manifest.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    // Test-only pregrant. Native browser permission dialogs are not exercised.
    manifest.host_permissions.push('https://tiles.example.com/*');await writeFile(manifestFile, JSON.stringify(manifest));
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
        api.runtime.sendMessage=message=>{
            if(message.type==='CUSTOM_PRIVATE_GET')document.documentElement.dataset.verificationPrivateReads=String(Number(document.documentElement.dataset.verificationPrivateReads||0)+1);
            if(message.type==='CUSTOM_PRIVATE_GET'&&message.resource==='metadata'&&document.documentElement.dataset.verificationMetadataReady!=='true'){
                document.documentElement.dataset.verificationMetadataFailure='done';return Promise.resolve({ok:false,code:'private-source'});
            }
            return original(message);
        };}
    `);
    const html = await snowMapDocument(), fixture = await createBrowserFixtureServer({ temporaryRoot: root, masterMapDocument: html, peakMapDocument: html,
        bigMapDocument: '<!doctype html><style>html,body{margin:0;height:100%}iframe{width:100%;height:650px;border:0}</style><iframe id="if" src="/map/MasterMap.aspx?t=G&amp;d=2296&amp;gt=rc"></iframe>' } as never);resources.defer('Peakbagger fixture', () => fixture.close());
    const providerRoot = path.join(root, 'provider');await mkdir(providerRoot);const cert = await createFixtureCertificate({ directory: providerRoot as never });assert.ok(cert);
    const requests: { path: string; origin: string | undefined }[] = [];let png: Buffer | undefined, sourceVersion = 0, holdMetadata = false, denyMetadata = false; const metadataReleases: (() => void)[] = [];let lastProviderRequest = performance.now();
    resources.defer('held metadata', () => { holdMetadata = false; metadataReleases.splice(0).forEach(resolve => resolve()); });
    const server = createServer(cert, async (request, response) => {
        const url = new URL(request.url!, 'https://tiles.example.com');requests.push({ path: url.pathname, origin: request.headers.origin });lastProviderRequest = performance.now();
        assert.equal(url.searchParams.get('api_key'), secret);assert.equal(request.headers.cookie, undefined);assert.equal(request.headers.referer, undefined);
        if (url.pathname === '/source.json') {
            if (holdMetadata) await new Promise<void>(resolve => metadataReleases.push(resolve));
            if (denyMetadata) { response.writeHead(503); response.end(); return; }
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ tilejson: '3.0.0', minzoom: 0, maxzoom: sourceVersion % 4 === 2 ? 17 : 18,
                tiles: [`https://${request.headers.host}/tiles-${sourceVersion}/{z}/{x}/{y}.png?signed=${sourceVersion}`] }));return;
        }
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });response.end(png);
    });resources.defer('private provider', () => closeServer(server));await listenServer(server, 0, '127.0.0.1');
    const origin = `https://www.peakbagger.com:${fixture.port}`, provider = `https://tiles.example.com:${(server.address() as AddressInfo).port}`;
    let evaluate: PageFn, admin: PageFn, click: (surface: Surface, selector: string) => Promise<unknown>, fill: (selector: string, value: string) => Promise<unknown>,
        inside: PageFn, activate: (surface: Surface) => Promise<unknown>, openReview: () => Promise<PageFn>,
        setViewport: (size: { width: number; height: number }) => Promise<unknown>, setReviewViewport: (size: { width: number; height: number }) => Promise<unknown>,
        setMapViewport: (size: { width: number; height: number }) => Promise<unknown>, press: (selector: string) => Promise<unknown>,
        shot: (surface: Surface, file: string) => Promise<unknown>, extensionUrl: string, version: string, terrainEvaluate: PageFn;
    if (kind === 'chrome') {
        // Loaded here so the Firefox path does not need Playwright installed.
        const { launchVerificationChrome, PEAKBAGGER_HOST_RULE } = await import('./verification-launch.mts');
        const trust = '--ignore-certificate-errors-spki-list=' + [fixture, cert].flatMap(item => item.chromeTrustArgs.map((arg: string) => arg.split('=').slice(1).join('='))).join(',');
        const context = await launchVerificationChrome(resources, 'private Chrome', path.join(root, 'profile'), { viewport: { width: 1000, height: 900 },ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            trustArgs: [trust], args: ['--no-proxy-server'], hosts: [PEAKBAGGER_HOST_RULE, 'tiles.example.com 127.0.0.1'], extension: source });
        await context.route('https://tiles.mapterhorn.com/**', route => route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' },body: snowMapDem }));
        const registry = await context.newPage();await registry.goto('chrome://extensions-internals/');
        const extension = await registry.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find((item: { name: string; id: string }) => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
        let access!: Page;
        extensionUrl = `chrome-extension://${extension.id}`;const options = await context.newPage();await options.goto(extensionUrl + '/options/options.html#custom-map-layers');
        const map = await context.newPage();await map.goto(origin + '/map/BigMap.aspx?t=A');
        evaluate = (fn, arg) => map.evaluate(fn as (value: unknown) => never, arg);admin = (fn, arg) => options.evaluate(fn as (value: unknown) => never, arg);
        inside = async (fn, arg) => options.frames().find(frame => frame.url().includes('/custom-overlay/editor.html'))?.evaluate(fn as (value: unknown) => never, arg) as Promise<never>;
        click = (surface, selector) => surface === 'editor' ? options.frameLocator('#custom-layer-dialog iframe').locator(selector).click() : (surface === 'access' ? access : surface === 'options' ? options : map).locator(selector).click();
        fill = (selector, value) => options.frameLocator('#custom-layer-dialog iframe').locator(selector).fill(value);
        activate = surface => (surface === 'options' ? options : map).bringToFront();
        openReview = async () => { const next = context.waitForEvent('page');await click('map', '[data-bpb-private-layer]');access = await next;await access.waitForLoadState();return (fn => access.evaluate(fn as () => never)) as PageFn; };
        setViewport = size => options.setViewportSize(size);shot = (surface, file) => (surface === 'access' ? access : surface === 'options' ? options : map).screenshot({ path: file });version = context.browser()!.version();
        setReviewViewport = size => access.setViewportSize(size);
        setMapViewport = size => map.setViewportSize(size); press = selector => map.locator(selector).press('Enter');
        terrainEvaluate = (fn, arg) => map.frames().find(frame => frame.url().includes('/terrain/terrain.html'))?.evaluate(fn as (value: unknown) => never, arg) as Promise<never>;
    } else {
        const { Builder, By, Key } = await import('selenium-webdriver'), firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot: root, distDir: source });resources.defer('private Firefox source', () => prepared.cleanup());resources.defer('private Firefox processes', () => stopOwnedFirefoxProcesses(root));
        const profile = path.join(root, 'profile');await mkdir(profile);
        const configuration = new firefox.Options().addArguments('-headless', '-no-remote').setProfile(profile)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,tiles.example.com').setPreference('webgl.sanitize-unmasked-renderer', false);
        configuration.enableBidi(); configuration.setAcceptInsecureCerts(true);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(configuration).setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${root}`)).build() as FirefoxDriver;resources.defer('private Firefox', () => quitFirefoxDriver(driver, root));
        const addon = await driver.installAddon(prepared.sourceDir, true);await driver.setContext(firefox.Context.CHROME);
        extensionUrl = (await driver.executeScript<string>('return WebExtensionPolicy.getByID(arguments[0]).getURL("");', addon)).replace(/\/$/, '');await driver.setContext(firefox.Context.CONTENT);
        await driver.get(extensionUrl + '/options/options.html#custom-map-layers');const options = await driver.getWindowHandle();await driver.switchTo().newWindow('tab');const map = await driver.getWindowHandle();let access!: string;await driver.get(origin + '/map/BigMap.aspx?t=A');
        const run = async (handle: string, fn: (arg: never) => unknown, arg?: unknown) => { await driver.switchTo().window(handle);return driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null) as Promise<never>; };
        evaluate = (fn, arg) => run(map, fn, arg);admin = (fn, arg) => run(options, fn, arg);
        inside = async (fn, arg) => { await driver.switchTo().window(options);try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));return await (driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null) as Promise<never>); } finally { await driver.switchTo().defaultContent(); } };
        click = async (surface, selector) => { await driver.switchTo().window(surface === 'access' ? access : surface === 'options' || surface === 'editor' ? options : map);try {
            if (surface === 'editor') await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));await driver.findElement(By.css(selector)).click();
        } finally { await driver.switchTo().defaultContent(); } };
        fill = async (selector, value) => { await driver.switchTo().window(options);try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));const field = await driver.findElement(By.css(selector));await field.clear();await field.sendKeys(value); } finally { await driver.switchTo().defaultContent(); } };
        activate = async surface => { const handle = surface === 'options' ? options : map;
            if (surface !== 'options') await admin(async (target: string) => { const api = (globalThis as { browser?: typeof chrome }).browser || chrome;const tabs = await api.tabs.query({});const tab = tabs.find(item => item.url === target)!;await api.tabs.update(tab.id!, { active: true }); }, origin + '/map/BigMap.aspx?t=A');
            await driver.switchTo().window(handle);
        };
        openReview = async () => { const before = await driver.getAllWindowHandles();await click('map', '[data-bpb-private-layer]');access = (await waitForCondition(async () => (await driver.getAllWindowHandles()).find(handle => !before.includes(handle)), { description: 'Firefox approval tab' }))!;return (fn => run(access, fn)) as PageFn; };
        setViewport = async size => { await driver.switchTo().window(options);await driver.manage().window().setRect({ width: Math.max(500, size.width), height: size.height + 85 }); };
        // Firefox BiDi cannot override a privileged extension-page viewport.
        setReviewViewport = async size => { await driver.switchTo().window(access);await driver.manage().window().setRect({ width: Math.max(500, size.width), height: size.height + 85 }); };
        shot = async (surface, file) => { await driver.switchTo().window(surface === 'access' ? access : surface === 'options' ? options : map);await writeFile(file, await driver.takeScreenshot(), 'base64'); };version = (await driver.getCapabilities()).getBrowserVersion() as string;
        terrainEvaluate = async fn => { await driver.switchTo().window(map);try { await driver.switchTo().frame(await driver.findElement(By.id('bpb-terrain-frame')));return await (driver.executeScript(`return (${fn})();`) as Promise<never>); } finally { await driver.switchTo().defaultContent(); } };
        setMapViewport = async size => { await driver.switchTo().window(map); await setFirefoxContentViewport(driver, size); };
        press = async selector => { await driver.switchTo().window(map); await driver.findElement(By.css(selector)).sendKeys(Key.ENTER); };
        await setFirefoxContentViewport(driver, { width: 1000, height: 900 });
    }
    const wait = <T,>(fn: () => T | Promise<T>, description: string) => waitForCondition(fn, { description, timeoutMs: 30000 });
    png = Buffer.from(await evaluate(() => { const canvas = document.createElement('canvas');canvas.width = canvas.height = 256;const ctx = canvas.getContext('2d')!;ctx.fillStyle = '#d22';ctx.fillRect(0, 0, 256, 256);return canvas.toDataURL().split(',')[1]; }), 'base64');
    await admin(async () => ((globalThis as { browser?: typeof chrome }).browser || chrome).runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: { showSnotel: false, showWeather: false, showSunMoon: false, enable3dMap: true, terrainCacheLimitMb: 0 } }));
    await evaluate(() => location.reload());await wait(() => evaluate(() => !!document.querySelector('#bpb-terrain-toggle')), '3D toggle after authoritative settings');
    await click('options', '#custom-layer-add');await wait(() => inside(() => !!document.getElementById('name')), 'Settings editor');
    await fill('#name', 'Private tiles');await fill('#url', `${provider}/source.json`);await click('editor', '#private-parameters > summary');await click('editor', '#add-parameter');
    await fill('.parameter-row input[id^=parameter-key]', 'api_key');await fill('.parameter-row input[id^=parameter-value]', secret);
    for (const width of [1000, 375]) for (const theme of ['light', 'dark']) {
        await setViewport({ width, height: 900 });await inside((value: string) => { document.documentElement.dataset.theme = value; }, theme);
        const fit = await inside(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, fieldsOverflow:(document.getElementById('editor-fields') as Field).scrollWidth>(document.getElementById('editor-fields') as Field).clientWidth, hidden: document.querySelector<Field>('.parameter-row input[type=password]')!.value.length > 0 }));assert(!fit.overflow);assert(!fit.fieldsOverflow,`private fields overflow: ${JSON.stringify(fit)}`);assert(fit.hidden);
        if (shots) { await mkdir(shots, { recursive: true });await shot('options', path.join(shots, `private-${kind}-editor-${width}-${theme}.png`)); }
        await click('editor', '#private-access-help > summary');
        await inside(() => (document.getElementById('private-access-help') as Field).scrollIntoView({ block:'center' }));
        const helpFit=await inside(()=>{
            const area=document.getElementById('editor-fields')!;
            return {root:document.documentElement.scrollWidth<=innerWidth,available:area.clientWidth,content:area.scrollWidth,
                wide:[...area.querySelectorAll('p,fieldset,details')].filter(item=>item.scrollWidth>item.clientWidth).map(item=>({tag:item.tagName,id:item.id,available:item.clientWidth,content:item.scrollWidth}))};
        });assert(helpFit.root&&helpFit.content<=helpFit.available,`approval help fits the editor: ${JSON.stringify(helpFit)}`);
        if (shots) await shot('options', path.join(shots, `private-${kind}-help-${width}-${theme}.png`));
        await click('editor', '#private-access-help > summary');
    }
    await inside(() => { document.documentElement.dataset.verificationSave = 'hold';(document.getElementById('save') as Field).scrollIntoView({ block: 'center', behavior: 'instant' }); });
    const geometry = () => inside((): Geometry => Object.fromEntries(['save', 'test', 'cancel', 'private-parameters'].map(id => { const r = document.getElementById(id)!.getBoundingClientRect();return [id, [r.x, r.y, r.width, r.height]]; }).concat([['scroll', [(document.getElementById('editor-fields') as Field).scrollTop]], ['focus', [document.activeElement?.id === 'save' ? 1 : 0]]])));
    await inside(() => (document.getElementById('save') as Field).focus({ preventScroll: true }));const anchored = await geometry();
    const stable = async () => { const after = await geometry();for (const region of Object.keys(anchored)) for (const [index, value] of after[region].entries()) assert(Math.abs(value - anchored[region][index]) <= 1, `private Save ${region} moved`);assert.equal(after.focus[0], 1); };
    for (const outcome of ['error', 'success']) {
        const writes = await inside(() => Number(document.documentElement.dataset.verificationSaves || 0));
        await click('editor', '#save');await wait(() => inside(() => Number(document.documentElement.dataset.verificationSaves || 0)).then(count => count > writes), 'private source detected and save write pending');await stable();
        const attempts = await inside(() => document.documentElement.dataset.verificationSaves);await inside(() => (document.getElementById('save') as Field).click());assert.equal(await inside(() => document.documentElement.dataset.verificationSaves), attempts);
        await inside((result: string) => { document.documentElement.dataset.verificationRelease = result; }, outcome);
        await wait(() => inside(() => (document.getElementById('save') as Field).getAttribute('aria-disabled') === 'false'), 'private save settled');await stable();
        assert.equal(await inside(() => document.querySelector<Field>('.parameter-row input[type=password]')!.value), secret);
    }
    assert.equal(await inside(() => (document.getElementById('feedback') as Field).textContent), 'Saved on this device.');
    assert.equal(await inside(() => (document.getElementById('advanced') as Field).open), false, 'private metadata detection must not require Advanced');
    assert.equal(requests.filter(request => request.path === '/source.json').length, 1, 'Settings reads private metadata once');
    await setViewport({ width: 1000, height: 900 });
    const snapshot = await admin(async () => { const api = (globalThis as { browser?: typeof chrome }).browser || chrome;return { local: await api.storage.local.get(null), exported: await api.runtime.sendMessage({ type: 'SETTINGS_FILE_EXPORT' }) as { ok: boolean; content: string } }; });
    assert(!JSON.stringify(snapshot.local).includes(secret), 'secret leaked into storage.local');
    assert(snapshot.exported.ok && snapshot.exported.content.includes(secret), 'manual settings files include private map parameters without the account credential checkbox');
    await click('editor', '#cancel');await wait(() => admin(() => !(document.getElementById('custom-layer-dialog') as Field).open), 'editor dismissed');
    // Supply only this synthetic file at the native input boundary; retain the
    // shipped parser, review, confirmation and worker transaction.
    await admin((content: string) => {
        const transfer = new DataTransfer();transfer.items.add(new File([content], 'private-map-settings.json', { type:'application/json' }));
        const input = document.getElementById('settings-backup-file') as HTMLInputElement;input.files = transfer.files;input.dispatchEvent(new Event('change', { bubbles:true }));
    }, JSON.stringify((() => {
        const file = JSON.parse(snapshot.exported.content);
        // A supported metadata-only definition forces each new renderer to
        // initialize from metadata; pre-resolved tile arrays mask Retry bugs.
        file.privateCustomLayers[0].source.source.tiles = [];
        file.customLayers.sources[0].source.tiles = [];
        return file;
    })()));
    await wait(() => admin(() => !(document.getElementById('settings-backup-confirmation') as Field).hidden), 'private settings import review');
    assert(await admin(() => (document.getElementById('settings-backup-confirmation-detail') as Field).textContent.includes('Includes private map URLs and request parameters.')));
    for (const width of [1000, kind === 'firefox' ? 500 : 375]) for (const theme of ['light','dark']) {
        await setViewport({ width,height:900 });await admin((value: string) => {
            document.documentElement.dataset.bpbTheme = value;location.hash = '#github-settings-backup';
            (document.getElementById('settings-backup-confirmation') as Field).scrollIntoView({ block:'center',behavior:'instant' });
        }, theme);
        await wait(() => admin(() => {
            const rect = (document.getElementById('settings-backup-confirmation') as Field).getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= document.documentElement.clientHeight;
        }), 'settings import review visible in the viewport');
        assert(await admin(() => document.documentElement.scrollWidth <= innerWidth), 'settings file review fits the viewport');
        if (shots) await shot('options',path.join(shots,`private-${kind}-file-review-${width}-${theme}.png`));
    }
    await click('options','#settings-backup-confirm');
    await wait(() => admin(() => (document.getElementById('settings-backup-confirmation') as Field).hidden), 'private map file imported through Settings');
    await setViewport({ width:1000,height:900 });
    console.log(JSON.stringify({ stage: 'saved', library: await admin(() => ({ status: (document.getElementById('custom-layer-status') as Field).textContent, rows: (document.getElementById('custom-layer-list') as Field).children.length, dialog: (document.getElementById('custom-layer-dialog') as Field).open })) }));
    await click('options', '#custom-layer-list .custom-layer-actions > button:first-of-type');await wait(() => inside(() => (document.querySelector<Field>('.parameter-row input[type=password]')?.value.length ?? 0) > 0), 'saved parameter restored for editing');
    assert.equal(await inside(() => document.querySelector<Field>('.parameter-row input[type=password]')!.value), secret);await click('editor', '#cancel');await wait(() => admin(() => !(document.getElementById('custom-layer-dialog') as Field).open), 'edit dismissed');
    await activate('map');await wait(() => evaluate(() => !!document.querySelector<Field>('.bpb-map-layers > button')?.getClientRects().length), 'active map overlay control');
    await click('map', '.bpb-map-layers > button');await wait(() => evaluate(() => !!document.querySelector('.bpb-custom-source input[type=checkbox]')), 'private layer row');
    await evaluate(() => { const log = window as unknown as PrivateWindow;log.privateMessages = [];window.addEventListener('message', event => { if (event.data?.__bpbCustomOverlays) log.privateMessages.push(JSON.stringify(event.data)); }); });
    await click('map', '.bpb-custom-source input[type=checkbox]');await waitForCondition(() => evaluate(() => ({ text: document.querySelector<Field>('.bpb-custom-feedback')?.textContent,summary: document.querySelector<Field>('.bpb-custom-source summary')?.innerText,
        frames: [...document.querySelectorAll('iframe')].map(frame => { try { const w = frame.contentWindow as unknown as { location: Location; document: Document; innerWidth: number; innerHeight: number; mapsPlaceholder?: DiagnosticMap };return { url: w.location.pathname, hidden: w.document.hidden, width: w.innerWidth, height: w.innerHeight, tiles: w.document.querySelectorAll('.bpb-custom-overlays canvas').length, pane: w.mapsPlaceholder?.getPane('bpb-custom-overlays')?.outerHTML.slice(0,800),map: w.mapsPlaceholder && {zoom:w.mapsPlaceholder.getZoom(),size:w.mapsPlaceholder.getSize(),layers:Object.values(w.mapsPlaceholder._layers).map(l=>({grid:!!l.createTile,tiles:l._tiles&&Object.keys(l._tiles).length,min:l.options?.minZoom,max:l.options?.maxZoom,loaded:l._loading}))} }; } catch { return {}; } }) })), { description: 'unapproved request rejected',isReady: value => value.text?.includes('Approve') });assert.equal(requests.length, 1, 'only the explicit Settings metadata check may fetch before map approval');
    await evaluate(() => { document.querySelector<Field>('.bpb-custom-source')!.open = true; });
    const grantLabel = `${PRIVATE_LIMITS.grantRequests.toLocaleString('en-US')} requests for ${PRIVATE_LIMITS.grantMs / 3600000} hours`;
    assert((await evaluate(() => document.querySelector('.bpb-custom-feedback')!.textContent || '')).includes(grantLabel), 'map must explain the enforced allowance');
    const review = await openReview();await waitForCondition(() => review(() => ({ ready: (document.getElementById('allow') as Field).getAttribute('aria-disabled') === 'false', status: (document.getElementById('status') as Field).textContent })), { description: 'approval details', isReady: value => value.ready });
    assert.equal(await review(() => document.querySelector<Field>('strong')!.textContent), grantLabel);
    assert((await review(() => document.querySelector('.sub')!.textContent || '')).includes(`${PRIVATE_LIMITS.hourlyRequests.toLocaleString('en-US')} requests per hour and ${PRIVATE_LIMITS.dailyRequests.toLocaleString('en-US')} per day`));
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
    await click('access', '#allow');await wait(() => review(() => (document.getElementById('status') as Field).textContent.startsWith('Approved.')), 'approved map allowance');
    const approvalAfter = await approvalGeometry();assert(approvalAfter.every((rect, index) => rect.every((value, axis) => Math.abs(value - approvalBefore[index][axis]) <= 1)), 'approval actions and reading position must remain anchored');
    await setReviewViewport({ width: 1000, height: 900 });
    await activate('map');await click('map', '.bpb-custom-actions button:not([data-bpb-private-layer])');
    await waitForCondition(() => evaluate(() => ({ summary: document.querySelector<Field>('.bpb-custom-source summary')?.innerText, feedback: document.querySelector<Field>('.bpb-custom-feedback')?.textContent,
        replies: (window as unknown as PrivateWindow).privateMessages.filter(text => text.includes('privateReply')).map(text => { const data = JSON.parse(text);return { ok: data.reply?.ok, code: data.reply?.code, diagnostic: data.reply?.diagnostic }; }).slice(-5) })), { description: 'private raster painted in 2D',timeoutMs: 30000,isReady: value => value.summary?.includes('60%') });assert(requests.length > 0);
    assert(!await evaluate((value: string) => document.documentElement.outerHTML.includes(value) || (window as unknown as PrivateWindow).privateMessages.some(text => text.includes(value)), secret), 'secret appeared in Peakbagger DOM or messages');
    const refreshSelector = '.bpb-custom-actions button:not([data-bpb-private-layer])';
    const refreshGeometry = () => evaluate((selector: string): RefreshGeometry => ({
        rectangles: [document.querySelector(selector), document.querySelector('.bpb-custom-source summary'), document.querySelector('.bpb-map-layers > button')].map(element => {
            const rect = element!.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }),
        scroll: scrollY, focus: document.activeElement === document.querySelector(selector),
    }), refreshSelector);
    const assertRefreshGeometry = (before: RefreshGeometry, after: RefreshGeometry, phase: string) => {
        assert.equal(after.scroll, before.scroll, phase + ' keeps reading position'); assert(after.focus, phase + ' retains keyboard focus');
        for (const [index, rect] of after.rectangles.entries()) for (const [axis, value] of rect.entries()) assert(Math.abs(value - before.rectangles[index][axis]) <= 1, phase + ' moves a control or summary');
    };
    const refreshMatrix = async (mode: string) => {
        for (const width of [1000, 390]) for (const theme of ['light', 'dark']) for (const outcome of ['error', 'success']) {
            await setMapViewport({ width, height: 900 });
            await evaluate((value: { theme: string; width: number }) => {
                document.documentElement.dataset.bpbTheme = value.theme;
                document.querySelector<HTMLElement>('.bpb-map-layers')!.style.fontSize = value.width === 390 && value.theme === 'dark' ? '20px' : '';
            }, { theme, width });
            await waitForCondition(() => ({ quiet: performance.now() - lastProviderRequest }), { description: 'tiles settle before refresh', isReady: value => value.quiet >= 500 });
            await evaluate((selector: string) => document.querySelector<HTMLElement>(selector)!.focus({ preventScroll: true }), refreshSelector);
            await evaluate((selector: string) => document.querySelector(selector)!.scrollIntoView({ block: 'nearest' }), refreshSelector);
            const beforeRefresh = await refreshGeometry();
            sourceVersion++; holdMetadata = true; denyMetadata = outcome === 'error';
            await press(refreshSelector);
            await wait(() => metadataReleases.length > 0, 'held metadata request');
            assertRefreshGeometry(beforeRefresh, await refreshGeometry(), mode + ' pending');
            const attempts = requests.filter(item => item.path === '/source.json').length;
            await press(refreshSelector); assert.equal(requests.filter(item => item.path === '/source.json').length, attempts, 'busy keyboard activation is suppressed');
            holdMetadata = false; metadataReleases.splice(0).forEach(resolve => resolve());
            if (outcome === 'success') {
                await wait(() => evaluate(() => document.querySelector<Field>('.bpb-custom-source summary')?.innerText.includes('60%')), 'Reload completes');
                await wait(() => requests.some(item => item.path.startsWith(`/tiles-${sourceVersion}/`)), 'Reload uses changed metadata tile endpoints');
            } else await wait(() => evaluate(() => document.querySelector<Field>('.bpb-custom-source summary')?.innerText.includes('Partly loaded')), 'failed refresh retains old loaded output');
            assertRefreshGeometry(beforeRefresh, await refreshGeometry(), mode + ' ' + outcome);
            denyMetadata = false;
            if (shots) await shot('map', path.join(shots, `private-${kind}-${mode}-reload-${width}-${theme}-${outcome}.png`));
        }
        await setMapViewport({ width: 1000, height: 900 });
    };
    await refreshMatrix('2d');
    // Malicious MAIN messages can request only stored resources, never a URL or
    // a different document's secret. Synthetic events cannot open approval.
    await waitForCondition(() => ({ quietMs:performance.now()-lastProviderRequest }),{description:'private provider idle after 2D tiles',isReady:value=>value.quietMs>=500});
    const before = requests.length;await evaluate(() => {
        const row = document.querySelector<HTMLElement>('[data-bpb-private-layer]')!;row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        window.postMessage({ __bpbCustomOverlays: true, dir: 'toCS', type: 'privateGet', message: { requestId: 'forged', id: row.dataset.bpbPrivateLayer, revision: Number(row.dataset.revision), resource: 'fetch', url: 'https://evil.example/leak' } }, location.origin);
    });await wait(() => evaluate(() => (window as unknown as PrivateWindow).privateMessages.some(text => text.includes('forged') && text.includes('privateReply'))), 'forged destination rejected');assert.equal(requests.length, before);
    if (shots) await shot('map', path.join(shots, `private-${kind}-2d.png`));
    await click('map', '#bpb-terrain-toggle');if (await evaluate(() => !!document.querySelector('.bpb-terrain-consent-primary'))) await click('map', '.bpb-terrain-consent-primary');
    await wait(() => evaluate(() => !!document.querySelector('#bpb-terrain-frame')), '3D frame');
    const renderer = await wait(async () => { try { return await terrainEvaluate(() => { const canvas = document.querySelector<HTMLCanvasElement>('canvas.maplibregl-canvas'), gl = canvas?.getContext('webgl2');const info = gl?.getExtension('WEBGL_debug_renderer_info');return info && gl!.getParameter(info.UNMASKED_RENDERER_WEBGL) as string; }); } catch { return null; } }, 'hardware WebGL');
    assert(!/swiftshader|software|llvmpipe/i.test(String(renderer)));
    await waitForCondition(async () => ({ summary: await evaluate(() => document.querySelector<Field>('.bpb-custom-source summary')?.innerText), metadataFailure: await terrainEvaluate(() => document.documentElement.dataset.verificationMetadataFailure), reads: await terrainEvaluate(() => document.documentElement.dataset.verificationPrivateReads), feedback: await evaluate(() => document.querySelector<Field>('.bpb-custom-feedback')?.textContent) }), { description: 'initial 3D metadata failure', timeoutMs: 10000, isReady: value => value.metadataFailure === 'done' && value.summary?.includes('Couldn’t load') });
    await terrainEvaluate(() => { document.documentElement.dataset.verificationMetadataReady = 'true'; });
    await click('map', '.bpb-custom-actions button:not([data-bpb-private-layer])');
    await wait(() => evaluate(() => document.querySelector<Field>('.bpb-custom-source summary')?.innerText.includes('60%')), '3D Retry paints a previously missing source');
    assert(await terrainEvaluate(() => Number(document.documentElement.dataset.verificationPrivateReads) > 0), '3D must read tiles through the worker, including cache hits');
    if (shots) await shot('map', path.join(shots, `private-${kind}-3d.png`));
    await refreshMatrix('3d');
    // A first completed paint can precede MapLibre's remaining tile queue.
    // Establish network quiescence before attributing requests to the reload.
    await waitForCondition(() => ({ quietMs:performance.now()-lastProviderRequest, requests:requests.length }), { description:'private provider idle after 3D tiles',isReady:value=>value.quietMs>=500 });
    const beforeReload = requests.length;await evaluate(() => location.reload());await wait(() => evaluate(() => !!document.querySelector('#bpb-terrain-toggle')), 'map reloaded');
    await wait(() => evaluate(() => !!document.querySelector<Field>('.bpb-map-layers > button')?.getClientRects().length), 'reloaded map overlay control');
    await click('map', '.bpb-map-layers > button');await click('map', '.bpb-custom-source input[type=checkbox]');
    await wait(() => evaluate(() => document.querySelector<Field>('.bpb-custom-feedback')?.textContent.includes('Approve')), 'navigation revoked private approval');assert.equal(requests.length, beforeReload);
    console.log(JSON.stringify({ verification: 'private-layers', kind, version, hidden: true, viewport: '1000x900', editorWidths: [1000, kind === 'firefox' ? 500 : 375], requests: requests.length, renderer, noPreapprovalMapRequests: true, metadataDetectedPrivately: true, secretAbsentFromPageAndPublicStorage: true, privateMapFileRoundTrip: true, permissionFixture: 'pregranted', nativePermissionPrompt: 'not tested' }));
    await resources.dispose();
} catch (error) { await resources.dispose(error as null); }
