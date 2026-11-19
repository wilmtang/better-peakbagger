// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixtureCertificate, createBrowserFixtureServer, waitForCondition as untypedWaitForCondition } from './browser-verification-fixtures.mts';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mts';
import { snowMapDocument, snowMapDem } from './verify-snow-map-fixture.mts';
import { prepareFirefoxSource } from './run-firefox.mts';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mts';
import { setFirefoxContentViewport } from './firefox-content-viewport.mts';
import { createVerificationRoot, launchVerificationChrome, PEAKBAGGER_HOST_RULE } from './verification-launch.mts';
import type { Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => T | Promise<T>, options: { description: string; timeoutMs: number; isReady?: (value: T) => boolean }) => Promise<T>;
// Browser-neutral page access: Playwright evaluates the function, WebDriver its source.
type PageFn = <T>(fn: (arg: never) => T, arg?: unknown) => Promise<Awaited<T>>;
type Field = HTMLInputElement;
type Rect = { x: number; y: number; w: number; h: number };
interface SnowGeometry { trigger: Rect; action: Rect; heading: Rect; following: Rect; scrollY: number }
// The MapLibre map the instrumented terrain frame exposes; callbacks cast in place.
interface SnowTerrain { __snowDepthTestMap: {
    getStyle(): { layers: { id: string; source: string }[]; sources: Record<string, { maxzoom?: number }> };
    getPaintProperty(layer: string, property: string): unknown; getSource(id: string): unknown;
    once(type: string, callback: () => void): void; triggerRepaint(): void;
} }
import { snowDepthCatalogue, snowDepthLegend } from '../test/helpers/snow-depth-fixture.mjs';

const [kind, ...args] = process.argv.slice(2);
assert.ok(['chrome', 'firefox'].includes(kind) && !args.length, 'Usage: node scripts/verify-snow-depth.mts chrome|firefox');
const output = process.env.BPB_VERIFY_SNOW_DEPTH_SCREENSHOT_DIR;
const resources = createResourceStack(); let failure: unknown = null, diagnostics: (() => Promise<unknown>) | undefined;
try {
    const temporaryRoot = await createVerificationRoot(resources, 'bpb-snow-depth-', 'snow depth profiles');
    console.log(`Snow depth disposable root: ${temporaryRoot}`);
    const nativeHTML = (await snowMapDocument()).replace('</script></body>', 'window.L_FIX=L.tileLayer(new URLSearchParams(location.search).get(\'base\'),{crossOrigin:true,referrerPolicy:\'no-referrer\',maxNativeZoom:11}).addTo(mapsPlaceholder);</script></body>');
    const fixture = await createBrowserFixtureServer({ temporaryRoot, masterMapDocument: nativeHTML,
        bigMapDocument: '<!doctype html><style>body{margin:0;font:14px system-ui}h1,h2{margin:8px}iframe{display:block;width:100%;height:650px;border:0}</style><h1 id="heading">Peakbagger map</h1><iframe id="if"></iframe><h2 id="following">Following native content</h2><script>document.getElementById("if").src="/map/MasterMap.aspx?t=A&d=2296&base="+encodeURIComponent(new URLSearchParams(location.search).get("base"));</script>' } as never);
    resources.defer('snow depth HTTPS fixture', () => fixture.close());
    const certRoot = path.join(temporaryRoot, 'provider'); await mkdir(certRoot);
    const certificate = await createFixtureCertificate({ directory: certRoot as never }); assert.ok(certificate); resources.defer('snow provider certificate', () => certificate.remove());
    let png: Buffer | undefined, basePNG: Buffer | undefined, mode = 'ready'; const held: (() => void)[] = [], requests: URL[] = [], origins = new Set<string | undefined>();
    const release = (value: string) => { mode = value; held.splice(0).forEach(resolve => resolve()); };
    resources.defer('snow held tiles', () => release('ready'));
    const provider = createServer(certificate, async (request, response) => {
        const url = new URL(request.url!, 'https://snow.example.com');
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
        if (mode === 'hold') await new Promise<void>(resolve => held.push(resolve));
        if (mode === 'error') { response.writeHead(404, headers); response.end(); return; }
        response.writeHead(200, { ...headers, 'content-type': 'image/png' }); response.end(png);
    });
    resources.defer('snow provider server', () => closeServer(provider)); await listenServer(provider, 0, '127.0.0.1');
    const providerOrigin = `https://snow.example.com:${(provider.address() as AddressInfo).port}`, origin = `https://www.peakbagger.com:${fixture.port}`;
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
    let evaluate: PageFn, admin: PageFn, click: (selector: string) => Promise<unknown>, key: (selector: string, value: string) => Promise<unknown>,
        viewport: (size: { width: number; height: number }) => Promise<unknown>, screenshot: (file?: string) => Promise<Buffer>, terrain: PageFn,
        version: string, navigate: (url: string) => Promise<unknown>;
    if (kind === 'chrome') {
        const trust = '--ignore-certificate-errors-spki-list=' + [fixture, certificate].map(item => item.chromeTrustArgs[0].split('=').slice(1).join('=')).join(',');
        const context = await launchVerificationChrome(resources, 'snow Chrome', path.join(temporaryRoot, 'profile'), {
            viewport: { width: 1440, height: 1000 }, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            trustArgs: [trust], args: ['--no-proxy-server'], hosts: [PEAKBAGGER_HOST_RULE, 'snow.example.com 127.0.0.1'], extension: source });
        await context.route('https://tiles.mapterhorn.com/**', route => route.fulfill({ contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: snowMapDem }));
        await context.route('https://base.example.com/**', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: basePNG }));
        const options = await context.newPage(); await options.goto('chrome://extensions-internals/');
        const extension = await options.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find((item: { name: string; id: string }) => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
        await options.goto(`chrome-extension://${extension.id}/options/options.html`);
        const page = await context.newPage();
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        diagnostics = async () => ({ errors: errors.slice(-6), state: await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 500), controls: [...document.querySelectorAll<HTMLElement>('.bpb-map-layers')].map(el => ({ hidden: el.hidden, style: el.getAttribute('style') })), frames: [...document.querySelectorAll('iframe')].map(el => ({ src: el.src, text: el.contentDocument?.body?.innerText.slice(0, 300), leaflet: typeof (el.contentWindow as unknown as { L?: unknown } | null)?.L, map: !!(el.contentWindow as unknown as { mapsPlaceholder?: unknown } | null)?.mapsPlaceholder })) })) });
        evaluate = (fn, arg) => page.evaluate(fn as (value: unknown) => never, arg); admin = (fn, arg) => options.evaluate(fn as (value: unknown) => never, arg);
        click = selector => page.locator(selector).click(); key = (selector, value) => page.locator(selector).press(value);
        viewport = size => page.setViewportSize(size); navigate = url => page.goto(url);
        screenshot = file => page.screenshot(file ? { path: file } : {});
        terrain = async fn => { const frame = await page.locator('#bpb-terrain-frame').elementHandle(); return (await frame!.contentFrame())!.evaluate(fn as () => never); };
        version = context.browser()!.version();
    } else {
        const { Builder, By, Key } = await import('selenium-webdriver'), firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot, distDir: source }); resources.defer('snow Firefox source', () => prepared.cleanup());
        resources.defer('snow Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
        const profile = path.join(temporaryRoot, 'profile'); await mkdir(profile);
        const options = new firefox.Options().addArguments('-headless', '-no-remote').setProfile(profile)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,snow.example.com').setPreference('network.proxy.type', 0)
            .setPreference('webgl.sanitize-unmasked-renderer', false).setPreference('webgl.disable-angle', false);
        options.enableBidi(); options.setAcceptInsecureCerts(true);
        if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
            .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`)).build() as FirefoxDriver;
        resources.defer('snow Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        const optionsURL = await driver.executeScript<string>('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        await driver.setContext(firefox.Context.CONTENT); await driver.get(optionsURL); const optionsHandle = await driver.getWindowHandle();
        await driver.switchTo().newWindow('tab'); const mapHandle = await driver.getWindowHandle();
        evaluate = (fn, arg) => driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null) as Promise<never>;
        admin = async (fn, arg) => { await driver.switchTo().window(optionsHandle); try { return await (evaluate(fn, arg) as Promise<never>); } finally { await driver.switchTo().window(mapHandle); } };
        click = async selector => (await driver.findElement(By.css(selector))).click();
        key = async (selector, value) => (await driver.findElement(By.css(selector))).sendKeys(value === 'Space' ? Key.SPACE : Key.ENTER);
        viewport = size => setFirefoxContentViewport(driver, size); navigate = url => driver.get(url);
        screenshot = async file => { const data = Buffer.from(await driver.takeScreenshot(), 'base64'); if (file) await writeFile(file, data); return data; };
        terrain = async fn => { await driver.switchTo().frame(await driver.findElement(By.id('bpb-terrain-frame'))); try { return await (evaluate(fn) as Promise<never>); } finally { await driver.switchTo().defaultContent(); } };
        const bidi = await driver.getBidi(); await bidi.subscribe('network.beforeRequestSent');
        const intercept = (event: { isBlocked: boolean; request: { url: string; request: string } }) => {
            if (!event.isBlocked || !/^https:\/\/(?:tiles\.mapterhorn\.com|base\.example\.com)\//.test(event.request.url)) return;
            const base = event.request.url.startsWith('https://base.example.com/');
            void bidi.send({ method: 'network.provideResponse', params: { request: event.request.request, statusCode: 200,
                headers: [{ name: 'content-type', value: { type: 'string', value: base ? 'image/png' : 'image/webp' } }, { name: 'access-control-allow-origin', value: { type: 'string', value: '*' } }], body: { type: 'base64', value: (base ? basePNG! : snowMapDem).toString('base64') } } });
        };
        bidi.on('network.beforeRequestSent', intercept); resources.defer('snow Firefox listener', () => bidi.off('network.beforeRequestSent', intercept));
        await bidi.send({ method: 'network.addIntercept', params: { phases: ['beforeRequestSent'], urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'tiles.mapterhorn.com' }, { type: 'pattern', protocol: 'https', hostname: 'base.example.com' }] } });
        version = (await driver.getCapabilities()).getBrowserVersion() as string;
    }
    const wait = <T,>(read: () => T | Promise<T>, description: string) => waitForCondition(read, { description, timeoutMs: 30000 });
    const patch = (update: object) => admin(async (settingsPatch: object) => ((globalThis as { browser?: typeof chrome }).browser || chrome).runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: settingsPatch }), update);
    await patch({ enable3dMap: true, showWeather: false, showSnotel: false, showSunMoon: false, terrainCacheLimitMb: 0, theme: 'light' });
    png = Buffer.from(await admin(() => { const c = document.createElement('canvas'); c.width = c.height = 256; const ctx = c.getContext('2d')!; ctx.fillStyle = '#2875d0'; ctx.fillRect(64, 0, 192, 256); return c.toDataURL().split(',')[1]; }), 'base64');
    basePNG = Buffer.from(await admin(() => { const c = document.createElement('canvas'); c.width = c.height = 256; const ctx = c.getContext('2d')!; ctx.fillStyle = '#e5e5e5'; ctx.fillRect(0, 0, 256, 256); return c.toDataURL().split(',')[1]; }), 'base64');
    await navigate(`${origin}/map/BigMap.aspx?t=A&d=2296&c=900001&base=${encodeURIComponent('https://base.example.com/{z}/{x}/{y}.png')}`);
    await wait(() => evaluate(() => !!document.querySelector('.bpb-layers-trigger') && !document.querySelector<Field>('.bpb-map-layers')!.hidden), 'shipped Overlays control');
    await click('.bpb-layers-trigger'); await click('[data-layer="snow"] .bpb-layers-disclosure');
    assert.equal(requests.length, 0, 'opening controls does not contact NOAA');
    const checkbox = '[data-layer="snow"] input', retry = '[data-overlay="snow"] .bpb-layers-retry';
    const geometry = () => evaluate((): SnowGeometry => {
        const rect = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        return { trigger: rect('.bpb-layers-trigger'), action: rect('[data-overlay="snow"] .bpb-layers-retry'), heading: rect('#heading'), following: rect('#following'), scrollY };
    });
    const stable = (a: SnowGeometry, b: SnowGeometry, label: string) => {
        for (const region of ['trigger', 'action', 'heading', 'following'] as const) for (const dimension of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(a[region][dimension] - b[region][dimension]) <= 1, `${label}: ${region}.${dimension} ${JSON.stringify({ a, b })}`);
        assert.equal(a.scrollY, b.scrollY, `${label}: reading position`);
    };
    let inTerrain = false;
    const settle = async () => {
        if (inTerrain) {
            const expected = await evaluate(() => document.querySelector<Field>('[data-layer="snow"] input')!.checked ? Number(document.querySelector<Field>('[aria-label="Snow depth opacity"]')!.value) / 100 : null);
            await waitForCondition(() => terrain(() => { const map = (globalThis as unknown as SnowTerrain).__snowDepthTestMap, layer = map.getStyle().layers.find(entry => entry.id.startsWith('bpb-overlay-snow-')); return layer ? map.getPaintProperty(layer.id, 'raster-opacity') : null; }), { description: 'terrain accepts snow opacity '+expected, timeoutMs: 30000, isReady: value => value === expected });
            await terrain(() => new Promise(resolve => { const map = (globalThis as unknown as SnowTerrain).__snowDepthTestMap; map.once('idle', () => resolve(null)); map.triggerRepaint(); }));
        }
        else await wait(() => evaluate(() => { const win = (document.getElementById('if') as HTMLIFrameElement).contentWindow!; return [...win.document.querySelectorAll('.leaflet-bpb-overlay-snow-pane canvas')].every(tile => win.getComputedStyle(tile).opacity === '1'); }), 'Leaflet tile fades finished');
    };
    const painted = async () => evaluate(async (data: string) => {
        const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0, score = 0;
        const active3d = (document.getElementById('bpb-terrain-toggle') as Field | null)?.getAttribute('aria-pressed') === 'true';
        const area = document.querySelector(active3d ? '#bpb-terrain-frame' : '#if')!.getBoundingClientRect();
        const masks = [...document.querySelectorAll('.bpb-map-layers,.bpb-layers-panel')].map(el => el.getBoundingClientRect());
        const scale = canvas.width / innerWidth;
        for (let i = 0; i < pixels.length; i += 4) {
            const x = (i / 4 % canvas.width) / scale, y = Math.floor(i / 4 / canvas.width) / scale;
            if (x < area.left || x >= area.right || y < area.top || y >= area.bottom || masks.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) continue;
            if (pixels[i + 2] > pixels[i + 1] + 8 && pixels[i + 2] > pixels[i] + 20) { count++; score += pixels[i + 2] - pixels[i]; }
        }
        return { count, score };
    }, (await screenshot()).toString('base64'));
    const changedPixels = async (first: Buffer, second: Buffer) => evaluate(async ({ first: before, second: after }: { first: string; second: string }) => {
        const images = await Promise.all([before, after].map(async data => { const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode(); return img; }));
        const canvas = document.createElement('canvas'); canvas.width = images[0].width; canvas.height = images[0].height; const ctx = canvas.getContext('2d')!;
        ctx.drawImage(images[0], 0, 0); const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(images[1], 0, 0); const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const active3d = (document.getElementById('bpb-terrain-toggle') as Field | null)?.getAttribute('aria-pressed') === 'true', area = document.querySelector(active3d ? '#bpb-terrain-frame' : '#if')!.getBoundingClientRect();
        const masks = [...document.querySelectorAll('.bpb-map-layers,.bpb-layers-panel')].map(el => el.getBoundingClientRect()), scale = canvas.width / innerWidth; let changed = 0, total = 0;
        for (let i = 0; i < a.length; i += 4) { const x = (i / 4 % canvas.width) / scale, y = Math.floor(i / 4 / canvas.width) / scale;
            if (x < area.left || x >= area.right || y < area.top || y >= area.bottom || masks.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) continue;
            total++; if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 15) changed++;
        }
        return { changed, total, ratio: changed / total };
    }, { first: first.toString('base64'), second: second.toString('base64') });
    const waitPainted = () => waitForCondition(painted, { description: 'snow pixels actually painted', timeoutMs: 30000, isReady: value => value.count > 1000 });
    const ready = () => wait(() => evaluate(() => document.querySelector<Field>('[data-layer="snow"] .bpb-layers-value')?.hidden === false), 'snow tiles and metadata finish');
    const rowStatus = (text: string) => wait(() => evaluate((value: string) => document.querySelector<Field>('[data-layer="snow"] .bpb-layers-row-status')?.textContent === value, text), `snow ${text}`);
    release('hold'); await key(checkbox, 'Space'); await rowStatus('Loading'); await wait(() => held.length > 0, 'held initial depth tiles');
    release('error'); await rowStatus('Couldn’t load');
    const original = await geometry();
    await evaluate((selector: string) => document.querySelector<HTMLElement>(selector)!.focus(), retry); release('hold'); await key(retry, 'Enter'); await rowStatus('Loading');
    stable(original, await geometry(), 'error → retry pending');
    const catalogueRequests = () => requests.filter(url => url.pathname.endsWith('/query')).length;
    const busyRequests = catalogueRequests(); await key(retry, 'Enter'); assert.equal(catalogueRequests(), busyRequests, 'busy keyboard activation cannot duplicate catalogue reads');
    release('ready'); await ready(); stable(original, await geometry(), 'retry → success');
    assert.equal(await evaluate((selector: string) => document.activeElement === document.querySelector(selector), retry), true, 'Refresh retains keyboard focus');
    assert.equal(await evaluate(() => document.querySelector<Field>('.bpb-snow-depth-time')!.title), '2026-10-30T00:00:00.000Z');
    assert.match(await evaluate(() => document.querySelector<Field>('[data-overlay="snow"] .bpb-layers-legend')!.textContent), /0–0.39 in/);
    let cases = 1, renderer: string | null | undefined;
    for (const dimension of ['2d', '3d']) {
        if (dimension === '3d') {
            await wait(() => evaluate(() => (document.getElementById('bpb-terrain-toggle') as Field | null)?.disabled === false), 'terrain available');
            await click('#bpb-terrain-toggle');
            await wait(() => evaluate(() => (document.getElementById('bpb-terrain-toggle') as Field | null)?.getAttribute('aria-pressed') === 'true'), 'terrain active');
            await ready(); inTerrain = true; await settle();
            await wait(() => terrain(() => !!(globalThis as unknown as SnowTerrain).__snowDepthTestMap.getSource('basemap')), 'snow retains the native basemap drape');
            renderer = await terrain(() => { const gl = document.querySelector<HTMLCanvasElement>('canvas.maplibregl-canvas')!.getContext('webgl2')!, ext = gl.getExtension('WEBGL_debug_renderer_info'); return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) as string; });
            assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
            release('error'); await key(checkbox, 'Space'); await settle(); await key(checkbox, 'Space'); await rowStatus('Couldn’t load');
            const beforeRetry = await geometry(); release('hold'); await key(retry, 'Enter'); await rowStatus('Loading');
            await wait(() => held.length > 0, '3D retry reaches the tile provider'); stable(beforeRetry, await geometry(), '3D retry pending');
            release('ready'); await ready(); await settle(); await waitPainted(); stable(beforeRetry, await geometry(), '3D retry finishes');
            assert.equal(await evaluate((selector: string) => document.activeElement === document.querySelector(selector), retry), true, '3D retry retains focus');
            const sourceSpec = await terrain(() => { const map = (globalThis as unknown as SnowTerrain).__snowDepthTestMap, layer = map.getStyle().layers.find(entry => entry.id.startsWith('bpb-overlay-snow-'))!; return { maxzoom: map.getStyle().sources[layer.source].maxzoom, sampling: map.getPaintProperty(layer.id, 'raster-resampling') }; });
            assert.equal(sourceSpec.maxzoom, 11); assert.equal(sourceSpec.sampling, 'nearest');
        }
        for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
            console.log(`Snow depth ${kind}: ${dimension} ${width}px ${theme}`);
            await viewport({ width, height: 1000 });
            await evaluate((value: string) => { document.documentElement.dataset.bpbTheme = value; const doc = (document.getElementById('if') as HTMLIFrameElement | null)?.contentDocument; if (doc) doc.documentElement.dataset.bpbTheme = value; }, theme);
            await wait(() => evaluate((value: string) => document.documentElement.dataset.bpbTheme === value, theme), `${theme} theme`);
            await ready();
            await evaluate(() => { const slider = document.querySelector<Field>('[aria-label="Snow depth opacity"]')!; slider.value = '60'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
            await settle();
            await waitPainted(); const solid = await screenshot();
            await evaluate(() => { const slider = document.querySelector<Field>('[aria-label="Snow depth opacity"]')!; slider.focus(); slider.value = '30'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
            await ready(); await settle();
            await waitForCondition(async () => changedPixels(solid, await screenshot()), { description: '30 percent changes painted map pixels', timeoutMs: 30000, isReady: value => value.ratio > .01 });
            if (output) { await mkdir(output, { recursive: true }); await screenshot(path.join(output, `snow-depth-${kind}-${dimension}-${width}-${theme}.png`)); }
            const fit = await evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, legend: getComputedStyle(document.querySelector('[data-overlay="snow"] .bpb-layers-legend')!).color }));
            assert.equal(fit.overflow, false); assert.equal(fit.width, width);
            const enabledPixels = await screenshot();
            await key(checkbox, 'Space'); await wait(() => evaluate(() => document.querySelector<Field>('[data-layer="snow"] input')!.checked === false), 'snow off'); await settle();
            await waitForCondition(async () => changedPixels(enabledPixels, await screenshot()), { description: 'snow off visibly restores the basemap', timeoutMs: 30000, isReady: value => value.ratio > .01 });
            await key(checkbox, 'Space'); await ready(); await settle(); await waitPainted(); cases++;
        }
        await evaluate((selector: string) => { document.querySelector<HTMLElement>('.bpb-map-layers')!.style.fontSize = '26px'; document.querySelector(selector)!.scrollIntoView({ block: 'nearest' }); document.querySelector<HTMLElement>(selector)!.focus({ preventScroll: true }); }, retry);
        const enlarged = await geometry(); release('hold'); await key(retry, 'Enter'); await rowStatus('Loading');
        stable(enlarged, await geometry(), dimension+' 200% text pending');
        release('ready'); await ready(); await settle(); stable(enlarged, await geometry(), dimension+' 200% text success');
        // The old overflow was reproduced in Chrome. Firefox uses different
        // font metrics; it must fit the fixed layout without inventing a failure.
        if (kind === 'chrome' && dimension === '2d') {
            await evaluate(() => { const header = document.querySelector<Field>('.bpb-custom-header')!; header.style.flexWrap = 'nowrap'; });
            assert.equal(await evaluate(() => { const panel = document.querySelector<Field>('.bpb-layers-panel')!; return panel.scrollWidth > panel.clientWidth; }), true, 'the enlarged-layout assertion detects the historical footer overflow');
            await evaluate(() => { document.querySelector<Field>('.bpb-custom-header')!.style.flexWrap = ''; });
        }
        if (output) await screenshot(path.join(output, `snow-depth-${kind}-${dimension}-375-dark-200pct.png`));
        const enlargedFit = await evaluate(() => { const panel = document.querySelector<Field>('.bpb-layers-panel')!; return { panelScroll: panel.scrollWidth, panelWidth: panel.clientWidth, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, overflowing: [...panel.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > panel.getBoundingClientRect().right + 1).map(el => ({ tag: el.tagName, className: el.className, width: el.getBoundingClientRect().width, text: (el.textContent || '').slice(0, 60) })).slice(0, 8) }; });
        assert.ok(enlargedFit.panelScroll <= enlargedFit.panelWidth && enlargedFit.documentWidth <= enlargedFit.viewport, 'enlarged snow details wrap: '+JSON.stringify(enlargedFit));
        assert.equal(await evaluate(() => { const text = document.querySelector('[data-overlay="snow"] .bpb-layers-feedback > span')!.firstChild; if (!text) return true; return [...text.textContent!.matchAll(/\S+/g)].every(match => { const range = document.createRange(); range.setStart(text, match.index!); range.setEnd(text, match.index! + match[0].length); return range.getClientRects().length === 1; }); }), true, 'enlarged feedback wraps between words');
        await evaluate(() => { document.querySelector<Field>('.bpb-map-layers')!.style.fontSize = ''; }); cases++;
    }
    assert.ok(origins.has(origin) && [...origins].some(value => /^(?:chrome|moz)-extension:\/\//.test(String(value))), 'real page and extension origins both reach the CORS provider');
    assert.ok(cases > 1);
    console.log(JSON.stringify({ verification: 'snow-depth', browser: kind, version, hidden: true, renderer, cases, viewports: ['1440x1000', '375x1000'], requests: requests.length, proof: 'real extension; fixture NOAA replies and synthetic DEM; stable keyboard retry and native content' }));
} catch (error) { failure = error; if (diagnostics) console.error(JSON.stringify(await diagnostics())); } finally { await resources.dispose(failure as null); }
